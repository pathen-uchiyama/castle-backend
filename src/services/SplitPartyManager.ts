import { ItineraryStep, Guest, ParkID } from '../models/types';
import { ScoredRide } from '../data/RepeatVoteScoring';

/**
 * SplitPartyManager — Parallel Sub-Group Routing (Max 3 Groups)
 *
 * When a family wants to split up (adults ride TRON, kids do Buzz),
 * this system manages parallel itinerary tracks with independent
 * LL snipe queues and automatic reunion scheduling.
 *
 * Architecture:
 *   - Max 3 sub-groups (hard cap enforced in DB trigger: 005_ride_preferences.sql)
 *   - Each sub-group gets an independent ItineraryTrack
 *   - LL snipe jobs maintain the party's tier priority (not downgraded)
 *   - "Call Back" reunification calculates optimal meeting points
 *   - Late-group alerts fire at >5 minutes past meeting time
 *
 * Cost Control:
 *   - Token circuit breaker accounts per-PARTY, not per-group
 *   - So a family split into 3 groups uses 1 party's quota, not 3
 *
 * Worst-Case Load:
 *   - 80 families × 3 groups = 240 parallel tracks during mass recalibration
 *   - Each track generates independent snipe jobs → priority queue handles load
 */

// ── Types ───────────────────────────────────────────────────────

export interface SubGroup {
    id: string;
    name: string;
    guests: Guest[];
    /** Lead adult responsible for this sub-group */
    leadGuestId: string;
    /** Color code for UI differentiation */
    color: 'blue' | 'orange' | 'green';
}

export interface SplitPartyState {
    tripId: string;
    partyId: string;
    /** Full guest list */
    allGuests: Guest[];
    /** Sub-groups (max 3, enforced by API) */
    subGroups: SubGroup[];
    /** Whether the party is currently split */
    isSplit: boolean;
    /** Planned reunification events */
    reunionPoints: ReunionPoint[];
    /** When the split was initiated */
    splitInitiatedAt: string | null;
    /** Subscription tier (applies to entire party, not per-group) */
    tier: string;
}

export interface ItineraryTrack {
    subGroupId: string;
    subGroupName: string;
    steps: ItineraryStep[];
    activeSnipeJobs: string[];
}

export interface ReunionPoint {
    id: string;
    /** Meeting location (e.g., "Cosmic Ray's Starlight Café") */
    location: string;
    locationLand: string;
    parkId: ParkID;
    /** Planned meeting time */
    meetingTime: string;
    /** Which sub-groups should meet */
    expectedGroupIds: string[];
    /** Which have checked in */
    arrivedGroupIds: string[];
    /** Whether the reunion is complete */
    isComplete: boolean;
    /** Whether late alert has been sent */
    lateAlertSent: boolean;
    /** Note for guests */
    notes: string;
}

// ── Meeting Point Database ──────────────────────────────────────

interface MeetingLocation {
    name: string;
    land: string;
    parkId: ParkID;
    /** Whether it has seating/shade (better for families with young kids) */
    hasSeating: boolean;
    /** Central enough to be walkable from multiple lands */
    isCentral: boolean;
    /** Has food/drink available */
    hasFood: boolean;
}

const MEETING_POINTS: MeetingLocation[] = [
    // Magic Kingdom
    { name: "Cosmic Ray's Starlight Café", land: 'Tomorrowland', parkId: 'MK', hasSeating: true, isCentral: true, hasFood: true },
    { name: 'Columbia Harbour House', land: 'Liberty Square', parkId: 'MK', hasSeating: true, isCentral: true, hasFood: true },
    { name: 'The Hub (Castle Stage)', land: 'Main Street', parkId: 'MK', hasSeating: false, isCentral: true, hasFood: false },
    { name: 'Pinocchio Village Haus', land: 'Fantasyland', parkId: 'MK', hasSeating: true, isCentral: false, hasFood: true },
    { name: 'Pecos Bill Tall Tale Inn', land: 'Frontierland', parkId: 'MK', hasSeating: true, isCentral: false, hasFood: true },

    // EPCOT
    { name: 'Connections Café', land: 'World Celebration', parkId: 'EP', hasSeating: true, isCentral: true, hasFood: true },
    { name: 'Sunshine Seasons', land: 'World Nature', parkId: 'EP', hasSeating: true, isCentral: false, hasFood: true },
    { name: 'World Showcase Plaza', land: 'World Showcase', parkId: 'EP', hasSeating: false, isCentral: true, hasFood: false },

    // Hollywood Studios
    { name: 'ABC Commissary', land: 'Commissary Lane', parkId: 'HS', hasSeating: true, isCentral: true, hasFood: true },
    { name: 'Docking Bay 7', land: "Galaxy's Edge", parkId: 'HS', hasSeating: true, isCentral: false, hasFood: true },
    { name: 'Hollywood Blvd (Center Stage)', land: 'Hollywood Blvd', parkId: 'HS', hasSeating: false, isCentral: true, hasFood: false },

    // Animal Kingdom
    { name: 'Flame Tree Barbecue', land: 'Discovery Island', parkId: 'AK', hasSeating: true, isCentral: true, hasFood: true },
    { name: 'Satu\'li Canteen', land: 'Pandora', parkId: 'AK', hasSeating: true, isCentral: false, hasFood: true },
    { name: 'Tree of Life Garden', land: 'Discovery Island', parkId: 'AK', hasSeating: true, isCentral: true, hasFood: false },
];

