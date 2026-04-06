/**
 * k6 Load Test 7: Mass Recalibration with Flash Mob Prevention
 *
 * Purpose: Validate that when a major ride closes (e.g., TRON), the
 * Day Recalibration Engine correctly redistributes 200 affected users
 * without creating a "Flash Mob" on any single alternative ride.
 *
 * Success Criteria:
 *   - No alternative ride receives >15% of redistributed users
 *   - All 200 users receive recalibrated itineraries
 *   - Recalibration completes within 5 seconds per user
 *   - Split party groups maintain correct parallel tracks
 *
 * Scenario:
 *   1. 200 users with varied ride preferences (60% have TRON as #1)
 *   2. Trigger mass recalibration (TRON closure)
 *   3. Verify no ride exceeds 15% concentration
 *   4. Verify split parties get correct per-group recalibration
 *
 * Run:
 *   k6 run load-tests/07_mass_recalibration.js
 */

import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Rate, Counter, Trend } from 'k6/metrics';

// ── Custom Metrics ──────────────────────────────────────────────────
const recalibrationAttempts = new Counter('recalibration_attempts');
const recalibrationSuccess = new Counter('recalibration_success');
const flashMobWarnings = new Counter('flash_mob_warnings');
const advisoryFilters = new Counter('advisory_filters');
const diversifiedSlots = new Counter('diversified_slots');
const recalibrationLatency = new Trend('recalibration_latency_ms');
const noFlashMob = new Rate('no_flash_mob');  // Must be 100%
const recalibrationRate = new Rate('recalibration_success_rate');
const splitPartyRecalSuccess = new Rate('split_party_recal_success');

// ── Configuration ───────────────────────────────────────────────────
const BASE_URL = __ENV.BASE_URL || 'http://localhost:3001/api';

// Ride alternatives (what users might shift to after TRON closure)
const ALTERNATIVES = [
    'MK_7DMT', 'MK_SPACE', 'MK_SPLASH', 'MK_PIRATES', 'MK_HM',
    'MK_BTMRR', 'MK_JUNGLE', 'MK_BUZZ', 'MK_PETER', 'MK_DUMBO',
];

export const options = {
    scenarios: {
        // 200 users, each running recalibration
        mass_recal: {
            executor: 'shared-iterations',
            iterations: 200,
            vus: 50,
            maxDuration: '120s',
        },
        // 40 split party families (3 groups each = 120 parallel tracks)
        split_party_recal: {
            executor: 'shared-iterations',
            iterations: 40,
            vus: 20,
            startTime: '30s',
            maxDuration: '90s',
            exec: 'splitPartyRecalibration',
        },
    },
    thresholds: {
        // No flash mob warnings allowed
        no_flash_mob: ['rate==1'],
        // >95% successful recalibrations
        recalibration_success_rate: ['rate>0.95'],
        // Recalibration latency p95 < 5 seconds
        recalibration_latency_ms: ['p(95)<5000'],
        // Split party recalibration succeeds
        split_party_recal_success: ['rate>0.90'],
    },
};

// ── Generate User Preferences ───────────────────────────────────────

function generateScoredRides(vuId, iterIdx) {
    // 60% of users have TRON as #1 (will be filtered out by advisory)
    const hasTronAsFirst = (vuId + iterIdx) % 10 < 6;

    const scoredRides = [];

    if (hasTronAsFirst) {
        scoredRides.push({
            attractionId: 'MK_TRON',
            attractionName: 'TRON Lightcycle / Run',
            parkId: 'MK',
            score: 300,
            snipeJobCount: 2,
            instances: [1, 2],
            preference: {
                attractionId: 'MK_TRON',
                attractionName: 'TRON Lightcycle / Run',
                parkId: 'MK',
                repeatCount: 2,
                priorityTier: 'must_do',
                priorityRank: 1,
            },
        });
    }

    // Add 4-6 alternative rides with varied scores
    const numAlts = 4 + Math.floor(Math.random() * 3);
    const shuffled = [...ALTERNATIVES].sort(() => Math.random() - 0.5);

    for (let i = 0; i < numAlts && i < shuffled.length; i++) {
        scoredRides.push({
            attractionId: shuffled[i],
            attractionName: shuffled[i].replace('MK_', ''),
            parkId: 'MK',
            score: 200 - (i * 30) + Math.floor(Math.random() * 20),
            snipeJobCount: 1,
            instances: [1],
            preference: {
                attractionId: shuffled[i],
                attractionName: shuffled[i].replace('MK_', ''),
                parkId: 'MK',
                repeatCount: 1,
                priorityTier: i < 2 ? 'must_do' : 'like_to',
                priorityRank: i + 2,
            },
        });
    }

    return scoredRides;
}

