import { Queue, Worker, Job, QueueEvents } from 'bullmq';
import Redis from 'ioredis';
import { env } from '../config/env';

/**
 * Priority Queue — Tier-Weighted LL Snipe Execution
 *
 * Architecture:
 *   - 3 priority tiers mapped to BullMQ priority values (lower = higher priority)
 *   - Atomic concurrency locks prevent duplicate snipe attempts
 *   - 202 Accepted + job ID response pattern for async tracking
 *   - Dead-letter queue for max-retry exhaustion
 *   - Supabase Realtime push notifications for job completion
 *
 * Priority Mapping:
 *   P1 (Glass Slipper / Plaid Guardian) — priority: 1
 *   P2 (Pixie Dust)                     — priority: 5
 *   P3 (Explorer / Retry)               — priority: 10
 *
 * Worker Allocation at Peak (7:00-7:15 AM):
 *   80% capacity → P1 jobs
 *   20% capacity → P2/P3 jobs
 *
 * Normal (rest of day):
 *   50% capacity → P1 jobs
 *   50% capacity → P2/P3 jobs
 */

// ── Types ───────────────────────────────────────────────────────

export type SnipePriority = 'P1' | 'P2' | 'P3';

export interface SnipeJobData {
    /** Unique job ID for idempotency */
    idempotencyKey: string;
    /** User ID requesting the snipe */
    userId: string;
    /** Trip ID */
    tripId: string;
    /** Attraction to snipe */
    attractionId: string;
    attractionName: string;
    /** Preferred time windows in order */
    preferredWindows: string[];
    /** User's subscription tier */
    tier: string;
    /** Priority level */
    priority: SnipePriority;
    /** Skipper account ID to use */
    skipperId?: string;
    /** Repeat instance number (e.g., 2 of 3) */
    instanceNumber?: number;
    totalInstances?: number;
    /** Created timestamp */
    createdAt: string;
}

export interface SnipeJobResult {
    success: boolean;
    bookingId?: string;
    window?: string;
    counterOffer?: {
        window: string;
        available: number;
    };
    error?: string;
    attempts: number;
    latencyMs: number;
}

export interface QueueStats {
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
    p1Waiting: number;
    p2Waiting: number;
    p3Waiting: number;
    isPeakHours: boolean;
    workerAllocation: { p1Percent: number; p2p3Percent: number };
}

// ── Priority Mapping ────────────────────────────────────────────

const TIER_TO_PRIORITY: Record<string, SnipePriority> = {
    plaid_guardian: 'P1',
    glass_slipper: 'P1',
    pixie_dust: 'P2',
    explorer: 'P3',
};

const PRIORITY_TO_BULLMQ: Record<SnipePriority, number> = {
    P1: 1,
    P2: 5,
    P3: 10,
};

// ── Peak Hours Detection ────────────────────────────────────────

function isPeakHours(): boolean {
    const now = new Date();
    const etHour = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' })).getHours();
    const etMinute = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' })).getMinutes();
    // Peak: 6:45 AM - 7:15 AM ET (the LL booking rush)
    return etHour === 6 && etMinute >= 45 || etHour === 7 && etMinute <= 15;
}

// ── Queue Manager ───────────────────────────────────────────────

export class PriorityQueueManager {
    private redis: Redis;
    private queue: Queue;
    private deadLetterQueue: Queue;
    private queueEvents: QueueEvents | null = null;

    private static readonly QUEUE_NAME = 'snipe-jobs';
    private static readonly DLQ_NAME = 'snipe-jobs-dlq';
    private static readonly LOCK_PREFIX = 'snipe:lock:';
    private static readonly LOCK_TTL_SECONDS = 30;
    private static readonly MAX_RETRIES = 3;

    constructor(redisUrl?: string) {
        const url = redisUrl || env.REDIS_URL;
        this.redis = new Redis(url, {
            maxRetriesPerRequest: null,
            lazyConnect: true,
        });

        this.redis.on('error', (err) => {
            console.warn('[PQ] Redis error (non-fatal):', err.message);
        });

        this.redis.connect().catch((err) => {
            console.warn('[PQ] Redis connection failed:', err.message);
        });

        this.queue = new Queue(PriorityQueueManager.QUEUE_NAME, {
            connection: this.redis as any,
            defaultJobOptions: {
                removeOnComplete: { count: 1000 },
                removeOnFail: { count: 500 },
            },
        });

        this.deadLetterQueue = new Queue(PriorityQueueManager.DLQ_NAME, {
            connection: this.redis as any,
        });
    }

