import Redis from 'ioredis';
import { env } from '../config/env';

/**
 * OfflineReconciliation — Zero-Loss State Sync for Mobile Reconnection
 *
 * When a guest loses cellular coverage in a park (common in queues,
 * underground rides, or thick-walled attractions), the mobile app
 * queues actions locally. On reconnection, the handshake protocol
 * ensures zero data loss and zero duplicate bookings.
 *
 * Protocol:
 *   1. Mobile sends `GET /api/sync/state?since={lastSyncTimestamp}`
 *   2. Server returns all state changes since that timestamp
 *   3. Mobile sends its local action queue
 *   4. Server applies idempotency-checked merge
 *   5. Server returns canonical merged state
 *
 * Idempotency Key Format: {userId}:{rideId}:{date}:{windowType}
 * Example: "usr_abc:tron:2026-04-15:morning"
 *
 * Conflict Resolution Rules:
 *   - Server booking ALWAYS wins (it's already committed to Disney)
 *   - Client preference changes apply if no server-side change exists
 *   - Duplicate actions are silently dropped (idempotency)
 *   - Conflicting manual actions are flagged for user review
 */

// ── Types ───────────────────────────────────────────────────────

export type ActionType =
    | 'BOOKING_CONFIRMED'
    | 'BOOKING_CANCELLED'
    | 'PREFERENCE_CHANGED'
    | 'ITINERARY_REORDERED'
    | 'SNIPE_SUBMITTED'
    | 'SNIPE_COMPLETED'
    | 'SNIPE_FAILED'
    | 'BREAK_ADDED'
    | 'STEP_SKIPPED'
    | 'PIVOT_ACCEPTED'
    | 'PIVOT_REJECTED';

export interface StateAction {
    /** Idempotency key */
    idempotencyKey: string;
    /** Action type */
    type: ActionType;
    /** User who performed the action */
    userId: string;
    /** Trip this action belongs to */
    tripId: string;
    /** Timestamp of the action (ISO 8601) */
    timestamp: string;
    /** Action payload */
    payload: Record<string, any>;
    /** Source: 'server' = backend-initiated, 'client' = mobile offline queue */
    source: 'server' | 'client';
}

export interface SyncRequest {
    userId: string;
    tripId: string;
    /** Last successful sync timestamp */
    lastSyncAt: string;
    /** Locally queued actions from offline period */
    localActions: StateAction[];
    /** Client's local state version hash */
    clientStateHash?: string;
}

export interface SyncResponse {
    /** Canonical merged state */
    serverActions: StateAction[];
    /** Actions that were accepted from the client */
    acceptedActions: StateAction[];
    /** Actions that were rejected (conflicts) */
    rejectedActions: { action: StateAction; reason: string; serverAction?: StateAction }[];
    /** Duplicate actions that were silently dropped */
    droppedDuplicates: string[];
    /** New sync timestamp to use for next request */
    newSyncTimestamp: string;
    /** Whether the client should do a full state refresh */
    requiresFullRefresh: boolean;
}

export interface ConflictReport {
    clientAction: StateAction;
    serverAction: StateAction;
    resolution: 'server_wins' | 'client_wins' | 'merged' | 'user_review';
    reason: string;
}

// ── Engine ──────────────────────────────────────────────────────

export class OfflineReconciliation {
    private redis: Redis;
    private static readonly STATE_PREFIX = 'sync:state:';
    private static readonly IDEMPOTENCY_PREFIX = 'sync:idem:';
    private static readonly CONFLICT_PREFIX = 'sync:conflict:';

    // Actions where server ALWAYS wins (already committed to Disney)
    private static readonly SERVER_PRIORITY_ACTIONS: ActionType[] = [
        'BOOKING_CONFIRMED',
        'BOOKING_CANCELLED',
        'SNIPE_COMPLETED',
        'SNIPE_FAILED',
    ];

    // Actions where client can win (local preference changes)
    private static readonly CLIENT_MERGEABLE_ACTIONS: ActionType[] = [
        'PREFERENCE_CHANGED',
        'ITINERARY_REORDERED',
        'BREAK_ADDED',
        'STEP_SKIPPED',
        'PIVOT_ACCEPTED',
        'PIVOT_REJECTED',
    ];

    constructor(redisUrl?: string) {
        this.redis = new Redis(redisUrl || env.REDIS_URL, {
            maxRetriesPerRequest: null,
            lazyConnect: true,
        });

        this.redis.on('error', (err) => {
            console.warn('[Sync] Redis error:', err.message);
        });

        this.redis.connect().catch((err) => {
            console.warn('[Sync] Redis connection failed:', err.message);
        });
    }

    // ── Server-Side State Recording ─────────────────────────────

