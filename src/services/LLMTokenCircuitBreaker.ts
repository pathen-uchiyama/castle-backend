import Redis from 'ioredis';
import { env } from '../config/env';

/**
 * LLM Token Circuit Breaker — Cost Control & Usage Tracking
 *
 * Enforces hard spending limits per tier per user per day. Prevents runaway
 * LLM costs from a single user or a burst of concurrent pivot requests.
 *
 * Architecture:
 *   1. Pre-flight check: `canInvoke(userId, tier, estimatedTokens)` → boolean
 *   2. Post-flight record: `recordUsage(userId, tier, tokens, cost, model, latencyMs)`
 *   3. Circuit trips at configurable thresholds (hourly, daily, per-user)
 *   4. De-dup cache: identical prompts within 60s are served from cache
 *
 * Redis Keys:
 *   llm:usage:daily:{date}:{userId} — per-user daily token count
 *   llm:usage:hourly:{hour}:{userId} — per-user hourly token count
 *   llm:usage:global:daily:{date} — global daily cost ceiling
 *   llm:dedup:{hash} — prompt de-duplication cache (60s TTL)
 *   llm:circuit:state — global circuit breaker state
 */

// ── Types ───────────────────────────────────────────────────────

export interface LLMUsageRecord {
    userId: string;
    model: string;
    provider: 'openai' | 'google';
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUsd: number;
    latencyMs: number;
    taskType: string;
    timestamp: string;
}

export interface LLMQuotaConfig {
    /** Max tokens per user per hour */
    maxTokensPerUserHour: number;
    /** Max tokens per user per day */
    maxTokensPerUserDay: number;
    /** Max total USD spend per day (across all users) */
    maxDailySpendUsd: number;
    /** Max total USD spend per hour (across all users) */
    maxHourlySpendUsd: number;
    /** De-dup cache TTL in seconds */
    dedupCacheTtlSeconds: number;
}

export interface LLMCircuitState {
    state: 'CLOSED' | 'OPEN' | 'DEGRADED';
    reason: string | null;
    trippedAt: string | null;
    dailyTokens: number;
    dailyCostUsd: number;
    hourlyTokens: number;
    hourlyCostUsd: number;
}

// ── Cost Constants ──────────────────────────────────────────────

/**
 * Per-1K-token costs (USD) as of March 2026.
 * Update when pricing changes.
 */
const MODEL_COSTS: Record<string, { input: number; output: number }> = {
    'gpt-4o':              { input: 0.0025,  output: 0.010 },
    'gpt-4o-mini':         { input: 0.00015, output: 0.0006 },
    'gpt-4-turbo':         { input: 0.010,   output: 0.030 },
    'gemini-1.5-flash':    { input: 0.000075, output: 0.0003 },
    'gemini-1.5-pro':      { input: 0.00125, output: 0.005 },
    'gemini-2.0-flash':    { input: 0.0001,  output: 0.0004 },
};

// ── Default Quotas by Tier ──────────────────────────────────────

const TIER_QUOTAS: Record<string, LLMQuotaConfig> = {
    explorer: {
        maxTokensPerUserHour: 5_000,
        maxTokensPerUserDay: 20_000,
        maxDailySpendUsd: 5.00,
        maxHourlySpendUsd: 1.00,
        dedupCacheTtlSeconds: 120,  // Aggressive de-dup for free tier
    },
    pixie_dust: {
        maxTokensPerUserHour: 25_000,
        maxTokensPerUserDay: 100_000,
        maxDailySpendUsd: 25.00,
        maxHourlySpendUsd: 5.00,
        dedupCacheTtlSeconds: 60,
    },
    glass_slipper: {
        maxTokensPerUserHour: 50_000,
        maxTokensPerUserDay: 200_000,
        maxDailySpendUsd: 75.00,
        maxHourlySpendUsd: 15.00,
        dedupCacheTtlSeconds: 30,
    },
    plaid_guardian: {
        maxTokensPerUserHour: 100_000,
        maxTokensPerUserDay: 500_000,
        maxDailySpendUsd: 150.00,
        maxHourlySpendUsd: 30.00,
        dedupCacheTtlSeconds: 15,
    },
};

// Global ceiling (absolute safety net regardless of tier)
const GLOBAL_DAILY_CEILING_USD = 500.00;
const GLOBAL_HOURLY_CEILING_USD = 100.00;

