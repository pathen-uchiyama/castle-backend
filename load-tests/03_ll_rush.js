/**
 * k6 Load Test 3: 7AM LL Rush — Full Operational Payload
 *
 * Purpose: Simulate the 7:00 AM Lightning Lane booking rush on the Mock Disney API.
 * This is the CRITICAL test — it validates the full Time-Series State Machine.
 *
 * Run against Mock Disney API (must be running on port 3099):
 *   k6 run load-tests/03_ll_rush.js
 *
 * The mock server should be reset before each run:
 *   curl -X POST http://localhost:3099/admin/reset
 */

import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';
import { SharedArray } from 'k6/data';

// ── Custom Metrics ──────────────────────────────────────────────────
const errorRate = new Rate('errors');
const bookingSuccess = new Rate('booking_success');
const counterOfferRate = new Rate('counter_offers');
const availLatency = new Trend('availability_latency', true);
const bookLatency = new Trend('booking_latency', true);
const confirmLatency = new Trend('confirm_latency', true);
const totalBookings = new Counter('total_bookings');
const totalCounterOffers = new Counter('total_counter_offers');
const totalSoldOut = new Counter('total_sold_out');
const disneyErrors = new Counter('disney_503_errors');

// ── Configuration ───────────────────────────────────────────────────
const MOCK_DISNEY_URL = __ENV.MOCK_DISNEY_URL || 'http://localhost:3099';
const CASTLE_URL = __ENV.CASTLE_URL || 'http://localhost:3000';

// Tier 1 headliner rides (aggressive decay — sells out fast)
const TIER1_RIDES = ['MK_TRON', 'MK_7DMT', 'MK_TIANA'];
// Tier 2 mid-tier rides (linear decay — more availability)
const TIER2_RIDES = ['MK_HM', 'MK_JUNGLE', 'MK_SPACE'];

const ALL_RIDES = [...TIER1_RIDES, ...TIER2_RIDES];
const EARLY_WINDOWS = ['09:00', '09:15', '09:30', '09:45', '10:00'];
const LATE_WINDOWS = ['10:15', '10:30', '10:45', '11:00', '11:15', '11:30', '11:45'];

export const options = {
    scenarios: {
        // Phase 1: The 7:00 AM rush (everyone hits Tier 1 first)
        rush_wave: {
            executor: 'ramping-vus',
            startVUs: 0,
            stages: [
                { duration: '5s', target: 50 },      // Early birds
                { duration: '10s', target: 250 },     // Rush begins
                { duration: '15s', target: 500 },     // Peak rush — 500 concurrent
                { duration: '30s', target: 500 },     // Sustained peak
                { duration: '20s', target: 200 },     // Decay
                { duration: '10s', target: 50 },      // Stragglers
                { duration: '10s', target: 0 },       // Wind down
            ],
        },
    },
    thresholds: {
        // Hard benchmarks from task list
        http_req_duration: ['p(95)<3000', 'p(99)<5000'],
        errors: ['rate<0.05'],              // <5% error rate (includes 503s)
        booking_success: ['rate>0.50'],     // At least 50% success (rest = sold out)
        availability_latency: ['p(95)<1000'],
        booking_latency: ['p(95)<2000'],
    },
};

export function setup() {
    // Reset mock Disney API inventory
    const resetRes = http.post(`${MOCK_DISNEY_URL}/admin/reset`, JSON.stringify({
        config: {
            errorRate: 0.03,        // 3% Disney 503s
            latencyRange: [50, 300],
            chaosReReleaseRate: 0.05,
            chaosIntervalMs: 5000,
            rateLimitPerSecond: 2,
        },
    }), { headers: { 'Content-Type': 'application/json' } });

    console.log(`Mock Disney reset: ${resetRes.status}`);
    return { startTime: Date.now() };
}