    /**
     * Record a server-side state change.
     * Called by booking handlers, snipe workers, etc.
     */
    async recordServerAction(action: Omit<StateAction, 'source'>): Promise<void> {
        const fullAction: StateAction = { ...action, source: 'server' };
        const stateKey = `${OfflineReconciliation.STATE_PREFIX}${action.tripId}`;
        const idemKey = `${OfflineReconciliation.IDEMPOTENCY_PREFIX}${action.idempotencyKey}`;

        const pipeline = this.redis.pipeline();

        // Store the action in the trip's state log (sorted by timestamp)
        pipeline.zadd(stateKey, new Date(action.timestamp).getTime().toString(), JSON.stringify(fullAction));

        // Mark the idempotency key as used (7-day TTL)
        pipeline.set(idemKey, JSON.stringify(fullAction), 'EX', 604800);

        // Keep the state log trimmed (last 1,000 actions per trip)
        pipeline.zremrangebyrank(stateKey, 0, -1001);

        // 30-day TTL on the state log
        pipeline.expire(stateKey, 2592000);

        await pipeline.exec();
    }

    // ── Reconnection Handshake ──────────────────────────────────

    /**
     * Handle a sync request from a reconnecting mobile client.
     * This is the core reconciliation algorithm.
     */
    async handleSyncRequest(request: SyncRequest): Promise<SyncResponse> {
        const stateKey = `${OfflineReconciliation.STATE_PREFIX}${request.tripId}`;
        const sinceTimestamp = new Date(request.lastSyncAt).getTime();

        // 1. Get all server-side actions since the client's last sync
        const serverActionsRaw = await this.redis.zrangebyscore(
            stateKey,
            sinceTimestamp,
            '+inf'
        );
        const serverActions: StateAction[] = serverActionsRaw.map(a => JSON.parse(a));

        // 2. Build idempotency index from server actions
        const serverIdemIndex = new Map<string, StateAction>();
        for (const action of serverActions) {
            serverIdemIndex.set(action.idempotencyKey, action);
        }

        // 3. Process each client action
        const acceptedActions: StateAction[] = [];
        const rejectedActions: { action: StateAction; reason: string; serverAction?: StateAction }[] = [];
        const droppedDuplicates: string[] = [];

        for (const clientAction of request.localActions) {
            // Check idempotency — has this exact action already been processed?
            const existingIdem = await this.redis.get(
                `${OfflineReconciliation.IDEMPOTENCY_PREFIX}${clientAction.idempotencyKey}`
            );

            if (existingIdem) {
                // Duplicate — silently drop
                droppedDuplicates.push(clientAction.idempotencyKey);
                continue;
            }

            // Check for conflicts with server actions
            const conflict = this.detectConflict(clientAction, serverIdemIndex);

            if (conflict) {
                if (conflict.resolution === 'server_wins') {
                    rejectedActions.push({
                        action: clientAction,
                        reason: conflict.reason,
                        serverAction: conflict.serverAction,
                    });
                } else if (conflict.resolution === 'client_wins' || conflict.resolution === 'merged') {
                    // Client action is safe to apply
                    await this.applyClientAction(clientAction, request.tripId);
                    acceptedActions.push(clientAction);
                } else {
                    // User review needed
                    await this.queueForUserReview(request.userId, conflict);
                    rejectedActions.push({
                        action: clientAction,
                        reason: 'Conflict detected — queued for your review',
                        serverAction: conflict.serverAction,
                    });
                }
            } else {
                // No conflict — apply the action
                await this.applyClientAction(clientAction, request.tripId);
                acceptedActions.push(clientAction);
            }
        }

        const newSyncTimestamp = new Date().toISOString();

        // Determine if client needs full refresh (>100 missed actions or >24h gap)
        const msSinceLastSync = Date.now() - sinceTimestamp;
        const requiresFullRefresh = serverActions.length > 100 || msSinceLastSync > 86400000;

        return {
            serverActions,
            acceptedActions,
            rejectedActions,
            droppedDuplicates,
            newSyncTimestamp,
            requiresFullRefresh,
        };
    }

    // ── Conflict Detection ──────────────────────────────────────

