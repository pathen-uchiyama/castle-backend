import { EndpointRegistry } from './EndpointRegistry';
import { SessionManager, SkipperSession } from './SessionManager';
import { CircuitBreaker } from './CircuitBreaker';
import { HumanMimicry } from './HumanMimicry';
import {
  DisneyExperience,
  GuestEligibility,
  DisneyOffer,
  DisneyBooking,
  VQQueue,
  VQLinkedGuest,
  VQJoinResult,
  DisneyResponse,
  ResortId,
  WDW_CONFIG,
  DLR_CONFIG,
  HourlyTimeSlot,
  ConfirmedReservation,
} from './types';
import { env } from '../../config/env';

/**
 * DisneyAPIClient — Clean-room implementation of all 12 Disney endpoints.
 *
 * Architecture: Every request flows through this pipeline:
 *   1. EndpointRegistry → resolve the URL path (hot-swappable)
 *   2. CircuitBreaker → check if endpoint is healthy
 *   3. HumanMimicry → apply jitter + rate limit
 *   4. SessionManager → get auth headers
 *   5. fetch() → make the request
 *   6. CircuitBreaker → record success/failure
 *
 * If a circuit trips, requests queue up in BullMQ and drain
 * automatically when the circuit closes.
 */
export class DisneyAPIClient {
  private registry: EndpointRegistry;
  private sessions: SessionManager;
  private breaker: CircuitBreaker;
  private mimicry: HumanMimicry;

  constructor(
    registry: EndpointRegistry,
    sessions: SessionManager,
    breaker: CircuitBreaker,
    mimicry: HumanMimicry
  ) {
    this.registry = registry;
    this.sessions = sessions;
    this.breaker = breaker;
    this.mimicry = mimicry;
  }

  // ── Read Operations ────────────────────────────────────────

  /**
   * Get Lightning Lane / Virtual Queue availability for a park.
   * Equivalent to what you see on the MDE tipboard.
   */
  async getExperiences(
    parkId: string,
    date: string,
    skipperId: string,
    resort: ResortId = 'WDW'
  ): Promise<DisneyExperience[]> {
    const path = await this.registry.resolveEndpoint('ll', 'experiences', { parkId });

    const response = await this.makeRequest<{ availableExperiences: DisneyExperience[] }>({
      path,
      method: 'GET',
      params: { date },
      skipperId,
      resort,
      endpointName: 'll.experiences',
    });

    return response.data.availableExperiences ?? [];
  }

  /**
   * Check guest eligibility for LL booking.
   * Returns which guests in the party can book, and why others can't.
   */
  async getGuests(
    skipperId: string,
    options?: { experienceId?: string; date?: string },
    resort: ResortId = 'WDW'
  ): Promise<GuestEligibility> {
    const path = await this.registry.resolveEndpoint('ll', 'guests');

    const body: Record<string, unknown> = {};
    if (options?.experienceId) body.facilityId = options.experienceId;
    if (options?.date) body.date = options.date;

    const response = await this.makeRequest<GuestEligibility>({
      path,
      method: 'POST',
      data: body,
      skipperId,
      resort,
      endpointName: 'll.guests',
    });

    return response.data;
  }

  // ── Offer Operations ───────────────────────────────────────

  /**
   * Generate a pre-book offer for a Lightning Lane reservation.
   * This is the step before confirming — like adding to cart.
   */
  async generateOffer(
    experienceId: string,
    parkId: string,
    guestIds: string[],
    date: string,
    skipperId: string,
    resort: ResortId = 'WDW'
  ): Promise<DisneyOffer> {
    const path = await this.registry.resolveEndpoint('ll', 'offerGenerate');

    const response = await this.makeRequest<DisneyOffer>({
      path,
      method: 'POST',
      data: {
        facilityId: experienceId,
        parkId,
        guestIds,
        date,
      },
      skipperId,
      resort,
      endpointName: 'll.offerGenerate',
    });

    return response.data;
  }

  /**
   * Get available time slots for an existing offer.
   */
  async getOfferTimes(
    offerId: string,
    offerSetId: string,
    date: string,
    skipperId: string,
    resort: ResortId = 'WDW'
  ): Promise<HourlyTimeSlot[]> {
    const path = await this.registry.resolveEndpoint('ll', 'offerTimes');

    const response = await this.makeRequest<{ times: HourlyTimeSlot[] }>({
      path,
      method: 'POST',
      data: { offerId, offerSetId, date },
      skipperId,
      resort,
      endpointName: 'll.offerTimes',
    });

    return response.data.times ?? [];
  }

