import { ItineraryStep, Guest, Preference, ResortID, Ride, ParkID } from '../models/types';
import { PARK_RULES } from '../data/ParkRules';

export class ItineraryProcessor {
    static injectLogisticalShadows(
        itinerary: ItineraryStep[],
        guests: Guest[],
        tripType: 'family' | 'adults' | 'solo' = 'family',
        napStrategy: 'power' | 'nap' | 'quiet' = 'power',
        staminaLevel: number = 5,
        resortId: ResortID = 'WDW',
        adventureStartTime?: string
    ): ItineraryStep[] {
        const rules = PARK_RULES[resortId];
        const processed: ItineraryStep[] = [];
        const hasStroller = guests.some(g => g.stroller_required);
        const youngestAge = guests.length > 0 ? Math.min(...guests.map(g => g.age)) : 18;
        const isFamilyTrip = tripType === 'family';

        let lastBioBreakTime = adventureStartTime ? new Date(adventureStartTime).getTime() : new Date(itinerary[0]?.planned_start || Date.now()).getTime();
        let midDayBreakInjected = false;
        let lastParkId: ParkID | null = null;

        itinerary.forEach((step, index) => {
            const currentTime = new Date(step.planned_start).getTime();
            const currentHour = new Date(step.planned_start).getHours();
            const stepCopy = { ...step };

            // 0. Mid-day Nap Injection (Logistical Necessity)
            if (napStrategy === 'nap' && !midDayBreakInjected && currentHour >= 12 && currentHour <= 14) {
                processed.push({
                    id: `mid_day_nap_${index}`,
                    trip_id: step.trip_id,
                    park_id: step.park_id,
                    step_name: 'Mid-Day Hotel Nap (Sanity Check)',
                    step_type: 'break',
                    planned_start: new Date(currentTime).toISOString(),
                    status: 'pending',
                    is_pivot: true,
                    notes: "Strategic Buffer: ~2.5 hours reserved for travel and rest as requested by the Parent-Centric Plan."
                } as ItineraryStep);
                midDayBreakInjected = true;
            }

            // 0.5 transport buffer based on park rules vs same-park transit
            const staminaMultiplier = staminaLevel <= 3 ? 2 : 1;
            const sameParkTransit = 3 * staminaMultiplier;
            const resortTransport = rules.transport_buffer_mins;

            // Logic: If same park as last step, use 3m. If different, use rule (45m).
            const isSamePark = !lastParkId || lastParkId === step.park_id;
            const baseTransit = isSamePark ? sameParkTransit : resortTransport;

            // 1. Forced Bio-Break Injection (Every 3 hours)
            const BIO_BREAK_INTERVAL = 3 * 60 * 60 * 1000; // 3 Hours
            if (isFamilyTrip && (currentTime - lastBioBreakTime >= BIO_BREAK_INTERVAL)) {
                processed.push({
                    id: `bio_break_${index}`,
                    trip_id: step.trip_id,
                    park_id: step.park_id,
                    step_name: youngestAge < 3 ? 'Baby Care Center (Safe Harbor)' : 'Bio-Break',
                    step_type: 'break',
                    planned_start: new Date(currentTime - 10 * 60000).toISOString(),
                    status: 'pending',
                    is_pivot: true,
                    duration_mins: 10,
                    notes: `Invisible Itinerary: Mandatory 10m bio-break (3h threshold met).`
                } as ItineraryStep);
                lastBioBreakTime = currentTime;
            }

            // 2. Parade Pathing Penalty (+20m when crossing paths)
            const hasParadePenalty = ItineraryProcessor.checkParadeConflict(stepCopy.park_id, stepCopy.planned_start);
            const paradePenalty = hasParadePenalty ? 20 : 0;

            // 3. Logistical Shadow Calculation
            // Shadows include: Base Transit + Parade
            // Stroller buffers are handled separately in extra_buffers
            let shadowMins = baseTransit + paradePenalty;

            if (isFamilyTrip && hasStroller && (stepCopy.step_type === 'ride' || stepCopy.step_type === 'show')) {
                // If it's a ride/show, it needs stroller parking/retrieval
                stepCopy.extra_buffers = {
                    pre: 5 * staminaMultiplier,
                    post: 5 * staminaMultiplier
                };
            }

            stepCopy.logistical_shadow = shadowMins;

            // 4. Sensory Recovery Buffers / Quiet Time Injection
            const hasSensoryTrigger = (stepCopy.intensity === 'High' || stepCopy.sensory_tags?.some(tag => ['Loud', 'Dark', 'Drops'].includes(tag)));
            const needsRecovery = guests.some(g => g.sensory_sensitivities && g.sensory_sensitivities.length > 0);

            if (hasSensoryTrigger && needsRecovery) {
                stepCopy.recovery_buffer = 15;
                stepCopy.notes = (stepCopy.notes || '') + " [Sensory Load Detected]";
            }

            processed.push(stepCopy);

            // Inject separate Quiet Time break if recovery buffer is set
            if (stepCopy.recovery_buffer) {
                processed.push({
                    id: `quiet_time_${index}`,
                    trip_id: step.trip_id,
                    park_id: step.park_id,
                    step_name: 'Quiet Time Recovery (Sensory Sanctuary)',
                    step_type: 'break',
                    planned_start: new Date(currentTime + 45 * 60000).toISOString(), // Mock offset
                    status: 'pending',
                    is_pivot: true,
                    duration_mins: 15,
                    notes: "Refined Strategy: 15m reserved for sensory decompression after high-intensity experience."
                } as ItineraryStep);
            }
            lastParkId = step.park_id;
        });

        return processed;
    }

