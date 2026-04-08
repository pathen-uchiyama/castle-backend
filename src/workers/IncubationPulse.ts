import { AccountRegistry } from '../services/AccountRegistry';
import { DisneyAPIClient } from '../services/disney/DisneyAPIClient';

/**
 * IncubationPulse
 * 
 * Background cron worker designed to warm up synthetically generated accounts.
 * To avoid immediate bot flagging by Disney, newly minted ("QUARANTINED" / "INCUBATING")
 * accounts are aged for 72 hours. During this period, the pulse will execute benign
 * actions (like fetching dining availability or park wait times) to build realistic
 * account telemetry before they are marked as 'AVAILABLE' for lightning lane bookings.
 */
export class IncubationPulse {
    private registry: AccountRegistry;
    private apiClient?: DisneyAPIClient;

    constructor(apiClient?: DisneyAPIClient) {
        this.registry = new AccountRegistry();
        this.apiClient = apiClient;
    }

    /**
     * Executes one pulse tick across all incubating accounts.
     * Called by a standard cron scheduler or BullMQ repeatable job (e.g. every 2 hours).
     */
    public async tick(): Promise<void> {
        console.log(`[IncubationPulse] Commencing warming cycle for quarantined accounts...`);
        const accounts = await this.registry.getIncubatingAccounts();

        if (accounts.length === 0) {
            console.log(`[IncubationPulse] No incubating accounts found.`);
            return;
        }

        let promotedCount = 0;
        let warmedCount = 0;

        for (const act of accounts) {
            try {
                // Check if account has cleared the quarantine period
                if (act.hoursElapsed >= 72) {
                    console.log(`[IncubationPulse] Account ${act.email} has cleared 72h incubation. Promoting to AVAILABLE.`);
                    await this.registry.promoteToAvailable(act.id);
                    promotedCount++;
                    continue;
                }

                // If not promoted, perform a benign "warming" action to simulate human traffic.
                // e.g. checking Magic Kingdom experiences
                if (this.apiClient) {
                    try {
                        console.log(`[IncubationPulse] Executing benign 'getExperiences' read for ${act.email}...`);
                        await this.apiClient.getExperiences('80007944', new Date().toISOString().split('T')[0], act.id, 'WDW');
                    } catch (e) {
                         // We silently catch API errors during warming
                         console.debug(`[IncubationPulse] API read failed, continuing...`);
                    }
                } else {
                     console.log(`[IncubationPulse] Structural Dummy: Warming action simulated for ${act.email}`);
                }

                await this.registry.recordIncubationAction(act.id);
                warmedCount++;

                // Jitter to prevent all requests from hitting simultaneously
                const jitter = Math.floor(Math.random() * 5000) + 1000;
                await new Promise(resolve => setTimeout(resolve, jitter));
                
            } catch (err: any) {
                console.error(`[IncubationPulse] Failed to process account ${act.email}: ${err.message}`);
            }
        }

        console.log(`[IncubationPulse] Cycle complete. Warmed: ${warmedCount}. Promoted: ${promotedCount}.`);
    }
}
