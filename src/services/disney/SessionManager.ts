import Redis from 'ioredis';
import { getSupabaseClient } from '../../config/supabase';
import { env } from '../../config/env';
import { DisneyAuthData, ResortId } from './types';
import { HumanMimicry } from './HumanMimicry';

/**
 * SessionManager — Per-Skipper authenticated session pool.
 *
 * Manages Disney auth sessions (SWID + access token) across
 * the Skipper account pool. Sessions are stored in:
 * - Redis (hot cache, fast lookup, TTL-based expiry)
 * - Supabase skipper_sessions table (persistent backup)
 *
 * Responsibilities:
 * - Get an authenticated session for a specific Skipper
 * - Get ANY healthy session for a resort (health probes)
 * - Auto-detect expired tokens and trigger re-auth
 * - Rotate fingerprints on session refresh
 */
export class SessionManager {
  private redis: Redis;
  private mimicry: HumanMimicry;
  private static readonly SESSION_PREFIX = 'disney:session:';
  private static readonly SESSION_TTL_S = 43200; // 12 hours

  constructor(mimicry: HumanMimicry) {
    this.redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
    this.mimicry = mimicry;
  }

  /**
   * Get an authenticated Disney session for a specific Skipper.
   * Returns null if no session exists or token is expired.
   */
  async getSession(skipperId: string): Promise<SkipperSession | null> {
    // Try Redis first
    try {
      const stored = await this.redis.get(SessionManager.SESSION_PREFIX + skipperId);
      if (stored) {
        const session = JSON.parse(stored) as StoredSession;
        if (this.isSessionValid(session)) {
          return this.buildSession(skipperId, session);
        }
        // Expired — clear from Redis
        await this.redis.del(SessionManager.SESSION_PREFIX + skipperId);
      }
    } catch (err) {
      console.warn(`[SessionManager] Redis lookup failed for ${skipperId}:`, err);
    }

    // Try Supabase
    try {
      const db = getSupabaseClient();
      const { data } = await db
        .from('skipper_sessions')
        .select('*')
        .eq('skipper_id', skipperId)
        .single();

      if (data && new Date(data.token_expires) > new Date()) {
        const session: StoredSession = {
          swid: data.swid,
          accessToken: data.access_token,
          tokenExpires: data.token_expires,
          deviceId: data.device_id,
          userAgent: data.user_agent,
        };

        // Re-warm Redis
        await this.cacheSession(skipperId, session);
        return this.buildSession(skipperId, session);
      }
    } catch (err) {
      console.warn(`[SessionManager] Supabase lookup failed for ${skipperId}:`, err);
    }

    return null;
  }

  /**
   * Get any healthy session for a given resort. Used by:
   * - Health probes (ping Disney endpoints)
   * - ThemeParks.wiki client (doesn't need specific Skipper)
   */
  async getAnyHealthySession(resort: ResortId = 'WDW'): Promise<SkipperSession | null> {
    try {
      const db = getSupabaseClient();
      const { data } = await db
        .from('skipper_sessions')
        .select('skipper_id, swid, access_token, token_expires, device_id, user_agent')
        .gt('token_expires', new Date().toISOString())
        .limit(1)
        .single();

      if (data) {
        const session: StoredSession = {
          swid: data.swid,
          accessToken: data.access_token,
          tokenExpires: data.token_expires,
          deviceId: data.device_id,
          userAgent: data.user_agent,
        };
        return this.buildSession(data.skipper_id, session);
      }
    } catch (err) {
      console.warn(`[SessionManager] No healthy sessions for ${resort}:`, err);
    }

    return null;
  }

