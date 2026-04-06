/**
 * k6 Load Test 2: Auth + Database Read  
 * 
 * Purpose: Test authenticated database reads under concurrent load.
 * Targets: User profiles, ride advisories, ride preferences
 * 
 * Run: k6 run load-tests/02_auth_db_read.js --vus 50 --duration 60s
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';

// ── Custom Metrics ──────────────────────────────────────────────────
const errorRate = new Rate('errors');
const dbReadLatency = new Trend('db_read_latency', true);
const advisoryLatency = new Trend('advisory_latency', true);
const totalReads = new Counter('total_reads');

// ── Configuration ───────────────────────────────────────────────────
const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

export const options = {
    scenarios: {
        db_reads: {
            executor: 'ramping-vus',
            startVUs: 0,
            stages: [
                { duration: '10s', target: 50 },    // Warm up
                { duration: '30s', target: 250 },   // Ramp
                { duration: '30s', target: 500 },   // Peak — 500 concurrent profile reads
                { duration: '10s', target: 0 },      // Cool down
            ],
        },
    },
    thresholds: {
        http_req_duration: ['p(95)<1000', 'p(99)<2000'],
        errors: ['rate<0.02'],  // <2% error rate
        db_read_latency: ['p(95)<800'],
        advisory_latency: ['p(95)<500'],
    },
};

const PARK_IDS = ['MK', 'EP', 'HS', 'AK'];

export default function () {
    const iteration = __ITER;

    // 1. User profiles (paginated)
    const page = (iteration % 10) + 1;
    const usersRes = http.get(`${BASE_URL}/api/admin/users?page=${page}`);
    dbReadLatency.add(usersRes.timings.duration);
    totalReads.add(1);
    check(usersRes, {
        'users: status 200': (r) => r.status === 200,
        'users: has total': (r) => {
            try { return JSON.parse(r.body).total !== undefined; } catch { return false; }
        },
    }) || errorRate.add(1);

    // 2. Ride advisories (all + per park)
    const advisoriesRes = http.get(`${BASE_URL}/api/ride-advisories`);
    advisoryLatency.add(advisoriesRes.timings.duration);
    totalReads.add(1);
    check(advisoriesRes, {
        'advisories: status 200': (r) => r.status === 200,
        'advisories: has data': (r) => {
            try { return JSON.parse(r.body).total > 0; } catch { return false; }
        },
    }) || errorRate.add(1);

    // 3. Ride advisories filtered by park
    const parkId = PARK_IDS[iteration % PARK_IDS.length];
    const parkRes = http.get(`${BASE_URL}/api/ride-advisories?parkId=${parkId}`);
    totalReads.add(1);
    check(parkRes, {
        'park-advisories: status 200': (r) => r.status === 200,
        'park-advisories: correct park': (r) => {
            try {
                const body = JSON.parse(r.body);
                return body.parks && body.parks.includes(parkId);
            } catch { return false; }
        },
    }) || errorRate.add(1);

    // 4. Single ride advisory
    const rideIds = ['MK_TRON', 'MK_7DMT', 'EP_GUARDIANS', 'HS_RISE', 'AK_FLIGHT'];
    const rideId = rideIds[iteration % rideIds.length];
    const rideRes = http.get(`${BASE_URL}/api/ride-advisories/${rideId}`);
    totalReads.add(1);
    check(rideRes, {
        'single-advisory: status 200': (r) => r.status === 200,
        'single-advisory: correct ride': (r) => {
            try { return JSON.parse(r.body).attractionId === rideId || JSON.parse(r.body).attraction_id === rideId; } catch { return false; }
        },
    }) || errorRate.add(1);

    // 5. Feature flags
    const flagsRes = http.get(`${BASE_URL}/api/admin/feature-flags`);
    totalReads.add(1);
    check(flagsRes, {
        'feature-flags: status 200': (r) => r.status === 200,
    }) || errorRate.add(1);

    sleep(0.2); // 200ms think time
}

export function handleSummary(data) {
    return {
        'load-tests/results/02_auth_db_read.json': JSON.stringify(data, null, 2),
    };
}
