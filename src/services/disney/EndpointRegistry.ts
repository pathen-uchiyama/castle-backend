import Redis from 'ioredis';
import { getSupabaseClient } from '../../config/supabase';
import { EndpointMap, DEFAULT_ENDPOINT_MAP } from './types';
import { env } from '../../config/env';

/**
 * EndpointRegistry — Hot-swappable Disney API endpoint configuration.
 *
 * Primary storage: Redis (fast reads, survives restarts)
 * Backup storage: Supabase (persistent, audit trail)
 * Default fallback: Hardcoded DEFAULT_ENDPOINT_MAP
 *
 * When the BG1SyncEngine detects a path change from upstream,
 * it patches this registry in Redis. The next DisneyAPIClient
 * request reads the updated path — zero downtime, no redeployment.
 */
export class EndpointRegistry {
  private redis: Redis;
  private static readonly REDIS_KEY = 'disney:endpoints';
  private static readonly VERSION_KEY = 'disney:endpoints:version';
  private cachedEndpoints: EndpointMap | null = null;
  private cacheLoadedAt: number = 0;
  private static readonly CACHE_TTL_MS = 30_000; // Re-read from Redis every 30s

  constructor() {
    this.redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  }

  /**
   * Get the current endpoint map. Reads from:
   * 1. In-memory cache (if fresh)
   * 2. Redis (primary)
   * 3. Supabase (backup)
   * 4. Hardcoded defaults (last resort)
   */
  async getEndpoints(): Promise<EndpointMap> {
    // Check in-memory cache first
    if (this.cachedEndpoints && (Date.now() - this.cacheLoadedAt) < EndpointRegistry.CACHE_TTL_MS) {
      return this.cachedEndpoints;
    }

    // Try Redis
    try {
      const stored = await this.redis.get(EndpointRegistry.REDIS_KEY);
      if (stored) {
        this.cachedEndpoints = JSON.parse(stored) as EndpointMap;
        this.cacheLoadedAt = Date.now();
        return this.cachedEndpoints;
      }
    } catch (err) {
      console.warn('[EndpointRegistry] Redis read failed, falling back:', err);
    }

    // Try Supabase
    try {
      const db = getSupabaseClient();
      const { data } = await db
        .from('disney_endpoint_registry')
        .select('endpoints')
        .eq('is_active', true)
        .order('activated_at', { ascending: false })
        .limit(1)
        .single();

      if (data?.endpoints) {
        const endpoints = data.endpoints as EndpointMap;
        // Warm Redis back up
        await this.redis.set(EndpointRegistry.REDIS_KEY, JSON.stringify(endpoints));
        this.cachedEndpoints = endpoints;
        this.cacheLoadedAt = Date.now();
        return endpoints;
      }
    } catch (err) {
      console.warn('[EndpointRegistry] Supabase read failed, using defaults:', err);
    }

    // Last resort: hardcoded defaults
    console.warn('[EndpointRegistry] Using hardcoded DEFAULT_ENDPOINT_MAP');
    this.cachedEndpoints = DEFAULT_ENDPOINT_MAP;
    this.cacheLoadedAt = Date.now();
    return DEFAULT_ENDPOINT_MAP;
  }

  /**
   * Resolve a specific endpoint path with parameter substitution.
   * e.g., resolveEndpoint('ll', 'experiences', { parkId: '80007944' })
   */
  async resolveEndpoint(
    group: 'll' | 'vq',
    endpoint: string,
    params?: Record<string, string>
  ): Promise<string> {
    const endpoints = await this.getEndpoints();
    let path = (endpoints[group] as Record<string, string>)[endpoint];

    if (!path) {
      throw new Error(`[EndpointRegistry] Unknown endpoint: ${group}.${endpoint}`);
    }

    // Substitute {paramName} placeholders
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        path = path.replace(`{${key}}`, encodeURIComponent(value));
      }
    }

    return path;
  }

  /**
   * Update a single endpoint path. Used by BG1SyncEngine for auto-patching.
   * Updates Redis (immediate) and Supabase (persistent backup).
   */
  async patchEndpoint(
    group: 'll' | 'vq',
    endpoint: string,
    newPath: string,
    sourceCommit?: string
  ): Promise<void> {
    const endpoints = await this.getEndpoints();
    const groupEndpoints = endpoints[group] as Record<string, string>;

    const oldPath = groupEndpoints[endpoint];
    if (oldPath === newPath) {
      console.log(`[EndpointRegistry] No change for ${group}.${endpoint}`);
      return;
    }

    console.log(`[EndpointRegistry] Patching ${group}.${endpoint}:`);
    console.log(`  Old: ${oldPath}`);
    console.log(`  New: ${newPath}`);

    // Update in-memory + Redis
    groupEndpoints[endpoint] = newPath;
    this.cachedEndpoints = endpoints;
    this.cacheLoadedAt = Date.now();

    await this.redis.set(EndpointRegistry.REDIS_KEY, JSON.stringify(endpoints));

    // Update version
    const version = new Date().toISOString().split('T')[0]!;
    await this.redis.set(EndpointRegistry.VERSION_KEY, version);

    // Persist to Supabase
    try {
      const db = getSupabaseClient();

      // Deactivate previous
      await db
        .from('disney_endpoint_registry')
        .update({ is_active: false })
        .eq('is_active', true);

      // Insert new active version
      await db.from('disney_endpoint_registry').insert({
        version,
        source_commit: sourceCommit ?? null,
        endpoints,
        is_active: true,
        activated_at: new Date().toISOString(),
      });
    } catch (err) {
      console.error('[EndpointRegistry] Supabase persist failed:', err);
      // Redis is still updated — non-fatal
    }
  }

  /**
   * Bulk-replace the entire endpoint map. Used for initial seeding
   * or when a major API overhaul is detected.
   */
  async setEndpoints(endpoints: EndpointMap, version: string, sourceCommit?: string): Promise<void> {
    this.cachedEndpoints = endpoints;
    this.cacheLoadedAt = Date.now();

    await this.redis.set(EndpointRegistry.REDIS_KEY, JSON.stringify(endpoints));
    await this.redis.set(EndpointRegistry.VERSION_KEY, version);

    try {
      const db = getSupabaseClient();
      await db
        .from('disney_endpoint_registry')
        .update({ is_active: false })
        .eq('is_active', true);

      await db.from('disney_endpoint_registry').insert({
        version,
        source_commit: sourceCommit ?? null,
        endpoints,
        is_active: true,
        activated_at: new Date().toISOString(),
      });
    } catch (err) {
      console.error('[EndpointRegistry] Supabase bulk persist failed:', err);
    }
  }

  /**
   * Get the current version string.
   */
  async getVersion(): Promise<string> {
    const version = await this.redis.get(EndpointRegistry.VERSION_KEY);
    return version ?? 'default';
  }

  /**
   * Seed the registry with defaults if nothing exists yet.
   */
  async seedIfEmpty(): Promise<void> {
    const existing = await this.redis.get(EndpointRegistry.REDIS_KEY);
    if (!existing) {
      console.log('[EndpointRegistry] Seeding with default endpoint map');
      await this.setEndpoints(DEFAULT_ENDPOINT_MAP, 'initial', 'hardcoded');
    }
  }

  /**
   * Invalidate the in-memory cache, forcing next read from Redis.
   */
  invalidateCache(): void {
    this.cachedEndpoints = null;
    this.cacheLoadedAt = 0;
  }
}