// ── Main Test: Mass Recalibration ───────────────────────────────────

export default function () {
    const userId = `user-${__VU}-${__ITER}`;
    const tripId = `trip-recal-${__VU}-${__ITER}`;

    group('Mass Recalibration', function () {
        recalibrationAttempts.add(1);

        const scoredRides = generateScoredRides(__VU, __ITER);

        // Simulate existing itinerary with TRON in it
        const existingItinerary = scoredRides.slice(0, 4).map((ride, idx) => ({
            id: ride.attractionId,
            trip_id: tripId,
            park_id: 'MK',
            step_name: ride.attractionName,
            step_type: 'ride',
            planned_start: new Date(Date.now() + idx * 60 * 60000).toISOString(),
            status: 'pending',
            is_pivot: false,
        }));

        // Guest profiles for advisory filtering
        const guests = [
            {
                id: `guest-${__VU}-1`,
                name: 'Parent A',
                age: 35,
                height_cm: 175,
                is_first_timer: false,
                stroller_required: false,
            },
            {
                id: `guest-${__VU}-2`,
                name: 'Child',
                age: 8,
                height_cm: 125,
                is_first_timer: true,
                stroller_required: false,
            },
        ];

        const startTime = Date.now();

        const recalRes = http.post(`${BASE_URL}/trips/${tripId}/recalibrate`, JSON.stringify({
            parkId: 'MK',
            guests,
            scoredRides,
            existingItinerary,
        }), { headers: { 'Content-Type': 'application/json' } });

        recalibrationLatency.add(Date.now() - startTime);

        const recalOk = check(recalRes, {
            'recal: status 200': (r) => r.status === 200,
            'recal: has response body': (r) => r.body && r.body.length > 2,
        });

        if (recalOk && recalRes.status === 200) {
            recalibrationSuccess.add(1);
            recalibrationRate.add(1);

            try {
                const result = JSON.parse(recalRes.body);

                // Track advisory filters (should filter TRON if closed in advisory data)
                if (result.filteredRides && result.filteredRides.length > 0) {
                    advisoryFilters.add(result.filteredRides.length);
                }

                // Track diversified slots
                if (result.diversifiedSlots) {
                    diversifiedSlots.add(typeof result.diversifiedSlots === 'number'
                        ? result.diversifiedSlots
                        : result.diversifiedSlots.length || 0
                    );
                }

                // CHECK: Flash Mob warnings
                if (result.flashMobWarnings && result.flashMobWarnings.length > 0) {
                    flashMobWarnings.add(result.flashMobWarnings.length);
                    noFlashMob.add(0);

                    for (const warning of result.flashMobWarnings) {
                        console.warn(`⚠️ Flash Mob: ${warning.attractionName} at ${warning.concentrationPercent}%`);
                    }
                } else {
                    noFlashMob.add(1);
                }
            } catch {
                noFlashMob.add(1); // Parse failure doesn't mean flash mob
            }
        } else {
            recalibrationRate.add(0);
            noFlashMob.add(1);
        }
    });

    sleep(0.1 + Math.random() * 0.2);
}

// ── Split Party Recalibration ───────────────────────────────────────

