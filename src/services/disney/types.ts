/**
 * Disney API Types — Clean Room Implementation
 *
 * All types derived from publicly observable API behavior and
 * factual endpoint documentation. No GPL-licensed code copied.
 */

// ── Resort Configuration ─────────────────────────────────────────────

export type ResortId = 'WDW' | 'DLR';

export interface ResortConfig {
  id: ResortId;
  name: string;
  origins: {
    main: string;     // disneyworld.disney.go.com or disneyland.disney.go.com
    vq: string;       // vqguest-svc-wdw.wdprapps.disney.com
  };
  parks: ParkConfig[];
}

export interface ParkConfig {
  id: string;         // Disney's internal park entity ID
  name: string;
  slug: string;       // MK, EP, HS, AK, DL, DCA
  themeparksWikiId?: string;  // ThemeParks.wiki entity ID
}

export const WDW_CONFIG: ResortConfig = {
  id: 'WDW',
  name: 'Walt Disney World',
  origins: {
    main: 'https://disneyworld.disney.go.com',
    vq: 'https://vqguest-svc-wdw.wdprapps.disney.com',
  },
  parks: [
    { id: '80007944', name: 'Magic Kingdom', slug: 'MK' },
    { id: '80007838', name: 'EPCOT', slug: 'EP' },
    { id: '80007998', name: "Hollywood Studios", slug: 'HS' },
    { id: '80007823', name: 'Animal Kingdom', slug: 'AK' },
  ],
};

export const DLR_CONFIG: ResortConfig = {
  id: 'DLR',
  name: 'Disneyland Resort',
  origins: {
    main: 'https://disneyland.disney.go.com',
    vq: 'https://vqguest-svc.wdprapps.disney.com',
  },
  parks: [
    { id: '330339', name: 'Disneyland', slug: 'DL' },
    { id: '336894', name: 'Disney California Adventure', slug: 'DCA' },
  ],
};

// ── Authentication ───────────────────────────────────────────────────

export interface DisneyAuthData {
  swid: string;           // Subscriber-Wide ID (e.g., "{GUID}")
  accessToken: string;    // Bearer token
  tokenExpires: Date;     // Expiration (typically ~5 PM park time daily)
  refreshToken?: string;  // If available
}

export interface DisneyAuthHeaders {
  'Accept-Language': string;
  'Authorization': string;
  'x-user-id': string;
  'User-Agent'?: string;
}

// ── Experience / Attraction ──────────────────────────────────────────

export type UnavailableReason =
  | 'TEMPORARILY_DOWN'
  | 'CLOSED'
  | 'REFURBISHMENT'
  | 'NOT_YET_OPEN'
  | 'NO_MORE_SHOWS';

export interface StandbyInfo {
  available: boolean;
  waitTime?: number;              // Minutes
  unavailableReason?: UnavailableReason;
}

export interface FlexInfo {                  // LL Multi Pass
  available: boolean;
  nextAvailableTime?: string;     // HH:mm:ss format
  enrollmentStartTime?: string;
}

export interface IndividualInfo {             // LL Single Pass (paid)
  available: boolean;
  displayPrice?: string;          // e.g., "$20.00"
  nextAvailableTime?: string;
}

export interface VirtualQueueInfo {
  available: boolean;
  nextAvailableTime?: string;
}

export interface DisneyExperience {
  id: string;                     // Disney facility ID
  type: 'ATTRACTION' | 'ENTERTAINMENT' | 'CHARACTER';
  name?: string;
  standby: StandbyInfo;
  flex?: FlexInfo;
  individual?: IndividualInfo;
  virtualQueue?: VirtualQueueInfo;
}

// ── Guest Eligibility ────────────────────────────────────────────────

export type IneligibleReason =
  | 'INVALID_PARK_ADMISSION'
  | 'PARK_RESERVATION_NEEDED'
  | 'GENIE_PLUS_NEEDED'
  | 'EXPERIENCE_LIMIT_REACHED'
  | 'TOO_EARLY'
  | 'TOO_EARLY_FOR_PARK_HOPPING'
  | 'MULTI_PASS_NEEDED'
  | 'REDEMPTION_NEEDED'
  | 'TIER_LIMIT_REACHED'
  | 'UNKNOWN';

export interface DisneyGuest {
  id: string;                     // Disney guest ID
  name?: string;
  avatarUrl?: string;
  primary?: boolean;
  orderDetails?: {
    externalIdentifier: string;
    [key: string]: unknown;
  };
}

export interface IneligibleGuest extends DisneyGuest {
  ineligibleReason: IneligibleReason;
  isSoftConflict?: boolean;
  conflictingFacilityIds?: string[];
}

export interface GuestEligibility {
  eligible: DisneyGuest[];
  ineligible: IneligibleGuest[];
}

