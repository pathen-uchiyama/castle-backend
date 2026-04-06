/**
 * k6 Load Test 5: Failure & Recovery — Atomic Guarantee
 *
 * Purpose: Verify zero orphaned/zombie bookings when Disney API returns 503s.
 * Tests the Atomic Guarantee: every booking is either fully confirmed or fully rolled back.
 *
 * Run: 
 *   # First, start mock Disney API with HIGH error rate
 *   curl -X POST http://localhost:3099/admin/reset -H 'Content-Type: application/json' \
 *     -d '{"config":{"errorRate":0.15,"latencyRange":[100,500]}}'
 *   
 *   # Then run the test
 *   k6 run load-tests/05_failure_recovery.js
 */

import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';

// ── Custom Metrics ──────────────────────────────────────────────────
const bookingAttempts = new Counter('booking_attempts');
const confirmedBookings = new Counter('confirmed_bookings');
const rolledBackBookings = new Counter('rolledback_bookings');
const orphanedBookings = new Counter('orphaned_bookings');  // THIS MUST BE ZERO
const confirmFailures = new Counter('confirm_failures');
const retryAttempts = new Counter('retry_attempts');
const atomicIntegrity = new Rate('atomic_integrity');  // Must be 100%

// ── Configuration ───────────────────────────────────────────────────
const MOCK_DISNEY_URL = __ENV.MOCK_DISNEY_URL || 'http://localhost:3099';
const MAX_RETRIES = 3;

export const options = {
    scenarios: {
        failure_storm: {
            executor: 'constant-vus',
            vus: 100,
            duration: '60s',
        },
    },
    thresholds: {
        // THE CRITICAL THRESHOLD: Zero orphaned bookings
        orphaned_bookings: ['count==0'],
        // Atomic integrity must be 100%
        atomic_integrity: ['rate==1'],
    },
};

export function setup() {
    // Reset with HIGH error rate to force failures
    const resetRes = http.post(`${MOCK_DISNEY_URL}/admin/reset`, JSON.stringify({
        config: {
            errorRate: 0.15,          // 15% failure rate
            latencyRange: [100, 500],
            chaosReReleaseRate: 0.10, // High chaos
            chaosIntervalMs: 3000,
        },
    }), { headers: { 'Content-Type': 'application/json' } });

    console.log(`Mock Disney reset for failure test: ${resetRes.status}`);
    return {};
}

export default function () {
    const userId = `user-${__VU}-${__ITER}`;
    const rides = ['MK_TRON', 'MK_7DMT', 'MK_HM', 'MK_SPACE', 'MK_JUNGLE'];
    const rideId = rides[Math.floor(Math.random() * rides.length)];
    const windows = ['09:00', '09:15', '09:30', '10:00', '10:30', '11:00'];
    const window = windows[Math.floor(Math.random() * windows.length)];

    group('Atomic Booking Test', function () {
        bookingAttempts.add(1);

        // Step 1: Book with retry logic
        let bookingId = null;
        let booked = false;

        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            const idempotencyKey = `${userId}:${rideId}:${window}`;

            const bookRes = http.post(`${MOCK_DISNEY_URL}/api/v1/book`, JSON.stringify({
                rideId,
                window,
                userId,
                idempotencyKey,
            }), { headers: { 'Content-Type': 'application/json' } });

            if (bookRes.status === 201 || bookRes.status === 200) {
                try {
                    const data = JSON.parse(bookRes.body);
                    bookingId = data.booking.id;
                    booked = true;

                    // Check for duplicate detection
                    if (data.duplicate) {
                        // Idempotency working correctly — don't double-book
                        atomicIntegrity.add(1);
                        return;
                    }
                } catch { /* noop */ }
                break;
            }

            if (bookRes.status === 409) {
                // Sold out — not a failure, just no availability
                atomicIntegrity.add(1);
                return;
            }

            if (bookRes.status === 503) {
                retryAttempts.add(1);
                // Exponential backoff: 1s, 2s, 4s
                sleep(Math.pow(2, attempt));
                continue;
            }

            // Unexpected error
            break;
        }

        if (!booked || !bookingId) {
            atomicIntegrity.add(1); // No booking was made, nothing to orphan
            return;
        }

        // Step 2: Confirm booking (this is where failures create orphans)
        let confirmed = false;

        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            const confirmRes = http.post(`${MOCK_DISNEY_URL}/api/v1/confirm/${bookingId}`);

            if (confirmRes.status === 200) {
                try {
                    const data = JSON.parse(confirmRes.body);
                    if (data.confirmed) {
                        confirmed = true;
                        confirmedBookings.add(1);
                        atomicIntegrity.add(1);
                        break;
                    }
                } catch { /* noop */ }
            }

            if (confirmRes.status === 503) {
                confirmFailures.add(1);
                retryAttempts.add(1);

                // Check if server rolled back the booking
                try {
                    const data = JSON.parse(confirmRes.body);
                    if (data.code === 'CONFIRM_FAILED') {
                        // Server rolled back — this is CORRECT behavior
                        rolledBackBookings.add(1);
                        atomicIntegrity.add(1);
                        return; // Exit — booking was cleanly rolled back
                    }
                } catch { /* noop */ }

                sleep(Math.pow(2, attempt));
                continue;
            }

            break;
        }

        if (!confirmed) {
            // CRITICAL: We booked but never confirmed — this is an orphan
            orphanedBookings.add(1);
            atomicIntegrity.add(0); // FAILURE
            console.error(`🚨 ORPHANED BOOKING: ${bookingId} for ${rideId}@${window} by ${userId}`);
        }
    });

    sleep(0.1 + Math.random() * 0.3);
}

export function teardown(data) {
    const stateRes = http.get(`${MOCK_DISNEY_URL}/admin/state`);
    if (stateRes.status === 200) {
        try {
            const state = JSON.parse(stateRes.body);
            console.log(`\n🔒 Atomic Guarantee Results:`);
            console.log(`   Total bookings in system: ${state.bookingCount}`);
            console.log(`   Total requests: ${state.requestCount}`);
            console.log(`   Server-side errors: ${state.errorCount}`);
        } catch { /* noop */ }
    }
}

export function handleSummary(data) {
    return {
        'load-tests/results/05_failure_recovery.json': JSON.stringify(data, null, 2),
    };
}