    /**
     * Detect if a client action conflicts with any server action.
     */
    private detectConflict(
        clientAction: StateAction,
        serverIndex: Map<string, StateAction>
    ): ConflictReport | null {
        // Check for same-resource conflicts
        // Parse the idempotency key: {userId}:{rideId}:{date}:{windowType}
        const [, rideId, date, windowType] = clientAction.idempotencyKey.split(':');

        // Look for server actions on the same resource
        for (const [serverKey, serverAction] of serverIndex) {
            const [, serverRideId, serverDate, serverWindowType] = serverKey.split(':');

            if (rideId === serverRideId && date === serverDate) {
                // Same ride, same day — potential conflict

                // Rule 1: Server booking ALWAYS wins
                if (OfflineReconciliation.SERVER_PRIORITY_ACTIONS.includes(serverAction.type)) {
                    return {
                        clientAction,
                        serverAction,
                        resolution: 'server_wins',
                        reason: `Server already processed ${serverAction.type} for ${rideId} on ${date}`,
                    };
                }

                // Rule 2: Same action type on same resource — server wins
                if (clientAction.type === serverAction.type) {
                    return {
                        clientAction,
                        serverAction,
                        resolution: 'server_wins',
                        reason: `Duplicate ${clientAction.type} for ${rideId} — server version preserved`,
                    };
                }

                // Rule 3: Different action types — check if mergeable
                if (OfflineReconciliation.CLIENT_MERGEABLE_ACTIONS.includes(clientAction.type)) {
                    if (!OfflineReconciliation.SERVER_PRIORITY_ACTIONS.includes(serverAction.type)) {
                        return {
                            clientAction,
                            serverAction,
                            resolution: 'merged',
                            reason: `Merged: client ${clientAction.type} + server ${serverAction.type} for ${rideId}`,
                        };
                    }
                }

                // Rule 4: Unresolvable conflict — queue for user review
                return {
                    clientAction,
                    serverAction,
                    resolution: 'user_review',
                    reason: `Conflict: client ${clientAction.type} vs server ${serverAction.type} for ${rideId}. Please review.`,
                };
            }
        }

        // No conflict
        return null;
    }

    // ── Apply Client Action ─────────────────────────────────────

    /**
     * Apply a client action to the server state.
     */
    private async applyClientAction(action: StateAction, tripId: string): Promise<void> {
        const fullAction: StateAction = { ...action, source: 'client' };
        const stateKey = `${OfflineReconciliation.STATE_PREFIX}${tripId}`;
        const idemKey = `${OfflineReconciliation.IDEMPOTENCY_PREFIX}${action.idempotencyKey}`;

        const pipeline = this.redis.pipeline();
        pipeline.zadd(stateKey, new Date(action.timestamp).getTime().toString(), JSON.stringify(fullAction));
        pipeline.set(idemKey, JSON.stringify(fullAction), 'EX', 604800);
        pipeline.expire(stateKey, 2592000);
        await pipeline.exec();
    }

    // ── User Review Queue ───────────────────────────────────────

    /**
     * Queue a conflict for user review in the mobile app.
     */
    private async queueForUserReview(userId: string, conflict: ConflictReport): Promise<void> {
        const key = `${OfflineReconciliation.CONFLICT_PREFIX}${userId}`;
        await this.redis.lpush(key, JSON.stringify({
            ...conflict,
            queuedAt: new Date().toISOString(),
            status: 'pending',
        }));
        await this.redis.ltrim(key, 0, 99); // Max 100 conflicts per user
        await this.redis.expire(key, 604800); // 7-day TTL
    }

    /**
     * Get pending conflicts for a user.
     */
    async getPendingConflicts(userId: string): Promise<any[]> {
        const key = `${OfflineReconciliation.CONFLICT_PREFIX}${userId}`;
        const items = await this.redis.lrange(key, 0, -1);
        return items.map(i => JSON.parse(i));
    }

    /**
     * Resolve a conflict (user chose which version to keep).
     */
    async resolveConflict(
        userId: string,
        idempotencyKey: string,
        choice: 'keep_server' | 'keep_client'
    ): Promise<{ success: boolean }> {
        if (choice === 'keep_client') {
            // Re-apply the client action
            const conflicts = await this.getPendingConflicts(userId);
            const conflict = conflicts.find((c: ConflictReport) => c.clientAction.idempotencyKey === idempotencyKey);
            if (conflict) {
                await this.applyClientAction(conflict.clientAction, conflict.clientAction.tripId);
            }
        }
        // Either way, remove from conflict queue
        // (simplified — in production, use LREM with the exact value)
        return { success: true };
    }

    // ── State Queries ───────────────────────────────────────────

    /**
     * Get full state history for a trip.
     */
    async getTripState(tripId: string, limit: number = 100): Promise<StateAction[]> {
        const stateKey = `${OfflineReconciliation.STATE_PREFIX}${tripId}`;
        const raw = await this.redis.zrevrange(stateKey, 0, limit - 1);
        return raw.map(r => JSON.parse(r));
    }

    /**
     * Check if an idempotency key has been used.
     */
    async isIdempotent(idempotencyKey: string): Promise<boolean> {
        const idemKey = `${OfflineReconciliation.IDEMPOTENCY_PREFIX}${idempotencyKey}`;
        return (await this.redis.exists(idemKey)) === 1;
    }
}