    static checkParadeConflict(parkId: string, time: string): boolean {
        const hour = new Date(time).getHours();
        const mins = new Date(time).getMinutes();
        // Mock: Festival of Fantasy at 12:00 PM and 3:00 PM (WDW)
        if (parkId === 'MK' || parkId === 'WDW') { // Support both labels
            const isNoonParade = (hour === 12 && mins <= 45);
            const isThreeParade = (hour === 15 && mins <= 45);
            return isNoonParade || isThreeParade;
        }
        return false;
    }

    static validateParadePathingObstacle(
        currentLocation: string,
        targetLocation: string,
        isParadeActive: boolean
    ): string | null {
        // High-level cross-park check
        const isCrossPark = (currentLocation === 'Frontierland' && targetLocation === 'Tomorrowland') ||
            (currentLocation === 'Tomorrowland' && targetLocation === 'Frontierland');

        if (isParadeActive && isCrossPark) {
            return "Parade Obstacle: Cross-park sprint blocked by parade route. Use the railroad or wait 20m.";
        }
        return null;
    }

    static validateParadeWall(
        stepA: ItineraryStep,
        stepB: ItineraryStep,
        paradeTime: string, // e.g., '2026-02-25T15:00:00'
        isCrossing: boolean
    ): boolean {
        const paradeStart = new Date(paradeTime).getTime();
        const paradeEnd = paradeStart + 30 * 60000; // 30 min duration
        const transitionTime = new Date(stepB.planned_start).getTime();

        // Check if transition happens during or 30m before parade
        if (isCrossing && transitionTime >= (paradeStart - 30 * 60000) && transitionTime <= paradeEnd) {
            return false; // Blocked by Parade Wall
        }
        return true;
    }

    static fillDASGaps(
        itinerary: ItineraryStep[],
        nearbyLowStress: ItineraryStep[]
    ): ItineraryStep[] {
        const filled: ItineraryStep[] = [];
        itinerary.forEach(step => {
            filled.push(step);
            // If there's a gap > 30m after this step, fill it
            // (Simplified for prototype)
            if (step.step_type === 'ride' && nearbyLowStress.length > 0) {
                filled.push({
                    ...nearbyLowStress[0],
                    is_pivot: true,
                    notes: 'DAS Return-Time Gap Filler'
                });
            }
        });
        return filled;
    }

