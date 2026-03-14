import Redis from 'ioredis';
import { env } from '../config/env';
import { AttractionStatus, AttractionOperatingStatus, ParkClosure, ParkID } from '../models/types';

/**
 * ParkStatusRegistry — Redis-backed, real-time attraction status cache.
 *
 * This is the "single source of truth" that the ReasoningEngine queries
 * BEFORE constructing any prompt to the LLM. It prevents hallucinations
 * by ensuring the AI never suggests a ride that is currently closed.
 *
 * Data flows IN from:
 *   - The Scout agent (live wait-time polling)
 *   - The Scraper Pipeline (nightly ingestion of closure calendars)
 *   - Manual admin overrides (emergency closures)
 *
 * Data flows OUT to:
 *   - ReasoningEngine (pre-prompt closure injection)
 *   - Guardian agent (nudge payload construction)
 */
export class ParkStatusRegistry {
    private redis: Redis;
    private static KEY_PREFIX = 'park:status:';
    private static CLOSURE_KEY = 'park:closures';

    constructor() {
        this.redis = new Redis(env.REDIS_URL, {
            maxRetriesPerRequest: null,
        });
        console.log('🏰 ParkStatusRegistry initialized');
    }

    // ── Write Operations (Called by Scout / Scraper) ─────────────────────

    /**
     * Update a single attraction's real-time status.
     * Called by the Scout agent every 1–5 minutes.
     */
    async updateAttractionStatus(attraction: AttractionStatus): Promise<void> {
        const key = `${ParkStatusRegistry.KEY_PREFIX}${attraction.attractionId}`;
        const parkSetKey = `park:attractions:${attraction.parkId}`;
        
        // Track the attraction ID in a per-park Set
        await this.redis.sadd(parkSetKey, attraction.attractionId);
        
        await this.redis.set(key, JSON.stringify({
            ...attraction,
            lastUpdated: new Date().toISOString()
        }), 'EX', 600); // TTL: 10 minutes — stale data auto-expires
    }

    /**
     * Bulk-seed known closures (e.g., from nightly scraper or manual input).
     * This populates the registry with refurbishment data that won't change
     * minute-to-minute.
     */
    async seedClosures(closures: ParkClosure[]): Promise<void> {
        const pipeline = this.redis.pipeline();

        for (const closure of closures) {
            const status: AttractionStatus = {
                attractionId: closure.attractionId,
                name: closure.name,
                parkId: closure.parkId,
                status: closure.closureType === 'permanent' ? 'CLOSED' : 'REFURB',
                lastUpdated: new Date().toISOString(),
                closureReason: closure.reason,
                reopenDate: closure.closureEnd || 'TBD',
                alternativeIds: closure.alternativeNames,
            };

            const key = `${ParkStatusRegistry.KEY_PREFIX}${closure.attractionId}`;
            // Long TTL for known closures (24 hours — refreshed by nightly scraper)
            pipeline.set(key, JSON.stringify(status), 'EX', 86400);
        }

        // Also store the full closure manifest for batch queries
        pipeline.set(ParkStatusRegistry.CLOSURE_KEY, JSON.stringify(closures), 'EX', 86400);

        await pipeline.exec();
        console.log(`🏰 Seeded ${closures.length} closures into ParkStatusRegistry`);
    }

    // ── Read Operations (Called by ReasoningEngine / Guardian) ───────────

    /**
     * Get a single attraction's current status.
     */
    async getAttractionStatus(attractionId: string): Promise<AttractionStatus | null> {
        const key = `${ParkStatusRegistry.KEY_PREFIX}${attractionId}`;
        const raw = await this.redis.get(key);
        return raw ? JSON.parse(raw) : null;
    }

    /**
     * Get ALL current attraction statuses for a given park.
     * Used by the Dashboard API to visualize the entire park map.
     */
    async getParkStatus(parkId: string): Promise<AttractionStatus[]> {
        const parkSetKey = `park:attractions:${parkId}`;
        const ids = await this.redis.smembers(parkSetKey);
        
        if (ids.length === 0) return [];

        const pipeline = this.redis.pipeline();
        for (const id of ids) {
            pipeline.get(`${ParkStatusRegistry.KEY_PREFIX}${id}`);
        }
        
        const results = await pipeline.exec();
        const statuses: AttractionStatus[] = [];
        
        for (const [err, raw] of results || []) {
            if (!err && raw) {
                statuses.push(JSON.parse(raw as string));
            }
        }
        
        // Sort by name for consistent UI display
        return statuses.sort((a, b) => a.name.localeCompare(b.name));
    }

    /**
     * Check if a specific attraction is operational.
     */
    async isOperational(attractionId: string): Promise<boolean> {
        const status = await this.getAttractionStatus(attractionId);
        return status ? status.status === 'OPEN' : true; // Default open if unknown
    }

    /**
     * Get ALL current closures for a given park.
     * Used by ReasoningEngine to inject structured closure data into the prompt.
     */
    async getClosuresForPark(parkId: ParkID): Promise<AttractionStatus[]> {
        const closureManifest = await this.redis.get(ParkStatusRegistry.CLOSURE_KEY);
        if (!closureManifest) return [];

        const allClosures: ParkClosure[] = JSON.parse(closureManifest);
        const parkClosures = allClosures.filter(c => c.parkId === parkId);

        const statuses: AttractionStatus[] = [];
        for (const closure of parkClosures) {
            const status = await this.getAttractionStatus(closure.attractionId);
            if (status) statuses.push(status);
        }
        return statuses;
    }

    /**
     * Generate a structured closure summary for LLM prompt injection.
     * Returns a concise, machine-readable string that the ReasoningEngine
     * can prepend to its prompt to prevent hallucinations.
     */
    async generateClosureContext(parkId: ParkID): Promise<string> {
        const closures = await this.getClosuresForPark(parkId);

        if (closures.length === 0) {
            return 'PARK STATUS: All attractions currently operational.';
        }

        let context = `PARK STATUS ALERT — ${closures.length} attraction(s) unavailable:\n`;
        for (const c of closures) {
            context += `  ❌ ${c.name}: ${c.status} — ${c.closureReason || 'No reason provided'}`;
            if (c.reopenDate) context += ` (Reopen: ${c.reopenDate})`;
            if (c.alternativeIds && c.alternativeIds.length > 0) {
                context += ` → Alternatives: ${c.alternativeIds.join(', ')}`;
            }
            context += '\n';
        }
        context += 'CRITICAL: Do NOT suggest any attraction listed above. Use the alternatives instead.\n';

        return context;
    }

    /**
     * Health Check for SafetyProtocol.
     */
    static async healthCheck(): Promise<boolean> {
        try {
            const testRegistry = new ParkStatusRegistry();
            await testRegistry.redis.ping();
            await testRegistry.redis.quit();
            return true;
        } catch (error) {
            console.error('[ParkStatusRegistry] Redis Ping Failed:', error);
            return false;
        }
    }
}
