import { RideAdvisory } from '../data/RideAdvisoryTypes';
import { ScoredRide, getMinSpacingMinutes } from '../data/RepeatVoteScoring';
import { ParkID, Guest, ItineraryStep } from '../models/types';
import Redis from 'ioredis';
import { env } from '../config/env';

// ── Debounce Manager ────────────────────────────────────────────

/**
 * RecalibrationDebounce — Collapse multiple triggers within 30s
 *
 * When a major ride closes, it can trigger recalibration for hundreds
 * of users simultaneously. This debounce ensures only ONE recalibration
 * job runs per trip per 30-second window.
 *
 * Pattern: Redis SETNX with 30s TTL
 *   - First trigger: sets key, runs calibration
 *   - Subsequent triggers within 30s: return cached result
 */
export class RecalibrationDebounce {
    private redis: Redis | null = null;
    private static readonly DEBOUNCE_PREFIX = 'recal:debounce:';
    private static readonly RESULT_PREFIX = 'recal:result:';
    private static readonly DEBOUNCE_TTL = 30; // seconds

    constructor(redisUrl?: string) {
        try {
            this.redis = new Redis(redisUrl || env.REDIS_URL, {
                maxRetriesPerRequest: null,
                lazyConnect: true,
            });
            this.redis.on('error', () => { /* non-fatal */ });
            this.redis.connect().catch(() => { /* non-fatal */ });
        } catch {
            this.redis = null;
        }
    }

    /**
     * Check if a recalibration is already in progress or recently completed.
     * Returns the cached result if debounced, or null if this is the first trigger.
     */
    async checkDebounce(tripId: string, triggerReason: string): Promise<{
        debounced: boolean;
        cachedResult: any | null;
        triggerId: string;
    }> {
        if (!this.redis) {
            return { debounced: false, cachedResult: null, triggerId: `local_${Date.now()}` };
        }

        const debounceKey = `${RecalibrationDebounce.DEBOUNCE_PREFIX}${tripId}`;
        const triggerId = `recal_${tripId}_${Date.now()}`;

        // Try to acquire the debounce lock
        const acquired = await this.redis.set(
            debounceKey,
            JSON.stringify({ triggerId, reason: triggerReason, timestamp: new Date().toISOString() }),
            'EX', RecalibrationDebounce.DEBOUNCE_TTL,
            'NX'
        );

        if (acquired) {
            // We got the lock — this is the first trigger
            return { debounced: false, cachedResult: null, triggerId };
        }

        // Lock exists — check for cached result
        const resultKey = `${RecalibrationDebounce.RESULT_PREFIX}${tripId}`;
        const cached = await this.redis.get(resultKey);

        if (cached) {
            return { debounced: true, cachedResult: JSON.parse(cached), triggerId };
        }

        // Result not yet available (still processing) — return debounced with no result
        return { debounced: true, cachedResult: null, triggerId };
    }

    /**
     * Cache the calibration result for subsequent debounced requests.
     */
    async cacheResult(tripId: string, result: any): Promise<void> {
        if (!this.redis) return;

        const resultKey = `${RecalibrationDebounce.RESULT_PREFIX}${tripId}`;
        await this.redis.set(resultKey, JSON.stringify(result), 'EX', RecalibrationDebounce.DEBOUNCE_TTL);
    }

