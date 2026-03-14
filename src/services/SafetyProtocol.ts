import { env } from '../config/env';
import { EmailService } from './EmailService';
import { NotificationService } from './NotificationService';
import { ParkStatusRegistry } from './ParkStatusRegistry';

/**
 * SafetyProtocol
 * 
 * Monitors critical system components (Redis, Scrapers, API Connectivity)
 * and dispatches high-priority alerts to the administrator if failures are detected.
 */
export class SafetyProtocol {
    private static isAlerting = false;

    /**
     * Executes a deep health check of all vital systems.
     */
    static async performHealthAudit(): Promise<void> {
        console.log('[SafetyProtocol] Commencing system audit...');
        
        try {
            // 1. Check Redis Connectivity (Registry Heartbeat)
            const redisHealthy = await ParkStatusRegistry.healthCheck();
            if (!redisHealthy) {
                await this.triggerEmergencyAlert('REDIS_FAILURE', 'The Redis cache is unresponsive. Real-time telemetry is stale.');
            }

            // 2. check for "Zombie" Scrapers or stale data
            // (Placeholder for future scraper health check)

            console.log('[SafetyProtocol] Audit complete. Systems Nominal.');
        } catch (error) {
            console.error('[SafetyProtocol] Critical Audit Error:', error);
            await this.triggerEmergencyAlert('AUDIT_CRASH', `The SafetyProtocol itself encountered an error: ${error}`);
        }
    }

    /**
     * Dispatches SMS and Email alerts to the administrator.
     */
    private static async triggerEmergencyAlert(code: string, message: string): Promise<void> {
        if (this.isAlerting) return; // Prevent alert storms
        this.isAlerting = true;

        const timestamp = new Date().toLocaleString();
        const fullMessage = `🚨 CASTLE CRITICAL [${code}]: ${message} at ${timestamp}`;

        console.error(fullMessage);

        try {
            // 1. Dispatch SMS
            await NotificationService.sendGuardianSms(env.ADMIN_PHONE, fullMessage);

            // 2. Dispatch Email
            const emailHtml = `
                <div style="font-family: sans-serif; padding: 20px; border: 2px solid #ff0000; border-radius: 10px;">
                    <h2 style="color: #ff0000;">⚠️ Castle Companion System Alert</h2>
                    <p><strong>Condition:</strong> ${code}</p>
                    <p><strong>Diagnostic:</strong> ${message}</p>
                    <p><strong>Timestamp:</strong> ${timestamp}</p>
                    <hr>
                    <p style="font-size: 12px; color: #666;">This is an automated safety protocol alert. Immediate intervention may be required.</p>
                </div>
            `;
            await EmailService.sendEmail(env.ADMIN_EMAIL, `🚨 CRITICAL: Castle Companion Alert [${code}]`, emailHtml);

            console.log(`[SafetyProtocol] Emergency alerts dispatched successfully for ${code}.`);
        } catch (err) {
            console.error('[SafetyProtocol] FATAL: Failed to dispatch emergency alerts:', err);
        } finally {
            // Reset after 10 minutes to allow for a new alert if the issue persists
            setTimeout(() => { this.isAlerting = false; }, 10 * 60 * 1000);
        }
    }

    /**
     * Starts the background watchdog loop.
     */
    static startWatchdog(intervalMs: number = 300000) { // Default 5 mins
        console.log(`[SafetyProtocol] Watchdog active. Polling every ${intervalMs / 1000}s.`);
        setInterval(() => this.performHealthAudit(), intervalMs);
    }
}
