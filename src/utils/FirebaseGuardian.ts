import * as admin from 'firebase-admin';
import { env } from '../config/env';
import { NudgePayload, HapticPattern, NudgeType } from '../models/types';

/**
 * The Guardian Agent — responsible for delivering "Magic Pivot" nudges
 * to the user's device via Firebase Cloud Messaging.
 *
 * Translates ReasoningEngine output into structured NudgePayload objects
 * with haptic patterns, priority levels, and optional deep links.
 */
export class FirebaseGuardian {
    private static isInitialized = false;

    private static initialize() {
        if (this.isInitialized) return;

        try {
            if (env.FIREBASE_SERVICE_ACCOUNT_PATH) {
                admin.initializeApp({
                    credential: admin.credential.cert(env.FIREBASE_SERVICE_ACCOUNT_PATH)
                });
                this.isInitialized = true;
                console.log("🛡️ Firebase Guardian Armed (Live Mode)");
            } else {
                console.warn("🛡️ Firebase Guardian in MOCK mode (No Service Account provided)");
                this.isInitialized = true;
            }
        } catch (error) {
            console.error("🛡️ Firebase Guardian Malfunction:", error);
        }
    }

    // ── NudgePayload Construction ────────────────────────────────────────

    /**
     * Constructs a NudgePayload from a pivot strategy response.
     * Maps the disruption type to the appropriate haptic pattern and priority.
     */
    static constructNudge(
        nudgeType: NudgeType,
        message: string,
        options?: {
            actionLink?: string;
            funSeekTrigger?: string;
            expiresInMinutes?: number;
        }
    ): NudgePayload {
        return {
            nudgeType,
            hapticPattern: this.getHapticForType(nudgeType),
            message,
            actionLink: options?.actionLink,
            funSeekTrigger: options?.funSeekTrigger,
            expiresAt: options?.expiresInMinutes
                ? new Date(Date.now() + options.expiresInMinutes * 60000).toISOString()
                : undefined,
            priority: this.getPriorityForType(nudgeType),
        };
    }

    /**
     * Maps nudge types to their blueprint-specified haptic patterns.
     */
    private static getHapticForType(type: NudgeType): HapticPattern {
        switch (type) {
            case 'LL_READY':
                return 'DOUBLE_TAP';       // "Your Lightning Lane is ready"
            case 'RAIN_ALERT':
                return 'LONG_VIBRATION';   // "Rain is coming"
            case 'PIVOT':
                return 'TRIPLE_PULSE';     // "Ride went down, here's your pivot"
            case 'DINING_HANDOFF':
                return 'DOUBLE_TAP';       // "Reservation found!"
            case 'SHOWTIME_SHIFT':
                return 'GENTLE_NUDGE';     // "Fireworks moved to 9:30"
            case 'GENERAL':
            default:
                return 'GENTLE_NUDGE';
        }
    }

    /**
     * Maps nudge types to priority levels for notification delivery.
     */
    private static getPriorityForType(type: NudgeType): NudgePayload['priority'] {
        switch (type) {
            case 'RAIN_ALERT':
            case 'PIVOT':
                return 'high';
            case 'LL_READY':
            case 'DINING_HANDOFF':
                return 'critical';
            case 'SHOWTIME_SHIFT':
                return 'medium';
            case 'GENERAL':
            default:
                return 'low';
        }
    }

    // ── Delivery ─────────────────────────────────────────────────────────

    /**
     * Dispatches a structured NudgePayload to the user's device via FCM.
     * The payload includes haptic pattern metadata that the mobile client
     * uses to trigger the appropriate vibration pattern.
     */
    static async dispatchNudge(
        tripId: string,
        nudge: NudgePayload
    ): Promise<string> {
        this.initialize();

        const message = {
            notification: {
                title: this.getTitleForType(nudge.nudgeType),
                body: nudge.message,
            },
            data: {
                tripId,
                nudgeType: nudge.nudgeType,
                hapticPattern: nudge.hapticPattern,
                priority: nudge.priority,
                actionLink: nudge.actionLink || '',
                funSeekTrigger: nudge.funSeekTrigger || '',
                expiresAt: nudge.expiresAt || '',
            },
            topic: `trip_${tripId}`,
            android: {
                priority: nudge.priority === 'critical' ? 'high' as const : 'normal' as const,
            },
            apns: {
                payload: {
                    aps: {
                        sound: nudge.priority === 'critical' ? 'critical_alert.caf' : 'default',
                        'interruption-level': nudge.priority === 'critical' ? 'critical' : 'active',
                    },
                },
            },
        };

        if (env.FIREBASE_SERVICE_ACCOUNT_PATH) {
            try {
                const response = await admin.messaging().send(message);
                console.log(`🛡️ [Guardian] Nudge dispatched for Trip ${tripId}: ${nudge.nudgeType} (${nudge.hapticPattern})`);
                return response;
            } catch (error) {
                console.error(`❌ [Guardian] Failed to dispatch nudge for Trip ${tripId}:`, error);
                throw error;
            }
        } else {
            console.log(`[MOCK NUDGE] Trip: ${tripId} | Type: ${nudge.nudgeType} | Haptic: ${nudge.hapticPattern} | Msg: ${nudge.message}`);
            return "mock-nudge-success";
        }
    }

    /**
     * Human-friendly notification titles for each nudge type.
     */
    private static getTitleForType(type: NudgeType): string {
        switch (type) {
            case 'PIVOT':
                return '✨ Magic Pivot';
            case 'RAIN_ALERT':
                return '🌧️ Weather Alert';
            case 'DINING_HANDOFF':
                return '🍽️ Reservation Found!';
            case 'SHOWTIME_SHIFT':
                return '🎆 Schedule Update';
            case 'LL_READY':
                return '⚡ Lightning Lane Ready';
            case 'GENERAL':
            default:
                return '🏰 Castle Companion';
        }
    }

    // ── Legacy Method (Backward Compatibility) ──────────────────────────

    /**
     * @deprecated Use `dispatchNudge()` with a NudgePayload instead.
     */
    static async sendPivotNotification(tripId: string, title: string, body: string, actionUrl?: string) {
        const nudge = this.constructNudge('PIVOT', body, { actionLink: actionUrl });
        return this.dispatchNudge(tripId, nudge);
    }
}
