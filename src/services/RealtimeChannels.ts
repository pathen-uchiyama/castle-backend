/**
 * Supabase Realtime Channels — Push Updates to Mobile App
 *
 * Channels:
 *   - queue:{tripId}     → Snipe job status updates (queued → processing → confirmed/failed)
 *   - sync:{userId}      → Offline reconciliation conflict notifications
 *   - party:{partyId}    → Split party reunion alerts + late-group nudges
 *   - advisory:{parkId}  → Ride closure / advisory change broadcasts
 *
 * Usage:
 *   import { realtime } from './services/RealtimeChannels';
 *   realtime.pushQueueUpdate(tripId, { jobId, status: 'confirmed', rideId });
 *   realtime.pushConflictAlert(userId, { idempotencyKey, conflictType });
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { env } from '../config/env';

// ── Types ───────────────────────────────────────────────────────

export interface QueueUpdate {
    jobId: string;
    status: 'queued' | 'processing' | 'confirmed' | 'failed' | 'counter_offer';
    rideId: string;
    rideName?: string;
    window?: string;
    message?: string;
    timestamp: string;
}

export interface ConflictAlert {
    idempotencyKey: string;
    conflictType: 'server_wins' | 'needs_review' | 'merged';
    serverAction?: any;
    clientAction?: any;
    message: string;
}

export interface PartyAlert {
    type: 'reunion_reminder' | 'late_group' | 'reunion_checkin' | 'party_merged';
    reunionId?: string;
    location?: string;
    meetTime?: string;
    lateGroupId?: string;
    minutesLate?: number;
    message: string;
}

export interface AdvisoryBroadcast {
    attractionId: string;
    attractionName: string;
    changeType: 'closure' | 'reopen' | 'advisory_added' | 'wait_time_change';
    previousStatus?: string;
    newStatus: string;
    message: string;
}

// ── Realtime Manager ────────────────────────────────────────────

class RealtimeChannels {
    private supabase: SupabaseClient | null = null;
    private initialized = false;

    constructor() {
        this.init();
    }

    private init() {
        if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
            console.warn('[Realtime] Supabase credentials not configured — realtime disabled');
            return;
        }

        try {
            this.supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
                realtime: {
                    params: {
                        eventsPerSecond: 10, // Rate limit to prevent abuse
                    },
                },
            });
            this.initialized = true;
            console.log('[Realtime] Supabase Realtime channels initialized');
        } catch (err) {
            console.warn('[Realtime] Failed to initialize:', err);
        }
    }

    // ── Queue Updates ───────────────────────────────────────────

    /**
     * Push snipe job status update to a specific trip.
     * Mobile app subscribes to `queue:{tripId}` on the itinerary screen.
     */
    async pushQueueUpdate(tripId: string, update: QueueUpdate): Promise<void> {
        await this.broadcast(`queue:${tripId}`, 'queue_update', update);
    }

    // ── Conflict Alerts ─────────────────────────────────────────

    /**
     * Push conflict notification to a user after offline reconciliation.
     * Mobile app subscribes to `sync:{userId}` on reconnection.
     */
    async pushConflictAlert(userId: string, alert: ConflictAlert): Promise<void> {
        await this.broadcast(`sync:${userId}`, 'conflict_alert', alert);
    }

    // ── Party Alerts ────────────────────────────────────────────

    /**
     * Push reunion/late-group alerts to a split party.
     * Each member of the party subscribes to `party:{partyId}`.
     */
    async pushPartyAlert(partyId: string, alert: PartyAlert): Promise<void> {
        await this.broadcast(`party:${partyId}`, 'party_alert', alert);
    }

    // ── Advisory Broadcasts ─────────────────────────────────────

    /**
     * Broadcast ride advisory changes to ALL users in a park.
     * Mobile app subscribes to `advisory:{parkId}` for their current park.
     */
    async pushAdvisoryBroadcast(parkId: string, broadcast: AdvisoryBroadcast): Promise<void> {
        await this.broadcast(`advisory:${parkId}`, 'advisory_change', broadcast);
    }

    // ── Core Broadcast ──────────────────────────────────────────

    private async broadcast(channelName: string, event: string, payload: any): Promise<void> {
        if (!this.initialized || !this.supabase) {
            // Degrade gracefully — log instead of crash
            console.log(`[Realtime] Would broadcast to ${channelName}:${event}`, 
                JSON.stringify(payload).substring(0, 100));
            return;
        }

        try {
            const channel = this.supabase.channel(channelName);
            
            await channel.send({
                type: 'broadcast',
                event,
                payload: {
                    ...payload,
                    _channel: channelName,
                    _sentAt: new Date().toISOString(),
                },
            });

            // Unsubscribe after sending (server-side push, not long-lived)
            await this.supabase.removeChannel(channel);
        } catch (err) {
            console.warn(`[Realtime] Failed to broadcast to ${channelName}:`, err);
        }
    }

    // ── Convenience: Batch Broadcast ────────────────────────────

    /**
     * Broadcast to multiple channels at once (e.g., advisory change to all parks).
     */
    async broadcastToMany(
        channelNames: string[],
        event: string,
        payload: any
    ): Promise<void> {
        await Promise.allSettled(
            channelNames.map(ch => this.broadcast(ch, event, payload))
        );
    }
}

// ── Singleton Export ─────────────────────────────────────────────

export const realtime = new RealtimeChannels();
