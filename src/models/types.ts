export type ResortID = 'DL' | 'WDW';
export type ParkID = 'MK' | 'EP' | 'HS' | 'AK' | 'DL' | 'DCA';
export type SubscriptionTier = 'explorer' | 'strategic_parent' | 'plaid_guardian';
export type SubscriptionStatus = 'active' | 'past_due' | 'canceled' | 'none';


export interface ParkRule {
    resort_id: ResortID;
    dining_window_days: number;
    ll_booking_window_resort: number;
    ll_booking_window_other: number;
    has_tiers: boolean;
    transport_buffer_mins: number;
    virtual_queue_times: string[];
}
export type StepStatus = 'pending' | 'completed' | 'skipped' | 'down';
export type StepType = 'ride' | 'character' | 'food' | 'transport' | 'break' | 'show' | 'snack';

export interface StrategyProfile {
    strategyType: 'A' | 'B'; // A = Strategist (Options), B = Believer (Curated Auto-Routes)
    pacingFilter: 'intense' | 'moderate' | 'relaxed';
    primaryFocus: 'thrills' | 'toddlers' | 'classic' | 'shows';
    diningStyle: 'snacks' | 'quick' | 'table' | 'signature';
    singleRiderAllowed: boolean;
    dasAllowed: boolean;
    onSiteResort: boolean;
    arrivalIntent?: 'rope-drop' | 'leisurely' | 'evening-only';
    splurgeAppetite: 'low' | 'moderate' | 'high';
    premiumInterests: string[];
    diningReservationIntent?: boolean;
    budgetDirectives: {
        llMultiPassAllowed: boolean;
        llSinglePassAllowed: boolean;
        autoPurchasePhotoPass: boolean;
        allowMerchandiseUpcharges: boolean;
        allowReservedSeatingPackages: boolean;
    };
    rideDirectives: {
        maxWaitToleranceMins: number;
        thrillCap: 'Low' | 'Moderate' | 'High';
        prioritizeIndoor: boolean;
        minimizeWalking: boolean; // Clustering logic
        strobeSensitivity?: boolean;
        loudNoiseSensitivity?: boolean;
    };
}

export type ArrivalIntent = 'Rope Drop' | 'Standard' | 'Late Start' | 'Evening Only';

export interface Ride {
    id: string;
    park_id: ParkID;
    name: string;
    land: string; // e.g., 'Tomorrowland', 'Galaxy's Edge'
    height_requirement_cm?: number;
    intensity?: string;
    sensory_tags?: string[];
}

export interface Guest {
    id: string;
    name: string;
    age: number;
    height_cm: number;
    stroller_required: boolean;
    is_first_timer?: boolean;
    sensory_sensitivities?: string[];
    memberships?: {
        wdw_ap_tier?: string;
        dl_ap_tier?: string;
    };
}

export interface Preference {
    item_id: string;
    item_type: StepType;
    guest_id: string;
    rank: 'must-do' | 'like-to-do' | 'neutral' | 'skip';
}

export interface ItineraryStep {
    id: string;
    trip_id: string;
    park_id: ParkID;
    step_name: string;
    step_type: StepType;
    planned_start: string; // ISO date string
    actual_start?: string;
    planned_wait?: number;
    actual_wait?: number;
    status: StepStatus;
    is_pivot: boolean;
    nudge_id?: string;
    duration_mins?: number;
    notes?: string;
    logistical_shadow?: number;
    recovery_buffer?: number;
    extra_buffers?: {
        pre: number;
        post: number;
    };
    intensity?: string;
    sensory_tags?: string[];
}

// ── Phase 5A: Park Status & Closure Registry ──────────────────────────

export type AttractionOperatingStatus = 'OPEN' | 'CLOSED' | 'REFURB' | 'DELAYED' | 'WEATHER_HOLD';

export interface AttractionStatus {
    attractionId: string;
    name: string;
    parkId: ParkID;
    status: AttractionOperatingStatus;
    currentWaitMins?: number;
    lastUpdated: string; // ISO timestamp
    closureReason?: string; // e.g., "Muppet retheme", "Permanent closure for Indiana Jones"
    reopenDate?: string;   // ISO date or "TBD"
    alternativeIds?: string[]; // Pre-computed nearby pivot options
}

export interface ParkClosure {
    attractionId: string;
    name: string;
    parkId: ParkID;
    closureType: 'temporary' | 'permanent' | 'seasonal' | 'refurbishment';
    closureStart: string;
    closureEnd?: string;
    reason: string;
    alternativeNames: string[];
}

// ── Phase 5C: Notification & Haptic Protocol ──────────────────────────

export type HapticPattern = 'DOUBLE_TAP' | 'LONG_VIBRATION' | 'TRIPLE_PULSE' | 'GENTLE_NUDGE';
export type NudgeType = 'PIVOT' | 'RAIN_ALERT' | 'DINING_HANDOFF' | 'SHOWTIME_SHIFT' | 'LL_READY' | 'GENERAL' | 'VQ_SUCCESS' | 'VQ_FAILED' | 'RIDE_UPDATE';

export interface NudgePayload {
    nudgeType: NudgeType;
    hapticPattern: HapticPattern;
    message: string;          // Concise, glanceable text (< 3 sentences)
    actionLink?: string;      // Deep link (e.g., "mde://dining/reservation/confirm?id=12345")
    funSeekTrigger?: string;  // Optional lore hint
    expiresAt?: string;       // ISO timestamp for time-sensitive nudges
    priority: 'low' | 'medium' | 'high' | 'critical';
}

// ── Phase 10: Infrastructure Efficiency & Telemetry ──────────────────

export interface SystemMetric {
    apiLatency: number;
    successRate: number;
    activeUsers: number;
    activeBots: number;
    errorCount: number;
    revenue: number;
    minutesSavedTotal: number;
    proxyDataGB: number;
    tokenBurn: number;
    captchaSuccessRate: number;
    zombieCount: number;
    timestamp: number;
}