// ── Circuit Breaker ─────────────────────────────────────────────

export class LLMTokenCircuitBreaker {
    private redis: Redis;
    private static readonly PREFIX = 'llm:';

    constructor(redisUrl?: string) {
        this.redis = new Redis(redisUrl || env.REDIS_URL, {
            maxRetriesPerRequest: null,
            lazyConnect: true,
        });

        this.redis.on('error', (err) => {
            console.warn('[LLM-CB] Redis error (non-fatal):', err.message);
        });

        this.redis.connect().catch((err) => {
            console.warn('[LLM-CB] Redis connection failed:', err.message);
        });
    }

    // ── Pre-flight Check ────────────────────────────────────────

    /**
     * Check if an LLM invocation should be allowed.
     * Returns { allowed: true } or { allowed: false, reason: string }.
     */
    async canInvoke(
        userId: string,
        tier: string,
        estimatedTokens: number
    ): Promise<{ allowed: boolean; reason?: string; cached?: string }> {
        try {
            const quota = TIER_QUOTAS[tier] || TIER_QUOTAS.explorer;
            const now = new Date();
            const dateKey = now.toISOString().substring(0, 10);  // 2026-04-06
            const hourKey = now.toISOString().substring(0, 13);  // 2026-04-06T19

            // 1. Check global circuit state
            const circuitState = await this.getCircuitState();
            if (circuitState.state === 'OPEN') {
                return { allowed: false, reason: `LLM circuit OPEN: ${circuitState.reason}` };
            }

            // 2. Check global daily ceiling
            const globalDailyCost = await this.getGlobalDailyCost(dateKey);
            if (globalDailyCost >= GLOBAL_DAILY_CEILING_USD) {
                await this.tripCircuit('GLOBAL_DAILY_CEILING', `Daily spend $${globalDailyCost.toFixed(2)} >= $${GLOBAL_DAILY_CEILING_USD}`);
                return { allowed: false, reason: `Global daily ceiling reached: $${globalDailyCost.toFixed(2)}` };
            }

            // 3. Check global hourly ceiling
            const globalHourlyCost = await this.getGlobalHourlyCost(hourKey);
            if (globalHourlyCost >= GLOBAL_HOURLY_CEILING_USD) {
                return { allowed: false, reason: `Global hourly ceiling reached: $${globalHourlyCost.toFixed(2)}` };
            }

            // 4. Check per-user hourly limit
            const userHourlyTokens = await this.getUserTokens(userId, 'hourly', hourKey);
            if (userHourlyTokens + estimatedTokens > quota.maxTokensPerUserHour) {
                return { allowed: false, reason: `User hourly limit: ${userHourlyTokens}/${quota.maxTokensPerUserHour} tokens` };
            }

            // 5. Check per-user daily limit
            const userDailyTokens = await this.getUserTokens(userId, 'daily', dateKey);
            if (userDailyTokens + estimatedTokens > quota.maxTokensPerUserDay) {
                return { allowed: false, reason: `User daily limit: ${userDailyTokens}/${quota.maxTokensPerUserDay} tokens` };
            }

            return { allowed: true };
        } catch (err) {
            // If Redis is down, ALLOW the request (fail-open for UX)
            console.warn('[LLM-CB] Pre-flight check failed (fail-open):', err);
            return { allowed: true };
        }
    }

    // ── De-duplication Cache ────────────────────────────────────

    /**
     * Check if an identical prompt was recently processed.
     * Returns cached response if found.
     */
    async checkDedup(promptHash: string): Promise<string | null> {
        try {
            const cached = await this.redis.get(`${LLMTokenCircuitBreaker.PREFIX}dedup:${promptHash}`);
            return cached;
        } catch {
            return null;
        }
    }

    /**
     * Cache a prompt response for de-duplication.
     */
    async cacheDedup(promptHash: string, response: string, tier: string): Promise<void> {
        try {
            const quota = TIER_QUOTAS[tier] || TIER_QUOTAS.explorer;
            await this.redis.set(
                `${LLMTokenCircuitBreaker.PREFIX}dedup:${promptHash}`,
                response,
                'EX',
                quota.dedupCacheTtlSeconds
            );
        } catch {
            // Non-critical — skip caching
        }
    }