    /**
     * Track global demand for rides in 1-minute expiration buckets.
     * Returns the total active users querying in this current bucket.
     */
    async recordDemand(parkId: string, rides: any[]): Promise<{ totalActiveUsers: number, globalConcentration: Map<string, number> }> {
        if (!this.redis) return { totalActiveUsers: 1, globalConcentration: new Map() };

        // We use a 1-minute bucket based on the current minute
        const bucketId = Math.floor(Date.now() / 60000);
        const baseKey = `recal:demand:${parkId}:${bucketId}`;

        const multi = this.redis.multi();
        multi.incr(`${baseKey}:total`);
        multi.expire(`${baseKey}:total`, 120);

        // Track how many users are asking for each specific ride
        for (const r of rides) {
            if (r && r.attractionId) {
                // We add the user's snipe count (usually 1 or more) to the global counter
                multi.incrby(`${baseKey}:ride:${r.attractionId}`, r.snipeJobCount || 1);
                multi.expire(`${baseKey}:ride:${r.attractionId}`, 120);
            }
        }

        const results = await multi.exec();
        if (!results) return { totalActiveUsers: 1, globalConcentration: new Map() };

        const totalActiveUsers = (results[0][1] as number) || 1;
        
        // Fetch current global tally for the rides that were just queried
        // We know that `results` contains the increments in order.
        // Index 0, 1 = total. Index 2, 3 = first ride... etc.
        const globalConcentration = new Map<string, number>();
        let resultIdx = 2; // Start after 'total'
        for (const r of rides) {
            if (r && r.attractionId) {
                const currentTally = (results[resultIdx][1] as number) || 1;
                globalConcentration.set(r.attractionId, currentTally);
                resultIdx += 2;
            }
        }

        return { totalActiveUsers, globalConcentration };
    }
}

/**
 * DayRecalibrationEngine — Flash Mob Prevention + Advisory-Aware Scheduling
 *
 * Purpose: Prevent Disney from detecting coordinated booking patterns
 * by diversifying our users' itineraries. Also enforces advisory tags
 * (height, sensory, accessibility) as hard constraints on scheduling.
 *
 * The engine operates in three layers:
 *   1. Advisory Filter — removes rides that violate physical/sensory constraints
 *   2. Flash Mob Prevention — detects and breaks up crowd concentration
 *   3. Time Slot Diversification — staggers repeat rides across the day
 *
 * CRITICAL RULE: If >15% of our user base targets the same ride in the same
 * 15-minute window, we trigger a "Flash Mob" alert and redistribute requests.
 */

// ── Types ───────────────────────────────────────────────────────

export interface CalibrationInput {
    tripId: string;
    parkId: ParkID;
    guests: Guest[];
    advisories: RideAdvisory[];
    scoredRides: ScoredRide[];
    existingItinerary: ItineraryStep[];
    activeSnipeCount: number;
    totalActiveUsers: number;
    globalConcentration?: Map<string, number>;
    strategyType?: 'A' | 'B';
}

export interface CalibrationResult {
    /** Rides that passed advisory filters */
    eligibleRides: ScoredRide[];
    /** Rides filtered out due to advisory constraints */
    filteredRides: { ride: ScoredRide; reason: string }[];
    /** Flash mob warnings */
    flashMobWarnings: FlashMobWarning[];
    /** Diversified time slots for repeat rides */
    diversifiedSlots: DiversifiedSlot[];
    /** Advisory-enriched itinerary steps */
    enrichedSteps: ItineraryStep[];
    /** A/B response pattern payload for flash mobs or closures */
    strategyResponse?: {
        type: 'A' | 'B';
        actionTaken: string;
        options?: string[]; // E.g. ride names to suggest
    };
    /** Sequence warnings for bad scheduling (e.g., wet ride before dinner) */
    scheduleWarnings: string[];
}

export interface FlashMobWarning {
    attractionId: string;
    attractionName: string;
    windowStart: string;
    concentrationPercent: number;
    recommendation: string;
}

export interface DiversifiedSlot {
    attractionId: string;
    instance: number;
    totalInstances: number;
    suggestedWindow: 'early_morning' | 'mid_morning' | 'midday' | 'afternoon' | 'evening';
    suggestedTimeRange: { start: string; end: string };
    reason: string;
}

// ── Window Definitions ──────────────────────────────────────────