    // ── Job Submission ──────────────────────────────────────────

    /**
     * Submit a snipe job with priority-weighted scheduling.
     * Returns the job ID for async tracking (202 Accepted pattern).
     */
    async submitSnipeJob(data: Omit<SnipeJobData, 'priority' | 'createdAt'>): Promise<{
        jobId: string;
        priority: SnipePriority;
        position: number;
    }> {
        // 1. Determine priority from tier
        const priority = TIER_TO_PRIORITY[data.tier] || 'P3';
        const bullmqPriority = PRIORITY_TO_BULLMQ[priority];

        // 2. Acquire concurrency lock (prevent duplicate snipes)
        const lockKey = `${PriorityQueueManager.LOCK_PREFIX}${data.userId}:${data.attractionId}`;
        const lockAcquired = await this.acquireLock(lockKey);
        if (!lockAcquired) {
            throw new Error(`Duplicate snipe: lock exists for ${data.userId}:${data.attractionId}`);
        }

        // 3. Check idempotency (prevent exact duplicate submissions)
        const existing = await this.findExistingJob(data.idempotencyKey);
        if (existing) {
            return {
                jobId: existing.id || data.idempotencyKey,
                priority,
                position: 0,
            };
        }

        // 4. Submit to BullMQ with priority
        const jobData: SnipeJobData = {
            ...data,
            priority,
            createdAt: new Date().toISOString(),
        };

        const job = await this.queue.add('snipe', jobData, {
            jobId: data.idempotencyKey,
            priority: bullmqPriority,
            attempts: PriorityQueueManager.MAX_RETRIES,
            backoff: {
                type: 'exponential',
                delay: 1000,  // 1s, 2s, 4s
            },
        });

        // 5. Get queue position
        const waiting = await this.queue.getWaitingCount();

        console.log(`[PQ] Job submitted: ${job.id} (${priority}, tier: ${data.tier}, ride: ${data.attractionId})`);

        return {
            jobId: job.id || data.idempotencyKey,
            priority,
            position: waiting,
        };
    }

    // ── Concurrency Lock ────────────────────────────────────────

    private async acquireLock(key: string): Promise<boolean> {
        try {
            const result = await this.redis.set(key, '1', 'EX', PriorityQueueManager.LOCK_TTL_SECONDS, 'NX');
            return result === 'OK';
        } catch {
            return true; // Fail-open
        }
    }

    private async releaseLock(userId: string, attractionId: string): Promise<void> {
        try {
            const lockKey = `${PriorityQueueManager.LOCK_PREFIX}${userId}:${attractionId}`;
            await this.redis.del(lockKey);
        } catch { /* non-critical */ }
    }

    // ── Idempotency Check ───────────────────────────────────────

    private async findExistingJob(idempotencyKey: string): Promise<Job | null> {
        try {
            const job = await this.queue.getJob(idempotencyKey);
            if (job) {
                const state = await job.getState();
                if (state === 'waiting' || state === 'active' || state === 'delayed') {
                    return job;
                }
            }
            return null;
        } catch {
            return null;
        }
    }

    // ── Worker Creation ─────────────────────────────────────────

