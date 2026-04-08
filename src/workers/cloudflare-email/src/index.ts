import PostalMime from 'postal-mime';

export interface Env {
  CASTLE_API_URL: string;
}

export default {
  async email(message: any, env: Env, ctx: any): Promise<void> {
    try {
      console.log(`[Cloudflare Email Catch-All] Intercepted email for: ${message.to}`);

      // 1. Parse the Raw Email using PostalMime
      const parser = new PostalMime();
      const email = await parser.parse(message.raw);

      // 2. Search for the 6-digit Disney OTP in subject, text, or HTML
      const contentToSearch = [
        email.subject || '',
        email.text || '',
        email.html || ''
      ].join(' ');

      // Disney OneID OTP usually appears as a distinct 6-character digit token
      // e.g., "Your one-time passcode for Walt Disney World is 123456"
      const otpMatch = contentToSearch.match(/\b\d{6}\b/);

      if (!otpMatch) {
         console.log(`[Worker] No 6-digit OTP found in email destined for ${message.to}. Dropping payload.`);
         // Not an OTP, could be spam or welcome email. Ignore.
         return;
      }

      const code = otpMatch[0];
      console.log(`[Worker] Extract SUCCESS! Code [${code}] found for ${message.to}.`);

      // 3. Forward to the Castle Companion Sovereign Backend
      const verifyEndpoint = `${env.CASTLE_API_URL}/verify-account`;
      
      const payload = {
         email: message.to.trim().toLowerCase(), // normalize
         code: code
      };

      console.log(`[Worker] Forwarding payload to backend: ${verifyEndpoint}`);

      const response = await fetch(verifyEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        console.error(`[Worker] Backend rejected payload. Status: ${response.status}`);
      } else {
        console.log(`[Worker] Backend accepted OTP payload successfully.`);
      }

    } catch (error) {
      console.error(`[Worker] Critical error processing inbound email: ${String(error)}`);
    }
  }
};