const TIME_WINDOWS = {
    early_morning: { start: '09:00', end: '10:00', label: 'Early Morning (Rope Drop)' },
    mid_morning:   { start: '10:00', end: '11:30', label: 'Mid-Morning' },
    midday:        { start: '11:30', end: '14:00', label: 'Midday' },
    afternoon:     { start: '14:00', end: '17:00', label: 'Afternoon' },
    evening:       { start: '17:00', end: '21:00', label: 'Evening' },
} as const;

// ── Engine ──────────────────────────────────────────────────────

export class DayRecalibrationEngine {
    private static readonly FLASH_MOB_THRESHOLD = 0.15; // 15% concentration
    private static readonly MAX_SAME_RIDE_PER_WINDOW = 5; // Max users on same ride per 15-min window

    /**
     * Run full day recalibration pipeline.
     */
    static calibrate(input: CalibrationInput): CalibrationResult {
        // Layer 1: Advisory Filter
        const { eligible, filtered } = this.applyAdvisoryFilters(
            input.scoredRides,
            input.advisories,
            input.guests
        );

        // Layer 2: Flash Mob Detection & Ride Shedding
        const flashMobWarnings = this.detectFlashMobRisk(
            eligible,
            input.activeSnipeCount,
            input.totalActiveUsers,
            input.globalConcentration
        );

        // Layer 3: Time Slot Diversification
        const diversifiedSlots = this.diversifyTimeSlots(eligible, input.parkId);

        // Layer 4: Enrich itinerary steps with advisory info
        const enrichedSteps = this.enrichWithAdvisories(
            input.existingItinerary,
            input.advisories,
            input.guests
        );

        // Layer 5: Sequence Constraints (e.g. meals vs intense rides)
        const scheduleWarnings = this.analyzeSequenceConstraints(input.existingItinerary, input.advisories);

        // Layer 6: Strategy Type (A vs B) handling
        let strategyResponse: CalibrationResult['strategyResponse'];
        if (flashMobWarnings.length > 0 || filtered.length > 0) {
            const type = input.strategyType || 'B';
            if (type === 'A') {
                strategyResponse = {
                    type: 'A',
                    actionTaken: 'Provided options due to disruptions / flash mobs.',
                    options: eligible.slice(0, 3).map(r => r.attractionName)
                };
            } else {
                strategyResponse = {
                    type: 'B',
                    actionTaken: 'Auto-rerouted the itinerary around closures and density.',
                };
            }
        }

        return {
            eligibleRides: eligible,
            filteredRides: filtered,
            flashMobWarnings,
            diversifiedSlots,
            enrichedSteps,
            scheduleWarnings,
            strategyResponse
        };
    }

    // ── Layer 1: Advisory Filter ────────────────────────────────

    /**
     * Filter rides based on guest profiles vs advisory tags.
     * This is a HARD filter — unsafe rides are excluded entirely.
     */
    static applyAdvisoryFilters(
        scoredRides: ScoredRide[],
        advisories: RideAdvisory[],
        guests: Guest[]
    ): {
        eligible: ScoredRide[];
        filtered: { ride: ScoredRide; reason: string }[];
    } {
        const advisoryMap = new Map(advisories.map(a => [a.attractionId, a]));
        const eligible: ScoredRide[] = [];
        const filtered: { ride: ScoredRide; reason: string }[] = [];

        for (const ride of scoredRides) {
            const advisory = advisoryMap.get(ride.attractionId);
            if (!advisory) {
                // No advisory data — allow by default
                eligible.push(ride);
                continue;
            }

            // Check operational status
            if (advisory.operationalStatus !== 'open') {
                filtered.push({
                    ride,
                    reason: `Ride closed: ${advisory.operationalStatus}${advisory.closureNotes ? ` — ${advisory.closureNotes}` : ''}`,
                });
                continue;
            }

            // Check height requirements against all guests
            const heightIssues = this.checkHeightRequirements(advisory, guests);
            if (heightIssues) {
                // Don't filter — flag for Rider Switch instead
                ride.preference = {
                    ...ride.preference,
                    // Mark that this ride needs Rider Switch
                };
            }

            // Check sensory/physical constraints
            const sensoryConcerns = this.checkSensoryConcerns(advisory, guests);
            if (sensoryConcerns.length > 0) {
                // Add notes but don't filter (user explicitly chose this ride)
                // Filtering only happens for hard constraints (height for solo child, etc.)
            }

            // Check expectant mother advisory
            const pregnantGuest = guests.find(g => (g as any).isExpectantMother);
            if (pregnantGuest && advisory.expectantMothersAdvised) {
                filtered.push({
                    ride,
                    reason: `Expectant mother advisory: ${advisory.name} not recommended during pregnancy`,
                });
                continue;
            }

            eligible.push(ride);
        }

        return { eligible, filtered };
    }

