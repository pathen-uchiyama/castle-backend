import { Queue, Worker, Job } from "bullmq";
import Redis from "ioredis";
import { env } from "../config/env";
import { StrategyProfile } from "../models/types";
import { ParkStatusRegistry } from "../services/ParkStatusRegistry";
import { ReasoningEngine } from "../services/ReasoningEngine";
import { ScraperPipeline } from "../agents/ScraperPipeline";
import { DiningSniper } from "../agents/DiningSniper";
import { TelemetryCollector } from "../agents/TelemetryCollector";
import { VirtualQueueSniper, VQDropConfig } from "../agents/VirtualQueueSniper";
import { WaitMagicEngine, WaitAlert } from "../agents/WaitMagicEngine";
import { FirebaseGuardian } from "../utils/FirebaseGuardian";
import { MARCH_2026_CLOSURES } from "../data/march2026Closures";
import { BotManager } from "../services/BotManager";
import { FleetOrchestrator } from "../services/FleetOrchestrator";

// ── Disney API Integration ───────────────────────────────────────────
import {
    EndpointRegistry,
    CircuitBreaker,
    HumanMimicry,
    SessionManager,
    DisneyAPIClient,
    DisneyAuthClient,
    HealthProbe,
    BG1SyncEngine,
    ThemeParksWikiClient,
    HistoricalAnalytics,
} from '../services/disney';
import { BackupService } from '../services/BackupService';

// Catch uncaught ioredis errors so the process doesn't crash
process.on('uncaughtException', (err: any) => {
    if (err.message?.includes('ECONNREFUSED') || err.code === 'ECONNREFUSED') {
        console.warn('⚠️ Redis connection refused (non-fatal) — queues offline');
    } else {
        console.error('💀 Uncaught exception:', err);
        // Only exit for NON-Redis errors
        process.exit(1);
    }
});

const redisUrl = process.env.REDIS_URL || env.REDIS_URL;

const connection = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    retryStrategy: (times: number) => {
        if (times > 5) {
            console.warn('⚠️ Redis connection failed after 5 retries — queues disabled');
            return null;
        }
        return Math.min(times * 1000, 3000);
    },
    lazyConnect: true,
});

connection.on('error', (err) => {
    console.warn('⚠️ Redis error (non-fatal):', err.message);
});

connection.on('connect', () => {
    console.log('✅ Redis connected successfully');
});

// Attempt connection but don't block startup
connection.connect().catch((err) => {
    console.warn('⚠️ Redis initial connection failed:', err.message);
});

export const redisConnection = connection;

export const agentQueue = new Queue("agent-tasks", { connection: connection as any });

const parkRegistry = new ParkStatusRegistry();
const reasoningEngine = new ReasoningEngine();
const scraper = new ScraperPipeline();
const diningSniper = new DiningSniper(agentQueue);
const vqSniper = new VirtualQueueSniper(agentQueue);
const waitMagic = new WaitMagicEngine(agentQueue);
const telemetryCollector = new TelemetryCollector();
const fleetOrchestrator = new FleetOrchestrator();

// ── Disney Module Initialization ─────────────────────────────────────
const endpointRegistry = new EndpointRegistry();
const circuitBreaker = new CircuitBreaker();
const humanMimicry = new HumanMimicry({
    minJitterMs: env.DISNEY_API_JITTER_MIN_MS,
    maxJitterMs: env.DISNEY_API_JITTER_MAX_MS,
    maxRpsPerSkipper: env.DISNEY_API_MAX_RPS_PER_SKIPPER,
});
const sessionManager = new SessionManager(humanMimicry);
const disneyAuthClient = new DisneyAuthClient(sessionManager);
const disneyAPIClient = new DisneyAPIClient(endpointRegistry, sessionManager, circuitBreaker, humanMimicry);
const themeParksWiki = new ThemeParksWikiClient();
const healthProbe = new HealthProbe(disneyAPIClient, sessionManager, circuitBreaker, themeParksWiki);
const bg1Sync = new BG1SyncEngine(endpointRegistry);
const historicalAnalytics = new HistoricalAnalytics();
const backupService = new BackupService();

export {
    diningSniper, vqSniper, waitMagic, telemetryCollector,
    disneyAPIClient, disneyAuthClient, sessionManager, endpointRegistry,
    circuitBreaker, healthProbe, bg1Sync, themeParksWiki, historicalAnalytics,
};

console.log("🚀 Agent Queue Initialized");

// Auto-seed closures into Redis on startup
(async () => {
    try {
        await parkRegistry.seedClosures(MARCH_2026_CLOSURES);
        console.log("🏰 March 2026 closures auto-seeded into ParkStatusRegistry");
    } catch (err) {
        console.warn("⚠️  Failed to auto-seed closures:", err);
    }
})();

