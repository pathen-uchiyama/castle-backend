import { Router } from 'express';
import { AgentController } from '../controllers/AgentController';
import { PaymentController } from '../controllers/PaymentController';
import { ParkController } from '../controllers/ParkController';
import { TelemetryController } from '../controllers/TelemetryController';
import {
    healthProbe, bg1Sync, circuitBreaker, historicalAnalytics, themeParksWiki,
} from '../workers/QueueManager';

const router = Router();

// Endpoint to start the background Scout polling for a given trip/park
router.post('/agents/scout', AgentController.activateScout);

// Real-time Park Status (Used by Dashboard Map)
router.get('/parks/:parkId/status', ParkController.getParkStatus);

// ── Phase 10: Infrastructure Efficiency & Telemetry ──────────────────
router.get('/telemetry', TelemetryController.getLatestMetrics);

// Endpoint to ask the Strategist for a "Magic Pivot" during a disruption
router.post('/agents/strategist/pivot', AgentController.requestPivot);

// Admin: Seed park closures & seasonal events into Redis + Pinecone
router.post('/admin/seed-closures', AgentController.seedClosures);
router.post('/admin/simulate-pivot', AgentController.simulatePivot);

// Dining Sniper: Start/cancel/check dining reservation searches
router.post('/dining/search', AgentController.startDiningSearch);
router.delete('/dining/search/:searchId', AgentController.cancelDiningSearch);
router.get('/dining/search/:searchId', AgentController.getDiningSearchStatus);

// Telemetry & RLHF: Behavioral signals, pivot feedback, and fine-tuning export
router.post('/telemetry/signal', AgentController.recordSignal);
router.post('/telemetry/pivot-feedback', AgentController.recordPivotFeedback);
router.get('/telemetry/stats', AgentController.getDailyStats);
router.get('/telemetry/stats/:date', AgentController.getDailyStats);
router.get('/admin/export-rlhf', AgentController.exportRLHF);

// Skipper Factory: Account automation & pool management
router.post('/verify-account', AgentController.verifyAccount);           // Cloudflare Worker callback
router.post('/skipper/allocate', AgentController.allocateSkipper);       // Allocate a Skipper for a trip
router.post('/skipper/:id/retire', AgentController.retireSkipper);       // Retire after trip ends
router.get('/skipper/pool-stats', AgentController.getPoolStats);         // Pool analytics
router.post('/admin/provision-domain', AgentController.provisionDomain); // Provision new domain + skippers

// Monetization & Billing
router.post('/payment/checkout', PaymentController.createCheckout);
router.post('/payment/portal', PaymentController.createPortal);

// ── Disney API Integration: Admin Endpoints ──────────────────────────

// Health Dashboard — aggregated Disney API + ThemeParks.wiki health
router.get('/admin/disney-health', async (_req, res) => {
    try {
        const result = await healthProbe.runHealthCheck();
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: 'Health check failed', details: String(err) });
    }
});

// BG1 Sync Status — last sync, pending reviews, recent activity
router.get('/admin/bg1-sync-status', async (_req, res) => {
    try {
        const status = await bg1Sync.getStatus();
        res.json(status);
    } catch (err) {
        res.status(500).json({ error: 'Sync status failed', details: String(err) });
    }
});

// Circuit Breaker Status — all endpoint health states
router.get('/admin/circuit-health', async (_req, res) => {
    try {
        const circuits = await circuitBreaker.getAllHealth();
        res.json({ circuits, hasTripped: circuits.some(c => c.state !== 'CLOSED') });
    } catch (err) {
        res.status(500).json({ error: 'Circuit health failed', details: String(err) });
    }
});

// Manual Circuit Reset
router.post('/admin/circuit-reset/:endpoint', async (req, res) => {
    try {
        await circuitBreaker.resetCircuit(req.params.endpoint);
        res.json({ success: true, endpoint: req.params.endpoint, state: 'CLOSED' });
    } catch (err) {
        res.status(500).json({ error: 'Circuit reset failed', details: String(err) });
    }
});

// Crowd Level — real-time crowd level vs historical average for a park
router.get('/admin/crowd-level/:parkId', async (req, res) => {
    try {
        const crowdLevel = await historicalAnalytics.getCrowdLevel(req.params.parkId);
        res.json(crowdLevel);
    } catch (err) {
        res.status(500).json({ error: 'Crowd level failed', details: String(err) });
    }
});

// LL Sell-Out Predictions — when does each ride's LL typically sell out?
router.get('/admin/sellout-predictions', async (_req, res) => {
    try {
        const predictions = await historicalAnalytics.getSellOutPredictions();
        res.json({ predictions });
    } catch (err) {
        res.status(500).json({ error: 'Sell-out predictions failed', details: String(err) });
    }
});

router.get('/admin/sellout-predictions/:parkId', async (req, res) => {
    try {
        const predictions = await historicalAnalytics.getSellOutPredictions(req.params.parkId);
        res.json({ predictions });
    } catch (err) {
        res.status(500).json({ error: 'Sell-out predictions failed', details: String(err) });
    }
});

// Live LL Availability — latest snapshot from ll_availability_history
router.get('/admin/ll-availability', async (_req, res) => {
    try {
        const { getSupabaseClient } = await import('../config/supabase');
        const db = getSupabaseClient();
        const { data, error } = await db
            .from('ll_availability_history')
            .select('attraction_name, park_id, ll_type, is_available, next_return_time, display_price, recorded_at')
            .order('recorded_at', { ascending: false })
            .limit(50);
        if (error) throw error;
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: 'LL availability failed', details: String(err) });
    }
});
// Live Wait Times — real-time from ThemeParks.wiki for all parks
router.get('/admin/live-wait-times', async (_req, res) => {
    try {
        const results: any[] = [];
        const parks = ['MK', 'EP', 'HS', 'AK', 'DL', 'DCA'];
        for (const parkSlug of parks) {
            const liveData = await themeParksWiki.getLiveData(parkSlug);
            for (const entity of liveData) {
                if (entity.entityType !== 'ATTRACTION' && entity.entityType !== 'SHOW') continue;
                results.push({
                    id: entity.id,
                    name: entity.name,
                    park: parkSlug,
                    type: entity.entityType === 'SHOW' ? 'Show' : 'Ride',
                    status: entity.status,
                    currentWait: entity.queue?.STANDBY?.waitTime ?? null,
                    llReturnTime: entity.queue?.RETURN_TIME?.returnStart ?? entity.queue?.PAID_RETURN_TIME?.returnStart ?? null,
                    llType: entity.queue?.PAID_RETURN_TIME ? 'Individual LL' : entity.queue?.RETURN_TIME ? 'Tier 1' : null,
                    llAvailable: (entity.queue?.RETURN_TIME?.state === 'AVAILABLE') || (entity.queue?.PAID_RETURN_TIME?.state === 'AVAILABLE') || false,
                    llPrice: entity.queue?.PAID_RETURN_TIME?.price?.formatted ?? null,
                    vqStatus: entity.queue?.BOARDING_GROUP?.allocationStatus ?? null,
                });
            }
        }
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: 'Live wait times failed', details: String(err) });
    }
});

export default router;