    static generateStrategyInsight(
        step: ItineraryStep,
        guests: Guest[],
        preferences: Preference[]
    ): string {
        // [Existing logic...]
        const sensitiveGuests = guests.filter(g =>
            g.sensory_sensitivities?.some(s => step.sensory_tags?.includes(s))
        ).map(g => g.name);

        if (sensitiveGuests.length > 0) {
            return `Sensory Notice: ${sensitiveGuests.join(' & ')} might find this ${step.sensory_tags?.join('/')}. Consider a scout-ahead.`;
        }

        const firstTimers = guests.filter(g => g.is_first_timer).map(g => g.name);
        if (firstTimers.length > 0 && step.step_type === 'ride') {
            return `First-Adventure Tip: This is a classic peak experience for ${firstTimers.join(' & ')}. Prepare for mild thrill!`;
        }

        const mustDoGuests = preferences
            .filter(p => p.item_id === step.id && p.rank === 'must-do')
            .map(p => guests.find(g => g.id === p.guest_id)?.name);

        if (mustDoGuests.length > 0) {
            return `Strategic Priority: This is a Must-Do for ${mustDoGuests.join(' & ')}.`;
        }

        const interestedGuests = preferences
            .filter(p => p.item_type === step.step_type && p.rank === 'like-to-do')
            .map(p => guests.find(g => g.id === p.guest_id)?.name);

        if (interestedGuests.length > 0) {
            return `Group Alignment: High interest for ${interestedGuests.join(' & ')} detected.`;
        }

        if (step.step_type === 'break') {
            return "Logistical Essential: Optimal window for stamina recovery.";
        }

        return "Adventure Curated: Selected for optimal flow and low wait times.";
    }

    /**
     * Identifies "Blackout Periods" where no bookings should be suggested.
     * Factors in both scheduled itinerary events (food/breaks) and membership-level restrictions.
     */
    static getBlackoutPeriods(itinerary: ItineraryStep[], guests: Guest[]): { start: Date; end: Date; reason: string }[] {
        const periods = itinerary
            .filter(step => step.step_type === 'food' || step.step_type === 'break')
            .map(step => {
                const start = new Date(step.planned_start);
                const end = new Date(start.getTime() + (step.step_type === 'food' ? 60 : 20) * 60000);
                return { start, end, reason: step.step_name };
            });

        // Add Membership-based Blackouts (Mock Data for Prototype)
        guests.forEach(guest => {
            const m = guest.memberships;
            if (!m) return;

            // WDW Blackout: Pixie Dust Pass usually blacked out on weekends
            if (m.wdw_ap_tier === 'Pixie') {
                const today = new Date();
                const day = today.getDay();
                if (day === 0 || day === 6) {
                    periods.push({
                        start: new Date(today.setHours(0, 0, 0, 0)),
                        end: new Date(today.setHours(23, 59, 59, 999)),
                        reason: `Pass Blackout: WDW Pixie Dust Restricted Window`
                    });
                }
            }

            // DLR Blackout: Imagine Key usually blacked out on weekends
            if (m.dl_ap_tier === 'Imagine') {
                const today = new Date();
                const day = today.getDay();
                if (day === 0 || day === 6) {
                    periods.push({
                        start: new Date(today.setHours(0, 0, 0, 0)),
                        end: new Date(today.setHours(23, 59, 59, 999)),
                        reason: `Key Blackout: DLR Imagine Restricted Window`
                    });
                }
            }
        });

        return periods;
    }

    /**
     * Checks if a target time falls within any blackout period.
     */
    static isBlockedForBooking(targetTime: Date, blackoutPeriods: { start: Date; end: Date; reason: string }[]): string | null {
        const blocked = blackoutPeriods.find(p => targetTime >= p.start && targetTime <= p.end);
        return blocked ? `Schedule Conflict: ${blocked.reason} in progress.` : null;
    }

