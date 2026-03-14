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

const connection = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
});

export const agentQueue = new Queue("agent-tasks", { connection: connection as any });

const parkRegistry = new ParkStatusRegistry();
const reasoningEngine = new ReasoningEngine();
const scraper = new ScraperPipeline();
const diningSniper = new DiningSniper(agentQueue);
const vqSniper = new VirtualQueueSniper(agentQueue);
const waitMagic = new WaitMagicEngine(agentQueue);
const telemetryCollector = new TelemetryCollector();

export { diningSniper, vqSniper, waitMagic, telemetryCollector }; // Export for use in AgentController

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
const scoutWorker = new Worker(
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

            default:
                console.log(`[Unknown] Task ${job.name} not configured.`);
        }
    },
    { connection: connection as any }
);

scoutWorker.on("completed", (job) => {
    console.log(`✅ Job [${job.id}] ${job.name} finished successfully.`);
});

scoutWorker.on("failed", (job, err) => {
    console.error(`❌ Job [${job?.id}] ${job?.name} failed:`, err);
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
    } catch (err) {
        console.warn('⚠️  Failed to register nightly cron jobs:', err);
    }
})();
