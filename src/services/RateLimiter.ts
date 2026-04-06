import Redis from 'ioredis';
import { env } from '../config/env';

/**
 * Rate Limiter — Per-User + Global Disney API Compliance
 *
 * Implements a dual-layer rate limiting system:
 *   1. Per-user: max 1 snipe request per 2 seconds (sliding window)
 *   2. Global: max N requests per second to Disney API (across all workers)
 *   3. Human Mimicry jitter: 200ms-1500ms non-linear delay
 *   4. Exponential backoff: 1s, 2s, 4s, 8s (max 3 retries)
 *
 * Uses Redis sliding window counter for precise rate limiting.
 */

// ── Types ───────────────────────────────────────────────────────

export interface RateLimitResult {
    allowed: boolean;
    retryAfterMs: number;
    remaining: number;
    limit: number;
    resetAt: number;
}

export interface RateLimitConfig {
    /** Per-user: max requests in window */
    perUserMaxRequests: number;
    /** Per-user: window size in milliseconds */
    perUserWindowMs: number;
    /** Global: max requests per second to Disney API */
    globalMaxRps: number;
    /** Human mimicry: minimum jitter in ms */
    jitterMinMs: number;
    /** Human mimicry: maximum jitter in ms */
    jitterMaxMs: number;
    /** Max retry attempts before giving up */
    maxRetries: number;
}

// ── Default Configuration ───────────────────────────────────────

const DEFAULT_CONFIG: RateLimitConfig = {
    perUserMaxRequests: 1,
    perUserWindowMs: 2000,       // 1 request per 2 seconds per user
    globalMaxRps: 10,            // 10 Disney API calls per second globally
    jitterMinMs: env.DISNEY_API_JITTER_MIN_MS,
    jitterMaxMs: env.DISNEY_API_JITTER_MAX_MS,
    maxRetries: 3,
};

// ── Rate Limiter ────────────────────────────────────────────────

export class RateLimiter {
    private redis: Redis;
    private config: RateLimitConfig;
    private static readonly PER_USER_PREFIX = 'ratelimit:user:';
    private static readonly GLOBAL_PREFIX = 'ratelimit:global:';

    constructor(config?: Partial<RateLimitConfig>, redisUrl?: string) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.redis = new Redis(redisUrl || env.REDIS_URL, {
            maxRetriesPerRequest: null,
            lazyConnect: true,
        });

        this.redis.on('error', (err) => {
            console.warn('[RateLimit] Redis error:', err.message);
        });

