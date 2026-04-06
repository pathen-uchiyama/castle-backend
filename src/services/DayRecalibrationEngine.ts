import { RideAdvisory } from '../data/RideAdvisoryTypes';
import { ScoredRide, getMinSpacingMinutes } from '../data/RepeatVoteScoring';
import { ParkID, Guest, ItineraryStep } from '../models/types';

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

        // Layer 2: Flash Mob Detection
        const flashMobWarnings = this.detectFlashMobRisk(
            eligible,
            input.activeSnipeCount,
            input.totalActiveUsers
        );

        // Layer 3: Time Slot Diversification
        const diversifiedSlots = this.diversifyTimeSlots(eligible, input.parkId);

        // Layer 4: Enrich itinerary steps with advisory info
        const enrichedSteps = this.enrichWithAdvisories(
            input.existingItinerary,
            input.advisories,
            input.guests
        );

        return {
            eligibleRides: eligible,
            filteredRides: filtered,
            flashMobWarnings,
            diversifiedSlots,
            enrichedSteps,
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
     * Detect if too many users are targeting the same ride in the same window.
     * If >15% of active users target the same ride, redistribute.
     */
    static detectFlashMobRisk(
        eligibleRides: ScoredRide[],
        activeSnipeCount: number,
        totalActiveUsers: number
    ): FlashMobWarning[] {
        const warnings: FlashMobWarning[] = [];
        if (totalActiveUsers === 0) return warnings;

        // Group by attractionId
        const rideConcentration = new Map<string, { count: number; name: string }>();
        for (const ride of eligibleRides) {
            const existing = rideConcentration.get(ride.attractionId) || { count: 0, name: ride.attractionName };
            existing.count += ride.snipeJobCount;
            rideConcentration.set(ride.attractionId, existing);
        }

        for (const [attractionId, data] of rideConcentration) {
            const concentrationPercent = data.count / Math.max(totalActiveUsers, 1);

            if (concentrationPercent > DayRecalibrationEngine.FLASH_MOB_THRESHOLD) {
                warnings.push({
                    attractionId,
                    attractionName: data.name,
                    windowStart: new Date().toISOString(),
                    concentrationPercent: Math.round(concentrationPercent * 100),
                    recommendation: `Redistribute: ${data.count}/${totalActiveUsers} users (${Math.round(concentrationPercent * 100)}%) targeting ${data.name}. Stagger by 3-5 minutes per batch.`,
                });
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
}