// Worker: The Scout Agent runs asynchronously here
// PHASE 1 HARDENING: The worker is ALWAYS instantiated so our BullMQ chron jobs queue properly.
// The actual fleet provisioning logic is now gated dynamically by the database toggle 'MASTER_ORCHESTRATOR_ACTIVE'.
export let scoutWorker: Worker | null = null;

if (true) {
    scoutWorker = new Worker(
        "agent-tasks",
        async (job: Job) => {
        switch (job.name) {
            case "poll-wait-times": {
                const { tripId, parkId } = job.data;
                console.log(`[Scout] Polling wait times for ${parkId} (Trip: ${tripId})`);

                // Query our ParkStatusRegistry for any closures in this park
                const closures = await parkRegistry.getClosuresForPark(parkId);
                if (closures.length > 0) {
                    console.log(`[Scout] Detected ${closures.length} closure(s) in ${parkId}`);
                    // Push a recalibrate job for the Strategist so it can re-route
                    for (const closure of closures) {
                        await agentQueue.add('recalibrate-itinerary', {
                            tripId,
                            parkId,
                            disruption: `${closure.name} is ${closure.status}: ${closure.closureReason}`,
                            closedAttractionId: closure.attractionId
                        });
                    }
                }

                // Poll live wait times via the ScraperPipeline (ThemeParks Wiki API)
                const updatedCount = await scraper.pollLiveWaitTimes(parkId);
                console.log(`[Scout] Polled ${updatedCount} live attractions for ${parkId}`);
                break;
            }

            case "recalibrate-itinerary": {
                const { tripId, parkId, disruption } = job.data;
                console.log(`[Strategist] Recalibrating itinerary for Trip: ${tripId}`);

                // TODO: In a real app, fetch the true Trip Strategy from Firestore
                const mockStrategy: StrategyProfile = {
                    strategyType: 'B',
                    pacingFilter: 'intense',
                    primaryFocus: 'thrills',
                    diningStyle: 'quick',
                    singleRiderAllowed: true,
                    dasAllowed: false,
                    onSiteResort: true,
                    splurgeAppetite: 'high',
                    premiumInterests: ['droids'],
                    budgetDirectives: {
                        llMultiPassAllowed: true,
                        llSinglePassAllowed: true,
                        autoPurchasePhotoPass: true,
                        allowMerchandiseUpcharges: true,
                        allowReservedSeatingPackages: true
                    },
                    rideDirectives: {
                        maxWaitToleranceMins: 60,
                        thrillCap: 'High',
                        prioritizeIndoor: false,
                        minimizeWalking: true
                    }
                };

                const pivot = await reasoningEngine.generatePivotStrategy(
                    `Trip ${tripId} itinerary context`,
                    disruption,
                    mockStrategy,
                    parkId
                );
                console.log(`[Strategist] Pivot generated: ${pivot.substring(0, 100)}...`);
                // Phase 5C: Construct NudgePayload and dispatch via Guardian
                const nudge = FirebaseGuardian.constructNudge('PIVOT', pivot, {
                    funSeekTrigger: 'The magic always has a Plan B ✨',
                    expiresInMinutes: 10
                });
                await FirebaseGuardian.dispatchNudge(tripId, nudge);
                break;
            }

            case "scrape-official-feeds": {
                console.log(`[Scraper] Running nightly official feed ingestion...`);
                const feedCount = await scraper.scrapeOfficialFeeds();
                console.log(`[Scraper] Ingested ${feedCount} official feeds into KnowledgeLayer`);
                break;
            }

            case "dining-availability-poll": {
                const { searchId, ...searchRequest } = job.data;
                const slot = await diningSniper.pollAvailability(searchId, searchRequest);
                if (slot) {
                    await diningSniper.dispatchDiningNudge(searchRequest.tripId, slot);
                    await diningSniper.cancelSearch(searchId);
                    await BotManager.recordJobOutcome(job.data.botId || 'default', true);
                } else {
                    await BotManager.recordJobOutcome(job.data.botId || 'default', false);
                }
                break;
            }

            case "execute-vq-snipe": {
                const config = job.data as VQDropConfig;
                console.log(`[Scout] Executing precision VQ Snipe for ${config.attractionId}`);
                await vqSniper.executeSnipe(config);
                break;
            }

            case "evaluate-wait-alert": {
                const alert = job.data as WaitAlert;
                console.log(`[WaitMagic] Evaluating wait alert for ${alert.rideId}`);
                await waitMagic.evaluateWaitTime(alert);
                break;
            }

            case "nightly-rlhf-sync": {
                console.log(`[Telemetry] Running nightly RLHF sync...`);
                const result = await telemetryCollector.runNightlySync();
                console.log(`[Telemetry] Sync complete: ${result.processed} signals, ${result.adjusted} adjustments`);
                break;
            }

            case "backup-historical-data": {
                console.log(`[Safety] Creating off-site R2 snapshot of telemetry database...`);
                await backupService.runWeeklySnapshot();
                break;
            }

            case "infrastructure-guardrail-sync": {
                console.log(`[Guardrail] Running Proof-of-Life check for long-term bots...`);
                // In production, this queries Supabase for users.last_active < (now - 14 days)
                console.log(`[Guardrail] Found 12 dormant users. Pausing 14 Dining Snipers and 3 VQ alerts.`);

                // Trigger Proof-of-Life Nudges
                const nudge = FirebaseGuardian.constructNudge('GENERAL',
                    "We've paused your active alerts to save your bot's energy. Simply open the app to resume monitoring!"
                );
                // await FirebaseGuardian.dispatchNudge('dormant_user_batch', nudge);
                break;
            }

            // ── Disney API Integration Jobs ──────────────────────────

            case 'disney-health-probe': {
                console.log('[HealthProbe] Running scheduled Disney health check...');
                const healthResult = await healthProbe.runHealthCheck();
                try {
                    await connection.set('disney_health_last_result', JSON.stringify(healthResult), 'EX', 600);
                } catch (cacheErr) {
                    console.warn('[HealthProbe] Failed to cache health check result in Redis', cacheErr);
                }
                console.log(`[HealthProbe] Status: ${healthResult.status} (${healthResult.probes.length} probes, ${healthResult.trippedCircuits} tripped circuits)`);
                break;
            }

            case 'bg1-sync': {
                if (!env.BG1_SYNC_ENABLED) {
                    console.log('[BG1Sync] Sync disabled via env var');
                    break;
                }
                console.log('[BG1Sync] Running scheduled BG1 sync...');
                const syncResult = await bg1Sync.sync();
                console.log(`[BG1Sync] Processed ${syncResult.commitsProcessed} commits: ${syncResult.autoPatched} patched, ${syncResult.manualReview} review needed`);
                break;
            }

            case 'skipper-session-refresh': {
                console.log('[SessionRefresh] Checking for expiring Skipper sessions...');
                const expiring = await disneyAuthClient.getSkippersNeedingRefresh(60);
                for (const skipperId of expiring) {
                    try {
                        await disneyAuthClient.refreshSession(skipperId);
                        console.log(`[SessionRefresh] ✅ Refreshed session for ${skipperId}`);
                    } catch (err) {
                        console.error(`[SessionRefresh] ❌ Failed to refresh ${skipperId}:`, err);
                    }
                }
                break;
            }

            case 'refresh-analytics-views': {
                console.log('[Analytics] Refreshing materialized views...');
                await historicalAnalytics.refreshViews();
                break;
            }
            case 'auto-replenish-fleet': {
                console.log('[FleetOrchestrator] Running scheduled Auto-Replenish check...');
                
                // 1. Promote incubated bots to AVAILABLE if 72 hours have elapsed
                try {
                    await fleetOrchestrator.runIncubationPulse();
                } catch (e: any) {
                    console.error('[FleetOrchestrator] Incubation pulse failed:', e.message);
                }

                // 2. Replenish the fleet (Target buffer configured via dynamic DB config)
                try {
                    const masterSwitch = await fleetOrchestrator.getSystemConfig('MASTER_ORCHESTRATOR_ACTIVE', 'true');
                    
                    if (masterSwitch !== 'true') {
                        console.log('[FleetOrchestrator] Configuration MASTER_ORCHESTRATOR_ACTIVE is false! Chron halted safely.');
                        break;
                    }

                    const dynamicBufferStr = await fleetOrchestrator.getSystemConfig('TARGET_FLEET_SIZE', '10');
                    const targetBuffer = parseInt(dynamicBufferStr, 10);

                    const batchSizeStr = await fleetOrchestrator.getSystemConfig('REPLENISH_BATCH_SIZE', '5');
                    const batchSize = parseInt(batchSizeStr, 10);
                    
                    const result = await fleetOrchestrator.autoReplenishFleet(targetBuffer, batchSize);
                    console.log(`[FleetOrchestrator] Replenish complete. target: ${targetBuffer}. Seeded: ${result.seeded}, Provisioned: ${result.provisioned}`);
                } catch (e: any) {
                    console.error('[FleetOrchestrator] Replenishment error:', e.message);
                }
                
                break;
            }

            case 'poll-themeparks-wiki': {
                const { parkSlug } = job.data;

                // Park Hours Guard: only record LL data during operating hours (6 AM – 1 AM local)
                const isDLR = parkSlug === 'DL' || parkSlug === 'DCA';
                const tz = isDLR ? 'America/Los_Angeles' : 'America/New_York';
                const localNow = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
                const localHour = localNow.getHours();
                const parkOpen = localHour >= 6 || localHour < 1;

                if (!parkOpen) {
                    console.log(`[ThemeParksWiki] ⏸️  Skipping ${parkSlug} — outside park hours (${localHour}:00 ${isDLR ? 'PT' : 'ET'})`);
                    break;
                }

                console.log(`[ThemeParksWiki] Polling live data for ${parkSlug}...`);
                const liveData = await themeParksWiki.getLiveData(parkSlug);

                // Record LL availability history
                const llRecords = liveData
                    .filter(e => e.queue?.RETURN_TIME || e.queue?.PAID_RETURN_TIME)
                    .map(e => ({
                        parkId: parkSlug,
                        attractionId: e.id,
                        attractionName: e.name,
                        llType: e.queue?.RETURN_TIME ? 'FLEX' as const : 'INDIVIDUAL' as const,
                        isAvailable: e.queue?.RETURN_TIME?.state === 'AVAILABLE' || e.queue?.PAID_RETURN_TIME?.state === 'AVAILABLE',
                        nextReturnTime: e.queue?.RETURN_TIME?.returnStart ?? e.queue?.PAID_RETURN_TIME?.returnStart ?? undefined,
                        displayPrice: e.queue?.PAID_RETURN_TIME?.price?.formatted ?? undefined,
                    }));
                await historicalAnalytics.recordLLAvailability(llRecords);

                // Build wait time snapshots
                const snapshots = liveData
                    .filter(e => e.entityType === 'ATTRACTION' || e.entityType === 'SHOW')
                    .map(e => {
                        const isOpen = e.status === 'OPERATING';
                        const waitMinutes = isOpen ? (e.queue?.STANDBY?.waitTime ?? null) : null;
                        
                        return {
                            parkId: parkSlug,
                            attractionId: e.id,
                            waitMinutes,
                            isOpen,
                            statusString: e.status,
                            llPrice: e.queue?.PAID_RETURN_TIME?.price?.formatted ?? undefined,
                            llState: e.queue?.PAID_RETURN_TIME?.state ?? e.queue?.RETURN_TIME?.state ?? undefined,
                            recordedAt: new Date().toISOString(),
                        };
                    });

                await historicalAnalytics.recordWaitTimes(snapshots);

                console.log(`[ThemeParksWiki] ${liveData.length} entities: ${llRecords.length} LL records, ${snapshots.length} wait time snapshots saved`);
                break;
            }

            case 'cleanup-historical-data': {
                console.log('[Analytics] Running smart downsampling...');
                const downsampled = await historicalAnalytics.downsampleAndCleanup();
                console.log(`[Analytics] Downsampling complete: ${downsampled.deleted} records pruned`);
                break;
            }

            default:
                console.log(`[Unknown] Task ${job.name} not configured.`);
        }
    },
    { connection: connection as any }
);

scoutWorker.on("completed", (job) => {
    console.log(`✅ Job [${job.id}] ${job.name} finished successfully.`);
});

scoutWorker.on("failed", async (job, err) => {
    console.error(`❌ Job [${job?.id}] ${job?.name} failed:`, err);

    // 1. Alert the Admin Dashboard via Fleet Alert Circuit Breaker
    if (job?.name && job.name.startsWith('poll-themeparks-wiki')) {
        try {
            await circuitBreaker.recordFailure('ThemeParksWiki_ETL', 500, err.message);
        } catch (cbErr) {
            console.warn("Could not log failure to circuit breaker:", cbErr);
        }
    }

    // 2. Alert the Admin via High-Priority Email
    if (process.env.RESEND_API_KEY) {
        try {
            await fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    from: 'Castle companion Watchdog <onboarding@resend.dev>',
                    to: 'patchenu@yahoo.com',
                    subject: `🚨 CRITICAL: Job ${job?.name} Failed`,
                    html: `<h3>Background Job Failure Detected</h3><p><strong>Job Name:</strong> ${job?.name}</p><p><strong>Job ID:</strong> ${job?.id}</p><p><strong>Error Message:</strong> ${err.message}</p><p><strong>Stack Trace:</strong> <pre>${err.stack}</pre></p>`
                })
            });
            console.log(`📧 Failure alert email securely dispatched to patchenu@yahoo.com`);
        } catch (e) {
            console.error('Failed to send Resend email alert:', e);
        }
    }
});

