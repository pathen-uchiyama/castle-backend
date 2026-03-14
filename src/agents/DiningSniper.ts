import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { env } from '../config/env';
import { FirebaseGuardian } from '../utils/FirebaseGuardian';

/**
 * DiningSniper — Server-side dining reservation monitoring service.
 *
 * Replaces the client-side DiningMonitorEngine with a backend BullMQ worker
 * that continuously polls for dining availability and dispatches
 * "One-Tap Handoff" notifications via the Guardian Agent.
 *
 * Blueprint flow:
 *   1. User requests a dining search (restaurant, party size, time window)
 *   2. DiningSniper enqueues a repeating BullMQ job that polls availability
 *   3. When a slot is found → constructs a DINING_HANDOFF NudgePayload
 *   4. Guardian dispatches with deep link: mde://dining/reservation/confirm?id=XXX
 *   5. User taps notification → My Disney Experience opens directly to confirmation
 *
 * Security: No Disney credentials are stored. The deep link opens
 * the user's already-authenticated MDE session (MFA preserved).
 */

export interface DiningSearchRequest {
    tripId: string;
    userId: string;
    restaurantId: string;
    restaurantName: string;
    parkId: string;
    partySize: number;
    preferredDate: string;      // ISO date (e.g., "2026-03-15")
    preferredTimeStart: string; // "11:30 AM"
    preferredTimeEnd: string;   // "1:30 PM"
    maxPollMinutes?: number;    // How long to keep searching (default: 60)
}

export interface DiningSlot {
    restaurantId: string;
    restaurantName: string;
    availableTime: string;
    partySize: number;
    holdExpiresAt: string;      // When the hold auto-releases
    confirmationDeepLink: string; // mde:// deep link
}

// Redis key prefixes
const SEARCH_PREFIX = 'dining:search:';
const SLOT_PREFIX = 'dining:slot:';

export class DiningSniper {
    private redis: Redis;
    private queue: Queue;

    constructor(queue: Queue) {
        this.redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
        this.queue = queue;
    }

    /**
     * Starts monitoring for a dining reservation.
     * Enqueues a repeating BullMQ job that polls every 30 seconds.
     */
    async startSearch(request: DiningSearchRequest): Promise<string> {
        const searchId = `${request.tripId}_${request.restaurantId}`;

        // Store the search request in Redis
        await this.redis.set(
            `${SEARCH_PREFIX}${searchId}`,
            JSON.stringify({ ...request, status: 'SEARCHING', startedAt: new Date().toISOString() }),
            'EX',
            (request.maxPollMinutes || 60) * 60 // TTL = max poll duration
        );

        // Enqueue the polling job
        await this.queue.add('dining-availability-poll', {
            searchId,
            ...request
        }, {
            repeat: { every: 30000 }, // Poll every 30 seconds
            jobId: `dining-${searchId}`,
        });

        console.log(`🍽️ [DiningSniper] Search started: ${request.restaurantName} for ${request.partySize} on ${request.preferredDate}`);
        return searchId;
    }

    /**
     * Called by the BullMQ worker when polling for availability.
     * In production, this would hit Disney's dining availability API.
     */
    async pollAvailability(searchId: string, request: DiningSearchRequest): Promise<DiningSlot | null> {
        // Check if search is still active
        const searchData = await this.redis.get(`${SEARCH_PREFIX}${searchId}`);
        if (!searchData) {
            console.log(`[DiningSniper] Search ${searchId} expired or cancelled`);
            return null;
        }

        console.log(`[DiningSniper] Polling availability for ${request.restaurantName}...`);

        // TODO: In production, call Disney's dining REST API here.
        // For now, simulate a probabilistic find (~5% chance per poll = ~90s avg find time)
        const found = Math.random() < 0.05;

        if (found) {
            const slot: DiningSlot = {
                restaurantId: request.restaurantId,
                restaurantName: request.restaurantName,
                availableTime: request.preferredTimeStart,
                partySize: request.partySize,
                holdExpiresAt: new Date(Date.now() + 5 * 60000).toISOString(), // 5-min hold
                confirmationDeepLink: this.buildDeepLink(request.restaurantId, request.preferredDate),
            };

            // Store the found slot
            await this.redis.set(
                `${SLOT_PREFIX}${searchId}`,
                JSON.stringify(slot),
                'EX', 300 // 5-minute TTL for the hold
            );

            // Mark search as found
            const search = JSON.parse(searchData);
            search.status = 'FOUND';
            await this.redis.set(`${SEARCH_PREFIX}${searchId}`, JSON.stringify(search), 'EX', 300);

            console.log(`🍽️ [DiningSniper] FOUND: ${slot.restaurantName} at ${slot.availableTime}!`);
            return slot;
        }

        return null;
    }

    /**
     * Dispatches a DINING_HANDOFF nudge with the One-Tap deep link.
     */
    async dispatchDiningNudge(tripId: string, slot: DiningSlot): Promise<void> {
        const nudge = FirebaseGuardian.constructNudge(
            'DINING_HANDOFF',
            `${slot.restaurantName} has an opening at ${slot.availableTime} for ${slot.partySize}! Tap to confirm in My Disney Experience.`,
            {
                actionLink: slot.confirmationDeepLink,
                funSeekTrigger: `Fun fact: ${slot.restaurantName} is a Cast Member favorite 🎩`,
                expiresInMinutes: 5
            }
        );

        await FirebaseGuardian.dispatchNudge(tripId, nudge);
    }

    /**
     * Cancels an active dining search.
     */
    async cancelSearch(searchId: string): Promise<void> {
        await this.redis.del(`${SEARCH_PREFIX}${searchId}`);
        await this.redis.del(`${SLOT_PREFIX}${searchId}`);

        // Remove the repeating job
        const repeatableJobs = await this.queue.getRepeatableJobs();
        const diningJob = repeatableJobs.find(j => j.id === `dining-${searchId}`);
        if (diningJob && diningJob.key) {
            await this.queue.removeRepeatableByKey(diningJob.key);
        }

        console.log(`[DiningSniper] Search cancelled: ${searchId}`);
    }

    /**
     * Gets the current status of a dining search.
     */
    async getSearchStatus(searchId: string): Promise<{ status: string; slot?: DiningSlot } | null> {
        const searchData = await this.redis.get(`${SEARCH_PREFIX}${searchId}`);
        if (!searchData) return null;

        const search = JSON.parse(searchData);
        const slotData = await this.redis.get(`${SLOT_PREFIX}${searchId}`);
        const slot = slotData ? JSON.parse(slotData) : undefined;

        return { status: search.status, slot };
    }

    /**
     * Builds the "One-Tap Handoff" deep link for My Disney Experience.
     *
     * Blueprint security model:
     *   - No login credentials are stored or transmitted
     *   - The deep link opens MDE which already has the user's authenticated session
     *   - MFA compatibility is maintained
     */
    private buildDeepLink(restaurantId: string, date: string): string {
        // Disney's URI scheme for dining reservation confirmation
        return `mde://dining/reservation/confirm?restaurantId=${restaurantId}&date=${date}&source=castle-companion`;
    }
}
