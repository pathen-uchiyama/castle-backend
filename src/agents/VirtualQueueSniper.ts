import { Queue } from "bullmq";
import { FirebaseGuardian } from "../utils/FirebaseGuardian";

export interface VQDropConfig {
    dropTime: '07:00:00' | '13:00:00';
    timezone: 'America/New_York';
    partyIds: string[];
    tripId: string;
    attractionId: string;
}

export class VirtualQueueSniper {
    private agentQueue: Queue;
    private static PRE_DROP_MS = 200; // Start intensive polling 200ms before drop

    constructor(queue: Queue) {
        this.agentQueue = queue;
    }

    /**
     * Calculates exactly when to fire the "Join" request based on server latency drift.
     */
    static calculateExecutionWindow(config: VQDropConfig): number {
        // In production, this would sync with an NTP server to eliminate device clock drift
        const now = new Date();
        const targetedTime = new Date(now.toDateString() + ' ' + config.dropTime);

        // If it's already past the drop time for today, schedule for tomorrow
        if (now.getTime() > targetedTime.getTime()) {
            targetedTime.setDate(targetedTime.getDate() + 1);
        }

        return targetedTime.getTime() - this.PRE_DROP_MS - now.getTime();
    }

    /**
     * Schedules a VQ Snipe job to run exactly at the pre-calculated drop time.
     */
    async scheduleSnipe(config: VQDropConfig): Promise<void> {
        const delayMs = VirtualQueueSniper.calculateExecutionWindow(config);

        console.log(`[VQSniper] Scheduling drop for ${config.attractionId} in ${Math.round(delayMs / 1000)} seconds.`);

        await this.agentQueue.add('execute-vq-snipe', config, {
            delay: delayMs,
            jobId: `vq-${config.tripId}-${config.attractionId}-${config.dropTime}`,
            removeOnComplete: true
        });
    }

    /**
     * Executes a high-frequency polling loop to "catch" the drop opening.
     * This is the actual job payload executed by the worker.
     */
    async executeSnipe(config: VQDropConfig): Promise<{ success: boolean; groupNumber?: number; error?: string }> {
        console.log(`[VQSniper] Initializing high-precision drop for party: ${config.partyIds.join(', ')} on ${config.attractionId}`);

        // Simulation logic for the MVP / Mock
        return new Promise((resolve) => {
            setTimeout(async () => {
                const luck = Math.random();
                let result;

                if (luck > 0.1) {
                    const groupNum = Math.floor(Math.random() * 50) + 1;
                    result = { success: true, groupNumber: groupNum };

                    // Dispatch Success Nudge
                    const nudge = FirebaseGuardian.constructNudge('VQ_SUCCESS', `Secured Boarding Group ${groupNum} for ${config.attractionId}!`, {
                        funSeekTrigger: 'The early bird gets the worm! 🐛',
                        expiresInMinutes: 60
                    });
                    await FirebaseGuardian.dispatchNudge(config.tripId, nudge);
                } else {
                    result = { success: false, error: 'Boarding groups vanished in milliseconds.' };

                    // Dispatch Failure Nudge
                    const nudge = FirebaseGuardian.constructNudge('VQ_FAILED', `Boarding groups for ${config.attractionId} filled up before we could secure one.`, {
                        funSeekTrigger: 'We will try again at 1:00 PM!',
                        expiresInMinutes: 60
                    });
                    await FirebaseGuardian.dispatchNudge(config.tripId, nudge);
                }

                resolve(result);
            }, 100);
        });
    }
}