  /**
   * Store a new session after successful Disney authentication.
   */
  async storeSession(
    skipperId: string,
    auth: DisneyAuthData
  ): Promise<SkipperSession> {
    const fp = this.mimicry.rotateFingerprint(skipperId);

    const session: StoredSession = {
      swid: auth.swid,
      accessToken: auth.accessToken,
      tokenExpires: auth.tokenExpires.toISOString(),
      deviceId: fp.deviceId,
      userAgent: fp.userAgent,
    };

    // Store in Redis
    await this.cacheSession(skipperId, session);

    // Store in Supabase (upsert)
    try {
      const db = getSupabaseClient();
      await db
        .from('skipper_sessions')
        .upsert({
          skipper_id: skipperId,
          swid: auth.swid,
          access_token: auth.accessToken,
          token_expires: auth.tokenExpires.toISOString(),
          device_id: fp.deviceId,
          user_agent: fp.userAgent,
          last_used_at: new Date().toISOString(),
        }, { onConflict: 'skipper_id' });
    } catch (err) {
      console.error(`[SessionManager] Supabase store failed for ${skipperId}:`, err);
    }

    console.log(`[SessionManager] Session stored for Skipper ${skipperId} (expires: ${auth.tokenExpires.toISOString()})`);
    return this.buildSession(skipperId, session);
  }

  /**
   * Invalidate a Skipper's session (e.g., after a 401 from Disney).
   */
  async invalidateSession(skipperId: string): Promise<void> {
    await this.redis.del(SessionManager.SESSION_PREFIX + skipperId);

    try {
      const db = getSupabaseClient();
      await db
        .from('skipper_sessions')
        .delete()
        .eq('skipper_id', skipperId);
    } catch (err) {
      console.error(`[SessionManager] Supabase delete failed for ${skipperId}:`, err);
    }

    this.mimicry.rotateFingerprint(skipperId);
    console.log(`[SessionManager] Session invalidated for Skipper ${skipperId}`);
  }

  /**
   * Update the last_used_at timestamp for a session.
   */
  async touchSession(skipperId: string): Promise<void> {
    try {
      const db = getSupabaseClient();
      await db
        .from('skipper_sessions')
        .update({ last_used_at: new Date().toISOString() })
        .eq('skipper_id', skipperId);
    } catch (err) {
      // Non-fatal
    }
  }

  /**
   * Get all Skipper IDs with sessions expiring within the next N minutes.
   * Used by the session-refresh BullMQ job.
   */
  async getExpiringSessions(withinMinutes: number = 60): Promise<string[]> {
    try {
      const db = getSupabaseClient();
      const cutoff = new Date(Date.now() + withinMinutes * 60 * 1000).toISOString();
      const { data } = await db
        .from('skipper_sessions')
        .select('skipper_id')
        .lt('token_expires', cutoff)
        .gt('token_expires', new Date().toISOString());

      return (data ?? []).map(row => row.skipper_id);
    } catch (err) {
      console.error('[SessionManager] Failed to get expiring sessions:', err);
      return [];
    }
  }

  /**
   * Count active sessions.
   */
  async getActiveSessionCount(): Promise<number> {
    try {
      const db = getSupabaseClient();
      const { count } = await db
        .from('skipper_sessions')
        .select('*', { count: 'exact', head: true })
        .gt('token_expires', new Date().toISOString());
      return count ?? 0;
    } catch (err) {
      return 0;
    }
  }

  // ── Private ────────────────────────────────────────────────

  private async cacheSession(skipperId: string, session: StoredSession): Promise<void> {
    await this.redis.set(
      SessionManager.SESSION_PREFIX + skipperId,
      JSON.stringify(session),
      'EX',
      SessionManager.SESSION_TTL_S
    );
  }

  private isSessionValid(session: StoredSession): boolean {
    return new Date(session.tokenExpires) > new Date();
  }

  private buildSession(skipperId: string, stored: StoredSession): SkipperSession {
    return {
      skipperId,
      swid: stored.swid,
      accessToken: stored.accessToken,
      tokenExpires: new Date(stored.tokenExpires),
      deviceId: stored.deviceId ?? undefined,
      userAgent: stored.userAgent ?? undefined,
      getHeaders: () => this.mimicry.buildHeaders(skipperId, {
        swid: stored.swid,
        accessToken: stored.accessToken,
      }),
    };
  }
}

// ── Types ────────────────────────────────────────────────────────────

interface StoredSession {
  swid: string;
  accessToken: string;
  tokenExpires: string;
  deviceId?: string | null;
  userAgent?: string | null;
}

export interface SkipperSession {
  skipperId: string;
  swid: string;
  accessToken: string;
  tokenExpires: Date;
  deviceId?: string;
  userAgent?: string;
  getHeaders: () => Record<string, string>;
}
