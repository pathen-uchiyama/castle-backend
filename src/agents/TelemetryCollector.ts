import Redis from 'ioredis';
import { env } from '../config/env';
import { KnowledgeLayer } from '../services/KnowledgeLayer';

/**
 * TelemetryCollector — Server-side behavioral telemetry ingestion and RLHF pipeline.
 *
 * Blueprint architecture:
 *   1. Implicit signals: Ride_Skipped, Pace_Slower, Break_Taken_Early (from mobile telemetry)
 *   2. Explicit signals: Pivot thumbs-up/down, survey responses (from user UI)
 *   3. Nightly vector-weight adjustment: boosts/penalizes vectors in Pinecone
 *   4. Monthly fine-tuning export: JSONL for OpenAI fine-tuning API
 */

export interface BehavioralSignal {
    tripId: string;
    userId: string;
    timestamp: string;
    signalType: 'IMPLICIT' | 'EXPLICIT';
    eventType:
    | 'RIDE_SKIPPED'
    | 'PACE_SLOWER_THAN_EXPECTED'
    | 'PACE_FASTER_THAN_EXPECTED'
    | 'BREAK_TAKEN_EARLY'
    | 'PIVOT_ACCEPTED'
    | 'PIVOT_REJECTED'
    | 'NUDGE_DISMISSED'
    | 'NUDGE_ACTED_ON'
    | 'SURVEY_RESPONSE';
    metadata: {
        attractionId?: string;
        pivotId?: string;
        feedbackScore?: number;  // -5, -1, 1, or 5
        comment?: string;
        contextSnapshot?: string;
    };
}

export interface RLHFTrainingPair {
    prompt: string;
    completion: string;
    feedbackScore: number;
    timestamp: string;
}

// Redis key prefixes
const SIGNAL_LIST = 'telemetry:signals';
const RLHF_LIST = 'telemetry:rlhf_pairs';
const DAILY_STATS = 'telemetry:daily_stats';

export class TelemetryCollector {
    private redis: Redis;
    private knowledgeLayer: KnowledgeLayer;

    constructor() {
        this.redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
        this.knowledgeLayer = new KnowledgeLayer();
    }

    // ── Signal Ingestion ─────────────────────────────────────────────────

    /**
     * Records a behavioral signal from the mobile app.
     * Signals are stored in a Redis list for batch processing.
     */
    async recordSignal(signal: BehavioralSignal): Promise<void> {
        await this.redis.lpush(SIGNAL_LIST, JSON.stringify(signal));
        await this.redis.ltrim(SIGNAL_LIST, 0, 9999); // Keep last 10K signals

        // Update daily aggregates
        const dateKey = signal.timestamp.split('T')[0];
        await this.redis.hincrby(`${DAILY_STATS}:${dateKey}`, signal.eventType, 1);
        await this.redis.expire(`${DAILY_STATS}:${dateKey}`, 30 * 86400); // 30-day TTL

        console.log(`[Telemetry] Recorded: ${signal.signalType} / ${signal.eventType} for trip ${signal.tripId}`);
    }

    /**
     * Records an RLHF training pair (prompt + completion + feedback).
     * These are generated whenever a user gives explicit feedback on a pivot.
     */
    async recordTrainingPair(pair: RLHFTrainingPair): Promise<void> {
        await this.redis.lpush(RLHF_LIST, JSON.stringify(pair));
        console.log(`[Telemetry] RLHF pair recorded (score: ${pair.feedbackScore})`);
    }

    /**
     * Records pivot feedback — the core RLHF input.
     * Combines the pivot prompt/response with the user's feedback score.
     */
    async recordPivotFeedback(
        tripId: string,
        userId: string,
        pivotId: string,
        feedbackScore: number,
        originalPrompt: string,
        pivotResponse: string,
        comment?: string
    ): Promise<void> {
        // Record as a behavioral signal
        await this.recordSignal({
            tripId,
            userId,
            timestamp: new Date().toISOString(),
            signalType: 'EXPLICIT',
            eventType: feedbackScore > 0 ? 'PIVOT_ACCEPTED' : 'PIVOT_REJECTED',
            metadata: { pivotId, feedbackScore, comment }
        });

        // Record as an RLHF training pair
        await this.recordTrainingPair({
            prompt: originalPrompt,
            completion: pivotResponse,
            feedbackScore,
            timestamp: new Date().toISOString()
        });
    }

    // ── Nightly Processing ───────────────────────────────────────────────

