import { Router } from 'express';
import { AgentController } from '../controllers/AgentController';
import { PaymentController } from '../controllers/PaymentController';
import { ParkController } from '../controllers/ParkController';
import { TelemetryController } from '../controllers/TelemetryController';
import {
    healthProbe, bg1Sync, circuitBreaker, historicalAnalytics, themeParksWiki,
} from '../workers/QueueManager';
import { getSupabaseClient } from '../config/supabase';

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

// ── Phase 2: Feature Flags ──────────────────────────────────────
router.get('/admin/feature-flags', async (_req, res) => {
    try {
        const db = getSupabaseClient();
        const { data, error } = await db
            .from('feature_flags')
            .select('*')
            .order('category', { ascending: true });
        if (error) throw error;
        res.json(data || []);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch feature flags', details: String(err) });
    }
});

router.put('/admin/feature-flags/:id', async (req, res) => {
    try {
        const db = getSupabaseClient();
        const { id } = req.params;
        const { enabled, name, description, tier } = req.body;
        const updates: Record<string, any> = { updated_at: new Date().toISOString() };
        if (typeof enabled === 'boolean') updates.enabled = enabled;
        if (name) updates.name = name;
        if (description) updates.description = description;
        if (tier) updates.tier = tier;
        
        const { data, error } = await db
            .from('feature_flags')
            .update(updates)
            .eq('id', id)
            .select()
            .single();
        if (error) throw error;
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: 'Failed to update feature flag', details: String(err) });
    }
});

// ── Phase 2: Fleet Alerts (derived from circuit + health state) ──
router.get('/admin/fleet-alerts', async (_req, res) => {
    try {
        const alerts: any[] = [];
        
        // Derive alerts from circuit breaker state
        try {
            const circuits = await circuitBreaker.getAllHealth();
            if (Array.isArray(circuits)) {
                for (const circuit of circuits) {
                    if (circuit.state === 'OPEN') {
                        alerts.push({
                            id: `circuit-${circuit.endpoint}`,
                            type: 'circuit_breaker',
                            severity: 'critical',
                            title: `Circuit Tripped: ${circuit.endpoint}`,
                            detail: `Circuit breaker opened after repeated failures. Auto-reset in 30s.`,
                            timestamp: new Date().toISOString(),
                            resolved: false,
                        });
                    }
                }
            }
        } catch { /* circuits unavailable */ }

        // Always include a system status entry if no alerts
        if (alerts.length === 0) {
            alerts.push({
                id: 'all-clear',
                type: 'system',
                severity: 'info',
                title: 'All Systems Nominal',
                detail: 'No active alerts. All circuits closed, all probes healthy.',
                timestamp: new Date().toISOString(),
                resolved: true,
            });
        }

        res.json(alerts);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch fleet alerts', details: String(err) });
    }
});

// ── Phase 2: Users (from Supabase) ──────────────────────────────
router.get('/admin/users', async (req, res) => {
    try {
        const db = getSupabaseClient();
        const page = parseInt(req.query.page as string) || 1;
        const limit = 50;
        const offset = (page - 1) * limit;
        
        const { data, error, count } = await db
            .from('profiles')
            .select('*', { count: 'exact' })
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);
        
        if (error) throw error;
        res.json({ users: data || [], total: count || 0, page, limit });
    } catch (err) {
        // If profiles table doesn't exist yet, return empty
        res.json({ users: [], total: 0, page: 1, limit: 50, note: 'profiles table not yet created' });
    }
});

router.put('/admin/users/:id', async (req, res) => {
    try {
        const db = getSupabaseClient();
        const { id } = req.params;
        const updates = req.body;
        
        const { data, error } = await db
            .from('profiles')
            .update({ ...updates, updated_at: new Date().toISOString() })
            .eq('id', id)
            .select()
            .single();
        if (error) throw error;
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: 'Failed to update user', details: String(err) });
    }
});

// ── Phase 2: Inbox (System Messages) ────────────────────────────
router.get('/admin/inbox', async (req, res) => {
    try {
        const db = getSupabaseClient();
        const { data, error } = await db
            .from('system_messages')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(100);
        if (error) throw error;
        res.json(data || []);
    } catch (err) {
        // If table doesn't exist yet, return empty
        res.json([]);
    }
});

// ── Ride Advisories: Public Read + Admin Seed ───────────────────