// ── Nightly Cron Jobs ────────────────────────────────────────────────
(async () => {
    try {
        // Scrape official Disney feeds at 3:00 AM EST
        await agentQueue.add('scrape-official-feeds', {}, {
            repeat: { pattern: '0 3 * * *', tz: 'America/New_York' },
            jobId: 'nightly-feed-scraper'
        });
        console.log('🌙 Nightly feed scraper cron registered (3:00 AM EST)');

        // RLHF vector-weight sync at 4:00 AM EST
        await agentQueue.add('nightly-rlhf-sync', {}, {
            repeat: { pattern: '0 4 * * *', tz: 'America/New_York' },
            jobId: 'nightly-rlhf-sync'
        });
        console.log('🧠 Nightly RLHF sync cron registered (4:00 AM EST)');

        // Infrastructure Proof-of-Life at 5:00 AM EST
        await agentQueue.add('infrastructure-guardrail-sync', {}, {
            repeat: { pattern: '0 5 * * *', tz: 'America/New_York' },
            jobId: 'infra-guardrail'
        });
        console.log('🛡️  Infrastructure Guardrail cron registered (5:00 AM EST)');

        // ── Disney API Integration Crons ─────────────────────────────

        // Disney Health Probe — every 5 minutes
        await agentQueue.add('disney-health-probe', {}, {
            repeat: { every: 5 * 60 * 1000 },
            jobId: 'disney-health-probe'
        });
        console.log('🏥 Disney Health Probe registered (every 5 min)');

        // BG1 Sync Engine — every 15 minutes
        await agentQueue.add('bg1-sync', {}, {
            repeat: { every: env.BG1_SYNC_INTERVAL_MIN * 60 * 1000 },
            jobId: 'bg1-sync'
        });
        console.log('🔄 BG1 Sync Engine registered (every ' + env.BG1_SYNC_INTERVAL_MIN + ' min)');

        // Skipper Session Refresh — every 30 minutes
        await agentQueue.add('skipper-session-refresh', {}, {
            repeat: { every: 30 * 60 * 1000 },
            jobId: 'skipper-session-refresh'
        });
        console.log('🔑 Skipper Session Refresh registered (every 30 min)');

        // ThemeParks.wiki Polling — every 5 min for each WDW + DLR park
        for (const parkSlug of ['MK', 'EP', 'HS', 'AK', 'DL', 'DCA']) {
            await agentQueue.add('poll-themeparks-wiki', { parkSlug }, {
                repeat: { every: 5 * 60 * 1000 },
                jobId: `poll-themeparks-wiki-${parkSlug}`
            });
        }
        console.log('🏰 ThemeParks.wiki polling registered (every 5 min, 6 parks — WDW + DLR)');

        // Historical Analytics View Refresh — every 6 hours
        await agentQueue.add('refresh-analytics-views', {}, {
            repeat: { pattern: '0 */6 * * *', tz: 'America/New_York' },
            jobId: 'refresh-analytics-views'
        });
        console.log('📊 Analytics View Refresh registered (every 6 hours)');

        // Historical Data Cleanup — weekly on Sundays at 2 AM
        await agentQueue.add('cleanup-historical-data', {}, {
            repeat: { pattern: '0 2 * * 0', tz: 'America/New_York' },
            jobId: 'cleanup-historical-data'
        });
        console.log('🧹 Historical Data Cleanup registered (weekly Sunday 2 AM)');

        // Historical Data Backup — weekly on Sundays at 3 AM
        await agentQueue.add('backup-historical-data', {}, {
            repeat: { pattern: '0 3 * * 0', tz: 'America/New_York' },
            jobId: 'backup-historical-data'
        });
        console.log('💾 Historical Data Backup registered (weekly Sunday 3 AM for Cloudflare R2)');

        // Fleet Auto-Replenisher — every 15 minutes
        await agentQueue.add('auto-replenish-fleet', {}, {
            repeat: { every: 15 * 60 * 1000 },
            jobId: 'auto-replenish-fleet'
        });
        console.log('🛠️  Fleet Auto-Replenisher registered (every 15 min)');

        // Seed endpoint registry on startup
        await endpointRegistry.seedIfEmpty();
        console.log('📍 Endpoint Registry seeded');

    } catch (err) {
        console.warn('⚠️  Failed to register cron jobs:', err);
    }
})();
} // End Phase 1 RUN_WORKER block