  /**
   * Select a specific time slot for an offer (change the return window).
   */
  async fulfillOfferTime(
    offerId: string,
    offerSetId: string,
    selectedTime: string,
    date: string,
    skipperId: string,
    resort: ResortId = 'WDW'
  ): Promise<DisneyOffer> {
    const path = await this.registry.resolveEndpoint('ll', 'offerTimesFulfill');

    const response = await this.makeRequest<DisneyOffer>({
      path,
      method: 'POST',
      data: { offerId, offerSetId, selectedTime, date },
      skipperId,
      resort,
      endpointName: 'll.offerTimesFulfill',
    });

    return response.data;
  }

  // ── Write Operations ───────────────────────────────────────

  /**
   * Confirm a Lightning Lane reservation (book the offer).
   * This is the final "checkout" step.
   */
  async bookOffer(
    offerId: string,
    offerSetId: string,
    skipperId: string,
    resort: ResortId = 'WDW'
  ): Promise<DisneyBooking> {
    const path = await this.registry.resolveEndpoint('ll', 'book');

    // Non-linear pathing: occasionally make a decoy read before booking
    if (this.mimicry.shouldMakeDecoyRequest()) {
      console.log(`[DisneyAPI] Making decoy read before book`);
      // Fire a decoy getGuests request (read-only, harmless)
      try {
        await this.getGuests(skipperId, undefined, resort);
      } catch {
        // Decoy failures are irrelevant
      }
    }

    const response = await this.makeRequest<DisneyBooking>({
      path,
      method: 'POST',
      data: { offerId, offerSetId },
      skipperId,
      resort,
      endpointName: 'll.book',
    });

    return response.data;
  }

  /**
   * Modify an existing reservation with a new time.
   */
  async modifyBooking(
    entitlementIds: string[],
    experienceId: string,
    parkId: string,
    guestIds: string[],
    date: string,
    skipperId: string,
    resort: ResortId = 'WDW'
  ): Promise<DisneyOffer> {
    // Step 1: Generate modification offer
    const modPath = await this.registry.resolveEndpoint('ll', 'offerGenerateMod');
    const modResponse = await this.makeRequest<DisneyOffer>({
      path: modPath,
      method: 'POST',
      data: {
        facilityId: experienceId,
        parkId,
        guestIds,
        date,
        existingEntitlementIds: entitlementIds,
      },
      skipperId,
      resort,
      endpointName: 'll.offerGenerateMod',
    });

    return modResponse.data;
  }

  /**
   * Cancel one or more Lightning Lane reservations.
   */
  async cancelBooking(
    entitlementIds: string[],
    skipperId: string,
    resort: ResortId = 'WDW'
  ): Promise<void> {
    const path = await this.registry.resolveEndpoint('ll', 'cancel', {
      entitlementIds: entitlementIds.join(','),
    });

    await this.makeRequest<void>({
      path,
      method: 'DELETE',
      skipperId,
      resort,
      endpointName: 'll.cancel',
    });
  }

  // ── Virtual Queue ──────────────────────────────────────────

  /**
   * Get all active virtual queues.
   */
  async getQueues(
    skipperId: string,
    resort: ResortId = 'WDW'
  ): Promise<VQQueue[]> {
    const path = await this.registry.resolveEndpoint('vq', 'getQueues');

    const response = await this.makeRequest<{ queues: VQQueue[] }>({
      path,
      method: 'POST',
      data: {},
      skipperId,
      resort,
      endpointName: 'vq.getQueues',
      useVqOrigin: true,
    });

    return response.data.queues ?? [];
  }

  /**
   * Get guests linked to the Skipper for VQ selection.
   */
  async getLinkedGuests(
    queueId: string,
    skipperId: string,
    resort: ResortId = 'WDW'
  ): Promise<VQLinkedGuest[]> {
    const path = await this.registry.resolveEndpoint('vq', 'getLinkedGuests');

    const response = await this.makeRequest<{ guests: VQLinkedGuest[] }>({
      path,
      method: 'POST',
      data: { queueId },
      skipperId,
      resort,
      endpointName: 'vq.getLinkedGuests',
      useVqOrigin: true,
    });

    return response.data.guests ?? [];
  }