    /**
     * Sunset Audit: At 6:00 PM, re-prioritize all "Must-Do" items to ensure fulfillment.
     */
    static performMustDoAudit(
        itinerary: ItineraryStep[],
        preferences: Preference[],
        currentTime: Date
    ): { updatedItinerary: ItineraryStep[]; auditSummary: string | null } {
        const isSunsetWindow = currentTime.getHours() >= 18; // 6:00 PM
        if (!isSunsetWindow) return { updatedItinerary: itinerary, auditSummary: null };

        const pendingMustDos = preferences.filter(p =>
            p.rank === 'must-do' &&
            itinerary.some(step => step.id === p.item_id && step.status === 'pending')
        );

        if (pendingMustDos.length === 0) return { updatedItinerary: itinerary, auditSummary: "Sunset Audit: All Must-Do goals achieved or scheduled." };

        const mustDoIds = new Set(pendingMustDos.map(p => p.item_id));

        // Reshuffle: Move Must-Do items to the front of the pending list
        const completed = itinerary.filter(s => s.status === 'completed');
        const pending = itinerary.filter(s => s.status === 'pending');

        const priorityPending = pending.filter(s => mustDoIds.has(s.id));
        const regularPending = pending.filter(s => !mustDoIds.has(s.id));

        const reshuffled = [...completed, ...priorityPending, ...regularPending];

        return {
            updatedItinerary: reshuffled,
            auditSummary: `Sunset Audit: Reshuffled ${priorityPending.length} Must-Do items to ensure end-of-day success.`
        };
    }

    /**
     * Logic for Rider Switch: Child is too short.
     * Schedule Parent A (Ride) + Parent B (Wait/Snack), then swap.
     */
    static applyRiderSwitchLoop(
        step: ItineraryStep,
        guests: Guest[]
    ): ItineraryStep[] {
        const tooShort = guests.filter(g => g.height_cm < 100); // Mock height threshold
        if (tooShort.length === 0 || step.step_type !== 'ride') return [step];

        const parents = guests.filter(g => g.age >= 18);
        if (parents.length < 2) return [step]; // Need 2 parents for a loop

        const parentA = parents[0].name;
        const parentB = parents[1].name;

        return [
            {
                ...step,
                step_name: `${step.step_name} (Parent A: ${parentA})`,
                notes: `Rider Switch Step 1: ${parentB} waits with ${tooShort.map(g => g.name).join(', ')}.`
            },
            {
                id: `${step.id}_swap`,
                trip_id: step.trip_id,
                park_id: step.park_id,
                step_name: `${step.step_name} (Parent B: ${parentB})`,
                step_type: 'ride',
                planned_start: new Date(new Date(step.planned_start).getTime() + 45 * 60000).toISOString(),
                status: 'pending',
                is_pivot: true,
                notes: `Rider Switch Step 2: ${parentA} takes over child-watch.`
            }
        ];
    }

    /**
     * Identifies potential conflict points within a group for a list of rides.
     * Flags: Rider Switch (height), Age restrictions, or intense sensory conflicts.
     */
    static detectConflictPoints(guests: Guest[], rides: Ride[]): { rideId: string; type: 'Rider Switch' | 'Sensory' | 'Age'; guestsInvolved: string[] }[] {
        const conflicts: { rideId: string; type: 'Rider Switch' | 'Sensory' | 'Age'; guestsInvolved: string[] }[] = [];

        rides.forEach(ride => {
            // 1. Rider Switch (Height)
            if (ride.height_requirement_cm) {
                const guestsTooShort = guests.filter(g => g.height_cm < (ride.height_requirement_cm || 0));
                if (guestsTooShort.length > 0 && guestsTooShort.length < guests.length) {
                    conflicts.push({
                        rideId: ride.id,
                        type: 'Rider Switch',
                        guestsInvolved: guestsTooShort.map(g => g.name)
                    });
                }
            }

            // 2. Sensory Sensitivity Conflicts
            const sensorySensitiveGuests = guests.filter(g =>
                g.sensory_sensitivities?.some(s => ride.sensory_tags?.includes(s))
            );
            if (sensorySensitiveGuests.length > 0) {
                conflicts.push({
                    rideId: ride.id,
                    type: 'Sensory',
                    guestsInvolved: sensorySensitiveGuests.map(g => g.name)
                });
            }
        });

        return conflicts;
    }
}
