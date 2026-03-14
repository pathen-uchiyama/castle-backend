import { SystemMetric } from '../models/types';
import Redis from 'ioredis';
import { env } from '../config/env';

const redis = new Redis(env.REDIS_URL);

/**
 * TelemetryService
 * 
 * Aggregates and stores system-wide operational metrics in Redis.
 * This provides the data for the Elite Operations Suite dashboard.
 */
export class TelemetryService {
    private static METRICS_KEY = 'system:metrics:latest';

    /**
     * Log a set of metrics to the persistent store.
     */
    static async logMetrics(metrics: Partial<SystemMetric>): Promise<void> {
        const current = await this.getLatestMetrics();
        const fullMetric: SystemMetric = {
            apiLatency: metrics.apiLatency ?? current.apiLatency ?? 120,
            successRate: metrics.successRate ?? current.successRate ?? 0.98,
            activeUsers: metrics.activeUsers ?? current.activeUsers ?? 0,
            activeBots: metrics.activeBots ?? current.activeBots ?? 0,
            errorCount: metrics.errorCount ?? current.errorCount ?? 0,
            revenue: metrics.revenue ?? current.revenue ?? 0,
            minutesSavedTotal: metrics.minutesSavedTotal ?? current.minutesSavedTotal ?? 0,
            proxyDataGB: metrics.proxyDataGB ?? current.proxyDataGB ?? 0,
            tokenBurn: metrics.tokenBurn ?? current.tokenBurn ?? 0,
            captchaSuccessRate: metrics.captchaSuccessRate ?? current.captchaSuccessRate ?? 0.95,
            zombieCount: metrics.zombieCount ?? current.zombieCount ?? 0,
            timestamp: Date.now()
        };

        await redis.set(this.METRICS_KEY, JSON.stringify(fullMetric));
    }

    /**
     * Retrieve the most recent snapshot of system metrics.
     */
    static async getLatestMetrics(): Promise<SystemMetric> {
        const raw = await redis.get(this.METRICS_KEY);
        if (raw) return JSON.parse(raw);

        // Bootstrap defaults if Redis is empty
        return {
            apiLatency: 0,
            successRate: 0,
            activeUsers: 0,
            activeBots: 0,
            errorCount: 0,
            revenue: 0,
            minutesSavedTotal: 0,
            proxyDataGB: 0,
            tokenBurn: 0,
            captchaSuccessRate: 0,
            zombieCount: 0,
            timestamp: Date.now()
        };
    }
}
