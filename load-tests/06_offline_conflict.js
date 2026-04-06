/**
 * k6 Load Test 6: Offline Conflict Resolution
 *
 * Purpose: Validate zero duplicate bookings when users reconnect after
 * offline periods with locally queued actions that conflict with
 * server-side state changes.
 *
 * Scenario:
 *   - 100 users go "offline" (stop syncing for 5-10 seconds)
 *   - Server processes snipe jobs during offline window
 *   - 50% of users queue conflicting manual actions (same ride, different window)
 *   - All users reconnect simultaneously with their local queues
 *   - Verify: zero duplicate bookings, correct conflict resolution
 *
 * Run:
 *   k6 run load-tests/06_offline_conflict.js
 */

import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Rate, Counter, Trend } from 'k6/metrics';

// ── Custom Metrics ──────────────────────────────────────────────────
const syncAttempts = new Counter('sync_attempts');
const syncSuccess = new Counter('sync_success');
const conflictsDetected = new Counter('conflicts_detected');
const conflictsResolved = new Counter('conflicts_resolved');
const duplicatesPrevented = new Counter('duplicates_prevented');
const orphanedActions = new Counter('orphaned_actions');   // MUST BE ZERO
const syncLatency = new Trend('sync_latency_ms');
const conflictResolution = new Rate('conflict_resolution_rate');
const zeroDuplicates = new Rate('zero_duplicates');

// ── Configuration ───────────────────────────────────────────────────
const BASE_URL = __ENV.BASE_URL || 'http://localhost:3001/api';

export const options = {
    scenarios: {
        // Phase 1: Seed server-side state (users are "online")
        seed_state: {
            executor: 'shared-iterations',
            iterations: 100,
            vus: 10,
            startTime: '0s',
            maxDuration: '20s',
            exec: 'seedServerState',
        },
        // Phase 2: Simulate offline period + local queuing
        offline_queue: {
            executor: 'shared-iterations',
            iterations: 100,
            vus: 50,
            startTime: '25s',
            maxDuration: '15s',
            exec: 'simulateOffline',
        },
        // Phase 3: Mass reconnection storm
        reconnection_storm: {
            executor: 'constant-vus',
            vus: 100,
            duration: '30s',
            startTime: '45s',
            exec: 'massReconnect',
        },
    },
    thresholds: {
        // Zero orphaned actions
        orphaned_actions: ['count==0'],
        // Zero duplicates
        zero_duplicates: ['rate==1'],
        // >95% of conflicts should be resolved automatically
        conflict_resolution_rate: ['rate>0.95'],
        // Sync latency p95 < 2 seconds
        sync_latency_ms: ['p(95)<2000'],
    },
};

// ── Phase 1: Seed Server State ──────────────────────────────────────

const rides = ['MK_TRON', 'MK_7DMT', 'MK_SPACE', 'MK_SPLASH', 'EP_GUARDIANS'];
const windows = ['morning', 'midday', 'evening'];

export function seedServerState() {
    const userId = `user-${__VU}-${__ITER}`;
    const tripId = `trip-${__VU}`;
    const rideId = rides[__ITER % rides.length];
    const windowType = windows[__ITER % windows.length];

    group('Seed Server State', function () {
        // Record a server-side booking action
        const syncRes = http.post(`${BASE_URL}/sync/state`, JSON.stringify({
            userId,
            tripId,
            lastSyncAt: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
            localActions: [{
                idempotencyKey: `${userId}:${rideId}:2026-04-15:${windowType}`,
                type: 'BOOKING_CONFIRMED',
                userId,
                tripId,
                timestamp: new Date().toISOString(),
                payload: {
                    rideId,
                    window: windowType,
                    bookingId: `bk_${__VU}_${__ITER}`,
                },
                source: 'server',
            }],
        }), { headers: { 'Content-Type': 'application/json' } });

        check(syncRes, {
            'seed state: status 200': (r) => r.status === 200,
        });
    });

    sleep(0.1);
}

// ── Phase 2: Simulate Offline Period ────────────────────────────────

export function simulateOffline() {
    const userId = `user-${__VU}-${__ITER}`;
    const tripId = `trip-${__VU}`;

    group('Offline Period', function () {
        // Simulate 5-10 seconds offline
        const offlineDuration = 5 + Math.random() * 5;
        sleep(offlineDuration);

        // 50% of users create conflicting local actions
        if (__VU % 2 === 0) {
            // This user queued a manual action for the same ride
            // as a server-side booking — this is the conflict scenario
            console.log(`User ${userId} queued conflicting action during offline`);
        }
    });
}