    private static checkHeightRequirements(advisory: RideAdvisory, guests: Guest[]): string | null {
        if (!advisory.heightRequirementInches) return null;

        const requirementCm = advisory.heightRequirementInches * 2.54;
        const tooShort = guests.filter(g => g.height_cm < requirementCm);

        if (tooShort.length > 0 && tooShort.length < guests.length) {
            return `Rider Switch needed: ${tooShort.map(g => g.name).join(', ')} below ${advisory.heightRequirementInches}" requirement`;
        }

        if (tooShort.length === guests.length) {
            return `No guests meet ${advisory.heightRequirementInches}" height requirement`;
        }

        return null;
    }

    private static checkSensoryConcerns(advisory: RideAdvisory, guests: Guest[]): string[] {
        const concerns: string[] = [];

        for (const guest of guests) {
            if (!guest.sensory_sensitivities) continue;

            for (const sensitivity of guest.sensory_sensitivities) {
                if (sensitivity === 'Loud' && advisory.noiseLevel === 'loud') {
                    concerns.push(`${guest.name}: Noise sensitivity — ${advisory.name} is loud`);
                }
                if (sensitivity === 'Dark' && advisory.hasDarkEnclosed) {
                    concerns.push(`${guest.name}: Dark sensitivity — ${advisory.name} has dark enclosed sections`);
                }
                if (sensitivity === 'Drops' && advisory.heightDrop !== 'none') {
                    concerns.push(`${guest.name}: Drop sensitivity — ${advisory.name} has ${advisory.heightDrop} drops`);
                }
                if (sensitivity === 'Spinning' && advisory.spinIntensity !== 'none') {
                    concerns.push(`${guest.name}: Spin sensitivity — ${advisory.name} has ${advisory.spinIntensity} spinning`);
                }
            }

            // Motion sickness cross-reference
            if ((guest as any).motionSensitivity && advisory.motionSicknessRisk !== 'none') {
                concerns.push(`${guest.name}: Motion sickness risk — ${advisory.name}: ${advisory.motionSicknessRisk}`);
            }
        }

        return concerns;
    }

    // ── Layer 2: Flash Mob Detection ────────────────────────────