// GET all advisories, optionally filtered by park
router.get('/ride-advisories', async (req, res) => {
    try {
        const db = getSupabaseClient();
        const parkId = req.query.parkId as string | undefined;

        let query = db
            .from('ride_advisories')
            .select('*')
            .order('park_id')
            .order('name');

        if (parkId) {
            query = query.eq('park_id', parkId);
        }

        const { data, error } = await query;
        if (error) throw error;

        res.json({
            advisories: data || [],
            total: data?.length || 0,
            parks: [...new Set((data || []).map((r: { park_id: string }) => r.park_id))],
        });
    } catch (err) {
        // Return from TypeScript data if Supabase table is empty
        const { ALL_WDW_ADVISORIES } = await import('../data/RideAdvisories');
        const parkId = req.query.parkId as string | undefined;
        const filtered = parkId
            ? ALL_WDW_ADVISORIES.filter(a => a.parkId === parkId)
            : ALL_WDW_ADVISORIES;
        res.json({
            advisories: filtered,
            total: filtered.length,
            parks: [...new Set(filtered.map(a => a.parkId))],
            source: 'typescript_fallback',
        });
    }
});

// GET single ride advisory
router.get('/ride-advisories/:attractionId', async (req, res) => {
    try {
        const db = getSupabaseClient();
        const { attractionId } = req.params;

        const { data, error } = await db
            .from('ride_advisories')
            .select('*')
            .eq('attraction_id', attractionId)
            .single();

        if (error || !data) {
            // Fallback to TypeScript data
            const { ADVISORY_MAP } = await import('../data/RideAdvisories');
            const advisory = ADVISORY_MAP[attractionId];
            if (!advisory) {
                return res.status(404).json({ error: 'Ride not found' });
            }
            return res.json({ ...advisory, source: 'typescript_fallback' });
        }

        res.json(data);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch advisory', details: String(err) });
    }
});

// POST seed all advisories from TypeScript data → Supabase
router.post('/admin/seed-advisories', async (_req, res) => {
    try {
        const db = getSupabaseClient();
        const { ALL_WDW_ADVISORIES } = await import('../data/RideAdvisories');

        // Transform camelCase TypeScript → snake_case Supabase
        const rows = ALL_WDW_ADVISORIES.map(a => ({
            attraction_id: a.attractionId,
            name: a.name,
            park_id: a.parkId,
            land: a.land,
            height_requirement_inches: a.heightRequirementInches,
            operational_status: a.operationalStatus,
            reopen_date: a.reopenDate,
            reopen_date_confirmed: a.reopenDateConfirmed,
            closure_notes: a.closureNotes,
            permanent_closure_date: a.permanentClosureDate,
            is_new_attraction: a.isNewAttraction,
            expected_open_date: a.expectedOpenDate,
            expected_open_date_confirmed: a.expectedOpenDateConfirmed,
            motion_sickness_risk: a.motionSicknessRisk,
            has_3d_glasses: a.has3DGlasses,
            has_strobe_effects: a.hasStrobeEffects,
            has_dark_enclosed: a.hasDarkEnclosed,
            noise_level: a.noiseLevel,
            spin_intensity: a.spinIntensity,
            height_drop: a.heightDrop,
            water_exposure: a.waterExposure,
            motion_roughness: a.motionRoughness,
            wheelchair_access: a.wheelchairAccess,
            restraint_type: a.restraintType,
            service_animal_permitted: a.serviceAnimalPermitted,
            expectant_mothers_advised: a.expectantMothersAdvised,
            back_neck_advisory: a.backNeckAdvisory,
            lockers_required: a.lockersRequired,
            lockers_recommended: a.lockersRecommended,
            single_rider_available: a.singleRiderAvailable,
            rider_swap_available: a.riderSwapAvailable,
            photo_pass_moment: a.photoPassMoment,
            advisory_notes: JSON.stringify(a.advisoryNotes),
        }));

        const { data, error } = await db
            .from('ride_advisories')
            .upsert(rows, { onConflict: 'attraction_id' })
            .select();

        if (error) throw error;

        res.json({
            seeded: data?.length || 0,
            total: ALL_WDW_ADVISORIES.length,
            parks: {
                MK: ALL_WDW_ADVISORIES.filter(a => a.parkId === 'MK').length,
                EP: ALL_WDW_ADVISORIES.filter(a => a.parkId === 'EP').length,
                HS: ALL_WDW_ADVISORIES.filter(a => a.parkId === 'HS').length,
                AK: ALL_WDW_ADVISORIES.filter(a => a.parkId === 'AK').length,
            },
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to seed advisories', details: String(err) });
    }
});

// ── Ride Preferences: User CRUD ─────────────────────────────────

// GET preferences for a trip
router.get('/trips/:tripId/ride-preferences', async (req, res) => {
    try {
        const db = getSupabaseClient();
        const { tripId } = req.params;

        const { data, error } = await db
            .from('ride_preferences')
            .select('*')
            .eq('trip_id', tripId)
            .order('priority_tier')
            .order('priority_rank');

        if (error) throw error;
        res.json({ preferences: data || [], total: data?.length || 0 });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch preferences', details: String(err) });
    }
});

// PUT upsert a ride preference (create or update)
router.put('/trips/:tripId/ride-preferences', async (req, res) => {
    try {
        const db = getSupabaseClient();
        const { tripId } = req.params;
        const { userId, attractionId, attractionName, parkId, repeatCount, priorityTier, priorityRank, userNotes } = req.body;

        if (!userId || !attractionId || !attractionName || !parkId) {
            return res.status(400).json({ error: 'Missing required fields: userId, attractionId, attractionName, parkId' });
        }

        const { data, error } = await db
            .from('ride_preferences')
            .upsert({
                trip_id: tripId,
                user_id: userId,
                attraction_id: attractionId,
                attraction_name: attractionName,
                park_id: parkId,
                repeat_count: Math.min(Math.max(repeatCount || 1, 1), 5),
                priority_tier: priorityTier || 'must_do',
                priority_rank: priorityRank || null,
                user_notes: userNotes || null,
                updated_at: new Date().toISOString(),
            }, { onConflict: 'trip_id,user_id,attraction_id' })
            .select()
            .single();

        if (error) throw error;
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: 'Failed to upsert preference', details: String(err) });
    }
});

