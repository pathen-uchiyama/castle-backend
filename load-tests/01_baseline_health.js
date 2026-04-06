/**
 * k6 Load Test 1: Baseline API Health
 * 
 * Purpose: Verify the Castle backend health endpoints respond under load.
 * Target: Castle Production Backend (or staging)
 * 
 * Run: k6 run load-tests/01_baseline_health.js --vus 100 --duration 60s
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

// ── Custom Metrics ──────────────────────────────────────────────────
const errorRate = new Rate('errors');
const healthLatency = new Trend('health_latency', true);

// ── Configuration ───────────────────────────────────────────────────
const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

export const options = {
    scenarios: {
        // Ramp up to 1000 concurrent users checking health
        health_baseline: {
            executor: 'ramping-vus',
            startVUs: 0,
            stages: [
                { duration: '10s', target: 100 },   // Warm up
                { duration: '30s', target: 500 },   // Ramp
                { duration: '30s', target: 1000 },  // Peak
                { duration: '10s', target: 0 },     // Cool down
            ],
        },
    },
    thresholds: {
        http_req_duration: ['p(95)<500', 'p(99)<1000'],  // 95th < 500ms, 99th < 1s
        errors: ['rate<0.01'],                             // <1% error rate
    },
};

export default function () {
    // Health check
    const healthRes = http.get(`${BASE_URL}/api/telemetry`);
    healthLatency.add(healthRes.timings.duration);

    check(healthRes, {
        'health: status 200': (r) => r.status === 200,
        'health: has body': (r) => r.body && r.body.length > 0,
    }) || errorRate.add(1);

    // Disney health check
    const disneyRes = http.get(`${BASE_URL}/api/admin/disney-health`);
    check(disneyRes, {
        'disney-health: status 200': (r) => r.status === 200,
    }) || errorRate.add(1);

    // Circuit breaker health
    const circuitRes = http.get(`${BASE_URL}/api/admin/circuit-health`);
    check(circuitRes, {
        'circuit-health: status 200': (r) => r.status === 200,
    }) || errorRate.add(1);

    // Pool stats
    const poolRes = http.get(`${BASE_URL}/api/skipper/pool-stats`);
    check(poolRes, {
        'pool-stats: status 200': (r) => r.status === 200,
    }) || errorRate.add(1);

    sleep(0.1); // 100ms think time
}

export function handleSummary(data) {
    return {
        'load-tests/results/01_baseline_health.json': JSON.stringify(data, null, 2),
    };
}
