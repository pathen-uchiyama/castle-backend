/**
 * RepeatVoteScoring.ts — Priority weighting for ride repeat voting
 * 
 * Core logic: A ride requested ×3 gets 3× the priority weight of a single ride.
 * Used by the itinerary engine to determine scheduling order and LL snipe priority.
 */

export interface RidePreference {
  attractionId: string;
  attractionName: string;
  parkId: string;
  repeatCount: number;       // 1-5
  priorityTier: 'must_do' | 'like_to' | 'will_avoid';
  priorityRank: number;      // 1 = highest within tier
}

export interface ScoredRide {
  attractionId: string;
  attractionName: string;
  parkId: string;
  /** Composite score: higher = schedule first */
  score: number;
  /** How many separate LL snipe jobs to queue */
  snipeJobCount: number;
  /** Which instances to schedule (e.g., [1,2,3] for ×3) */
  instances: number[];
  /** Original preference data */
  preference: RidePreference;
}

// ─── Tier Weights ───────────────────────────────────────────────────

const TIER_WEIGHTS: Record<string, number> = {
  must_do: 100,
  like_to: 50,
  will_avoid: 0,  // Excluded from itinerary generation
};

// ─── Scoring Function ───────────────────────────────────────────────

/**
 * Calculate priority score for a single ride preference.
 * 
 * Formula: (tierWeight × repeatCount) + (maxRank - priorityRank)
 * 
 * Examples:
 *   Must-Do, ×3, rank 1 → (100 × 3) + (20 - 1) = 319
 *   Must-Do, ×1, rank 2 → (100 × 1) + (20 - 2) = 118
 *   Like-to, ×2, rank 1 → (50 × 2) + (20 - 1) = 119
 * 
 * This ensures:
 *   - Must-Do ×3 always outscores Must-Do ×1
 *   - Within same tier+repeat, rank breaks ties
 *   - Will-Avoid always scores 0 (filtered out)
 */
export function scoreRidePreference(pref: RidePreference): ScoredRide {
  const MAX_RANK = 20; // Max rides in a preference list
  const tierWeight = TIER_WEIGHTS[pref.priorityTier] || 0;
  const repeatMultiplier = Math.min(Math.max(pref.repeatCount, 1), 5);
  const rankBonus = MAX_RANK - Math.min(pref.priorityRank, MAX_RANK);

  const score = (tierWeight * repeatMultiplier) + rankBonus;

  return {
    attractionId: pref.attractionId,
    attractionName: pref.attractionName,
    parkId: pref.parkId,
    score,
    snipeJobCount: pref.priorityTier === 'will_avoid' ? 0 : repeatMultiplier,
    instances: Array.from({ length: repeatMultiplier }, (_, i) => i + 1),
    preference: pref,
  };
}

// ─── Batch Scoring ──────────────────────────────────────────────────

/**
 * Score and rank all ride preferences for a trip.
 * Returns sorted array (highest priority first), with will_avoid excluded.
 */
export function scoreAllPreferences(prefs: RidePreference[]): ScoredRide[] {
  return prefs
    .filter(p => p.priorityTier !== 'will_avoid')
    .map(scoreRidePreference)
    .sort((a, b) => b.score - a.score);
}

// ─── Spacing Logic ──────────────────────────────────────────────────

/**
 * For repeated rides, calculate optimal time spacing.
 * We don't want Space Mountain ×3 scheduled back-to-back.
 * 
 * Strategy:
 *   - If ×2: morning + evening (at least 3 hours apart)
 *   - If ×3: morning + midday + evening (at least 2 hours apart)
 *   - If ×4: spread across day (at least 1.5 hours apart)
 *   - If ×5: earliest opportunity + fill gaps
 * 
 * Returns minimum minutes between instances.
 */
export function getMinSpacingMinutes(repeatCount: number): number {
  switch (repeatCount) {
    case 1: return 0;
    case 2: return 180;   // 3 hours
    case 3: return 120;   // 2 hours
    case 4: return 90;    // 1.5 hours
    case 5: return 60;    // 1 hour
    default: return 60;
  }
}

// ─── LL Snipe Job Generation ────────────────────────────────────────

export interface SnipeJobRequest {
  attractionId: string;
  attractionName: string;
  instance: number;           // "Space Mountain (2 of 3)"
  totalInstances: number;
  preferredTimeWindow: string; // 'morning' | 'midday' | 'evening'
  priority: number;           // From score
}

/**
 * Generate snipe job requests for a scored ride.
 * Each instance gets its own LL snipe job with a preferred time window.
 */
export function generateSnipeJobs(scored: ScoredRide): SnipeJobRequest[] {
  const timeWindows = ['morning', 'midday', 'evening', 'morning', 'evening'];

  return scored.instances.map((instance, i) => ({
    attractionId: scored.attractionId,
    attractionName: scored.attractionName,
    instance,
    totalInstances: scored.snipeJobCount,
    preferredTimeWindow: timeWindows[i] || 'morning',
    priority: scored.score,
  }));
}
