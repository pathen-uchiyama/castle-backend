import PostalMime from 'postal-mime';

export interface Env {
  CASTLE_API_URL: string;
}

/**
 * Extracts the 6-digit OTP from a Disney registration email.
 * 
 * Disney's email format (as of 2026-04):
 *   From: memberservices@wdw.twdc.com
 *   Subject: "Your one-time passcode for Walt Disney World"
 *   HTML: <span id="otp_code">958491</span>
 *   Plain text: "...It will expire in 15 minutes. 958491 If you did not..."
 *
 * Strategy: Try the most reliable extraction first, fall back to generic.
 */
function extractDisneyOTP(html: string, text: string, subject: string): string | null {
  // Strategy 1: Parse the HTML <span id="otp_code"> element (most reliable)
  const spanMatch = html.match(/<span[^>]*id=["']otp_code["'][^>]*>(\d{6})<\/span>/i);
  if (spanMatch) return spanMatch[1];

  // Strategy 2: Look for the OTP in the plain text near "expire" or "passcode"
  // Disney format: "...expire in 15 minutes. 958491 If you did not..."
  const textContextMatch = text.match(/(?:expire|passcode|minutes)[^0-9]*(\d{6})\b/i);
  if (textContextMatch) return textContextMatch[1];

  // Strategy 3: Subject line contains code directly (rare but possible)
  const subjectMatch = subject.match(/\b(\d{6})\b/);
  if (subjectMatch) return subjectMatch[1];

  // Strategy 4: Fallback — first standalone 6-digit number in text body
  // Avoid HTML content to prevent false matches on tracking pixel URLs
  const fallbackMatch = text.match(/\b(\d{6})\b/);
  if (fallbackMatch) return fallbackMatch[1];

  return null;
}

export default {
  async email(message: any, env: Env, ctx: any): Promise<void> {
    try {
      const recipient = (message.to || '').trim().toLowerCase();
      console.log(`[Cloudflare Email Catch-All] Intercepted email for: ${recipient}`);
      console.log(`[Worker] From: ${message.from}, Subject: ${message.headers?.get('subject') || 'unknown'}`);

      // 1. Parse the Raw Email using PostalMime
      const parser = new PostalMime();
      const email = await parser.parse(message.raw);

      const html = email.html || '';
      const text = email.text || '';
      const subject = email.subject || '';

      // 2. Quick gate: only process Disney OTP emails
      const isDisneyOTP = subject.includes('passcode') || 
                          subject.includes('one-time') ||
                          (message.from || '').includes('disney') ||
                          (message.from || '').includes('wdw.twdc.com');

      if (!isDisneyOTP) {
        console.log(`[Worker] Non-Disney email from ${message.from}. Checking for generic OTP...`);
      }

      // 3. Extract the OTP code using Disney-specific strategies
      const code = extractDisneyOTP(html, text, subject);

      if (!code) {
        console.log(`[Worker] No 6-digit OTP found in email for ${recipient}. Subject: "${subject}". Dropping.`);
        return;
      }

      console.log(`[Worker] Extract SUCCESS! Code [${code}] found for ${recipient}.`);

      // 4. Forward to the Castle Backend immediately
      const verifyEndpoint = `${env.CASTLE_API_URL}/verify-account`;
      
      const payload = {
        email: recipient,
        code: code
      };

      console.log(`[Worker] Forwarding to backend: ${verifyEndpoint}`);

      const response = await fetch(verifyEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const body = await response.text();
        console.error(`[Worker] Backend rejected. Status: ${response.status}, Body: ${body}`);
      } else {
        console.log(`[Worker] Backend accepted OTP for ${recipient}. Pipeline complete.`);
      }

    } catch (error) {
      console.error(`[Worker] Critical error: ${String(error)}`);
    }
  }
};