    // ── Post-flight Recording ───────────────────────────────────

    /**
     * Record token usage after an LLM invocation completes.
     */
    async recordUsage(record: LLMUsageRecord): Promise<void> {
        try {
            const now = new Date(record.timestamp);
            const dateKey = now.toISOString().substring(0, 10);
            const hourKey = now.toISOString().substring(0, 13);

            const pipeline = this.redis.pipeline();

            // Per-user hourly tokens
            const userHourlyKey = `${LLMTokenCircuitBreaker.PREFIX}usage:hourly:${hourKey}:${record.userId}`;
            pipeline.incrby(userHourlyKey, record.totalTokens);
            pipeline.expire(userHourlyKey, 7200);  // 2h TTL

            // Per-user daily tokens
            const userDailyKey = `${LLMTokenCircuitBreaker.PREFIX}usage:daily:${dateKey}:${record.userId}`;
            pipeline.incrby(userDailyKey, record.totalTokens);
            pipeline.expire(userDailyKey, 172800);  // 48h TTL

            // Global daily cost (stored as cents to avoid float issues)
            const costCents = Math.ceil(record.costUsd * 100);
            const globalDailyKey = `${LLMTokenCircuitBreaker.PREFIX}usage:global:daily:${dateKey}`;
            pipeline.incrby(globalDailyKey, costCents);
            pipeline.expire(globalDailyKey, 172800);

            // Global hourly cost
            const globalHourlyKey = `${LLMTokenCircuitBreaker.PREFIX}usage:global:hourly:${hourKey}`;
            pipeline.incrby(globalHourlyKey, costCents);
            pipeline.expire(globalHourlyKey, 7200);

            // Global daily token count
            const globalDailyTokens = `${LLMTokenCircuitBreaker.PREFIX}usage:global:tokens:daily:${dateKey}`;
            pipeline.incrby(globalDailyTokens, record.totalTokens);
            pipeline.expire(globalDailyTokens, 172800);

            // Append to usage log (last 1000 records)
            const logKey = `${LLMTokenCircuitBreaker.PREFIX}log:${dateKey}`;
            pipeline.lpush(logKey, JSON.stringify(record));
            pipeline.ltrim(logKey, 0, 999);
            pipeline.expire(logKey, 604800);  // 7 day TTL

            await pipeline.exec();
        } catch (err) {
            console.warn('[LLM-CB] Failed to record usage:', err);
        }
    }

    // ── Cost Calculation ────────────────────────────────────────

    /**
     * Calculate the USD cost for a given model invocation.
     */
    static calculateCost(
        model: string,
        inputTokens: number,
        outputTokens: number
    ): number {
        const costs = MODEL_COSTS[model] || { input: 0.001, output: 0.002 };
        return (inputTokens / 1000) * costs.input + (outputTokens / 1000) * costs.output;
    }

    // ── Circuit State Management ────────────────────────────────

    async getCircuitState(): Promise<LLMCircuitState> {
        try {
            const stored = await this.redis.get(`${LLMTokenCircuitBreaker.PREFIX}circuit:state`);
            if (stored) return JSON.parse(stored);
        } catch { /* fall through */ }

        const now = new Date();
        const dateKey = now.toISOString().substring(0, 10);
        const hourKey = now.toISOString().substring(0, 13);

        return {
            state: 'CLOSED',
            reason: null,
            trippedAt: null,
            dailyTokens: 0,
            dailyCostUsd: await this.getGlobalDailyCost(dateKey),
            hourlyTokens: 0,
            hourlyCostUsd: await this.getGlobalHourlyCost(hourKey),
        };
    }

