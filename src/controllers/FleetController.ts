import { Request, Response } from 'express';
import { FleetOrchestrator } from '../services/FleetOrchestrator';
import { AccountRegistry } from '../services/AccountRegistry';

const orchestrator = new FleetOrchestrator();
const registry = new AccountRegistry();

/**
 * FleetController — Dashboard action button handlers for fleet operations.
 * All endpoints are under /admin/fleet/*
 */
export class FleetController {

    /**
     * One-click: Provision new Skipper accounts via the Factory.
     * POST /admin/fleet/provision
     * Body: { count?: number } (default: 5)
     */
    static async provision(req: Request, res: Response) {
        try {
            const count = Math.min(req.body.count || 5, 20); // Cap at 20 per request
            console.log(`[FleetController] Provisioning ${count} new Skippers...`);
            
            // Start provisioning in the background (don't block the request)
            orchestrator.provisionNewSkippers(count).then(result => {
                console.log(`[FleetController] Provisioning complete:`, result);
            }).catch(err => {
                console.error('[FleetController] Provisioning failed:', err);
            });

            res.status(202).json({ 
                status: 'Provisioning started',
                count,
                message: `Factory is registering ${count} accounts. Check fleet/health for progress.`
            });
        } catch (error) {
            res.status(500).json({ error: 'Failed to start provisioning' });
        }
    }

    /**
     * One-click: Execute load shedding for 7AM surge.
     * POST /admin/fleet/load-shed
     */
    static async loadShed(_req: Request, res: Response) {
        try {
            const result = await orchestrator.executeLoadShedding();
            res.status(200).json(result);
        } catch (error) {
            res.status(500).json({ error: 'Failed to execute load shedding' });
        }
    }

    /**
     * One-click: Rotate proxies and deactivate compromised domains.
     * POST /admin/fleet/rotate-proxies
     */
    static async rotateProxies(_req: Request, res: Response) {
        try {
            const result = await orchestrator.rotateProxies();
            res.status(200).json(result);
        } catch (error) {
            res.status(500).json({ error: 'Failed to rotate proxies' });
        }
    }

    /**
     * Emergency: Deploy all warm reserves immediately.
     * POST /admin/fleet/deploy-reserves
     */
    static async deployReserves(_req: Request, res: Response) {
        try {
            const result = await orchestrator.deployWarmReserves();
            res.status(200).json(result);
        } catch (error) {
            res.status(500).json({ error: 'Failed to deploy reserves' });
        }
    }

    /**
     * Force replace a specific banned Skipper.
     * POST /admin/fleet/replace-banned
     * Body: { skipperId: string }
     */
    static async replaceBanned(req: Request, res: Response) {
        try {
            const { skipperId } = req.body;
            if (!skipperId) return res.status(400).json({ error: 'Missing skipperId' });

            const result = await orchestrator.forceReplace(skipperId);
            res.status(200).json(result);
        } catch (error) {
            res.status(500).json({ error: 'Failed to replace banned Skipper' });
        }
    }

    /**
     * Force run the auto replenisher loop once immediately.
     */
    static async forceReplenish(_req: Request, res: Response) {
        try {
            console.log('[FleetController] User triggered forceful auto-replenish pipeline');
            const result = await orchestrator.autoReplenishFleet();
            res.status(200).json({ success: true, message: 'Auto-replenisher triggered', ...result });
        } catch (error) {
            res.status(500).json({ error: 'Failed to replenish fleet', details: String(error) });
        }
    }

    /**
     * Comprehensive fleet health for the dashboard.
     * GET /admin/fleet/health
     */
    static async getHealth(_req: Request, res: Response) {
        try {
            const health = await orchestrator.getFleetHealth();
            res.status(200).json(health);
        } catch (error) {
            res.status(500).json({ error: 'Failed to get fleet health' });
        }
    }

    /**
     * Incubation pipeline status.
     * GET /admin/fleet/incubation-status
     */
    static async getIncubationStatus(_req: Request, res: Response) {
        try {
            const status = await orchestrator.getIncubationStatus();
            res.status(200).json(status);
        } catch (error) {
            res.status(500).json({ error: 'Failed to get incubation status' });
        }
    }

    /**
     * Manually trigger an incubation pulse (admin/cron).
     * POST /admin/fleet/run-pulse
     */
    static async runPulse(_req: Request, res: Response) {
        try {
            const result = await orchestrator.runIncubationPulse();
            res.status(200).json(result);
        } catch (error) {
            res.status(500).json({ error: 'Failed to run incubation pulse' });
        }
    }

    /**
     * Test endpoint: Manually inject an OTP code for pipeline testing.
     * POST /admin/fleet/test-otp
     * Body: { email: string, code: string }
     */
    static async testOTP(req: Request, res: Response) {
        try {
            const { email, code } = req.body;
            if (!email || !code) return res.status(400).json({ error: 'Missing email or code' });

            await registry.storeVerificationCode(email, code);
            res.status(200).json({ status: 'Test OTP stored', email, code });
        } catch (error) {
            res.status(500).json({ error: 'Failed to store test OTP' });
        }
    }
    /**
     * Toggles the global kill switch to pause or resume automated operations.
     * POST /admin/kill-switch
     */
    static async toggleKillSwitch(req: Request, res: Response) {
        try {
            const { active } = req.body;
            console.log(`[FleetController] Global Kill Switch requested: ${active ? 'ENGAGED' : 'DISENGAGED'}`);
            
            // In a full implementation, this state should persist in the DB (Feature Flags).
            // For now, we update it via the orchestrator.
            const result = await orchestrator.toggleKillSwitch(!!active);
            
            res.status(200).json({ success: true, message: `Kill switch ${active ? 'engaged' : 'disengaged'}`, ...result });
        } catch (error) {
            res.status(500).json({ error: 'Failed to toggle kill switch', details: String(error) });
        }
    }
}