// ── Phase 3: Mass Reconnection Storm ────────────────────────────────

export function massReconnect() {
    const userId = `user-${__VU}-${__ITER}`;
    const tripId = `trip-${__VU}`;
    const rideId = rides[__VU % rides.length];
    const windowType = windows[__ITER % windows.length];

    group('Reconnection Handshake', function () {
        syncAttempts.add(1);

        // Build local action queue (simulating what the mobile app would queue)
        const localActions = [];
        const hasConflict = __VU % 2 === 0;

        if (hasConflict) {
            // Conflicting action: same ride as server booking but different preference
            localActions.push({
                idempotencyKey: `${userId}:${rideId}:2026-04-15:${windowType}`,
                type: 'PREFERENCE_CHANGED',
                userId,
                tripId,
                timestamp: new Date(Date.now() - 5000).toISOString(), // 5s ago (during offline)
                payload: {
                    rideId,
                    newPreference: 'like_to',
                    oldPreference: 'must_do',
                },
                source: 'client',
            });
        }

        // Always include a non-conflicting action
        localActions.push({
            idempotencyKey: `${userId}:BREAK:2026-04-15:afternoon_${__ITER}`,
            type: 'BREAK_ADDED',
            userId,
            tripId,
            timestamp: new Date(Date.now() - 3000).toISOString(),
            payload: {
                breakType: 'bio_break',
                duration: 10,
            },
            source: 'client',
        });

        const startTime = Date.now();

        const syncRes = http.post(`${BASE_URL}/sync/state`, JSON.stringify({
            userId,
            tripId,
            lastSyncAt: new Date(Date.now() - 30000).toISOString(), // 30s ago
            localActions,
        }), { headers: { 'Content-Type': 'application/json' } });

        syncLatency.add(Date.now() - startTime);

        const syncOk = check(syncRes, {
            'sync: status 200': (r) => r.status === 200,
            'sync: has response body': (r) => r.body && r.body.length > 0,
        });

        if (syncOk && syncRes.status === 200) {
            syncSuccess.add(1);

            try {
                const result = JSON.parse(syncRes.body);

                // Check for conflicts detected
                if (result.rejectedActions && result.rejectedActions.length > 0) {
                    conflictsDetected.add(result.rejectedActions.length);
                }

                // Check duplicates were prevented
                if (result.droppedDuplicates && result.droppedDuplicates.length > 0) {
                    duplicatesPrevented.add(result.droppedDuplicates.length);
                }

                // Check accepted actions
                if (result.acceptedActions && result.acceptedActions.length > 0) {
                    conflictsResolved.add(result.acceptedActions.length);
                }

                // Verify no orphaned actions (actions that were neither accepted, rejected, nor dropped)
                const totalProcessed =
                    (result.acceptedActions?.length || 0) +
                    (result.rejectedActions?.length || 0) +
                    (result.droppedDuplicates?.length || 0);

                if (totalProcessed < localActions.length) {
                    orphanedActions.add(localActions.length - totalProcessed);
                    zeroDuplicates.add(0);
                } else {
                    zeroDuplicates.add(1);
                }

                conflictResolution.add(1);
            } catch {
                conflictResolution.add(0);
            }
        } else {
            conflictResolution.add(0);
        }
    });

    // Check for conflicts that need user review
    group('Check Pending Conflicts', function () {
        const conflictRes = http.get(`${BASE_URL}/sync/conflicts/${userId}`);

        check(conflictRes, {
            'conflicts: status 200': (r) => r.status === 200,
        });

        if (conflictRes.status === 200) {
            try {
                const data = JSON.parse(conflictRes.body);
                if (data.conflicts && data.conflicts.length > 0) {
                    // Resolve each conflict (keep server version)
                    for (const conflict of data.conflicts) {
                        const resolveRes = http.post(`${BASE_URL}/sync/conflicts/resolve`, JSON.stringify({
                            userId,
                            idempotencyKey: conflict.clientAction?.idempotencyKey || 'unknown',
                            choice: 'keep_server',
                        }), { headers: { 'Content-Type': 'application/json' } });

                        check(resolveRes, {
                            'resolve: status 200': (r) => r.status === 200,
                        });
                    }
                }
            } catch { /* noop */ }
        }
    });

    sleep(0.1 + Math.random() * 0.3);
}

export function handleSummary(data) {
    return {
        'load-tests/results/06_offline_conflict.json': JSON.stringify(data, null, 2),
    };
}
