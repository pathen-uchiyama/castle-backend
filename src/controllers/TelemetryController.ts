import { Request, Response } from 'express';
import { TelemetryService } from '../services/TelemetryService';

export class TelemetryController {
    /**
     * GET /api/telemetry
     * Retrieves the latest system-wide operational metrics.
     */
    static async getLatestMetrics(req: Request, res: Response) {
        try {
            const metrics = await TelemetryService.getLatestMetrics();
            res.json(metrics);
        } catch (error) {
            console.error('[TelemetryController] Error fetching metrics:', error);
            res.status(500).json({ error: 'Failed to retrieve system metrics' });
        }
    }
}
