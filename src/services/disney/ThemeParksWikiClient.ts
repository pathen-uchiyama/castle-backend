import {
  ThemeParksLiveData,
  ThemeParksScheduleEntry,
  ThemeParksEntity,
} from './types';

/**
 * ThemeParksWikiClient — Free, public API for park data.
 * https://api.themeparks.wiki/v1
 *
 * Provides data Disney's tipboard doesn't expose cleanly:
 * - Showtimes (parades, fireworks, character meets)
 * - Park schedules (30-day lookahead, extra hours)
 * - LL return time status (for free-tier users)
 * - VQ boarding group status
 * - Entity locations (lat/lng for proximity routing)
 * - Individual LL pricing history
 *
 * No authentication required. Community-maintained.
 * Rate limit: be respectful (~1 req/5s per endpoint).
 */
export class ThemeParksWikiClient {
  private static readonly BASE_URL = 'https://api.themeparks.wiki/v1';
  private lastRequestTime: number = 0;
  private static readonly MIN_INTERVAL_MS = 5000; // 5s between requests

  // WDW Park entity IDs on ThemeParks.wiki
  private static readonly PARK_IDS: Record<string, string> = {
    // Walt Disney World
    MK: '75ea578a-adc8-4116-a54d-dccb60765ef9',
    EP: '47f90d2c-e191-4239-a466-5892ef59a88b',
    HS: '288747d1-8b4f-4a64-867e-ea7c9b27bad8',
    AK: '1c84a229-8862-4648-9c71-eb509571d8f0',
    // Disneyland Resort
    DL: '7340550b-c14d-4def-80bb-acdb51d49a66',
    DCA: '832fcd51-ea19-4e77-85c7-75571f919b33',
  };

  /**
   * Get live data for a park: wait times, showtimes, LL/VQ status.
   * This is the richest endpoint — returns everything at once.
   */
  async getLiveData(parkSlug: string): Promise<ThemeParksLiveData[]> {
    const entityId = ThemeParksWikiClient.PARK_IDS[parkSlug];
    if (!entityId) {
      console.warn(`[ThemeParksWiki] Unknown park slug: ${parkSlug}`);
      return [];
    }

    const response = await this.request<{
      liveData: ThemeParksLiveData[];
    }>(`/entity/${entityId}/live`);

    return response?.liveData ?? [];
  }

  /**
   * Get park schedule for the next 30 days.
   * Returns opening/closing times, extra magic hours, ticketed events.
   */
  async getSchedule(parkSlug: string): Promise<ThemeParksScheduleEntry[]> {
    const entityId = ThemeParksWikiClient.PARK_IDS[parkSlug];
    if (!entityId) return [];

    const response = await this.request<{
      schedule: ThemeParksScheduleEntry[];
    }>(`/entity/${entityId}/schedule`);

    return response?.schedule ?? [];
  }

  /**
   * Get schedule for a specific month. Useful for trip planning.
   */
  async getScheduleForMonth(
    parkSlug: string,
    year: number,
    month: number
  ): Promise<ThemeParksScheduleEntry[]> {
    const entityId = ThemeParksWikiClient.PARK_IDS[parkSlug];
    if (!entityId) return [];

    const paddedMonth = month.toString().padStart(2, '0');
    const response = await this.request<{
      schedule: ThemeParksScheduleEntry[];
    }>(`/entity/${entityId}/schedule/${year}/${paddedMonth}`);

    return response?.schedule ?? [];
  }

  /**
   * Get all child entities for a park (rides, shows, restaurants).
   * Includes lat/lng for proximity-based routing in the ItineraryProcessor.
   */
  async getEntities(parkSlug: string): Promise<ThemeParksEntity[]> {
    const entityId = ThemeParksWikiClient.PARK_IDS[parkSlug];
    if (!entityId) return [];

    const response = await this.request<{
      children: ThemeParksEntity[];
    }>(`/entity/${entityId}/children`);

    return response?.children ?? [];
  }

  /**
   * Get entity details for a specific attraction/show.
   */
  async getEntityDetails(entityId: string): Promise<ThemeParksEntity | null> {
    const response = await this.request<ThemeParksEntity>(`/entity/${entityId}`);
    return response ?? null;
  }

  // ── Convenience Methods ────────────────────────────────────

  /**
   * Extract showtimes from live data. Filters to just shows/entertainment
   * with upcoming times (parades, fireworks, character meets).
   */
  async getShowtimes(parkSlug: string): Promise<ShowtimeInfo[]> {
    const liveData = await this.getLiveData(parkSlug);

    return liveData
      .filter(entity =>
        entity.showtimes && entity.showtimes.length > 0 &&
        entity.status !== 'CLOSED'
      )
      .map(entity => ({
        id: entity.id,
        name: entity.name,
        type: entity.entityType,
        status: entity.status,
        showtimes: (entity.showtimes ?? [])
          .filter(st => st.startTime !== null)
          .map(st => ({
            startTime: st.startTime!,
            endTime: st.endTime ?? null,
            type: st.type,
          })),
      }))
      .filter(s => s.showtimes.length > 0);
  }