export default function (data) {
    const userId = `user-${__VU}-${__ITER}`;
    const vu = __VU;

    // Determine ride selection strategy:
    // - First 70% of VUs target Tier 1 (headliners) — simulates real rush behavior
    // - Remaining 30% target Tier 2 (mid-tier)
    const targetTier1 = vu % 10 < 7;
    const targetRides = targetTier1 ? TIER1_RIDES : TIER2_RIDES;
    const targetRide = targetRides[Math.floor(Math.random() * targetRides.length)];
    const preferredWindow = EARLY_WINDOWS[Math.floor(Math.random() * EARLY_WINDOWS.length)];

    group('LL Booking Flow', function () {
        // Step 1: Check availability
        const availRes = http.get(`${MOCK_DISNEY_URL}/api/v1/availability/${targetRide}`);
        availLatency.add(availRes.timings.duration);

        if (availRes.status === 503) {
            disneyErrors.add(1);
            errorRate.add(1);
            sleep(1 + Math.random() * 2); // Exponential backoff
            return;
        }

        const availOK = check(availRes, {
            'availability: status 200': (r) => r.status === 200,
        });
        if (!availOK) {
            errorRate.add(1);
            return;
        }

        let availData;
        try {
            availData = JSON.parse(availRes.body);
        } catch {
            errorRate.add(1);
            return;
        }

        // If ride is sold out, log and skip
        if (availData.soldOut || !availData.availableWindows || availData.availableWindows.length === 0) {
            totalSoldOut.add(1);
            bookingSuccess.add(0);
            return;
        }

        // Step 2: Pick the best available window (prefer early)
        const availWindows = availData.availableWindows.map(w => w.window);
        let selectedWindow = preferredWindow;
        if (!availWindows.includes(selectedWindow)) {
            // Take first available
            selectedWindow = availWindows[0];
        }

        // Human mimicry jitter: 200ms-1500ms think time before booking
        sleep(0.2 + Math.random() * 1.3);

        // Step 3: Book the slot
        const idempotencyKey = `${userId}:${targetRide}:${selectedWindow}`;
        const bookRes = http.post(`${MOCK_DISNEY_URL}/api/v1/book`, JSON.stringify({
            rideId: targetRide,
            window: selectedWindow,
            userId: userId,
            idempotencyKey: idempotencyKey,
        }), { headers: { 'Content-Type': 'application/json' } });
        bookLatency.add(bookRes.timings.duration);
        totalBookings.add(1);

        if (bookRes.status === 503) {
            disneyErrors.add(1);
            errorRate.add(1);
            return;
        }

        if (bookRes.status === 409) {
            // Sold out — check for counter-offer
            let bookData;
            try { bookData = JSON.parse(bookRes.body); } catch { return; }

            totalCounterOffers.add(1);
            counterOfferRate.add(1);

            if (bookData.counterOffer) {
                // Accept counter-offer — book alternative window
                sleep(0.3 + Math.random() * 0.5); // Think time

                const counterRes = http.post(`${MOCK_DISNEY_URL}/api/v1/book`, JSON.stringify({
                    rideId: targetRide,
                    window: bookData.counterOffer.window,
                    userId: userId,
                    idempotencyKey: `${idempotencyKey}:counter`,
                }), { headers: { 'Content-Type': 'application/json' } });

                if (counterRes.status === 201) {
                    bookingSuccess.add(1);
                    // Confirm the counter-offer booking
                    try {
                        const counterData = JSON.parse(counterRes.body);
                        confirmBooking(counterData.booking.id);
                    } catch { /* noop */ }
                } else {
                    bookingSuccess.add(0);
                }
            } else {
                // Fully sold out, no alternative
                bookingSuccess.add(0);
                totalSoldOut.add(1);
            }
            return;
        }

        const bookOK = check(bookRes, {
            'booking: status 201': (r) => r.status === 201,
        });

        if (!bookOK) {
            bookingSuccess.add(0);
            errorRate.add(1);
            return;
        }

        bookingSuccess.add(1);

        // Step 4: Confirm booking (two-phase commit / Atomic Handshake)
        let bookData;
        try { bookData = JSON.parse(bookRes.body); } catch { return; }

        confirmBooking(bookData.booking.id);
    });

    // Think time between iterations
    sleep(0.5 + Math.random());
}

function confirmBooking(bookingId) {
    sleep(0.1 + Math.random() * 0.3); // Brief pause before confirm

    const confirmRes = http.post(`${MOCK_DISNEY_URL}/api/v1/confirm/${bookingId}`);
    confirmLatency.add(confirmRes.timings.duration);

    check(confirmRes, {
        'confirm: status 200': (r) => r.status === 200,
        'confirm: confirmed true': (r) => {
            try { return JSON.parse(r.body).confirmed === true; } catch { return false; }
        },
    });

    if (confirmRes.status === 503) {
        disneyErrors.add(1);
        // Atomic Guarantee: confirmation failed — booking should be rolled back
        // This is EXPECTED behavior — the server handles rollback
    }
}

export function teardown(data) {
    // Get final mock server state
    const stateRes = http.get(`${MOCK_DISNEY_URL}/admin/state`);
    if (stateRes.status === 200) {
        try {
            const state = JSON.parse(stateRes.body);
            console.log(`\n🏰 Mock Disney Final State:`);
            console.log(`   Elapsed: ${state.elapsed}`);
            console.log(`   Bookings: ${state.bookingCount}`);
            console.log(`   Requests: ${state.requestCount}`);
            console.log(`   Errors: ${state.errorCount}`);
        } catch { /* noop */ }
    }
}

export function handleSummary(data) {
    return {
        'load-tests/results/03_ll_rush.json': JSON.stringify(data, null, 2),
        stdout: textSummary(data, { indent: '  ', enableColors: true }),
    };
}

function textSummary(data, opts) {
    // k6 will use its built-in text summary
    return '';
}
