import { Request, Response } from 'express';
import { agentQueue, diningSniper, telemetryCollector } from '../workers/QueueManager';
import { ReasoningEngine } from '../services/ReasoningEngine';
import { KnowledgeLayer } from '../services/KnowledgeLayer';
import { ParkStatusRegistry } from '../services/ParkStatusRegistry';
import { AccountRegistry } from '../services/AccountRegistry';
import { MARCH_2026_CLOSURES, MARCH_2026_EVENTS } from '../data/march2026Closures';

const engine = new ReasoningEngine();
const db = new KnowledgeLayer();
const parkRegistry = new ParkStatusRegistry();
const accountRegistry = new AccountRegistry();

export class AgentController {

    /**
     * Triggers the Scout to start monitoring the park actively.
     */
    static async activateScout(req: Request, res: Response) {
        try {
            const { tripId, parkId } = req.body;
            await agentQueue.add('poll-wait-times', { tripId, parkId }, {
                repeat: { every: 60000 },
                jobId: `scout-${tripId}`
            });
            res.status(200).json({ status: 'Monitoring Active', agent: 'Scout' });
        } catch (error) {
            res.status(500).json({ error: 'Failed to deploy Scout Agent' });
        }
    }

    /**
     * Endpoint for the app to request an immediate pivot strategy from the AI
     */
    static async requestPivot(req: Request, res: Response) {
        try {
            const { currentItinerary, disruption, strategyProfile, parkId, tier } = req.body;
            const context = await db.retrieveContext(disruption);
            const strategy = await engine.generatePivotStrategy(
                `Current Plan: ${currentItinerary}\n\nPark Rules Context: ${context}`,
                disruption,
                strategyProfile,
                parkId,
                tier
            );
            res.status(200).json({
                agent: 'Strategist',
                response: strategy,
                action: 'Awaiting User Confirmation'
            });
        } catch (error) {
            res.status(500).json({ error: 'Failed to generate Pivot' });
        }
    }

    /**
     * Admin tool to simulate a pivot and see the reasoning trace.
     */
    static async simulatePivot(req: Request, res: Response) {
        try {
            const { park, disruption, profile, tier } = req.body;
            
            // Mock a strategy profile based on the preset name
            const mockProfile = {
                pacingFilter: profile === 'The Commando' ? 'intense' : 'relaxed',
                primaryFocus: profile === 'The Commando' ? 'thrills' : 'classic',
                diningStyle: 'quick',
                singleRiderAllowed: true,
                dasAllowed: false,
                onSiteResort: true,
                splurgeAppetite: profile === 'Magic Skipper' ? 'high' : 'low',
                premiumInterests: [],
                budgetDirectives: {
                    llMultiPassAllowed: true,
                    llSinglePassAllowed: true,
                },
                rideDirectives: {
                    maxWaitToleranceMins: 45,
                    thrillCap: 'High',
                    prioritizeIndoor: false,
                    minimizeWalking: true, // Enabled for clustering simulation
                }
            };

            const strategy = await engine.generatePivotStrategy(
                `SIMULATION MODE: Typical weekday itinerary for ${park}.`,
                disruption,
                mockProfile as any,
                park,
                tier || 'plaid_guardian' // Admin default
            );

            res.status(200).json({ response: strategy });
        } catch (error) {
            res.status(500).json({ error: 'Simulation failed' });
        }
    }

    /**
     * Seeds the ParkStatusRegistry with the latest closure data.
     */
    static async seedClosures(_req: Request, res: Response) {
        try {
            await parkRegistry.seedClosures(MARCH_2026_CLOSURES);
            for (const event of MARCH_2026_EVENTS) {
                const text = `${event.name} (${event.parkId}): ${event.startDate} to ${event.endDate || 'Ongoing'}. ` +
                    `Key details: ${event.highlights.join('; ')}`;
                await db.upsertDocument(event.id, text, {
                    type: 'seasonal_event',
                    parkId: event.parkId,
                    startDate: event.startDate
                });
            }
            res.status(200).json({
                status: 'Seeded',
                closures: MARCH_2026_CLOSURES.length,
                events: MARCH_2026_EVENTS.length
            });
        } catch (error) {
            res.status(500).json({ error: 'Failed to seed closure data' });
        }
    }

    // ── Dining Sniper Endpoints ──────────────────────────────────────────

    /**
     * Starts a server-side dining reservation search.
     * POST /dining/search
     */
    static async startDiningSearch(req: Request, res: Response) {
        try {
            const searchId = await diningSniper.startSearch(req.body);
            res.status(200).json({
                status: 'Search Started',
                searchId,
                message: `Monitoring dining availability. You'll receive a push notification when a slot is found.`
            });
        } catch (error) {
            res.status(500).json({ error: 'Failed to start dining search' });
        }
    }

    /**
     * Cancels an active dining search.
     * DELETE /dining/search/:searchId
     */
    static async cancelDiningSearch(req: Request, res: Response) {
        try {
            await diningSniper.cancelSearch(req.params.searchId as string);
            res.status(200).json({ status: 'Search Cancelled' });
        } catch (error) {
            res.status(500).json({ error: 'Failed to cancel dining search' });
        }
    }