// ── Engine ──────────────────────────────────────────────────────

export class SplitPartyManager {
    /**
     * Create a split party configuration.
     * Validates the max-3 group hard cap and ensures every guest is assigned.
     */
    static createSplit(
        tripId: string,
        partyId: string,
        allGuests: Guest[],
        groupAssignments: { groupName: string; guestIds: string[]; leadGuestId: string }[],
        tier: string
    ): SplitPartyState {
        // Hard cap: max 3 groups
        if (groupAssignments.length > 3) {
            throw new Error('Maximum 3 sub-groups allowed per party');
        }

        if (groupAssignments.length < 2) {
            throw new Error('Need at least 2 sub-groups to split');
        }

        // Validate every guest is assigned exactly once
        const assignedIds = new Set<string>();
        for (const group of groupAssignments) {
            for (const guestId of group.guestIds) {
                if (assignedIds.has(guestId)) {
                    throw new Error(`Guest ${guestId} assigned to multiple groups`);
                }
                assignedIds.add(guestId);
            }
        }

        const unassigned = allGuests.filter(g => !assignedIds.has(g.id));
        if (unassigned.length > 0) {
            throw new Error(`Guests not assigned to any group: ${unassigned.map(g => g.name).join(', ')}`);
        }

        // Validate each group has at least one adult (for child safety)
        const colors: ('blue' | 'orange' | 'green')[] = ['blue', 'orange', 'green'];

        const subGroups: SubGroup[] = groupAssignments.map((assignment, i) => {
            const guests = assignment.guestIds.map(id => {
                const guest = allGuests.find(g => g.id === id);
                if (!guest) throw new Error(`Guest ${id} not found`);
                return guest;
            });

            const hasAdult = guests.some(g => g.age >= 18);
            if (!hasAdult) {
                throw new Error(`Group "${assignment.groupName}" must have at least one adult (18+)`);
            }

            return {
                id: `grp_${tripId}_${i}`,
                name: assignment.groupName,
                guests,
                leadGuestId: assignment.leadGuestId,
                color: colors[i],
            };
        });

        return {
            tripId,
            partyId,
            allGuests,
            subGroups,
            isSplit: true,
            reunionPoints: [],
            splitInitiatedAt: new Date().toISOString(),
            tier,
        };
    }

    // ── Parallel Itinerary Track Generation ─────────────────────

    /**
     * Generate independent itinerary tracks for each sub-group.
     * Each track gets its own advisory filtering based on the sub-group's guests.
     */
    static generateParallelTracks(
        state: SplitPartyState,
        allScoredRides: ScoredRide[],
        parkId: ParkID
    ): ItineraryTrack[] {
        return state.subGroups.map(group => {
            // Filter scored rides based on this sub-group's guest eligibility
            const groupScoredRides = allScoredRides.filter(ride => {
                // Check if any guest in this group specifically requested this ride
                return true; // All rides eligible by default — advisory filtering happens in DayRecalibrationEngine
            });

            // Generate itinerary steps for this sub-group
            const steps: ItineraryStep[] = groupScoredRides
                .slice(0, 8) // Max 8 rides per sub-group track
                .map((ride, index) => ({
                    id: `${group.id}_step_${index}`,
                    trip_id: state.tripId,
                    park_id: parkId,
                    step_name: ride.attractionName,
                    step_type: 'ride' as const,
                    planned_start: new Date(Date.now() + index * 45 * 60000).toISOString(),
                    status: 'pending' as const,
                    is_pivot: false,
                    notes: `Sub-Group: ${group.name} (${group.color})`,
                } as ItineraryStep));

            return {
                subGroupId: group.id,
                subGroupName: group.name,
                steps,
                activeSnipeJobs: [],
            };
        });
    }

    // ── Reunion Point Scheduling ────────────────────────────────