  /**
   * Join a virtual queue (boarding group).
   * Implements BG1-inspired auto-retry: if specific guests are rejected,
   * retry without them to get the rest of the party in.
   */
  async joinQueue(
    queueId: string,
    guestIds: string[],
    skipperId: string,
    resort: ResortId = 'WDW',
    maxRetries: number = 2
  ): Promise<VQJoinResult> {
    const path = await this.registry.resolveEndpoint('vq', 'joinQueue');
    let remainingGuests = [...guestIds];
    let lastResult: VQJoinResult | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (remainingGuests.length === 0) break;

      const response = await this.makeRequest<VQJoinResult>({
        path,
        method: 'POST',
        data: { queueId, guestIds: remainingGuests },
        skipperId,
        resort,
        endpointName: 'vq.joinQueue',
        useVqOrigin: true,
      });

      lastResult = response.data;

      if (lastResult.status === 'OK') {
        return lastResult;
      }

      // If some guests were rejected, remove them and retry
      if (lastResult.status === 'INVALID_GUEST' && Object.keys(lastResult.conflicts).length > 0) {
        const invalidIds = Object.keys(lastResult.conflicts);
        console.warn(`[DisneyAPI] VQ: ${invalidIds.length} guests rejected, retrying without them`);
        remainingGuests = remainingGuests.filter(id => !invalidIds.includes(id));
      } else {
        // Non-retryable error
        break;
      }
    }

    return lastResult ?? {
      status: 'UNKNOWN_ERROR',
      conflicts: {},
      closed: false,
    };
  }

  // ── Core Request Pipeline ──────────────────────────────────

  /**
   * The central request method. Every Disney API call flows through here.
   */
  private async makeRequest<T>(options: {
    path: string;
    method?: 'GET' | 'POST' | 'DELETE';
    params?: Record<string, string>;
    data?: Record<string, unknown>;
    skipperId: string;
    resort: ResortId;
    endpointName: string;
    useVqOrigin?: boolean;
  }): Promise<DisneyResponse<T>> {
    const {
      path,
      method = 'GET',
      params,
      data,
      skipperId,
      resort,
      endpointName,
      useVqOrigin = false,
    } = options;

    // 1. Circuit breaker check
    const allowed = await this.breaker.canRequest(endpointName);
    if (!allowed) {
      throw new DisneyAPIError(
        `Circuit breaker OPEN for ${endpointName}. Requests paused.`,
        503,
        endpointName
      );
    }

    // 2. Get authenticated session
    const session = await this.sessions.getSession(skipperId);
    if (!session) {
      throw new DisneyAPIError(
        `No active session for Skipper ${skipperId}. Re-authentication required.`,
        401,
        endpointName
      );
    }

    // 3. Apply human mimicry
    await this.mimicry.enforceRateLimit(skipperId);
    const jitterMs = await this.mimicry.applyJitter();

    // 4. Build request
    const resortConfig = resort === 'WDW' ? WDW_CONFIG : DLR_CONFIG;
    const origin = useVqOrigin ? resortConfig.origins.vq : resortConfig.origins.main;
    let url = `${origin}${path}`;

    if (params) {
      const searchParams = new URLSearchParams(params);
      url += `?${searchParams.toString()}`;
    }

    const headers = session.getHeaders();
    const fetchOptions: RequestInit = {
      method,
      headers,
    };

    if (data && method !== 'GET') {
      fetchOptions.body = JSON.stringify(data);
    }

    // 5. Execute request
    const startTime = Date.now();
    try {
      const response = await fetch(url, fetchOptions);
      const latencyMs = Date.now() - startTime;

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');

        // Handle specific error codes
        if (response.status === 401) {
          // Token expired — invalidate session so it gets refreshed
          await this.sessions.invalidateSession(skipperId);
        }

        await this.breaker.recordFailure(endpointName, response.status, errorBody);

        throw new DisneyAPIError(
          `Disney API ${endpointName} returned ${response.status}: ${errorBody.substring(0, 200)}`,
          response.status,
          endpointName
        );
      }

      const responseData = await response.json() as T;

      // 6. Record success
      await this.breaker.recordSuccess(endpointName);
      await this.sessions.touchSession(skipperId);

      console.log(
        `[DisneyAPI] ✅ ${endpointName} — ${response.status} ` +
        `(${latencyMs}ms + ${jitterMs}ms jitter)`
      );

      return {
        status: response.status,
        data: responseData,
        headers: Object.fromEntries(response.headers.entries()),
        latencyMs,
      };

    } catch (error) {
      if (error instanceof DisneyAPIError) throw error;

      // Network-level failure
      const latencyMs = Date.now() - startTime;
      await this.breaker.recordFailure(endpointName, 0, `Network error: ${error}`);

      throw new DisneyAPIError(
        `Network error calling ${endpointName}: ${error instanceof Error ? error.message : 'unknown'}`,
        0,
        endpointName
      );
    }
  }
}

// ── Error Types ──────────────────────────────────────────────────────

export class DisneyAPIError extends Error {
  statusCode: number;
  endpoint: string;

  constructor(message: string, statusCode: number, endpoint: string) {
    super(message);
    this.name = 'DisneyAPIError';
    this.statusCode = statusCode;
    this.endpoint = endpoint;
  }
}