  /**
   * Get LL return time status from ThemeParks.wiki (free-tier alternative).
   * This doesn't require Disney auth — useful for users without premium.
   */
  async getLLReturnTimeStatus(parkSlug: string): Promise<LLReturnTimeInfo[]> {
    const liveData = await this.getLiveData(parkSlug);

    return liveData
      .filter(entity => entity.queue?.RETURN_TIME || entity.queue?.PAID_RETURN_TIME)
      .map(entity => ({
        id: entity.id,
        name: entity.name,
        flex: entity.queue?.RETURN_TIME ? {
          state: entity.queue.RETURN_TIME.state,
          returnStart: entity.queue.RETURN_TIME.returnStart,
          returnEnd: entity.queue.RETURN_TIME.returnEnd,
        } : undefined,
        individual: entity.queue?.PAID_RETURN_TIME ? {
          state: entity.queue.PAID_RETURN_TIME.state,
          returnStart: entity.queue.PAID_RETURN_TIME.returnStart,
          returnEnd: entity.queue.PAID_RETURN_TIME.returnEnd,
          price: entity.queue.PAID_RETURN_TIME.price ?? undefined,
        } : undefined,
      }));
  }

  /**
   * Get VQ boarding group status for all active queues in a park.
   */
  async getVQStatus(parkSlug: string): Promise<VQStatusInfo[]> {
    const liveData = await this.getLiveData(parkSlug);

    return liveData
      .filter(entity => entity.queue?.BOARDING_GROUP)
      .map(entity => ({
        id: entity.id,
        name: entity.name,
        allocationStatus: entity.queue!.BOARDING_GROUP!.allocationStatus,
        currentGroupStart: entity.queue!.BOARDING_GROUP!.currentGroupStart,
        currentGroupEnd: entity.queue!.BOARDING_GROUP!.currentGroupEnd,
        nextAllocationTime: entity.queue!.BOARDING_GROUP!.nextAllocationTime,
        estimatedWait: entity.queue!.BOARDING_GROUP!.estimatedWait,
      }));
  }

  /**
   * Build a location map of all entities in a park.
   * Used for proximity-based routing in ItineraryProcessor.
   */
  async getLocationMap(parkSlug: string): Promise<Map<string, { lat: number; lng: number }>> {
    const entities = await this.getEntities(parkSlug);
    const map = new Map<string, { lat: number; lng: number }>();

    for (const entity of entities) {
      if (entity.location?.latitude && entity.location?.longitude) {
        map.set(entity.id, {
          lat: entity.location.latitude,
          lng: entity.location.longitude,
        });
      }
    }

    return map;
  }

  // ── Core Request ───────────────────────────────────────────

  private async request<T>(path: string): Promise<T | null> {
    // Rate limit: at least 5s between requests
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < ThemeParksWikiClient.MIN_INTERVAL_MS) {
      await new Promise(resolve =>
        setTimeout(resolve, ThemeParksWikiClient.MIN_INTERVAL_MS - elapsed)
      );
    }
    this.lastRequestTime = Date.now();

    const url = `${ThemeParksWikiClient.BASE_URL}${path}`;

    try {
      const response = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'CastleCompanion/1.0 (https://castlecompanion.com)',
        },
      });

      if (!response.ok) {
        console.error(`[ThemeParksWiki] ${path} returned ${response.status}`);
        return null;
      }

      return await response.json() as T;
    } catch (error) {
      console.error(`[ThemeParksWiki] Request failed for ${path}:`, error);
      return null;
    }
  }
}

// ── Types ────────────────────────────────────────────────────────────

export interface ShowtimeInfo {
  id: string;
  name: string;
  type: string;
  status: string;
  showtimes: Array<{
    startTime: string;
    endTime: string | null;
    type: string;
  }>;
}

export interface LLReturnTimeInfo {
  id: string;
  name: string;
  flex?: {
    state: string;
    returnStart: string | null;
    returnEnd: string | null;
  };
  individual?: {
    state: string;
    returnStart: string | null;
    returnEnd: string | null;
    price?: { amount: number; currency: string; formatted: string };
  };
}

export interface VQStatusInfo {
  id: string;
  name: string;
  allocationStatus: string;
  currentGroupStart: number | null;
  currentGroupEnd: number | null;
  nextAllocationTime: string | null;
  estimatedWait: number | null;
}
