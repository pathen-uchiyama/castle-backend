/**
 * CloudWatch Metrics Emitter — Production Observability
 *
 * Emits custom CloudWatch metrics from the Node.js backend.
 * Falls back to console logging when running locally (no AWS credentials).
 *
 * Metrics emitted:
 *   - ApiLatencyMs: Request latency per endpoint
 *   - HttpErrors: 4xx/5xx error counts
 *   - QueueDepth: Priority queue depth by tier
 *   - ActiveUsers: Connected users by subscription tier
 *   - CircuitBreakerTrips: Circuit breaker trip events
 *   - LlmTokensUsed: Token usage by model
 *   - LlmSpendUsd: Dollar spend by time window
 *   - ModerationDecisions: Whisper Gallery results
 *   - DroppedSessions: Zero-tolerance session drops
 *
 * Usage:
 *   import { metrics } from './services/MetricsEmitter';
 *   metrics.recordLatency('/api/trips', 145);
 *   metrics.recordError('5xx');
 */

// ── Types ───────────────────────────────────────────────────────

interface MetricDatum {
    MetricName: string;
    Value: number;
    Unit: 'Milliseconds' | 'Count' | 'None';
    Dimensions: { Name: string; Value: string }[];
    Timestamp: Date;
}

// ── Emitter ─────────────────────────────────────────────────────

class MetricsEmitter {
    private buffer: MetricDatum[] = [];
    private readonly namespace = 'CastleBackend';
    private readonly flushIntervalMs = 60_000; // Flush every 60 seconds
    private readonly maxBufferSize = 150;
    private cloudwatch: any = null;
    private isAWS: boolean = false;

    constructor() {
        this.detectEnvironment();
        this.startFlushLoop();
    }

    private async detectEnvironment() {
        try {
            // Check if we're running on EC2 with AWS SDK available
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { CloudWatch } = require('@aws-sdk/client-cloudwatch') as any;
            this.cloudwatch = new CloudWatch({ region: process.env.AWS_REGION || 'us-east-1' });
            this.isAWS = true;
            console.log('[Metrics] CloudWatch emitter initialized');
        } catch {
            this.isAWS = false;
            console.log('[Metrics] Running locally — metrics will log to console');
        }
    }

    // ── Recording Methods ───────────────────────────────────────

    /** Record API request latency */
    recordLatency(endpoint: string, latencyMs: number) {
        this.push({
            MetricName: 'ApiLatencyMs',
            Value: latencyMs,
            Unit: 'Milliseconds',
            Dimensions: [{ Name: 'Endpoint', Value: endpoint }],
            Timestamp: new Date(),
        });
        // Also record to the ALL aggregate
        this.push({
            MetricName: 'ApiLatencyMs',
            Value: latencyMs,
            Unit: 'Milliseconds',
            Dimensions: [{ Name: 'Endpoint', Value: 'ALL' }],
            Timestamp: new Date(),
        });
    }

    /** Record HTTP error */
    recordError(statusClass: '4xx' | '5xx') {
        this.push({
            MetricName: 'HttpErrors',
            Value: 1,
            Unit: 'Count',
            Dimensions: [{ Name: 'StatusClass', Value: statusClass }],
            Timestamp: new Date(),
        });
    }

    /** Record priority queue depth snapshot */
    recordQueueDepth(priority: 'P1' | 'P2' | 'P3', depth: number) {
        this.push({
            MetricName: 'QueueDepth',
            Value: depth,
            Unit: 'Count',
            Dimensions: [{ Name: 'Priority', Value: priority }],
            Timestamp: new Date(),
        });
    }

    /** Record active user count by tier */
    recordActiveUsers(tier: string, count: number) {
        this.push({
            MetricName: 'ActiveUsers',
            Value: count,
            Unit: 'Count',
            Dimensions: [{ Name: 'Tier', Value: tier }],
            Timestamp: new Date(),
        });
    }

    /** Record circuit breaker trip */
    recordCircuitTrip(service: string) {
        this.push({
            MetricName: 'CircuitBreakerTrips',
            Value: 1,
            Unit: 'Count',
            Dimensions: [{ Name: 'Service', Value: service }],
            Timestamp: new Date(),
        });
    }