        this.redis.connect().catch((err) => {
            console.warn('[RateLimit] Redis connection failed:', err.message);
        });
    }

    // ── Per-User Rate Limit ─────────────────────────────────────

    /**
     * Check if a user's request should be allowed.
     * Uses a sliding window counter in Redis.
     */
    async checkUserLimit(userId: string): Promise<RateLimitResult> {
        try {
            const key = `${RateLimiter.PER_USER_PREFIX}${userId}`;
            const now = Date.now();
            const windowStart = now - this.config.perUserWindowMs;

            const pipeline = this.redis.pipeline();
            // Remove expired entries
            pipeline.zremrangebyscore(key, 0, windowStart);
            // Count current entries
            pipeline.zcard(key);
            // Add current request timestamp
            pipeline.zadd(key, now.toString(), `${now}:${Math.random()}`);
            // Set expiry on the whole key
            pipeline.expire(key, Math.ceil(this.config.perUserWindowMs / 1000) + 1);

            const results = await pipeline.exec();
            const currentCount = (results?.[1]?.[1] as number) || 0;

            if (currentCount >= this.config.perUserMaxRequests) {
                // Rate limited — calculate retry delay
                const oldestKey = `${RateLimiter.PER_USER_PREFIX}${userId}`;
                const oldest = await this.redis.zrange(oldestKey, 0, 0, 'WITHSCORES');
                const oldestTime = oldest.length >= 2 ? parseInt(oldest[1]) : now;
                const retryAfterMs = Math.max(0, this.config.perUserWindowMs - (now - oldestTime));

                // Remove the request we just added (it was rejected)
                await this.redis.zremrangebyscore(key, now, now + 1);

                return {
                    allowed: false,
                    retryAfterMs,
                    remaining: 0,
                    limit: this.config.perUserMaxRequests,
                    resetAt: oldestTime + this.config.perUserWindowMs,
                };
            }

            return {
                allowed: true,
                retryAfterMs: 0,
                remaining: this.config.perUserMaxRequests - currentCount - 1,
                limit: this.config.perUserMaxRequests,
                resetAt: now + this.config.perUserWindowMs,
            };
        } catch (err) {
            // Fail-open: if Redis is down, allow the request
            console.warn('[RateLimit] User check failed (fail-open):', err);
            return {
                allowed: true,
                retryAfterMs: 0,
                remaining: this.config.perUserMaxRequests,
                limit: this.config.perUserMaxRequests,
                resetAt: Date.now() + this.config.perUserWindowMs,
            };
        }
    }

    // ── Global Disney API Rate Limit ────────────────────────────

    /**
     * Check global Disney API rate limit (across all workers).
     * Uses a simple counter with 1-second windows.
     */
    async checkGlobalLimit(): Promise<RateLimitResult> {
        try {
            const now = Math.floor(Date.now() / 1000); // Current second
            const key = `${RateLimiter.GLOBAL_PREFIX}${now}`;

            const current = await this.redis.incr(key);
            if (current === 1) {
                await this.redis.expire(key, 2); // 2s TTL for safety
            }

            if (current > this.config.globalMaxRps) {
                return {
                    allowed: false,
                    retryAfterMs: 1000 - (Date.now() % 1000), // Time until next second
                    remaining: 0,
                    limit: this.config.globalMaxRps,
                    resetAt: (now + 1) * 1000,
                };
            }

            return {
                allowed: true,
                retryAfterMs: 0,
                remaining: this.config.globalMaxRps - current,
                limit: this.config.globalMaxRps,
                resetAt: (now + 1) * 1000,
            };
        } catch (err) {
            console.warn('[RateLimit] Global check failed (fail-open):', err);
            return {
                allowed: true,
                retryAfterMs: 0,
                remaining: this.config.globalMaxRps,
                limit: this.config.globalMaxRps,
                resetAt: Date.now() + 1000,
            };
        }
    }

    // ── Combined Check ──────────────────────────────────────────

    /**
     * Check both per-user and global limits.
     * Returns the more restrictive result.
     */
    async checkLimits(userId: string): Promise<RateLimitResult & { limitedBy?: 'user' | 'global' }> {
        const [userResult, globalResult] = await Promise.all([
            this.checkUserLimit(userId),
            this.checkGlobalLimit(),
        ]);

        if (!userResult.allowed) {
            return { ...userResult, limitedBy: 'user' };
        }

        if (!globalResult.allowed) {
            return { ...globalResult, limitedBy: 'global' };
        }

        return {
            allowed: true,
            retryAfterMs: 0,
            remaining: Math.min(userResult.remaining, globalResult.remaining),
            limit: Math.min(userResult.limit, globalResult.limit),
            resetAt: Math.min(userResult.resetAt, globalResult.resetAt),
        };
    }
}

// ── Human Mimicry Jitter ────────────────────────────────────────

/**
 * Generate non-linear jitter delay to simulate human browsing patterns.
 *
 * Uses a beta distribution approximation (weighted toward shorter delays)
 * rather than uniform random, which looks bot-like.
 *
 * Result: Most delays cluster around 300-600ms with occasional longer pauses.
 */
export function generateHumanJitter(
    minMs: number = env.DISNEY_API_JITTER_MIN_MS,
    maxMs: number = env.DISNEY_API_JITTER_MAX_MS
): number {
    // Beta distribution approximation (alpha=2, beta=5)
    // Produces right-skewed distribution favoring shorter delays
    const u1 = Math.random();
    const u2 = Math.random();
    const beta = u1 / (u1 + Math.pow(u2, 2 / 5));

    return Math.floor(minMs + beta * (maxMs - minMs));
}

/**
 * Sleep for a human-like jitter duration.
 */
export function sleepWithJitter(
    minMs?: number,
    maxMs?: number
): Promise<void> {
    const delay = generateHumanJitter(minMs, maxMs);
    return new Promise(resolve => setTimeout(resolve, delay));
}

// ── Exponential Backoff ─────────────────────────────────────────

/**
 * Calculate exponential backoff delay for retry attempts.
 * Adds jitter to prevent thundering herd.
 *
 * @param attempt - 0-based attempt number
 * @param baseDelayMs - Base delay (default: 1000ms)
 * @returns Delay in milliseconds
 */
export function calculateBackoff(attempt: number, baseDelayMs: number = 1000): number {
    const exponentialDelay = baseDelayMs * Math.pow(2, attempt);
    const maxDelay = 8000; // Cap at 8 seconds
    const delay = Math.min(exponentialDelay, maxDelay);
    // Add ±25% jitter
    const jitter = delay * (0.75 + Math.random() * 0.5);
    return Math.floor(jitter);
}

/**
 * Sleep with exponential backoff.
 */
export function sleepWithBackoff(attempt: number, baseDelayMs?: number): Promise<void> {
    const delay = calculateBackoff(attempt, baseDelayMs);
    return new Promise(resolve => setTimeout(resolve, delay));
}