    /**
     * Gets the current status of a dining search.
     * GET /dining/search/:searchId
     */
    static async getDiningSearchStatus(req: Request, res: Response) {
        try {
            const result = await diningSniper.getSearchStatus(req.params.searchId as string);
            if (!result) {
                res.status(404).json({ error: 'Search not found or expired' });
                return;
            }
            res.status(200).json(result);
        } catch (error) {
            res.status(500).json({ error: 'Failed to get search status' });
        }
    }

    // ── Telemetry & RLHF Endpoints ───────────────────────────────────────

    /**
     * Records a behavioral signal from the mobile app.
     * POST /telemetry/signal
     */
    static async recordSignal(req: Request, res: Response) {
        try {
            await telemetryCollector.recordSignal(req.body);
            res.status(200).json({ status: 'Signal Recorded' });
        } catch (error) {
            res.status(500).json({ error: 'Failed to record signal' });
        }
    }

    /**
     * Records explicit pivot feedback (thumbs up/down).
     * POST /telemetry/pivot-feedback
     */
    static async recordPivotFeedback(req: Request, res: Response) {
        try {
            const { tripId, userId, pivotId, feedbackScore, originalPrompt, pivotResponse, comment } = req.body;
            await telemetryCollector.recordPivotFeedback(
                tripId, userId, pivotId, feedbackScore, originalPrompt, pivotResponse, comment
            );
            res.status(200).json({ status: 'Feedback Recorded' });
        } catch (error) {
            res.status(500).json({ error: 'Failed to record feedback' });
        }
    }

    /**
     * Exports RLHF training data as JSONL for fine-tuning.
     * GET /admin/export-rlhf
     */
    static async exportRLHF(_req: Request, res: Response) {
        try {
            const jsonl = await telemetryCollector.exportFineTuningData();
            res.setHeader('Content-Type', 'application/jsonl');
            res.setHeader('Content-Disposition', 'attachment; filename=rlhf_training.jsonl');
            res.status(200).send(jsonl);
        } catch (error) {
            res.status(500).json({ error: 'Failed to export RLHF data' });
        }
    }

    /**
     * Gets daily telemetry stats.
     * GET /telemetry/stats/:date?
     */
    static async getDailyStats(req: Request, res: Response) {
        try {
            const date = req.params.date as string | undefined;
            const stats = await telemetryCollector.getDailyStats(date);
            res.status(200).json(stats);
        } catch (error) {
            res.status(500).json({ error: 'Failed to get stats' });
        }
    }

    // ── Skipper Factory Endpoints ────────────────────────────────────────

    /**
     * Webhook called by Cloudflare Email Worker when a verification code is intercepted.
     * POST /verify-account
     */
    static async verifyAccount(req: Request, res: Response) {
        try {
            const { email, code } = req.body;
            if (!email || !code) return res.status(400).json({ error: 'Missing email or code' });

            await accountRegistry.storeVerificationCode(email, code);
            res.status(200).json({ status: 'Code stored and account verified' });
        } catch (error) {
            res.status(500).json({ error: 'Failed to process verification code' });
        }
    }

    /**
     * Allocates an available Skipper account for a trip.
     * POST /skipper/allocate
     */
    static async allocateSkipper(req: Request, res: Response) {
        try {
            const { tripId, userId, resort } = req.body;
            if (!tripId || !userId) return res.status(400).json({ error: 'Missing tripId or userId' });

            const skipper = await accountRegistry.allocateSkipper(tripId, userId, resort);
            if (!skipper) return res.status(404).json({ error: 'No available Skippers in pool' });

            res.status(200).json({ skipper });
        } catch (error) {
            res.status(500).json({ error: 'Failed to allocate Skipper' });
        }
    }

    /**
     * Retires a Skipper after a trip ends.
     * POST /skipper/:id/retire
     */
    static async retireSkipper(req: Request, res: Response) {
        try {
            await accountRegistry.retireSkipper(req.params.id as string);
            res.status(200).json({ status: 'Skipper retired and cooldown started' });
        } catch (error) {
            res.status(500).json({ error: 'Failed to retire Skipper' });
        }
    }

    /**
     * Returns current pool statistics for the admin dashboard.
     * GET /skipper/pool-stats
     */
    static async getPoolStats(_req: Request, res: Response) {
        try {
            const stats = await accountRegistry.getPoolStats();
            res.status(200).json(stats);
        } catch (error) {
            res.status(500).json({ error: 'Failed to get pool stats' });
        }
    }

    /**
     * Returns all skipper accounts for the admin dashboard.
     * GET /skippers
     */
    static async getAllSkippers(_req: Request, res: Response) {
        try {
            const skippers = await accountRegistry.getAllSkippers();
            res.status(200).json(skippers);
        } catch (error) {
            res.status(500).json({ error: 'Failed to fetch skippers' });
        }
    }

    /**
     * Provisions a new utility domain and a batch of Skipper accounts.
     * POST /admin/provision-domain
     */
    static async provisionDomain(req: Request, res: Response) {
        try {
            const { domainName, count, resort } = req.body;
            if (!domainName || !count) return res.status(400).json({ error: 'Missing domainName or count' });

            const domain = await accountRegistry.registerDomain(domainName);
            const provisioned = await accountRegistry.provisionSkippers(domain.id, domainName, count, resort);

            res.status(200).json({
                status: 'Domain and Skippers provisioned',
                domain,
                provisionedCount: provisioned
            });
        } catch (error) {
            res.status(500).json({ error: 'Failed to provision domain' });
        }
    }
}