// ── Offers (Pre-Booking) ─────────────────────────────────────────────

export interface DisneyOffer {
  offerSetId: string;
  offerId: string;
  experienceId: string;
  startDateTime: string;          // ISO 8601
  endDateTime: string;            // ISO 8601
  offerType: 'FLEX';
  guests: GuestEligibility;
  itinerary: OfferItineraryItem[];
  parkHours?: {
    openTime: string;
    closeTime: string;
  };
  expiresInSeconds?: number;
}

export interface OfferItineraryItem {
  type: 'OFFER_ITEM' | 'EXISTING_ITEM' | 'EVENT_ITEM';
  facilityId: string;
  startDateTime: string;
  startTime: string;
  endDateTime?: string;
  endTime?: string;
  showTimeInfo?: {
    showStartTime: string;
    showEndTime: string;
  };
  // Extended on EXISTING_ITEM:
  id?: string;                    // Entitlement ID
  // Extended on EVENT_ITEM:
  eventType?: 'PARK_OPEN' | 'PARK_CLOSE';
}

export interface HourlyTimeSlot {
  startTime: string;              // HH:mm:ss
}

// ── Bookings (Confirmed) ─────────────────────────────────────────────

export interface DisneyBooking {
  experienceId: string;
  startDateTime: string;
  endDateTime: string;
  guests: BookingGuest[];
}

export interface BookingGuest {
  guestId: string;
  entitlementId: string;          // The booking confirmation ID
}

export interface ConfirmedReservation {
  facilityId: string;
  name: string;
  type: 'LL';
  subtype: 'MP' | 'SP';          // Multi Pass or Single Pass
  entitlementId: string;
  start: string;                  // ISO 8601
  end: string;                    // ISO 8601
  cancellable: boolean;
  modifiable: boolean;
  guests: BookingGuest[];
}

// ── Virtual Queue ────────────────────────────────────────────────────

export interface VQQueue {
  queueId: string;
  name: string;
  isAcceptingJoins: boolean;
  maxPartySize?: number;
  nextScheduledOpenTime?: string;
  currentGroupStart?: number;
  currentGroupEnd?: number;
}

export interface VQLinkedGuest {
  id: string;
  firstName: string;
  lastName: string;
  avatarUrl?: string;
  isPrimaryGuest?: boolean;
}

export type VQJoinStatus = 'OK' | 'INVALID_GUEST' | 'CLOSED' | 'NOT_IN_PARK' | 'ALREADY_IN_QUEUE' | 'UNKNOWN_ERROR';

export interface VQJoinResult {
  status: VQJoinStatus;
  boardingGroup?: number;
  conflicts: Record<string, string>;  // guestId → reason
  closed: boolean;
}

// ── Endpoint Registry ────────────────────────────────────────────────

export interface EndpointMap {
  /** Lightning Lane */
  ll: {
    experiences: string;           // GET — availability per park
    guests: string;                // POST — guest eligibility
    availabilityBundle: string;    // POST — tier availability
    offerGenerate: string;         // POST — create pre-book offer
    offerGenerateMod: string;      // POST — create modification offer
    offerTimes: string;            // POST — list time slots
    offerTimesFulfill: string;     // POST — select time slot
    offerTimesModFulfill: string;  // POST — select time slot (mod)
    book: string;                  // POST — confirm booking
    bookMod: string;               // POST — confirm modification
    cancel: string;                // DELETE — cancel entitlements
  };
  /** Virtual Queue */
  vq: {
    getQueues: string;             // POST — list active queues
    getLinkedGuests: string;       // POST — guests for queue selection
    joinQueue: string;             // POST — join a queue
  };
}

export const DEFAULT_ENDPOINT_MAP: EndpointMap = {
  ll: {
    experiences: '/tipboard-vas/planning/v1/parks/{parkId}/experiences/',
    guests: '/ea-vas/planning/api/v1/experiences/guest/guests',
    availabilityBundle: '/ea-vas/planning/api/v1/experiences/availability/bundles/experiences',
    offerGenerate: '/ea-vas/planning/api/v1/experiences/offerset/generate',
    offerGenerateMod: '/ea-vas/planning/api/v1/experiences/mod/offerset/generate',
    offerTimes: '/ea-vas/planning/api/v1/experiences/offerset/times',
    offerTimesFulfill: '/ea-vas/planning/api/v1/experiences/offerset/times/fulfill',
    offerTimesModFulfill: '/ea-vas/planning/api/v1/experiences/mod/offerset/times/fulfill',
    book: '/ea-vas/planning/api/v1/experiences/entitlements/book',
    bookMod: '/ea-vas/planning/api/v1/experiences/mod/entitlements/book',
    cancel: '/ea-vas/api/v1/entitlements/{entitlementIds}',
  },
  vq: {
    getQueues: '/application/v1/guest/getQueues',
    getLinkedGuests: '/application/v1/guest/getLinkedGuests',
    joinQueue: '/application/v1/guest/joinQueue',
  },
};

