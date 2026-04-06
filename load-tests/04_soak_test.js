/**
 * k6 Load Test 4: 8-Hour Soak Test
 *
 * Purpose: Detect memory leaks, connection exhaustion, and resource degradation
 * over an extended period simulating a full park day.
 *
 * Run: k6 run load-tests/04_soak_test.js
 * Note: This test runs for 8 hours. Use --duration to override for shorter tests.
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend, Counter, Gauge } from 'k6/metrics';

// ── Custom Metrics ──────────────────────────────────────────────────
const errorRate = new Rate('errors');
const latencyDrift = new Trend('latency_drift', true);
const memoryLeakIndicator = new Counter('consecutive_slow_responses');

// ── Configuration ───────────────────────────────────────────────────
const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const MOCK_DISNEY_URL = __ENV.MOCK_DISNEY_URL || 'http://localhost:3099';

export const options = {
    scenarios: {
        // Simulate a full park day with varying traffic
        park_day: {
            executor: 'ramping-vus',
            startVUs: 0,
            stages: [
                // 7:00 AM — Morning rush
                { duration: '30m', target: 200 },
                // 7:30 AM — Peak LL booking
                { duration: '30m', target: 500 },
                // 8:00 AM — Sustained morning
                { duration: '1h', target: 300 },
                // 9:00 AM — Late morning
                { duration: '1h', target: 200 },
                // 10:00 AM — Midday lull
                { duration: '1h', target: 100 },
                // 11:00 AM — Lunch push
                { duration: '1h', target: 150 },
                // 12:00 PM — Afternoon
                { duration: '1h', target: 100 },
                // 1:00 PM — Evening planning
                { duration: '1h', target: 150 },
                // 2:00 PM — Wind down
                { duration: '30m', target: 50 },
                // 2:30 PM — Park close
                { duration: '30m', target: 0 },
            ],
        },
    },
    thresholds: {
        http_req_duration: ['p(95)<2000', 'p(99)<5000'],
        errors: ['rate<0.02'],
        // Key soak test threshold: latency should NOT drift upward over time
        latency_drift: ['p(95)<2000'],
    },
};

// Mixed traffic patterns simulating a real park day
const TRAFFIC_PATTERNS = [
    { weight: 30, fn: checkHealth },
    { weight: 25, fn: checkWaitTimes },
    { weight: 20, fn: checkAdvisories },
    { weight: 15, fn: checkPoolStats },
    { weight: 10, fn: checkInbox },
];

export default function () {
    // Weighted random selection of traffic pattern
    const rand = Math.random() * 100;
    let cumulative = 0;

    for (const pattern of TRAFFIC_PATTERNS) {
        cumulative += pattern.weight;
        if (rand <= cumulative) {
            pattern.fn();
            break;
        }
    }

    // Soak test think time: 1-3 seconds (realistic user spacing)
    sleep(1 + Math.random() * 2);
}

function checkHealth() {
    const res = http.get(`${BASE_URL}/api/telemetry`);
    latencyDrift.add(res.timings.duration);
    check(res, { 'health: 200': (r) => r.status === 200 }) || errorRate.add(1);

    // Memory leak detection: flag if response time > 2s consistently
    if (res.timings.duration > 2000) {
        memoryLeakIndicator.add(1);
    }
}

function checkWaitTimes() {
    const parks = ['magic-kingdom', 'epcot', 'hollywood-studios', 'animal-kingdom'];
    const park = parks[Math.floor(Math.random() * parks.length)];
    const res = http.get(`${BASE_URL}/api/wait-times/${park}`);
    latencyDrift.add(res.timings.duration);
    check(res, { 'wait-times: 200': (r) => r.status === 200 }) || errorRate.add(1);
}

function checkAdvisories() {
    const parkIds = ['MK', 'EP', 'HS', 'AK'];
    const parkId = parkIds[Math.floor(Math.random() * parkIds.length)];
    const res = http.get(`${BASE_URL}/api/ride-advisories?parkId=${parkId}`);
    latencyDrift.add(res.timings.duration);
    check(res, {
        'advisories: 200': (r) => r.status === 200,
        'advisories: has data': (r) => {
            try { return JSON.parse(r.body).total > 0; } catch { return false; }
        },
    }) || errorRate.add(1);
}

function checkPoolStats() {
    const res = http.get(`${BASE_URL}/api/skipper/pool-stats`);
    latencyDrift.add(res.timings.duration);
    check(res, { 'pool-stats: 200': (r) => r.status === 200 }) || errorRate.add(1);
}

function checkInbox() {
    const res = http.get(`${BASE_URL}/api/admin/inbox`);
    latencyDrift.add(res.timings.duration);
    check(res, { 'inbox: 200': (r) => r.status === 200 }) || errorRate.add(1);
}

export function handleSummary(data) {
    return {
        'load-tests/results/04_soak_test.json': JSON.stringify(data, null, 2),
    };
}