    async tripCircuit(reason: string, detail: string): Promise<void> {
        const state: LLMCircuitState = {
            state: 'OPEN',
            reason: `${reason}: ${detail}`,
            trippedAt: new Date().toISOString(),
            dailyTokens: 0,
            dailyCostUsd: 0,
            hourlyTokens: 0,
            hourlyCostUsd: 0,
        };

        await this.redis.set(
            `${LLMTokenCircuitBreaker.PREFIX}circuit:state`,
            JSON.stringify(state),
            'EX',
            3600  // Auto-reset after 1 hour
        );

        console.error(`[LLM-CB] 🚨 CIRCUIT TRIPPED: ${reason} — ${detail}`);

        // Fire webhook alert
        const webhookUrl = (env as Record<string, unknown>).ALERT_WEBHOOK_URL as string | undefined;
        if (webhookUrl) {
            try {
                await fetch(webhookUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        severity: 'CRITICAL',
                        reason: 'LLM_CIRCUIT_TRIPPED',
                        detail,
                        timestamp: new Date().toISOString(),
                    }),
                });
            } catch { /* non-critical */ }
        }
    }

    async resetCircuit(): Promise<void> {
        await this.redis.del(`${LLMTokenCircuitBreaker.PREFIX}circuit:state`);
        console.log('[LLM-CB] ♻️ Circuit manually reset to CLOSED');
    }

    // ── Dashboard Telemetry ─────────────────────────────────────

    /**
     * Get current usage stats for the admin dashboard.
     */
    async getUsageStats(): Promise<{
        daily: { tokens: number; costUsd: number; ceiling: number };
        hourly: { tokens: number; costUsd: number; ceiling: number };
        circuitState: LLMCircuitState;
        recentInvocations: LLMUsageRecord[];
        quotas: Record<string, LLMQuotaConfig>;
    }> {
        const now = new Date();
        const dateKey = now.toISOString().substring(0, 10);
        const hourKey = now.toISOString().substring(0, 13);

        const [dailyCost, hourlyCost, dailyTokens, circuitState, recentLog] = await Promise.all([
            this.getGlobalDailyCost(dateKey),
            this.getGlobalHourlyCost(hourKey),
            this.getGlobalDailyTokens(dateKey),
            this.getCircuitState(),
            this.getRecentLog(dateKey),
        ]);

        return {
            daily: {
                tokens: dailyTokens,
                costUsd: dailyCost,
                ceiling: GLOBAL_DAILY_CEILING_USD,
            },
            hourly: {
                tokens: 0, // TODO: track hourly tokens separately
                costUsd: hourlyCost,
                ceiling: GLOBAL_HOURLY_CEILING_USD,
            },
            circuitState,
            recentInvocations: recentLog,
            quotas: TIER_QUOTAS,
        };
    }

    // ── Private Helpers ─────────────────────────────────────────

    private async getUserTokens(userId: string, period: 'hourly' | 'daily', key: string): Promise<number> {
        try {
            const val = await this.redis.get(`${LLMTokenCircuitBreaker.PREFIX}usage:${period}:${key}:${userId}`);
            return parseInt(val || '0', 10);
        } catch {
            return 0;
        }
    }

    private async getGlobalDailyCost(dateKey: string): Promise<number> {
        try {
            const cents = await this.redis.get(`${LLMTokenCircuitBreaker.PREFIX}usage:global:daily:${dateKey}`);
            return parseInt(cents || '0', 10) / 100;
        } catch {
            return 0;
        }
    }

    private async getGlobalHourlyCost(hourKey: string): Promise<number> {
        try {
            const cents = await this.redis.get(`${LLMTokenCircuitBreaker.PREFIX}usage:global:hourly:${hourKey}`);
            return parseInt(cents || '0', 10) / 100;
        } catch {
            return 0;
        }
    }

    private async getGlobalDailyTokens(dateKey: string): Promise<number> {
        try {
            const val = await this.redis.get(`${LLMTokenCircuitBreaker.PREFIX}usage:global:tokens:daily:${dateKey}`);
            return parseInt(val || '0', 10);
        } catch {
            return 0;
        }
    }

    private async getRecentLog(dateKey: string): Promise<LLMUsageRecord[]> {
        try {
            const entries = await this.redis.lrange(`${LLMTokenCircuitBreaker.PREFIX}log:${dateKey}`, 0, 49);
            return entries.map(e => JSON.parse(e));
        } catch {
            return [];
        }
    }
}

// ── Prompt Hashing Utility ──────────────────────────────────────

/**
 * Create a fast hash of a prompt for de-duplication.
 * Uses a simple djb2 hash — not cryptographic, but fast for cache keys.
 */
export function hashPrompt(prompt: string): string {
    let hash = 5381;
    for (let i = 0; i < prompt.length; i++) {
        hash = ((hash << 5) + hash) + prompt.charCodeAt(i);
        hash = hash & hash; // Convert to 32-bit integer
    }
    return `prompt:${Math.abs(hash).toString(36)}`;
}