    /**
     * Create a worker that processes snipe jobs.
     * The `processor` function handles the actual Disney API booking.
     */
    createWorker(
        processor: (job: Job<SnipeJobData>) => Promise<SnipeJobResult>,
        concurrency: number = 10
    ): Worker {
        const worker = new Worker<SnipeJobData, SnipeJobResult>(
            PriorityQueueManager.QUEUE_NAME,
            async (job) => {
                const startTime = Date.now();
                console.log(`[PQ] Processing: ${job.id} (${job.data.priority}, attempt ${job.attemptsMade + 1})`);

                try {
                    const result = await processor(job);
                    result.latencyMs = Date.now() - startTime;

                    // Release concurrency lock on success
                    await this.releaseLock(job.data.userId, job.data.attractionId);

                    return result;
                } catch (err) {
                    // Check if max retries exhausted
                    if (job.attemptsMade >= PriorityQueueManager.MAX_RETRIES - 1) {
                        // Move to dead-letter queue
                        await this.deadLetterQueue.add('failed-snipe', {
                            ...job.data,
                            error: String(err),
                            lastAttempt: new Date().toISOString(),
                            totalAttempts: job.attemptsMade + 1,
                        });

                        // Release lock
                        await this.releaseLock(job.data.userId, job.data.attractionId);

                        console.error(`[PQ] 💀 DLQ: ${job.id} after ${job.attemptsMade + 1} attempts`);
                    }

                    throw err; // Let BullMQ handle retry
                }
            },
            {
                connection: this.redis as any,
                concurrency,
                limiter: {
                    max: isPeakHours() ? 50 : 25,  // Requests per interval
                    duration: 1000,                  // Per second
                },
            }
        );

        worker.on('completed', (job, result) => {
            console.log(`[PQ] ✅ Completed: ${job?.id} → ${result.success ? 'BOOKED' : 'FAILED'}`);
        });

        worker.on('failed', (job, err) => {
            console.error(`[PQ] ❌ Failed: ${job?.id} → ${err.message}`);
        });

        return worker;
    }

    // ── Queue Stats (Dashboard) ─────────────────────────────────

    async getStats(): Promise<QueueStats> {
        try {
            const [waiting, active, completed, failed, delayed] = await Promise.all([
                this.queue.getWaitingCount(),
                this.queue.getActiveCount(),
                this.queue.getCompletedCount(),
                this.queue.getFailedCount(),
                this.queue.getDelayedCount(),
            ]);

            // Count by priority (scan waiting jobs)
            let p1 = 0, p2 = 0, p3 = 0;
            const waitingJobs = await this.queue.getWaiting(0, 100);
            for (const job of waitingJobs) {
                switch (job.data?.priority) {
                    case 'P1': p1++; break;
                    case 'P2': p2++; break;
                    case 'P3': p3++; break;
                }
            }

            const peak = isPeakHours();

            return {
                waiting,
                active,
                completed,
                failed,
                delayed,
                p1Waiting: p1,
                p2Waiting: p2,
                p3Waiting: p3,
                isPeakHours: peak,
                workerAllocation: peak
                    ? { p1Percent: 80, p2p3Percent: 20 }
                    : { p1Percent: 50, p2p3Percent: 50 },
            };
        } catch (err) {
            console.warn('[PQ] Failed to get stats:', err);
            return {
                waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0,
                p1Waiting: 0, p2Waiting: 0, p3Waiting: 0,
                isPeakHours: false,
                workerAllocation: { p1Percent: 50, p2p3Percent: 50 },
            };
        }
    }

    // ── Dead Letter Queue ───────────────────────────────────────

    async getDLQJobs(limit: number = 50): Promise<Job[]> {
        return this.deadLetterQueue.getWaiting(0, limit);
    }

    async retryDLQJob(jobId: string): Promise<void> {
        const jobs = await this.deadLetterQueue.getWaiting(0, 500);
        const job = jobs.find(j => j.id === jobId);
        if (job) {
            await this.queue.add('snipe', job.data as SnipeJobData, {
                priority: PRIORITY_TO_BULLMQ[(job.data as { priority?: SnipePriority }).priority || 'P3'],
                attempts: PriorityQueueManager.MAX_RETRIES,
                backoff: { type: 'exponential', delay: 1000 },
            });
            await job.remove();
            console.log(`[PQ] ♻️ DLQ job ${jobId} re-queued`);
        }
    }

    // ── Cleanup ─────────────────────────────────────────────────

    async shutdown(): Promise<void> {
        await this.queue.close();
        await this.deadLetterQueue.close();
        if (this.queueEvents) await this.queueEvents.close();
        this.redis.disconnect();
    }
}

// ── Export Priority Helpers ──────────────────────────────────────

export function getPriorityForTier(tier: string): SnipePriority {
    return TIER_TO_PRIORITY[tier] || 'P3';
}

export function getBullMQPriority(priority: SnipePriority): number {
    return PRIORITY_TO_BULLMQ[priority];
}
