import twilio from 'twilio';
import { env } from '../config/env';

/**
 * NotificationService
 * 
 * Handles outward communication for "Guardian" logistical alerts.
 * Uses Twilio for verified Toll-Free SMS dispatch.
 */
export class NotificationService {
  private static client = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);

  /**
   * Sends a "Guardian" logistical SMS alert to a traveler.
   * 
   * @param to The recipient's phone number (E.164 format)
   * @param message The text content of the alert
   */
  static async sendGuardianSms(to: string, message: string): Promise<void> {
    try {
      if (!env.TWILIO_FROM_NUMBER) {
        throw new Error('TWILIO_FROM_NUMBER is not configured.');
      }

      await this.client.messages.create({
        body: message,
        from: env.TWILIO_FROM_NUMBER,
        to: to,
      });

      console.log(`✅ Guardian SMS sent to ${to}`);
    } catch (error) {
      console.error(`❌ Failed to send Guardian SMS to ${to}:`, error);
      throw error;
    }
  }

  /**
   * Sends a Rendezvous Pin drop to a family group.
   * 
   * @param to The recipient's phone number
   * @param mapUrl The unique link to the dynamic rendezvous map
   */
  static async sendRendezvousPin(to: string, mapUrl: string): Promise<void> {
    const message = `Castle Companion Alert: Your group has dropped a rendezvous pin. View the map here: ${mapUrl}`;
    return this.sendGuardianSms(to, message);
  }
}