// DELETE a ride preference
router.delete('/trips/:tripId/ride-preferences/:attractionId', async (req, res) => {
    try {
        const db = getSupabaseClient();
        const { tripId, attractionId } = req.params;
        const userId = req.query.userId as string;

        if (!userId) {
            return res.status(400).json({ error: 'userId query parameter required' });
        }

        const { error } = await db
            .from('ride_preferences')
            .delete()
            .eq('trip_id', tripId)
            .eq('user_id', userId)
            .eq('attraction_id', attractionId);

        if (error) throw error;
        res.json({ deleted: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete preference', details: String(err) });
    }
});

// POST score and rank all preferences for a trip (uses RepeatVoteScoring engine)
router.post('/trips/:tripId/ride-preferences/score', async (req, res) => {
    try {
        const db = getSupabaseClient();
        const { tripId } = req.params;

        const { data, error } = await db
            .from('ride_preferences')
            .select('*')
            .eq('trip_id', tripId);

        if (error) throw error;
        if (!data || data.length === 0) {
            return res.json({ scored: [], total: 0, snipeJobs: 0 });
        }

        const { scoreAllPreferences, generateSnipeJobs } = await import('../data/RepeatVoteScoring');

        // Map Supabase rows → RidePreference interface
        const prefs = data.map((row: {
            attraction_id: string;
            attraction_name: string;
            park_id: string;
            repeat_count: number;
            priority_tier: string;
            priority_rank: number;
        }) => ({
            attractionId: row.attraction_id,
            attractionName: row.attraction_name,
            parkId: row.park_id,
            repeatCount: row.repeat_count,
            priorityTier: row.priority_tier as 'must_do' | 'like_to' | 'will_avoid',
            priorityRank: row.priority_rank || 99,
        }));

        const scored = scoreAllPreferences(prefs);
        const allSnipeJobs = scored.flatMap(generateSnipeJobs);

        res.json({
            scored,
            total: scored.length,
            snipeJobs: allSnipeJobs.length,
            snipeJobDetails: allSnipeJobs,
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to score preferences', details: String(err) });
    }
});

// ── LLM Token Circuit Breaker: Admin Telemetry ──────────────────

router.get('/admin/llm-usage', async (_req, res) => {
    try {
        const { LLMTokenCircuitBreaker } = await import('../services/LLMTokenCircuitBreaker');
        const llmCB = new LLMTokenCircuitBreaker();
        const stats = await llmCB.getUsageStats();
        res.json(stats);
    } catch (err) {
        // If Redis is unavailable, return empty stats
        res.json({
            daily: { tokens: 0, costUsd: 0, ceiling: 500 },
            hourly: { tokens: 0, costUsd: 0, ceiling: 100 },
            circuitState: { state: 'CLOSED', reason: null },
            recentInvocations: [],
            quotas: {},
            note: 'Redis unavailable — showing defaults',
        });
    }
});

router.post('/admin/llm-circuit/reset', async (_req, res) => {
    try {
        const { LLMTokenCircuitBreaker } = await import('../services/LLMTokenCircuitBreaker');
        const llmCB = new LLMTokenCircuitBreaker();
        await llmCB.resetCircuit();
        res.json({ success: true, message: 'LLM circuit breaker reset to CLOSED' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to reset circuit', details: String(err) });
    }
});

// ── Priority Queue: Stats + Job Submission ──────────────────────

router.get('/admin/queue-stats', async (_req, res) => {
    try {
        const { PriorityQueueManager } = await import('../services/PriorityQueue');
        const pq = new PriorityQueueManager();
        const stats = await pq.getStats();
        res.json(stats);
    } catch (err) {
        res.json({
            waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0,
            p1Waiting: 0, p2Waiting: 0, p3Waiting: 0,
            isPeakHours: false,
            workerAllocation: { p1Percent: 50, p2p3Percent: 50 },
            note: 'Queue unavailable — showing defaults',
        });
    }
});

router.get('/admin/queue-dlq', async (_req, res) => {
    try {
        const { PriorityQueueManager } = await import('../services/PriorityQueue');
        const pq = new PriorityQueueManager();
        const jobs = await pq.getDLQJobs(50);
        res.json({ jobs: jobs.map(j => ({ id: j.id, data: j.data })), count: jobs.length });
    } catch (err) {
        res.json({ jobs: [], count: 0 });
    }
});

// Submit a snipe job (returns 202 Accepted + job ID)
router.post('/snipe/submit', async (req, res) => {
    try {
        const { userId, tripId, attractionId, attractionName, preferredWindows, tier } = req.body;

        if (!userId || !tripId || !attractionId || !attractionName || !preferredWindows) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // Rate limit check
        const { RateLimiter } = await import('../services/RateLimiter');
        const rateLimiter = new RateLimiter();
        const rateCheck = await rateLimiter.checkLimits(userId);

        if (!rateCheck.allowed) {
            return res.status(429).json({
                error: 'Rate limited',
                limitedBy: (rateCheck as { limitedBy?: string }).limitedBy,
                retryAfterMs: rateCheck.retryAfterMs,
                remaining: rateCheck.remaining,
            });
        }

        // LLM circuit breaker check (snipe jobs may trigger LLM calls)
        const { LLMTokenCircuitBreaker } = await import('../services/LLMTokenCircuitBreaker');
        const llmCB = new LLMTokenCircuitBreaker();
        const llmCheck = await llmCB.canInvoke(userId, tier || 'explorer', 500);

        // Submit to priority queue
        const { PriorityQueueManager } = await import('../services/PriorityQueue');
        const pq = new PriorityQueueManager();
        const result = await pq.submitSnipeJob({
            idempotencyKey: `${userId}:${attractionId}:${preferredWindows[0]}`,
            userId,
            tripId,
            attractionId,
            attractionName,
            preferredWindows,
            tier: tier || 'explorer',
        });

        // 202 Accepted — job is queued
        res.status(202).json({
            status: 'accepted',
            jobId: result.jobId,
            priority: result.priority,
            position: result.position,
            llmAvailable: llmCheck.allowed,
        });
    } catch (err: any) {
        if (err.message?.includes('Duplicate snipe')) {
            return res.status(409).json({ error: err.message });
        }
        res.status(500).json({ error: 'Failed to submit snipe job', details: String(err) });
    }
});

// ── Day Recalibration: Advisory-Aware Scheduling ────────────────

router.post('/trips/:tripId/recalibrate', async (req, res) => {
    try {
        const { tripId } = req.params;
        const { parkId, guests, scoredRides, existingItinerary } = req.body;

        if (!parkId) {
            return res.status(400).json({ error: 'parkId is required' });
        }

        // Load advisory data
        const supabase = getSupabaseClient();
        let advisories: any[] = [];

        const { data: advisoryData } = await supabase
            .from('ride_advisories')
            .select('*')
            .eq('park_id', parkId);

        if (advisoryData && advisoryData.length > 0) {
            advisories = advisoryData;
        } else {
            // Fallback to TypeScript data
            const { ALL_WDW_ADVISORIES } = await import('../data/RideAdvisories');
            advisories = ALL_WDW_ADVISORIES.filter((a: { parkId: string }) => a.parkId === parkId);
        }

        // Run recalibration engine
        const { DayRecalibrationEngine } = await import('../services/DayRecalibrationEngine');
        const result = DayRecalibrationEngine.calibrate({
            tripId,
            parkId: parkId as any,
            guests: guests || [],
            advisories,
            scoredRides: scoredRides || [],
            existingItinerary: existingItinerary || [],
            activeSnipeCount: 0,
            totalActiveUsers: 1,
        });

        res.json({
            tripId,
            parkId,
            eligibleRides: result.eligibleRides.length,
            filteredRides: result.filteredRides,
            flashMobWarnings: result.flashMobWarnings,
            diversifiedSlots: result.diversifiedSlots,
            enrichedSteps: result.enrichedSteps.length,
            advisoryCount: advisories.length,
        });
    } catch (err) {
        res.status(500).json({ error: 'Recalibration failed', details: String(err) });
    }
});

// ── Whisper Gallery: Content Moderation ──────────────────────────

// Submit content for moderation (4-layer pipeline)
router.post('/whisper/moderate', async (req, res) => {
    try {
        const { contentId, userId, text, contentType, accountAgeDays, priorFlags } = req.body;

        if (!text || !userId) {
            return res.status(400).json({ error: 'text and userId are required' });
        }

        const { WhisperGalleryModeration } = await import('../services/WhisperGalleryModeration');
        const moderator = new WhisperGalleryModeration();

        const result = await moderator.moderate({
            contentId: contentId || `wg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            userId,
            text,
            contentType: contentType || 'tip',
            accountAgeDays,
            priorFlags,
        });

        // Return appropriate HTTP status based on action
        const status = result.action === 'rejected' ? 403
            : result.action === 'queued_for_review' ? 202
            : 200;

        res.status(status).json(result);
    } catch (err) {
        res.status(500).json({ error: 'Moderation failed', details: String(err) });
    }
});

// Get human review queue (for UnifiedInbox)
router.get('/admin/whisper/review-queue', async (_req, res) => {
    try {
        const { WhisperGalleryModeration } = await import('../services/WhisperGalleryModeration');
        const moderator = new WhisperGalleryModeration();
        const queue = await moderator.getReviewQueue(50);
        res.json({ queue, count: queue.length });
    } catch (err) {
        res.json({ queue: [], count: 0 });
    }
});

// Human moderator decision
router.post('/admin/whisper/decision', async (req, res) => {
    try {
        const { contentId, adminId, decision, notes } = req.body;

        if (!contentId || !adminId || !decision) {
            return res.status(400).json({ error: 'contentId, adminId, and decision are required' });
        }

        if (!['approve', 'reject'].includes(decision)) {
            return res.status(400).json({ error: 'decision must be "approve" or "reject"' });
        }

        const { WhisperGalleryModeration } = await import('../services/WhisperGalleryModeration');
        const moderator = new WhisperGalleryModeration();
        const auditEntry = await moderator.humanDecision(contentId, adminId, decision, notes);

        res.json({ success: true, auditEntry });
    } catch (err) {
        res.status(500).json({ error: 'Decision failed', details: String(err) });
    }
});

// AB 316 Audit log
router.get('/admin/whisper/audit-log', async (req, res) => {
    try {
        const date = (req.query.date as string) || new Date().toISOString().substring(0, 10);
        const limit = parseInt(req.query.limit as string) || 100;

        const { WhisperGalleryModeration } = await import('../services/WhisperGalleryModeration');
        const moderator = new WhisperGalleryModeration();
        const entries = await moderator.getAuditLog(date, limit);

        res.json({ date, entries, count: entries.length });
    } catch (err) {
        res.json({ date: '', entries: [], count: 0 });
    }
});

// Moderation stats (dashboard panel)
router.get('/admin/whisper/stats', async (req, res) => {
    try {
        const date = req.query.date as string | undefined;

        const { WhisperGalleryModeration } = await import('../services/WhisperGalleryModeration');
        const moderator = new WhisperGalleryModeration();
        const stats = await moderator.getStats(date);

        res.json(stats);
    } catch (err) {
        res.json({
            total: 0, safe: 0, rejected: 0, rumor: 0,
            needsReview: 0, pendingReview: 0, avgLatencyMs: 0,
            byLayer: { L1: 0, L2: 0, L3: 0, L4: 0 },
        });
    }
});

export default router;