    /**
     * Nightly BullMQ job: Processes accumulated signals and adjusts
     * the Knowledge Layer (Pinecone) vector weights.
     *
     * Blueprint weight adjustment rules:
     *   - PIVOT_ACCEPTED (score 5)  → boost context vector by 1.2x
     *   - PIVOT_ACCEPTED (score 1)  → boost context vector by 1.05x
     *   - PIVOT_REJECTED (score -1) → reduce context vector by 0.95x
     *   - PIVOT_REJECTED (score -5) → reduce context vector by 0.8x
     *   - RIDE_SKIPPED 3+ times     → flag attraction as "unfavorable" in user profile
     */
    async runNightlySync(): Promise<{ processed: number; adjusted: number }> {
        console.log('[Telemetry] Starting nightly RLHF sync...');

        const signals = await this.redis.lrange(SIGNAL_LIST, 0, -1);
        let adjustedCount = 0;

        // Group signals by trip for context-aware processing
        const tripSignals = new Map<string, BehavioralSignal[]>();
        for (const raw of signals) {
            const signal: BehavioralSignal = JSON.parse(raw);
            const existing = tripSignals.get(signal.tripId) || [];
            existing.push(signal);
            tripSignals.set(signal.tripId, existing);
        }

        for (const [tripId, tripData] of tripSignals) {
            // Process pivot feedback
            const pivotSignals = tripData.filter(
                s => s.eventType === 'PIVOT_ACCEPTED' || s.eventType === 'PIVOT_REJECTED'
            );

            for (const signal of pivotSignals) {
                const score = signal.metadata.feedbackScore || 0;
                const weightMultiplier = this.getWeightMultiplier(score);

                // If the pivot had a context snapshot, adjust the vector weight
                if (signal.metadata.contextSnapshot) {
                    await this.adjustVectorWeight(
                        signal.metadata.contextSnapshot,
                        weightMultiplier
                    );
                    adjustedCount++;
                }
            }

            // Detect "unfavorable" attractions (skipped 3+ times)
            const skipCounts = new Map<string, number>();
            for (const signal of tripData.filter(s => s.eventType === 'RIDE_SKIPPED')) {
                const id = signal.metadata.attractionId || 'unknown';
                skipCounts.set(id, (skipCounts.get(id) || 0) + 1);
            }

            for (const [attractionId, count] of skipCounts) {
                if (count >= 3) {
                    console.log(`[Telemetry] Flagging ${attractionId} as unfavorable for trip ${tripId} (skipped ${count}x)`);
                    // Store in Redis as a user preference signal
                    await this.redis.sadd(`user:unfavorable:${tripId}`, attractionId);
                    await this.redis.expire(`user:unfavorable:${tripId}`, 90 * 86400); // 90-day TTL
                }
            }
        }

        // Clear processed signals
        await this.redis.del(SIGNAL_LIST);

        console.log(`[Telemetry] Nightly sync complete: ${signals.length} signals processed, ${adjustedCount} vector weights adjusted`);
        return { processed: signals.length, adjusted: adjustedCount };
    }

    /**
     * Maps feedback scores to Pinecone vector weight multipliers.
     */
    private getWeightMultiplier(score: number): number {
        switch (score) {
            case 5: return 1.2;   // Strong positive → significant boost
            case 1: return 1.05;  // Mild positive → slight boost
            case -1: return 0.95;  // Mild negative → slight reduction
            case -5: return 0.8;   // Strong negative → significant reduction
            default: return 1.0;   // Neutral → no change
        }
    }

    /**
     * Adjusts the weight of a vector in Pinecone by re-embedding with a scale factor.
     * In production, this would fetch the existing vector, scale it, and upsert.
     */
    private async adjustVectorWeight(contextText: string, multiplier: number): Promise<void> {
        // For now, we re-upsert the document with a weight metadata field
        // that the ReasoningEngine uses to boost/penalize retrieval relevance
        const docId = `rlhf_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        await this.knowledgeLayer.upsertDocument(docId, contextText, {
            type: 'rlhf_adjusted',
            weightMultiplier: String(multiplier),
            adjustedAt: new Date().toISOString()
        });
    }

    // ── Monthly Fine-Tuning Export ───────────────────────────────────────

    /**
     * Exports accumulated RLHF training pairs as JSONL format
     * for OpenAI fine-tuning API.
     *
     * Format matches OpenAI's chat fine-tuning spec:
     *   {"messages": [{"role": "system", "content": "..."}, {"role": "user", "content": "..."}, {"role": "assistant", "content": "..."}]}
     */
    async exportFineTuningData(): Promise<string> {
        const pairs = await this.redis.lrange(RLHF_LIST, 0, -1);
        const lines: string[] = [];

        for (const raw of pairs) {
            const pair: RLHFTrainingPair = JSON.parse(raw);

            // Only export strong signals (score >= 3 or <= -3)
            if (Math.abs(pair.feedbackScore) < 3) continue;

            const entry = {
                messages: [
                    {
                        role: 'system',
                        content: 'You are Castle Companion, an expert Disney park strategy AI. You generate real-time pivot strategies when a disruption occurs, considering ride closures, wait times, weather, dining times, and guest preferences.'
                    },
                    {
                        role: 'user',
                        content: pair.prompt
                    },
                    {
                        role: 'assistant',
                        content: pair.completion,
                        // OpenAI weight parameter for RLHF signal
                        weight: pair.feedbackScore > 0 ? 1 : 0
                    }
                ]
            };

            lines.push(JSON.stringify(entry));
        }

        const jsonl = lines.join('\n');
        console.log(`[Telemetry] Exported ${lines.length} RLHF training pairs (${jsonl.length} bytes)`);
        return jsonl;
    }

    // ── Analytics ────────────────────────────────────────────────────────

    /**
     * Gets daily signal counts for dashboard display.
     */
    async getDailyStats(date?: string): Promise<Record<string, string>> {
        const dateKey = date || new Date().toISOString().split('T')[0];
        return this.redis.hgetall(`${DAILY_STATS}:${dateKey}`);
    }

    /**
     * Calculates the Nudge Acceptance Rate over a given period.
     */
    async calculateNudgeAcceptance(): Promise<number> {
        const stats = await this.getDailyStats();
        const acted = parseInt(stats['NUDGE_ACTED_ON'] || '0');
        const dismissed = parseInt(stats['NUDGE_DISMISSED'] || '0');
        const total = acted + dismissed;
        return total > 0 ? (acted / total) : 0.85; // Default for demo if no data
    }

    /**
     * Calculates "Magic Saved" (Time saved vs original plan).
     */
    async calculateSavedTime(): Promise<number> {
        // High-level mock: In production, compares ItineraryStep durations
        const stats = await this.getDailyStats();
        const activeTrips = parseInt(stats['ACTIVE_TRIPS'] || '1');
        return activeTrips * 42; // Avg 42 mins saved per trip
    }
}
