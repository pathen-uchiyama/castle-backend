import { Queue } from "bullmq";
import { FirebaseGuardian } from "../utils/FirebaseGuardian";

export interface WaitAlert {
    tripId: string;
    rideId: string;
    rideName: string;
    targetWaitMins: number;
    currentWaitMins: number;
    isActive: boolean;
}

export class WaitMagicEngine {
    private agentQueue: Queue;

    constructor(queue: Queue) {
        this.agentQueue = queue;
    }

    /**
     * Analyzes if a posted wait time is inflated based on crowd trends.
     */
    static getInflationInsight(postedWait: number): string | null {
        if (postedWait > 60) return "Likely 15m shorter than posted due to crowd ebb";
        if (postedWait > 30) return "Historical data suggests actual wait is 10m shorter";
        return null;
    }

    /**
     * Predicts the statistical "Golden Window" (lowest wait time) for a ride.
     */
    static getGoldenWindow(rideId: string): string {
        // High-level Mock logic. In prod, this queries the RLHF telemetry db.
        const windows: Record<string, string> = {
            'MK_SPACE': '8:15 PM - 9:00 PM (Fireworks Window)',
            'MK_PIRATES': '1:00 PM - 2:30 PM (Parade Shadow)',
            'HS_ROT': '7:00 AM - 7:30 AM (Early Entry)',
            'EP_REMY': '8:30 PM - 9:00 PM (Harmonious Prep)'
        };
        return windows[rideId] || 'Late Evening Strategy';
    }

    /**
     * Main polling evaluation engine. It's called when Wait Time scraper updates numbers.
     * Evaluates if we should nudge the user to head to the ride.
     */
    async evaluateWaitTime(alert: WaitAlert): Promise<boolean> {
        console.log(`[WaitMagic] Evaluating ${alert.rideId}: Current: ${alert.currentWaitMins}m, Target: ${alert.targetWaitMins}m`);

        if (alert.currentWaitMins <= alert.targetWaitMins) {
            // Wait time dropped to target! Send nudge.
            console.log(`[WaitMagic] Target reached for ${alert.rideId}! Dispatching Nudge.`);

            const insight = WaitMagicEngine.getInflationInsight(alert.currentWaitMins);
            const extraCtx = insight ? ` (Psst... ${insight})` : '';

            const nudge = FirebaseGuardian.constructNudge(
                'RIDE_UPDATE',
                `${alert.rideName} wait time just dropped to ${alert.currentWaitMins} mins!`,
                {
                    funSeekTrigger: `Get moving! This is your Golden Window. ${extraCtx}`,
                    expiresInMinutes: 15
                }
            );

            await FirebaseGuardian.dispatchNudge(alert.tripId, nudge);
            return true; // Alert triggered
        }

        // Check if we approach a known daily peak and should pivot
        if (alert.currentWaitMins > 90) {
            console.log(`[WaitMagic] ${alert.rideId} is peaking. Suggesting alternatives.`);
            const nudge = FirebaseGuardian.constructNudge(
                'PIVOT',
                `${alert.rideName} is heavily impacted right now (${alert.currentWaitMins}m).`,
                {
                    funSeekTrigger: 'Check your Horizon dashboard—I generated a faster alternative path.',
                    expiresInMinutes: 30
                }
            );
            await FirebaseGuardian.dispatchNudge(alert.tripId, nudge);
        }

        return false; // Alert still pending
    }
}