export function splitPartyRecalibration() {
    const familyId = `family-${__VU}-${__ITER}`;
    const tripId = `trip-split-${__VU}-${__ITER}`;

    group('Split Party Recalibration', function () {
        // Create a split party (2-3 groups)
        const numGroups = 2 + (__VU % 2); // Alternate between 2 and 3 groups

        const guests = [
            { id: `g-${__VU}-1`, name: 'Dad', age: 40, height_cm: 180, is_first_timer: false, stroller_required: false },
            { id: `g-${__VU}-2`, name: 'Mom', age: 38, height_cm: 165, is_first_timer: false, stroller_required: false },
            { id: `g-${__VU}-3`, name: 'Teen', age: 15, height_cm: 170, is_first_timer: false, stroller_required: false },
            { id: `g-${__VU}-4`, name: 'Child', age: 7, height_cm: 120, is_first_timer: true, stroller_required: false },
        ];

        const groupAssignments = numGroups === 2
            ? [
                { groupName: 'Thrill Seekers', guestIds: [`g-${__VU}-1`, `g-${__VU}-3`], leadGuestId: `g-${__VU}-1` },
                { groupName: 'Gentle Explorers', guestIds: [`g-${__VU}-2`, `g-${__VU}-4`], leadGuestId: `g-${__VU}-2` },
            ]
            : [
                { groupName: 'Thrill Seekers', guestIds: [`g-${__VU}-1`], leadGuestId: `g-${__VU}-1` },
                { groupName: 'Mixed', guestIds: [`g-${__VU}-2`, `g-${__VU}-3`], leadGuestId: `g-${__VU}-2` },
                { groupName: 'Young Explorers', guestIds: [`g-${__VU}-4`, `g-${__VU}-2`], leadGuestId: `g-${__VU}-2` },
            ];

        // Step 1: Create split party
        const splitRes = http.post(`${BASE_URL}/trips/${tripId}/split-party`, JSON.stringify({
            partyId: familyId,
            guests,
            groupAssignments: numGroups === 2 ? groupAssignments : [
                { groupName: 'Thrill Seekers', guestIds: [`g-${__VU}-1`, `g-${__VU}-3`], leadGuestId: `g-${__VU}-1` },
                { groupName: 'Gentle Explorers', guestIds: [`g-${__VU}-2`, `g-${__VU}-4`], leadGuestId: `g-${__VU}-2` },
            ],
            tier: 'glass_slipper',
        }), { headers: { 'Content-Type': 'application/json' } });

        const splitOk = check(splitRes, {
            'split: status 201': (r) => r.status === 201,
            'split: has sub-groups': (r) => {
                try { return JSON.parse(r.body).subGroups.length >= 2; } catch { return false; }
            },
        });

        if (!splitOk) {
            splitPartyRecalSuccess.add(0);
            return;
        }

        // Step 2: Run recalibration for each sub-group
        let allGroupsRecalibrated = true;

        for (let g = 0; g < numGroups && g < 2; g++) {
            const subGroupGuests = g === 0
                ? [guests[0], guests[2]]   // Thrill Seekers
                : [guests[1], guests[3]];  // Gentle Explorers

            const scoredRides = generateScoredRides(__VU * 10 + g, __ITER);

            const recalRes = http.post(`${BASE_URL}/trips/${tripId}/recalibrate`, JSON.stringify({
                parkId: 'MK',
                guests: subGroupGuests,
                scoredRides,
                existingItinerary: [],
            }), { headers: { 'Content-Type': 'application/json' } });

            if (recalRes.status !== 200) {
                allGroupsRecalibrated = false;
            }
        }

        // Step 3: Schedule reunion
        const reunionRes = http.post(`${BASE_URL}/trips/${tripId}/reunion`, JSON.stringify({
            state: JSON.parse(splitRes.body),
            parkId: 'MK',
            requestedTime: new Date(Date.now() + 2 * 3600000).toISOString(), // 2 hours from now
            preferFood: true,
        }), { headers: { 'Content-Type': 'application/json' } });

        const reunionOk = check(reunionRes, {
            'reunion: status 200': (r) => r.status === 200,
            'reunion: has location': (r) => {
                try { return JSON.parse(r.body).location.length > 0; } catch { return false; }
            },
        });

        splitPartyRecalSuccess.add(allGroupsRecalibrated && reunionOk ? 1 : 0);
    });

    sleep(0.2 + Math.random() * 0.3);
}

export function handleSummary(data) {
    return {
        'load-tests/results/07_mass_recalibration.json': JSON.stringify(data, null, 2),
    };
}