    /** Record LLM token usage */
    recordLlmTokens(model: string, tokens: number) {
        this.push({
            MetricName: 'LlmTokensUsed',
            Value: tokens,
            Unit: 'Count',
            Dimensions: [{ Name: 'Model', Value: model }],
            Timestamp: new Date(),
        });
    }

    /** Record LLM dollar spend */
    recordLlmSpend(window: 'hourly' | 'daily', amountUsd: number) {
        this.push({
            MetricName: 'LlmSpendUsd',
            Value: amountUsd,
            Unit: 'None',
            Dimensions: [{ Name: 'Window', Value: window }],
            Timestamp: new Date(),
        });
    }

    /** Record moderation decision */
    recordModerationDecision(result: 'SAFE' | 'REJECT' | 'NEEDS_REVIEW' | 'RUMOR') {
        this.push({
            MetricName: 'ModerationDecisions',
            Value: 1,
            Unit: 'Count',
            Dimensions: [{ Name: 'Result', Value: result }],
            Timestamp: new Date(),
        });
    }

    /** Record dropped session (ZERO TOLERANCE) */
    recordDroppedSession() {
        this.push({
            MetricName: 'DroppedSessions',
            Value: 1,
            Unit: 'Count',
            Dimensions: [],
            Timestamp: new Date(),
        });
        // Immediately flush — this is critical
        this.flush().catch(console.error);
    }

    // ── Buffer Management ───────────────────────────────────────

    private push(datum: MetricDatum) {
        this.buffer.push(datum);

        // Auto-flush if buffer is full
        if (this.buffer.length >= this.maxBufferSize) {
            this.flush().catch(console.error);
        }
    }

    private startFlushLoop() {
        setInterval(() => {
            this.flush().catch(console.error);
        }, this.flushIntervalMs);
    }

    async flush(): Promise<void> {
        if (this.buffer.length === 0) return;

        const batch = this.buffer.splice(0, this.maxBufferSize);

        if (!this.isAWS || !this.cloudwatch) {
            // Local mode — log a summary instead
            const summary: Record<string, number> = {};
            for (const datum of batch) {
                summary[datum.MetricName] = (summary[datum.MetricName] || 0) + 1;
            }
            if (Object.keys(summary).length > 0) {
                console.log('[Metrics] Local flush:', JSON.stringify(summary));
            }
            return;
        }

        // AWS mode — batch put to CloudWatch (max 1000 per request)
        try {
            // CloudWatch accepts max 1000 metric data points per PutMetricData call
            for (let i = 0; i < batch.length; i += 1000) {
                const chunk = batch.slice(i, i + 1000);
                await this.cloudwatch.putMetricData({
                    Namespace: this.namespace,
                    MetricData: chunk.map((d: MetricDatum) => ({
                        MetricName: d.MetricName,
                        Value: d.Value,
                        Unit: d.Unit,
                        Dimensions: d.Dimensions,
                        Timestamp: d.Timestamp,
                    })),
                });
            }
        } catch (err) {
            console.warn('[Metrics] CloudWatch flush failed:', err);
            // Put them back in the buffer for retry
            this.buffer.unshift(...batch);
            // But cap the buffer to prevent memory leak
            if (this.buffer.length > 5000) {
                this.buffer = this.buffer.slice(-this.maxBufferSize);
            }
        }
    }
}

// ── Express Middleware ───────────────────────────────────────────

/**
 * Express middleware that automatically records latency and errors.
 * Add to your Express app: app.use(metricsMiddleware);
 */
export function metricsMiddleware(req: any, res: any, next: any) {
    const start = Date.now();

    res.on('finish', () => {
        const latency = Date.now() - start;
        const path = req.route?.path || req.path || 'unknown';

        metrics.recordLatency(path, latency);

        if (res.statusCode >= 500) {
            metrics.recordError('5xx');
        } else if (res.statusCode >= 400) {
            metrics.recordError('4xx');
        }
    });

    next();
}

// ── Singleton Export ─────────────────────────────────────────────

export const metrics = new MetricsEmitter();