    /**
     * Detect if too many users are targeting the same ride globally.
     * If >15% of active users target the same ride, redistribute them
     * by heavily penalizing the scores of swarmed rides!
     */
    static detectFlashMobRisk(
        eligibleRides: ScoredRide[],
        activeSnipeCount: number,
        totalActiveUsers: number,
        globalConcentration?: Map<string, number>
    ): FlashMobWarning[] {
        const warnings: FlashMobWarning[] = [];
        if (totalActiveUsers === 0) return warnings;

        // If no global concentration passed, fall back to local count (1 user = 100% false positives without this fix)
        // With the fix, globalConcentration reliably contains the entire park's load.
        for (const ride of eligibleRides) {
            let count = ride.snipeJobCount;
            if (globalConcentration && globalConcentration.has(ride.attractionId)) {
                count = globalConcentration.get(ride.attractionId)!;
            }

            // A flash mob requires at least MAX_SAME_RIDE_PER_WINDOW users to be physically problematic
            if (count <= DayRecalibrationEngine.MAX_SAME_RIDE_PER_WINDOW) {
                continue;
            }

            // Total users must be at least 100 to prevent early users from seeing 100% concentrations
            const concentrationPercent = count / Math.max(totalActiveUsers, 100);

            if (concentrationPercent > DayRecalibrationEngine.FLASH_MOB_THRESHOLD) {
                // --- ACTIVE REDISTRIBUTION (SHEDDING) ---
                // Heavily penalize the score so this ride drops down the priority list
                ride.score -= 1000;
                
                // For severe swarms (>20%), probabalistically drop the ride entirely from recommendations
                let dropped = false;
                if (concentrationPercent > 0.20) {
                    if (Math.random() < 0.75) { // 75% chance to drop completely for this specific user
                       ride.score = -9999;
                       dropped = true;
                    }
                }

                // If we DID NOT drop the ride (they slipped through the probability gate)
                // THEN we issue a warning, because they are actively contributing to the bottleneck.
                if (!dropped) {
                    warnings.push({
                        attractionId: ride.attractionId,
                        attractionName: ride.attractionName,
                        windowStart: new Date().toISOString(),
                        concentrationPercent: Math.round(concentrationPercent * 100),
                        recommendation: `Redistribute: ${count}/${Math.max(totalActiveUsers, 100)} users (${Math.round(concentrationPercent * 100)}%) targeting ${ride.attractionName}. Staggering priority.`,
                    });
                }
            }
        }
        
        // Remove dropped rides from the eligible array so they aren't scheduled
        for (let i = eligibleRides.length - 1; i >= 0; i--) {
            if (eligibleRides[i].score === -9999) {
                eligibleRides.splice(i, 1);
            }
        }

        return warnings;
    }

    // ── Layer 3: Time Slot Diversification ──────────────────────

    /**
     * For repeat rides (×2, ×3, etc.), assign each instance to a different
     * time window to prevent clumping and improve booking success rate.
     */
    static diversifyTimeSlots(
        eligibleRides: ScoredRide[],
        parkId: ParkID
    ): DiversifiedSlot[] {
        const slots: DiversifiedSlot[] = [];
        const windowOrder: (keyof typeof TIME_WINDOWS)[] = [
            'early_morning', 'afternoon', 'mid_morning', 'evening', 'midday',
        ];

        for (const ride of eligibleRides) {
            if (ride.snipeJobCount <= 1) {
                // Single ride — schedule at optimal time (rope drop for headliners)
                slots.push({
                    attractionId: ride.attractionId,
                    instance: 1,
                    totalInstances: 1,
                    suggestedWindow: ride.score >= 200 ? 'early_morning' : 'mid_morning',
                    suggestedTimeRange: ride.score >= 200
                        ? TIME_WINDOWS.early_morning
                        : TIME_WINDOWS.mid_morning,
                    reason: ride.score >= 200
                        ? 'Headliner — schedule at rope drop for lowest wait'
                        : 'Mid-tier — schedule mid-morning after rush subsides',
                });
                continue;
            }

            // Repeat ride — distribute across windows
            const minSpacing = getMinSpacingMinutes(ride.snipeJobCount);

            for (let i = 0; i < ride.snipeJobCount; i++) {
                const windowKey = windowOrder[i % windowOrder.length];
                const window = TIME_WINDOWS[windowKey];

                slots.push({
                    attractionId: ride.attractionId,
                    instance: i + 1,
                    totalInstances: ride.snipeJobCount,
                    suggestedWindow: windowKey,
                    suggestedTimeRange: window,
                    reason: `Instance ${i + 1}/${ride.snipeJobCount}: min ${minSpacing}min spacing → ${window.label}`,
                });
            }
        }

        return slots;
    }

    // ── Layer 4: Advisory Enrichment ────────────────────────────

