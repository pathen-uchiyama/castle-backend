import { getSupabaseClient } from '../../config/supabase';
import { DisneyAuthData } from './types';
import { SessionManager } from './SessionManager';

/**
 * DisneyAuthClient — Programmatic Disney login automation.
 *
 * Handles the full authentication flow:
 * 1. POST login with email/password → receive auth challenge or OTP prompt
 * 2. Disney sends OTP email to Skipper address
 * 3. Cloudflare Email Worker intercepts → extracts 6-digit code → POSTs to /api/verify-account
 * 4. Code stored in verification_codes table
 * 5. This client polls verification_codes, completes auth → receives SWID + access token
 * 6. Token stored via SessionManager
 *
 * NOTE: The actual Disney auth endpoint URLs may need to be discovered via
 * MITM proxy (mitmproxy) against the MDE app. The structure below is based on
 * standard OAuth2 + email-OTP patterns observed in Disney's auth system.
 */
export class DisneyAuthClient {
  private sessionManager: SessionManager;
  private static readonly OTP_POLL_INTERVAL_MS = 2000;
  private static readonly OTP_POLL_TIMEOUT_MS = 120_000; // 2 minutes max wait

  constructor(sessionManager: SessionManager) {
    this.sessionManager = sessionManager;
  }

  /**
   * Authenticate a Skipper account with Disney.
   * Full flow: login → OTP → complete auth → store session.
   */
  async authenticate(skipperId: string): Promise<DisneyAuthData> {
    // Get Skipper credentials from Supabase
    const credentials = await this.getSkipperCredentials(skipperId);
    if (!credentials) {
      throw new AuthError(`No credentials found for Skipper ${skipperId}`, 'NO_CREDENTIALS');
    }

    console.log(`[DisneyAuth] Starting auth for Skipper ${skipperId} (${credentials.email})`);

    try {
      // Step 1: Initiate Disney login
      const loginResult = await this.initiateLogin(credentials.email, credentials.password);

      if (loginResult.type === 'OTP_REQUIRED') {
        console.log(`[DisneyAuth] OTP required for ${credentials.email} — waiting for Cloudflare worker`);

        // Step 2: Wait for OTP from Cloudflare Email Worker
        const otpCode = await this.waitForOTP(credentials.email);
        if (!otpCode) {
          throw new AuthError('OTP not received within timeout', 'OTP_TIMEOUT');
        }

        // Step 3: Complete auth with OTP
        const authData = await this.completeAuthWithOTP(loginResult.sessionId, otpCode);

        // Step 4: Store the session
        await this.sessionManager.storeSession(skipperId, authData);

        // Step 5: Mark OTP as used
        await this.markOTPUsed(credentials.email, otpCode);

        console.log(`[DisneyAuth] ✅ Skipper ${skipperId} authenticated (SWID: ${authData.swid})`);
        return authData;

      } else if (loginResult.type === 'AUTHENTICATED') {
        // Direct auth (no OTP needed — rare but possible)
        await this.sessionManager.storeSession(skipperId, loginResult.auth);
        console.log(`[DisneyAuth] ✅ Skipper ${skipperId} authenticated directly`);
        return loginResult.auth;

      } else {
        throw new AuthError(`Unexpected login result: ${loginResult.type}`, 'UNEXPECTED_RESULT');
      }

    } catch (error) {
      if (error instanceof AuthError) throw error;
      console.error(`[DisneyAuth] Auth failed for Skipper ${skipperId}:`, error);
      throw new AuthError(
        `Authentication failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        'AUTH_FAILED'
      );
    }
  }

  /**
   * Refresh an existing session that's about to expire.
   */
  async refreshSession(skipperId: string): Promise<DisneyAuthData | null> {
    const existingSession = await this.sessionManager.getSession(skipperId);

    if (!existingSession) {
      // No existing session — must do full auth
      return this.authenticate(skipperId);
    }

    // Check if token is actually expiring soon (within 1 hour)
    const oneHourFromNow = new Date(Date.now() + 60 * 60 * 1000);
    if (existingSession.tokenExpires > oneHourFromNow) {
      // Still fresh — no refresh needed
      return null;
    }

    console.log(`[DisneyAuth] Refreshing session for Skipper ${skipperId}`);

    // For now, do a full re-auth (Disney doesn't expose a clean refresh token flow)
    // In the future, if we discover a refresh endpoint, we can optimize here
    return this.authenticate(skipperId);
  }

  /**
   * Get all Skippers that need session refresh.
   */
  async getSkippersNeedingRefresh(withinMinutes: number = 60): Promise<string[]> {
    return this.sessionManager.getExpiringSessions(withinMinutes);
  }

  // ── Disney Login Flow ──────────────────────────────────────

  /**
   * Step 1: Initiate login with Disney.
   *
   * TODO: The actual Disney auth endpoints need to be captured via
   * mitmproxy against the MDE app. The structure below is the expected
   * pattern based on standard OAuth2 + OTP flows.
   */
  private async initiateLogin(
    email: string,
    password: string
  ): Promise<LoginResult> {
    // Disney auth is typically at:
    // POST https://registerdisney.go.com/jgc/v6/client/EPA-CORE-WDW-LSINT/guest/login
    // or similar endpoint that changes with app versions

    // For MVP: simulate the flow. In production, replace with actual Disney auth endpoint.
    console.log(`[DisneyAuth] Initiating login for ${email}`);

    // The login endpoint will either:
    // a) Return tokens directly (if no 2FA) — rare
    // b) Send an OTP email and return a session ID — common
    // c) Return a CAPTCHA challenge — we can't automate this

    console.log(`[DisneyAuth] POSTing to Disney v8 login pipeline for ${email}`);
    
    // Captured via browser proxy
    const response = await fetch('https://registerdisney.go.com/jgc/v8/client/TPR-WDW-LBJS.WEB-PROD/guest/login?langPref=en-US&feature=no-password-reuse', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
      },
      body: JSON.stringify({
        loginValue: email,
        password: password,
      }),
    });

    const data = await response.json();

    if (data.data?.token?.access_token || data.access_token) {
      const swid = data.data?.profile?.swid || data.swid;
      const accessToken = data.data?.token?.access_token || data.access_token;
      const expiresIn = data.data?.token?.expires_in || data.expires_in || 3600;
      
      return {
        type: 'AUTHENTICATED',
        auth: {
          swid: swid,
          accessToken: accessToken,
          tokenExpires: new Date(expiresIn * 1000 + Date.now()),
        },
      };
    }

    // OTP Challenge received
    return {
      type: 'OTP_REQUIRED',
      sessionId: data.data?.loginSessionId || data.loginSessionId,
    };
  }

  /**
   * Step 2: Wait for OTP code to appear in verification_codes table.
   * The Cloudflare Email Worker intercepts Disney's OTP email and
   * POSTs the 6-digit code to /api/verify-account, which stores it here.
   */
  private async waitForOTP(email: string): Promise<string | null> {
    const startTime = Date.now();
    const db = getSupabaseClient();

    while (Date.now() - startTime < DisneyAuthClient.OTP_POLL_TIMEOUT_MS) {
      const { data } = await db
        .from('verification_codes')
        .select('code')
        .eq('email', email)
        .eq('used', false)
        .gt('expires_at', new Date().toISOString())
        .order('received_at', { ascending: false })
        .limit(1)
        .single();

      if (data?.code) {
        console.log(`[DisneyAuth] OTP received for ${email}`);
        return data.code;
      }

      // Wait before next poll
      await new Promise(resolve =>
        setTimeout(resolve, DisneyAuthClient.OTP_POLL_INTERVAL_MS)
      );
    }

    console.error(`[DisneyAuth] OTP timeout for ${email} after ${DisneyAuthClient.OTP_POLL_TIMEOUT_MS}ms`);
    return null;
  }

  /**
   * Step 3: Complete auth by submitting OTP code to Disney.
   *
   * TODO: Replace with actual Disney OTP verification endpoint.
   */
  private async completeAuthWithOTP(
    sessionId: string,
    otpCode: string
  ): Promise<DisneyAuthData> {
    console.log(`[DisneyAuth] Completing auth with OTP code ${otpCode} (session: ${sessionId})`);

    const response = await fetch('https://registerdisney.go.com/jgc/v8/client/TPR-WDW-LBJS.WEB-PROD/guest/login/otp/verify?langPref=en-US', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
      },
      body: JSON.stringify({
        loginSessionId: sessionId,
        otpCode: otpCode,
      }),
    });

    const data = await response.json();
    
    const swid = data.data?.profile?.swid || data.swid;
    const accessToken = data.data?.token?.access_token || data.access_token;
    const expiresIn = data.data?.token?.expires_in || data.expires_in || 3600;

    if (!swid || !accessToken) {
      throw new Error(`[DisneyAuth] OTP Verification failed: ${JSON.stringify(data)}`);
    }

    return {
      swid: swid,
      accessToken: accessToken,
      tokenExpires: new Date(expiresIn * 1000 + Date.now()),
    };
  }

  /**
   * Mark an OTP as used so it can't be replayed.
   */
  private async markOTPUsed(email: string, code: string): Promise<void> {
    try {
      const db = getSupabaseClient();
      await db
        .from('verification_codes')
        .update({ used: true, used_at: new Date().toISOString() })
        .eq('email', email)
        .eq('code', code);
    } catch (err) {
      console.warn(`[DisneyAuth] Failed to mark OTP as used:`, err);
    }
  }

  /**
   * Get stored credentials for a Skipper account.
   */
  private async getSkipperCredentials(
    skipperId: string
  ): Promise<{ email: string; password: string } | null> {
    try {
      const db = getSupabaseClient();
      const { data } = await db
        .from('skipper_accounts')
        .select('email') // Bypass broken encrypted_password column
        .eq('id', skipperId)
        .single();

      if (!data) return null;

      return {
        email: data.email,
        // MVP: Universal password for all current Skipper profiles
        password: 'CastleMagic!2026', 
      };
    } catch (err) {
      console.error(`[DisneyAuth] Failed to get credentials for ${skipperId}:`, err);
      return null;
    }
  }

  /**
   * Decrypt a stored password.
   * TODO: Implement proper AES-256 decryption using a KMS key.
   */
  private decryptPassword(encrypted: string): string {
    // In production: use AWS KMS, GCP KMS, or Node.js crypto with a proper key
    // For MVP: passwords are stored in base64 (not secure — replace before production)
    return Buffer.from(encrypted, 'base64').toString('utf-8');
  }
}

// ── Types ────────────────────────────────────────────────────────────

type LoginResult =
  | { type: 'OTP_REQUIRED'; sessionId: string }
  | { type: 'AUTHENTICATED'; auth: DisneyAuthData }
  | { type: 'CAPTCHA_REQUIRED' }; // Can't automate — needs manual intervention

export type AuthErrorCode =
  | 'NO_CREDENTIALS'
  | 'OTP_TIMEOUT'
  | 'UNEXPECTED_RESULT'
  | 'AUTH_FAILED'
  | 'CAPTCHA_BLOCKED';

export class AuthError extends Error {
  code: AuthErrorCode;
  constructor(message: string, code: AuthErrorCode) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}
