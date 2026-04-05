import { DisneyAuthHeaders } from './types';

/**
 * HumanMimicry — Request middleware for Disney API compliance.
 *
 * Implements the Human Mimicry spec from TRD §2:
 * - Jitter: 200ms-1500ms random delay before each request
 * - Fingerprint rotation: unique UA/device ID per Skipper session
 * - Non-linear pathing: occasional decoy read requests
 * - Rate limiting: max 2 req/s per Skipper (conservative vs BG1's 5)
 *
 * Goal: Make server-side automated requests indistinguishable
 * from a human using the My Disney Experience mobile app.
 */

// ── User-Agent Pool ──────────────────────────────────────────────────
// Realistic MDE app user agents, rotated per Skipper session

const USER_AGENTS = [
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_3_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  'Mozilla/5.0 (iPad; CPU OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  'Mozilla/5.0 (Linux; Android 15; Pixel 9 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 15; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 14; SM-A546B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Mobile Safari/537.36',
];

const ACCEPT_LANGUAGES = [
  'en-US,en;q=0.9',
  'en-US,en;q=0.8',
  'en-US',
  'en-US,en;q=0.9,es;q=0.8',
];

// ── Public API ───────────────────────────────────────────────────────

export class HumanMimicry {
  private readonly minJitterMs: number;
  private readonly maxJitterMs: number;
  private readonly maxRps: number;
  private lastRequestTimes: Map<string, number> = new Map(); // skipperId → last request epoch

  // Per-Skipper fingerprints (stable for session lifetime)
  private fingerprints: Map<string, SkipperFingerprint> = new Map();

  constructor(options?: {
    minJitterMs?: number;
    maxJitterMs?: number;
    maxRpsPerSkipper?: number;
  }) {
    this.minJitterMs = options?.minJitterMs ?? 200;
    this.maxJitterMs = options?.maxJitterMs ?? 1500;
    this.maxRps = options?.maxRpsPerSkipper ?? 2;
  }

  /**
   * Apply jitter delay before a Disney API request.
   * Returns the actual delay applied in ms.
   */
  async applyJitter(): Promise<number> {
    const delay = this.minJitterMs + Math.random() * (this.maxJitterMs - this.minJitterMs);
    // Add slight gaussian noise for more natural distribution
    const noise = this.gaussianNoise() * 100;
    const finalDelay = Math.max(this.minJitterMs, delay + noise);

    await this.sleep(finalDelay);
    return Math.round(finalDelay);
  }

  /**
   * Enforce per-Skipper rate limiting.
   * Blocks if the Skipper is making requests too fast.
   */
  async enforceRateLimit(skipperId: string): Promise<void> {
    const now = Date.now();
    const lastRequest = this.lastRequestTimes.get(skipperId) ?? 0;
    const minInterval = 1000 / this.maxRps; // e.g., 500ms for 2 req/s

    const elapsed = now - lastRequest;
    if (elapsed < minInterval) {
      const waitMs = minInterval - elapsed;
      await this.sleep(waitMs);
    }

    this.lastRequestTimes.set(skipperId, Date.now());
  }

  /**
   * Get or create a stable fingerprint for a Skipper session.
   * These values stay consistent for the lifetime of a session
   * (like a real human's device would).
   */
  getFingerprint(skipperId: string): SkipperFingerprint {
    let fp = this.fingerprints.get(skipperId);
    if (!fp) {
      fp = this.generateFingerprint();
      this.fingerprints.set(skipperId, fp);
    }
    return fp;
  }

  /**
   * Build the full set of HTTP headers for a Disney request,
   * including auth and device fingerprint.
   */
  buildHeaders(
    skipperId: string,
    auth: { swid: string; accessToken: string }
  ): DisneyAuthHeaders & Record<string, string> {
    const fp = this.getFingerprint(skipperId);

    return {
      'Accept': 'application/json',
      'Accept-Language': fp.acceptLanguage,
      'Authorization': `BEARER ${auth.accessToken}`,
      'x-user-id': auth.swid,
      'User-Agent': fp.userAgent,
      'Content-Type': 'application/json',
    };
  }

  /**
   * Rotate a Skipper's fingerprint (e.g., after session refresh).
   */
  rotateFingerprint(skipperId: string): SkipperFingerprint {
    const fp = this.generateFingerprint();
    this.fingerprints.set(skipperId, fp);
    return fp;
  }

  /**
   * Clear all rate limit tracking (useful in tests).
   */
  resetRateLimits(): void {
    this.lastRequestTimes.clear();
  }

  /**
   * Determine if we should make a "decoy" read request
   * before the actual write request (non-linear pathing).
   *
   * Real humans browse the app → check wait times → check their
   * bookings → then book. We mimic this by occasionally
   * interspersing read requests.
   */
  shouldMakeDecoyRequest(): boolean {
    // 30% chance of a decoy before any write operation
    return Math.random() < 0.3;
  }

  /**
   * Get a random "decoy" endpoint path to simulate browsing.
   */
  getDecoyEndpoint(): string {
    const decoys = [
      '/tipboard-vas/planning/v1/parks/{parkId}/experiences/',  // Browse availability
    ];
    return decoys[Math.floor(Math.random() * decoys.length)]!;
  }

  // ── Private ────────────────────────────────────────────────

  private generateFingerprint(): SkipperFingerprint {
    return {
      userAgent: USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]!,
      acceptLanguage: ACCEPT_LANGUAGES[Math.floor(Math.random() * ACCEPT_LANGUAGES.length)]!,
      deviceId: this.generateDeviceId(),
    };
  }

  /**
   * Generate a realistic-looking device ID.
   * Disney uses UUIDs for device identification.
   */
  private generateDeviceId(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  /**
   * Box-Muller transform for gaussian noise.
   * Makes jitter distribution feel more natural than uniform random.
   */
  private gaussianNoise(): number {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ── Types ────────────────────────────────────────────────────────────

export interface SkipperFingerprint {
  userAgent: string;
  acceptLanguage: string;
  deviceId: string;
}
