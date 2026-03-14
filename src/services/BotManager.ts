import { env } from "../config/env";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(env.SUPABASE_URL || "", env.SUPABASE_SERVICE_KEY || "");

export interface BotInstance {
    id: string;
    proxyId: string;
    successCount: number;
    failCount: number;
    lastActive: number;
    status: 'active' | 'quarantine' | 'retired';
}

export class BotManager {
    private static activeBots: Map<string, BotInstance> = new Map();
    private static SUCCESS_THRESHOLD = 0.6; // 60% success required
    private static MIN_JOBS_FOR_GATING = 10;
    private static BOT_TTL_MS = 120 * 60 * 1000; // 2 hour TTL for sessions

    /**
     * Registers a job outcome and checks if the bot should be recycled.
     */
    static async recordJobOutcome(botId: string, success: boolean) {
        const bot = this.activeBots.get(botId);
        if (!bot) return;

        if (success) bot.successCount++;
        else bot.failCount++;

        bot.lastActive = Date.now();

        const totalJobs = bot.successCount + bot.failCount;
        if (totalJobs >= this.MIN_JOBS_FOR_GATING) {
            const successRate = bot.successCount / totalJobs;
            if (successRate < this.SUCCESS_THRESHOLD) {
                console.log(`⚠️ Bot ${botId} underperforming (${(successRate * 100).toFixed(1)}%). Recyling...`);
                await this.recycleBot(botId, 'Low Success Rate');
            }
        }

        // Check TTL
        if (Date.now() - bot.lastActive > this.BOT_TTL_MS) {
            await this.recycleBot(botId, 'TTL Expired');
        }
    }

    /**
     * Recycles a bot by purging its session and provisioning a fresh identity.
     */
    static async recycleBot(botId: string, reason: string) {
        console.log(`♻️ Recycling Bot ${botId}. Reason: ${reason}`);
        
        // Mark as retired
        const bot = this.activeBots.get(botId);
        if (bot) {
            bot.status = 'retired';
            this.activeBots.delete(botId);
        }

        // Trigger provisioning of a replacement (mocked for now)
        // In reality, this would call specialized Disney Account Automation
    }

    /**
     * Performs a global identity flush (Flush all active sessions).
     */
    static async globalIdentityFlush() {
        console.log("🧨 GLOBAL IDENTITY FLUSH INITIATED");
        const count = this.activeBots.size;
        this.activeBots.clear();
        return count;
    }

    static getBotStats() {
        return Array.from(this.activeBots.values());
    }
}
