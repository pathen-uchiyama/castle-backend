import { Router } from 'express';
import { AgentController } from '../controllers/AgentController';
import { PaymentController } from '../controllers/PaymentController';
import { ParkController } from '../controllers/ParkController';
import { TelemetryController } from '../controllers/TelemetryController';

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

export default router;
