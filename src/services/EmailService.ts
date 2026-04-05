import { Resend } from 'resend';
import { env } from '../config/env';

/**
 * EmailService
 * 
 * Handles transactional email communication (Welcome, Receipts, Alerts).
 * Uses Resend with verified domain castlecompanion.com.
 */
export class EmailService {
  private static _resend: Resend | null = null;
  
  private static get resend(): Resend {
    if (!this._resend) {
      if (!env.RESEND_API_KEY) {
        console.warn('⚠️ RESEND_API_KEY not set — emails will fail');
      }
      this._resend = new Resend(env.RESEND_API_KEY || 'not-configured');
    }
    return this._resend;
  }

  /**
   * Sends a transactional email.
   * 
   * @param to Recipient email address
   * @param subject Email subject line
   * @param html HTML body content
   */
  static async sendEmail(to: string, subject: string, html: string): Promise<void> {
    try {
      const { data, error } = await this.resend.emails.send({
        from: 'Castle Companion <concierge@castlecompanion.com>',
        to: [to],
        subject: subject,
        html: html,
      });

      if (error) {
        throw error;
      }

      console.log(`📧 Email sent to ${to}, ID: ${data?.id}`);
    } catch (error) {
      console.error(`❌ Failed to send email to ${to}:`, error);
      throw error;
    }
  }

  /**
   * Sends a Welcome email to a new member.
   * 
   * @param to New member's email
   * @param name New member's name
   */
  static async sendWelcomeEmail(to: string, name: string): Promise<void> {
    const subject = 'Welcome to the Kingdom, ' + name + '!';
    const html = `
      <h1>Welcome to Castle Companion</h1>
      <p>Hi ${name},</p>
      <p>Your journey is about to begin. We're here to help you navigate the magic with precision and ease.</p>
      <p>Log in to your dashboard to start planning your itinerary.</p>
      <br>
      <p>To the Magic,</p>
      <p>The Castle Companion Team</p>
    `;
    return this.sendEmail(to, subject, html);
  }
}