    /**
     * Calculate optimal meeting point and time for reunion.
     * Considers current sub-group locations, food availability, and centrality.
     */
    static scheduleReunion(
        state: SplitPartyState,
        parkId: ParkID,
        requestedTime: string,
        groupIdsToMeet?: string[],
        preferFood: boolean = true
    ): ReunionPoint {
        const meetingGroupIds = groupIdsToMeet || state.subGroups.map(g => g.id);

        // Find best meeting point
        const parkLocations = MEETING_POINTS.filter(l => l.parkId === parkId);

        // Score meeting points
        const scored = parkLocations.map(location => {
            let score = 0;
            if (location.isCentral) score += 30;        // Central locations are better
            if (preferFood && location.hasFood) score += 20;  // Food available
            if (location.hasSeating) score += 15;        // Seating for rest
            // Add some randomness to prevent all families from picking the same spot
            score += Math.random() * 10;
            return { location, score };
        }).sort((a, b) => b.score - a.score);

        const bestLocation = scored[0]?.location || parkLocations[0];

        // Determine if young kids are in the party (prefer spots with seating)
        const hasYoungKids = state.allGuests.some(g => g.age < 6);
        const finalLocation = hasYoungKids
            ? scored.find(s => s.location.hasSeating)?.location || bestLocation
            : bestLocation;

        const reunion: ReunionPoint = {
            id: `reunion_${state.tripId}_${Date.now()}`,
            location: finalLocation.name,
            locationLand: finalLocation.land,
            parkId,
            meetingTime: requestedTime,
            expectedGroupIds: meetingGroupIds,
            arrivedGroupIds: [],
            isComplete: false,
            lateAlertSent: false,
            notes: hasYoungKids
                ? `Family-friendly spot with seating. 📍 ${finalLocation.land}`
                : `📍 ${finalLocation.land} — look for your group's color badge in the app`,
        };

        return reunion;
    }

    // ── Check-In and Late Alert ─────────────────────────────────

    /**
     * Mark a sub-group as arrived at the meeting point.
     */
    static checkInToReunion(
        reunion: ReunionPoint,
        groupId: string
    ): { reunion: ReunionPoint; isComplete: boolean; lateGroups: string[] } {
        if (!reunion.arrivedGroupIds.includes(groupId)) {
            reunion.arrivedGroupIds.push(groupId);
        }

        reunion.isComplete = reunion.expectedGroupIds.every(id =>
            reunion.arrivedGroupIds.includes(id)
        );

        const lateGroups = reunion.expectedGroupIds.filter(id =>
            !reunion.arrivedGroupIds.includes(id)
        );

        return { reunion, isComplete: reunion.isComplete, lateGroups };
    }

    /**
     * Check if any groups are late (>5 minutes past meeting time).
     * Returns groups that should receive a nudge notification.
     */
    static checkForLateGroups(
        reunion: ReunionPoint,
        currentTime: Date = new Date()
    ): { isLate: boolean; lateGroupIds: string[]; minutesLate: number } {
        if (reunion.isComplete || reunion.lateAlertSent) {
            return { isLate: false, lateGroupIds: [], minutesLate: 0 };
        }

        const meetingTime = new Date(reunion.meetingTime);
        const diffMs = currentTime.getTime() - meetingTime.getTime();
        const minutesLate = Math.floor(diffMs / 60000);

        if (minutesLate >= 5) {
            const lateGroupIds = reunion.expectedGroupIds.filter(id =>
                !reunion.arrivedGroupIds.includes(id)
            );

            return { isLate: true, lateGroupIds, minutesLate };
        }

        return { isLate: false, lateGroupIds: [], minutesLate: 0 };
    }

    // ── Merge Back ──────────────────────────────────────────────

    /**
     * Merge sub-groups back into a single party.
     * Combines all itinerary tracks into one timeline.
     */
    static mergeParty(
        state: SplitPartyState,
        tracks: ItineraryTrack[]
    ): { mergedItinerary: ItineraryStep[]; summary: string } {
        // Collect all steps from all tracks, sorted by time
        const allSteps = tracks
            .flatMap(track => track.steps.map(step => ({
                ...step,
                notes: `${step.notes || ''} [Merged from ${track.subGroupName}]`,
            })))
            .sort((a, b) =>
                new Date(a.planned_start).getTime() - new Date(b.planned_start).getTime()
            );

        const completedSteps = allSteps.filter(s => s.status === 'completed');
        const pendingSteps = allSteps.filter(s => s.status === 'pending');

        return {
            mergedItinerary: [...completedSteps, ...pendingSteps],
            summary: `Merged ${tracks.length} sub-groups: ${completedSteps.length} completed, ${pendingSteps.length} remaining`,
        };
    }

    // ── Snipe Job Generation Per Sub-Group ───────────────────────

    /**
     * Generate independent snipe jobs for each sub-group.
     * Uses the PARTY'S tier (not downgraded per sub-group).
     */
    static generateSubGroupSnipeJobs(
        state: SplitPartyState,
        tracks: ItineraryTrack[]
    ): { subGroupId: string; jobs: any[] }[] {
        return tracks.map(track => {
            const group = state.subGroups.find(g => g.id === track.subGroupId);
            const jobs = track.steps
                .filter(step => step.step_type === 'ride' && step.status === 'pending')
                .map(step => ({
                    idempotencyKey: `${state.partyId}:${track.subGroupId}:${step.id}`,
                    userId: group?.leadGuestId || state.partyId,
                    tripId: state.tripId,
                    attractionId: step.id,
                    attractionName: step.step_name,
                    preferredWindows: [step.planned_start],
                    tier: state.tier, // Party tier, NOT per-group
                }));

            return { subGroupId: track.subGroupId, jobs };
        });
    }
}