// ── Request / Response Wrappers ──────────────────────────────────────

export interface DisneyRequestConfig {
  path: string;
  method?: 'GET' | 'POST' | 'DELETE';
  origin?: string;                 // Override default origin
  params?: Record<string, string>; // URL query params
  data?: Record<string, unknown>;  // POST body
  skipAuth?: boolean;              // For unauthenticated requests
  skipperId?: string;              // Which Skipper session to use
}

export interface DisneyResponse<T = unknown> {
  status: number;
  data: T;
  headers: Record<string, string>;
  latencyMs: number;
}

// ── Circuit Breaker ──────────────────────────────────────────────────

export enum CircuitState {
  CLOSED = 'CLOSED',       // Normal: requests flow through
  HALF_OPEN = 'HALF_OPEN', // Testing: one probe request
  OPEN = 'OPEN',           // Tripped: all requests blocked
}

export interface EndpointHealth {
  endpoint: string;
  state: CircuitState;
  failureCount: number;
  lastFailure: string | null;
  lastSuccess: string | null;
  lastErrorCode: number | null;
  lastErrorBody: string | null;
}

// ── BG1 Sync ─────────────────────────────────────────────────────────

export type SyncClassification = 'auto_patched' | 'manual_review' | 'ignored';

export interface BG1Commit {
  sha: string;
  message: string;
  date: string;
  filesChanged: string[];
}

export interface SyncLogEntry {
  commitSha: string;
  commitMessage: string;
  filesChanged: string[];
  classification: SyncClassification;
  patchApplied?: Record<string, { old: string; new: string }>;
  alertSent: boolean;
  processedAt: string;
}

// ── ThemeParks.wiki ──────────────────────────────────────────────────

export type LiveStatusType = 'OPERATING' | 'DOWN' | 'CLOSED' | 'REFURBISHMENT';
export type ReturnTimeState = 'AVAILABLE' | 'TEMP_FULL' | 'FINISHED';
export type BoardingGroupState = 'AVAILABLE' | 'PAUSED' | 'CLOSED';

export interface ThemeParksLiveData {
  id: string;
  name: string;
  entityType: 'ATTRACTION' | 'SHOW' | 'RESTAURANT';
  status: LiveStatusType;
  lastUpdated: string;
  queue?: {
    STANDBY?: { waitTime: number | null };
    SINGLE_RIDER?: { waitTime: number | null };
    RETURN_TIME?: {
      state: ReturnTimeState;
      returnStart: string | null;
      returnEnd: string | null;
    };
    PAID_RETURN_TIME?: {
      state: ReturnTimeState;
      returnStart: string | null;
      returnEnd: string | null;
      price?: { amount: number; currency: string; formatted: string };
    };
    BOARDING_GROUP?: {
      allocationStatus: BoardingGroupState;
      currentGroupStart: number | null;
      currentGroupEnd: number | null;
      nextAllocationTime: string | null;
      estimatedWait: number | null;
    };
  };
  showtimes?: Array<{
    type: string;
    startTime: string | null;
    endTime: string | null;
  }>;
}

export interface ThemeParksScheduleEntry {
  date: string;          // YYYY-MM-DD
  openingTime: string;   // ISO 8601
  closingTime: string;   // ISO 8601
  type: 'OPERATING' | 'TICKETED_EVENT' | 'EXTRA_HOURS' | 'PRIVATE_EVENT';
}

export interface ThemeParksEntity {
  id: string;
  name: string;
  entityType: 'DESTINATION' | 'PARK' | 'ATTRACTION' | 'RESTAURANT' | 'HOTEL' | 'SHOW';
  location?: { latitude: number; longitude: number } | null;
}

// ── Historical Wait Time Analytics ───────────────────────────────────

export interface WaitTimeSnapshot {
  parkId: string;
  attractionId: string;
  waitMinutes: number | null;
  isOpen: boolean;
  statusString?: string;
  llPrice?: string;
  llState?: string;
  recordedAt: string;
}

export interface HistoricalAverage {
  attractionId: string;
  attractionName?: string;
  dayOfWeek: number;     // 0=Sunday, 6=Saturday
  hourOfDay: number;     // 0-23
  avgWaitMinutes: number;
  sampleCount: number;
}

export interface SellOutPrediction {
  attractionId: string;
  attractionName?: string;
  avgSellOutTime: string;   // HH:mm format — when LL typically becomes unavailable
  confidence: number;        // 0-1 based on sample count
}
