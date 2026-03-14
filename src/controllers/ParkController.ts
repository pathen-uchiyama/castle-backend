import { Request, Response } from 'express';
import { ParkStatusRegistry } from '../services/ParkStatusRegistry';
import { ParkID } from '../models/types';

const parkRegistry = new ParkStatusRegistry();

export class ParkController {
    /**
     * Get real-time status for all attractions in a park.
     * GET /api/parks/:parkId/status
     */
    static async getParkStatus(req: Request, res: Response) {
        try {
            const { parkId } = req.params;
            if (!parkId) {
                return res.status(400).json({ error: 'Missing parkId parameter' });
            }

            const statuses = await parkRegistry.getParkStatus(parkId as ParkID);
            res.status(200).json(statuses);
        } catch (error) {
            console.error('[ParkController] Failed to fetch park status:', error);
            res.status(500).json({ error: 'Failed to fetch real-time park status' });
        }
    }
}