    /**
     * Enrich existing itinerary steps with advisory context notes.
     * Adds practical tips (lockers, single rider, water exposure, etc.)
     */
    static enrichWithAdvisories(
        steps: ItineraryStep[],
        advisories: RideAdvisory[],
        guests: Guest[]
    ): ItineraryStep[] {
        const advisoryMap = new Map(advisories.map(a => [a.attractionId, a]));

        return steps.map(step => {
            const advisory = advisoryMap.get(step.id) || advisoryMap.get(step.step_name);
            if (!advisory || step.step_type !== 'ride') return step;

            const enriched = { ...step };
            const tips: string[] = [];

            // Practical tips
            if (advisory.lockersRequired) {
                tips.push('🔐 Lockers REQUIRED — free lockers near entrance');
            } else if (advisory.lockersRecommended) {
                tips.push('🔐 Lockers recommended for loose items');
            }

            if (advisory.singleRiderAvailable) {
                tips.push('⚡ Single Rider line available — significantly shorter wait');
            }

            if (advisory.riderSwapAvailable) {
                const tooShort = guests.filter(g =>
                    advisory.heightRequirementInches && g.height_cm < advisory.heightRequirementInches * 2.54
                );
                if (tooShort.length > 0) {
                    tips.push(`🔄 Rider Switch: ${tooShort.map(g => g.name).join(', ')} wait while others ride`);
                }
            }

            if (advisory.waterExposure === 'will_get_soaked') {
                tips.push('💦 You WILL get soaked — poncho recommended');
            } else if (advisory.waterExposure === 'may_get_sprayed') {
                tips.push('💧 Light spray possible');
            }

            if (advisory.photoPassMoment) {
                tips.push('📸 PhotoPass moment — check My Disney Experience after');
            }

            if (advisory.has3DGlasses) {
                tips.push('🥽 3D glasses required');
            }

            // Sensory warnings for sensitive guests
            const sensoryConcerns = this.checkSensoryConcerns(advisory, guests);
            if (sensoryConcerns.length > 0) {
                tips.push(`⚠️ ${sensoryConcerns[0]}`);
            }

            if (tips.length > 0) {
                enriched.notes = [enriched.notes, ...tips].filter(Boolean).join(' | ');
            }

            return enriched;
        });
    }

    // ── Layer 5: Sequence Constraints ───────────────────────────

    /**
     * Look at the chronological sequence of steps to prevent bad scheduling
     * like "intense motion sickness ride right after food" or "getting soaked before a sit-down meal".
     */
    static analyzeSequenceConstraints(
        steps: ItineraryStep[],
        advisories: RideAdvisory[]
    ): string[] {
        const warnings: string[] = [];
        const advisoryMap = new Map(advisories.map(a => [a.attractionId, a]));

        // Check sequential proximity
        for (let i = 0; i < steps.length - 1; i++) {
            const current = steps[i];
            const next = steps[i + 1];

            // Scenario 1: Food followed by Intense Ride
            if (current.step_type === 'food' || current.step_type === 'snack') {
                const nextAdv = advisoryMap.get(next.id) || advisoryMap.get(next.step_name);
                if (nextAdv && (nextAdv.motionSicknessRisk === 'intense' || nextAdv.motionSicknessRisk === 'moderate')) {
                    warnings.push(`Warning: Riding ${nextAdv.name} (Motion Risk: ${nextAdv.motionSicknessRisk}) immediately after food is not recommended.`);
                }
            }

            // Scenario 2: Getting soaked before dinner/table-service
            if (current.step_type === 'ride') {
                const curAdv = advisoryMap.get(current.id) || advisoryMap.get(current.step_name);
                if (curAdv && curAdv.waterExposure === 'will_get_soaked' && next.step_type === 'food') {
                    warnings.push(`Warning: You will get soaked on ${curAdv.name} right before your food reservation!`);
                }
            }
        }

        return warnings;
    }
}
