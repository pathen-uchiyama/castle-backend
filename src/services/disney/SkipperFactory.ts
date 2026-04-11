import { getSupabaseClient } from '../../config/supabase';
import { AccountRegistry, SkipperAccount } from '../AccountRegistry';
import puppeteer from 'puppeteer-extra';
// @ts-ignore
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import crypto from 'crypto';
import { createCursor } from 'ghost-cursor';
import { env } from '../../config/env';

puppeteer.use(StealthPlugin());

/**
 * SkipperFactory — Automated Disney account registration via Puppeteer Stealth.
 *
 * Takes UNREGISTERED accounts from the database, registers them on Disney,
 * waits for the verification email (caught by Cloudflare Email Worker → /verify-account),
 * enters the verification code, and moves the account to INCUBATING.
 *
 * Flow (confirmed via live Puppeteer testing):
 *   1. Navigate to disneyworld.disney.go.com/registration/
 *   2. Type email into the iframe → Click Continue
 *   3. Fill all registration form fields (name, password, DOB, address, TOS)
 *   4. Click "Agree & Continue" → Disney sends OTP email
 *   5. Cloudflare Email Worker intercepts OTP → stores in verification_codes
 *   6. Poll for OTP, enter it, submit → account created
 *   7. Mark as INCUBATING in our database
 *
 * Usage:
 *   const factory = new SkipperFactory();
 *   await factory.provisionBatch(5);
 */
export class SkipperFactory {
  private registry: AccountRegistry;

  // ──── Confirmed selectors (tested 2026-04-07 via headless Puppeteer) ────
  // The Disney registration form lives inside an iframe from cdn.registerdisney.go.com
  //
  // Step 1 (Email entry):
  //   Email input:     #InputIdentityFlowValue
  //   Continue button: button[type="submit"]
  //
  // Step 2 (Registration form):
  //   First Name:      #InputFirstName
  //   Middle Name:     #InputMiddleName (optional)
  //   Last Name:       #InputLastName
  //   Password:        #password-new
  //   Birthdate:       #InputDOB (placeholder: MM/DD/YYYY, must be typed)
  //   Address:         #BillingAddress-Line1Input
  //   Address Line 2:  #BillingAddress-Line2Input (optional)
  //   City:            #BillingAddress-CityInput
  //   Postal Code:     #BillingAddress-PostalCode
  //   Marketing opt-in: checkbox matching id starting with "BU_" (default checked)
  //   TOS checkbox:    #WDW-NGE2-TOU (default unchecked — MUST be checked)
  //   Submit button:   button with text "Agree & Continue"

  private static readonly DISNEY_REG_URL = 'https://disneyworld.disney.go.com/registration/';
  private static readonly REGISTRATION_DELAY_MS = 5 * 60 * 1000; // 5 min between registrations
  private static readonly OTP_POLL_INTERVAL_MS = 3000;
  private static readonly OTP_POLL_TIMEOUT_MS = 600_000; // 10 minutes

  // Production 2Captcha configuration
  private readonly TWOCAPTCHA_KEY = process.env.TWOCAPTCHA_KEY;

  constructor() {
    this.registry = new AccountRegistry();
  }

  /**
   * Invokes the 2Captcha API to solve any reCAPTCHA v3/Enterprise payloads 
   * detected on the page before form submission.
   */
  private async solveCaptcha(page: any, siteKey: string, pageUrl: string): Promise<string> {
    console.log(`[SkipperFactory] 🤖 Detecting CAPTCHA payload for siteKey=${siteKey}...`);
    // If no key provided (or mock), use the simulation
    if (!this.TWOCAPTCHA_KEY) {
      console.warn(`[SkipperFactory] ⚠️ TWOCAPTCHA_KEY is missing. Registration will likely fail if a captcha is challenged.`);
      await new Promise(r => setTimeout(r, 2000));
      return '';
    }

    try {
      // 1. Submit the challenge to 2captcha
      const inUrl = `http://2captcha.com/in.php?key=${this.TWOCAPTCHA_KEY}&method=userrecaptcha&googlekey=${siteKey}&pageurl=${pageUrl}&json=1`;
      const inRes = await fetch(inUrl, { method: 'POST' });
      const inData = await inRes.json();

      if (inData.status !== 1) {
        throw new Error(`2Captcha submission failed: ${inData.request}`);
      }
      
      const captchaId = inData.request;
      console.log(`[SkipperFactory] CAPTCHA submitted to 2Captcha. ID: ${captchaId}. Waiting 15s...`);
      
      // Give workers 15 seconds before first poll
      await new Promise(r => setTimeout(r, 15000));

      // 2. Poll for the result
      const maxRetries = 20;
      for (let i = 0; i < maxRetries; i++) {
        const resUrl = `http://2captcha.com/res.php?key=${this.TWOCAPTCHA_KEY}&action=get&id=${captchaId}&json=1`;
        const resRes = await fetch(resUrl);
        const resData = await resRes.json();

        if (resData.status === 1) {
          console.log(`[SkipperFactory] ✅ 2Captcha solved successfully in ~${15 + (i * 5)}s!`);
          return resData.request; // This is the solved token string
        }

        if (resData.request !== 'CAPCHA_NOT_READY') {
          throw new Error(`2Captcha polling failed: ${resData.request}`);
        }

        // Wait 5 seconds before checking again
        await new Promise(r => setTimeout(r, 5000));
      }
      
      throw new Error('2Captcha resolution timed out');
      
    } catch (err) {
      console.error('[SkipperFactory] 2Captcha Error:', err);
      throw err;
    }
  }

  /**
   * Provision a batch of accounts. Takes N UNREGISTERED accounts from the DB,
   * registers each with Disney, staggered to avoid suspicion.
   */
  async provisionBatch(count: number = 5): Promise<{ succeeded: string[]; failed: string[] }> {
    const accounts = await this.registry.getUnregisteredAccounts(count);
    if (accounts.length === 0) {
      console.warn('[SkipperFactory] No UNREGISTERED accounts available to provision.');
      return { succeeded: [], failed: [] };
    }

    console.log(`[SkipperFactory] Starting batch registration of ${accounts.length} accounts...`);
    const succeeded: string[] = [];
    const failed: string[] = [];

    for (let i = 0; i < accounts.length; i++) {
      const account = accounts[i];
      try {
        console.log(`[SkipperFactory] (${i + 1}/${accounts.length}) Registering ${account.email}...`);
        await this.registerSingleAccount(account);
        succeeded.push(account.email);
        console.log(`[SkipperFactory] ✅ ${account.email} registered successfully.`);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(`[SkipperFactory] ❌ Failed to register ${account.email}:`, errorMsg);
        failed.push(account.email);
        
        // Detect Structural Drift in Disney's DOM
        if (
            errorMsg.includes('waiting for selector') || 
            errorMsg.includes('not found') || 
            errorMsg.includes('iframe not found') ||
            errorMsg.includes('Could not find')
        ) {
            console.error(`[SkipperFactory] 🚨 REGISTRATION_DRIFT DETECTED: Disney registration DOM may have changed! (${errorMsg})`);
            const webhookUrl = (env as Record<string, unknown>).ALERT_WEBHOOK_URL as string | undefined;
            if (webhookUrl) {
                fetch(webhookUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        severity: 'CRITICAL',
                        reason: 'REGISTRATION_DRIFT',
                        endpoint: 'disneyworld.disney.go.com/registration',
                        timestamp: new Date().toISOString(),
                        action: 'Registration DOM selectors failed. Disney likely changed the flow. Initialize MITM Walkthrough in Dashboard.'
                    })
                }).catch(e => console.error('[SkipperFactory] Drift webhook failed', e));
            }
        }
      }

      // Stagger registrations (skip delay for last account)
      if (i < accounts.length - 1) {
        const jitter = Math.floor(Math.random() * 120_000); // 0-2 min random jitter
        const delay = SkipperFactory.REGISTRATION_DELAY_MS + jitter;
        console.log(`[SkipperFactory] Waiting ${Math.round(delay / 1000)}s before next registration...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }

    console.log(`[SkipperFactory] Batch complete. ${succeeded.length} succeeded, ${failed.length} failed.`);
    return { succeeded, failed };
  }

  /**
   * Register a single account with Disney via Puppeteer Stealth.
   * Uses the iframe-based registration form at disneyworld.disney.go.com/registration/
   */
  private async registerSingleAccount(account: SkipperAccount): Promise<void> {
    const password = this.generatePassword();
    const passwordHash = crypto.createHash('sha256').update(password).digest('hex');
    const identity = this.generateIdentity();

    const args = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'];
    
    // 1. Add residential proxy configuration
    if (process.env.PROXY_SERVER) {
      args.push(`--proxy-server=http://${process.env.PROXY_SERVER}`);
    }

    const browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined, // Railway Docker: /usr/bin/chromium
      args
    });

    try {
      const page = await browser.newPage();

      // Authenticate with the proxy if credentials are provided
      if (process.env.PROXY_USERNAME && process.env.PROXY_PASSWORD) {
        await page.authenticate({
          username: process.env.PROXY_USERNAME,
          password: process.env.PROXY_PASSWORD
        });
      }

      await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36');
      await page.setViewport({ width: 1280, height: 800 });
      
      // 2. Initialize ghost-cursor for human-like mouse trajectories
      const cursor = createCursor(page);

      // ────────────────────────────────────────────────────────────────
      // STEP 1: Navigate and find the registration iframe
      // ────────────────────────────────────────────────────────────────
      console.log(`[SkipperFactory] Navigating to Disney registration...`);
      await page.goto(SkipperFactory.DISNEY_REG_URL, {
        waitUntil: 'domcontentloaded',
        timeout: 20000
      });
      // Disney's page has heavy analytics that never stop — just wait for JS to render
      await new Promise(r => setTimeout(r, 8000 + Math.random() * 3000));

      // Find the registration iframe from cdn.registerdisney.go.com
      let regFrame: any = null;
      for (const frame of page.frames()) {
        if (frame.url().includes('cdn.registerdisney.go.com')) {
          regFrame = frame;
          break;
        }
      }
      if (!regFrame) throw new Error('Registration iframe not found on page');
      console.log(`[SkipperFactory] Found registration iframe.`);

      // ────────────────────────────────────────────────────────────────
      // STEP 2: Enter email and click Continue
      // ────────────────────────────────────────────────────────────────
      await regFrame.waitForSelector('#InputIdentityFlowValue', { timeout: 10000 });
      console.log(`[SkipperFactory] Email field found. Entering ${account.email}...`);

      // 3. Emulate human interaction: Read and scroll slightly
      await page.mouse.wheel({ deltaY: Math.random() * 200 + 100 });
      await new Promise(r => setTimeout(r, 1000 + Math.random() * 1000));
      await cursor.moveTo({ x: Math.random() * 500, y: Math.random() * 500 });
      await new Promise(r => setTimeout(r, 500 + Math.random() * 500));

      await regFrame.type('#InputIdentityFlowValue', account.email, { delay: 50 + Math.random() * 40 });
      await new Promise(r => setTimeout(r, 800 + Math.random() * 500));

      // Click Continue
      const continueBtn = await regFrame.$('button[type="submit"]');
      if (continueBtn) {
        await continueBtn.click();
      } else {
        throw new Error('Continue button not found');
      }
      console.log(`[SkipperFactory] Clicked Continue. Waiting for registration form...`);
      await new Promise(r => setTimeout(r, 6000 + Math.random() * 3000));

      // ────────────────────────────────────────────────────────────────
      // STEP 3: Fill the registration form
      // The form stays in the same iframe after Continue
      // ────────────────────────────────────────────────────────────────
      await regFrame.waitForSelector('#InputFirstName', { timeout: 15000 });
      console.log(`[SkipperFactory] Registration form loaded. Filling fields...`);

      // Idle scrolling before starting the form
      await page.mouse.wheel({ deltaY: Math.random() * 300 + 150 });
      await new Promise(r => setTimeout(r, 1500 + Math.random() * 1000));
      await cursor.moveTo({ x: Math.random() * 600, y: Math.random() * 600 });
      
      // First Name
      await regFrame.type('#InputFirstName', identity.firstName, { delay: 45 + Math.random() * 25 });
      await new Promise(r => setTimeout(r, 400 + Math.random() * 400));

      // Last Name
      await regFrame.type('#InputLastName', identity.lastName, { delay: 45 + Math.random() * 25 });
      await new Promise(r => setTimeout(r, 400 + Math.random() * 400));

      // Password
      await regFrame.type('#password-new', password, { delay: 35 + Math.random() * 20 });
      await new Promise(r => setTimeout(r, 400 + Math.random() * 400));

      // Birthdate — must be typed character by character (no paste allowed per user)
      await regFrame.type('#InputDOB', identity.birthdate, { delay: 60 + Math.random() * 30 });
      await new Promise(r => setTimeout(r, 400 + Math.random() * 400));

      // Address
      await regFrame.type('#BillingAddress-Line1Input', identity.address, { delay: 40 + Math.random() * 20 });
      await new Promise(r => setTimeout(r, 400 + Math.random() * 400));

      // City
      await regFrame.type('#BillingAddress-CityInput', identity.city, { delay: 40 + Math.random() * 20 });
      await new Promise(r => setTimeout(r, 400 + Math.random() * 400));

      // Postal Code
      await regFrame.type('#BillingAddress-PostalCode', identity.postalCode, { delay: 40 + Math.random() * 20 });
      await new Promise(r => setTimeout(r, 400 + Math.random() * 400));

      // TOS checkbox — #WDW-NGE2-TOU (default unchecked, MUST be checked)
      const tosCheckbox = await regFrame.$('#WDW-NGE2-TOU');
      if (tosCheckbox) {
        const isChecked = await tosCheckbox.evaluate((el: any) => el.checked);
        if (!isChecked) {
          // Pre-checkbox erratic motion mimicking a human finding the box
          await cursor.moveTo({ x: Math.random() * 800, y: Math.random() * 600 });
          await new Promise(r => setTimeout(r, 300 + Math.random() * 400));
          await tosCheckbox.click();
          console.log(`[SkipperFactory] Checked TOS checkbox.`);
        }
      }
      await new Promise(r => setTimeout(r, 500));

      // Screenshot before submit
      await page.screenshot({ path: `/tmp/factory_before_submit_${account.email.split('@')[0]}.png` });

      // ────────────────────────────────────────────────────────────────
      // STEP 3.5: CAPTCHA Resolution
      // ────────────────────────────────────────────────────────────────
      // We look for the invisible reCAPTCHA container. If found, we extract the sitekey
      // (Disney usually uses 6L... or similar Enterprise keys).
      try {
        const siteKeyEval = await regFrame.evaluate(() => {
           // Attempt to find the sitekey in the DOM via Regex (Google keys start with 6L and are 40 chars)
           const regex = /6L[a-zA-Z0-9_-]{38}/;
           const match = document.body.innerHTML.match(regex);
           if (match) return match[0];
           
           // Fallback to older querySelector just in case
           const elem = document.querySelector('.g-recaptcha, iframe[src*="recaptcha"]');
           if (elem) {
             return elem.getAttribute('data-sitekey') || new URLSearchParams(elem.getAttribute('src')?.split('?')[1] || '').get('k');
           }
           return null;
        });
        
        console.log(`[SkipperFactory] Passing challenge to 2Captcha handler...`);
        const solvedToken = await this.solveCaptcha(page, siteKeyEval, SkipperFactory.DISNEY_REG_URL);
        
        // Inject the solved token back into the DOM where Disney expects it
        await regFrame.evaluate((token: string) => {
          const responseElement = document.getElementById('g-recaptcha-response');
          if (responseElement) {
            (responseElement as HTMLInputElement).value = token;
          }
        }, solvedToken);

        console.log(`[SkipperFactory] ✅ CAPTCHA injected. Proceeding to submit.`);
      } catch (err) {
        console.warn(`[SkipperFactory] CAPTCHA handling skipped/failed: ${err}`);
      }

      // ────────────────────────────────────────────────────────────────
      // STEP 4: Click "Agree & Continue"
      // ────────────────────────────────────────────────────────────────
      await new Promise(r => setTimeout(r, 1000 + Math.random() * 1000));

      // Find the "Agree & Continue" button by text
      const buttons = await regFrame.$$('button');
      let submitted = false;
      for (const btn of buttons) {
        const text = await btn.evaluate((el: any) => el.textContent.trim());
        if (text.includes('Agree') && text.includes('Continue')) {
          await btn.click();
          submitted = true;
          console.log(`[SkipperFactory] Clicked "Agree & Continue".`);
          break;
        }
      }
      if (!submitted) {
        // Fallback: try generic submit
        const submitBtn = await regFrame.$('button[type="submit"]');
        if (submitBtn) {
          await submitBtn.click();
          console.log(`[SkipperFactory] Clicked submit button (fallback).`);
        } else {
          throw new Error('Could not find Agree & Continue button');
        }
      }

      await new Promise(r => setTimeout(r, 6000 + Math.random() * 3000));
      await page.screenshot({ path: `/tmp/factory_after_submit_${account.email.split('@')[0]}.png` });

      // ────────────────────────────────────────────────────────────────
      // STEP 5: Wait for OTP via Cloudflare Email Worker
      // Disney sends a 6-digit code to account.email
      // Cloudflare Email Worker → POST /verify-account → verification_codes table
      // ────────────────────────────────────────────────────────────────
      console.log(`[SkipperFactory] Waiting for verification email at ${account.email}...`);
      const otpCode = await this.waitForOTP(account.email);
      if (!otpCode) {
        throw new Error(`Verification code not received within timeout for ${account.email}`);
      }

      console.log(`[SkipperFactory] Got verification code: ${otpCode}. Entering...`);

      // Re-scan frame (may have reloaded after submission)
      let otpFrame: any = regFrame;
      for (const frame of page.frames()) {
        if (frame.url().includes('cdn.registerdisney.go.com')) {
          otpFrame = frame;
          break;
        }
      }

      // Look for the OTP input field
      const otpSelectors = ['#InputIdentityFlowValue', '#InputPasscode', 'input[type="tel"]', 'input[type="text"]'];
      let codeEntered = false;
      for (const sel of otpSelectors) {
        try {
          const el = await otpFrame.$(sel);
          if (el) {
            await el.type(otpCode, { delay: 60 + Math.random() * 30 });
            codeEntered = true;
            console.log(`[SkipperFactory] OTP entered via ${sel}`);
            break;
          }
        } catch (e) { /* try next */ }
      }
      if (!codeEntered) throw new Error('Could not find OTP input field');

      // Submit OTP
      await new Promise(r => setTimeout(r, 1000));
      const otpSubmitBtn = await otpFrame.$('button[type="submit"]');
      if (otpSubmitBtn) {
        await otpSubmitBtn.click();
      } else {
        await page.keyboard.press('Enter');
      }
      await new Promise(r => setTimeout(r, 8000 + Math.random() * 3000));
      await page.screenshot({ path: `/tmp/factory_otp_result_${account.email.split('@')[0]}.png` });

      // ────────────────────────────────────────────────────────────────
      // STEP 5b: Verify Disney accepted the OTP
      // Check the page for success/failure signals before promoting
      // ────────────────────────────────────────────────────────────────
      let registrationConfirmed = false;
      
      // Check page URL — Disney redirects to a success page after valid OTP
      const currentUrl = page.url();
      if (currentUrl.includes('my.disney.com') || currentUrl.includes('disneyworld.disney.go.com') && !currentUrl.includes('registration')) {
        registrationConfirmed = true;
        console.log(`[SkipperFactory] ✅ Disney redirected to: ${currentUrl} — registration confirmed.`);
      }
      
      // Check for error messages in the iframe
      if (!registrationConfirmed) {
        try {
          // Re-scan frames
          for (const frame of page.frames()) {
            if (frame.url().includes('cdn.registerdisney.go.com') || frame.url().includes('login.disney.com')) {
              const bodyText = await frame.evaluate(() => document.body?.innerText || '');
              
              if (bodyText.includes('Invalid code') || bodyText.includes('expired') || bodyText.includes('try again')) {
                throw new Error(`Disney rejected OTP: page says "${bodyText.substring(0, 200)}"`);
              }
              
              // Success indicators
              if (bodyText.includes('Welcome') || bodyText.includes('Account Created') || bodyText.includes('successfully')) {
                registrationConfirmed = true;
                console.log(`[SkipperFactory] ✅ Disney confirmation text found in iframe.`);
              }
            }
          }
        } catch (e: any) {
          if (e.message.includes('Disney rejected')) throw e;
          // Frame navigation errors are fine — means Disney redirected (success)
          registrationConfirmed = true;
          console.log(`[SkipperFactory] Frame navigated away — likely success redirect.`);
        }
      }
      
      // If we still can't confirm, check if the OTP form is gone (success) or still visible (failure)
      if (!registrationConfirmed) {
        try {
          for (const frame of page.frames()) {
            if (frame.url().includes('cdn.registerdisney.go.com')) {
              const otpStillVisible = await frame.$('input[type="tel"]');
              if (otpStillVisible) {
                // OTP form still showing = code was probably wrong
                console.warn(`[SkipperFactory] ⚠️ OTP form still visible after submit — code may have been rejected.`);
                throw new Error(`Disney OTP verification failed — OTP form still visible after submission`);
              } else {
                registrationConfirmed = true;
                console.log(`[SkipperFactory] ✅ OTP form disappeared — registration likely succeeded.`);
              }
            }
          }
        } catch (e: any) {
          if (e.message.includes('OTP verification failed')) throw e;
          // Frame gone = navigated away = success
          registrationConfirmed = true;
        }
      }
      
      if (!registrationConfirmed) {
        // Final fallback — assume success if we got this far without errors
        console.warn(`[SkipperFactory] ⚠️ Could not confirm Disney acceptance. Proceeding cautiously.`);
      }

      // ────────────────────────────────────────────────────────────────
      // STEP 6: Mark as INCUBATING in our database
      // ────────────────────────────────────────────────────────────────
      await this.registry.startIncubation(account.id, passwordHash);

      // Consume the verification code
      const db = getSupabaseClient();
      await db
        .from('verification_codes')
        .update({ used: true, used_at: new Date().toISOString() })
        .eq('email', account.email)
        .eq('code', otpCode);

      console.log(`[SkipperFactory] ✅ ${account.email} → INCUBATING`);

    } finally {
      await browser.close();
    }
  }

  /**
   * Polls the verification_codes table for an OTP for the given email.
   */
  private async waitForOTP(email: string): Promise<string | null> {
    const startTime = Date.now();
    const db = getSupabaseClient();

    while (Date.now() - startTime < SkipperFactory.OTP_POLL_TIMEOUT_MS) {
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
        console.log(`[SkipperFactory] OTP received for ${email}: ${data.code}`);
        return data.code;
      }
      await new Promise(resolve => setTimeout(resolve, SkipperFactory.OTP_POLL_INTERVAL_MS));
    }
    return null;
  }

  /**
   * Generates a strong password for a Disney account.
   */
  private generatePassword(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghkmnpqrstuvwxyz23456789';
    const special = '!@#$%';
    let pwd = '';
    for (let i = 0; i < 12; i++) pwd += chars[Math.floor(Math.random() * chars.length)];
    pwd += special[Math.floor(Math.random() * special.length)];
    pwd += Math.floor(Math.random() * 100);
    return pwd;
  }

  /**
   * Generates a plausible identity with a full US billing address.
   */
  private generateIdentity(): {
    firstName: string; lastName: string; birthdate: string;
    address: string; city: string; state: string; postalCode: string;
  } {
    const firstNames = ['Sarah', 'Michael', 'Jessica', 'Ryan', 'Emily', 'Chris', 'Amanda', 'David', 'Lauren', 'Brian', 'Katie', 'Josh', 'Ashley', 'Kevin', 'Nicole'];
    const lastNames = ['Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Wilson', 'Taylor', 'Clark', 'Lewis', 'Walker', 'Hall', 'Allen', 'Young'];

    const firstName = firstNames[Math.floor(Math.random() * firstNames.length)];
    const lastName = lastNames[Math.floor(Math.random() * lastNames.length)];

    // Random birthdate between 1980 and 2000
    const year = 1980 + Math.floor(Math.random() * 20);
    const month = String(1 + Math.floor(Math.random() * 12)).padStart(2, '0');
    const day = String(1 + Math.floor(Math.random() * 28)).padStart(2, '0');

    // Realistic US addresses (varied cities/states to avoid pattern detection)
    const addresses = [
      { address: 'Evergreen Terrace', city: 'Orlando', state: 'FL', postalCode: '32801' },
      { address: 'Maple Drive', city: 'Tampa', state: 'FL', postalCode: '33602' },
      { address: 'Oak Street', city: 'Atlanta', state: 'GA', postalCode: '30301' },
      { address: 'Sunset Blvd', city: 'Charlotte', state: 'NC', postalCode: '28202' },
      { address: 'Pine Avenue', city: 'Nashville', state: 'TN', postalCode: '37201' },
      { address: 'Cedar Lane', city: 'Austin', state: 'TX', postalCode: '78701' },
      { address: 'Birch Road', city: 'Denver', state: 'CO', postalCode: '80201' },
      { address: 'Willow Way', city: 'Jacksonville', state: 'FL', postalCode: '32099' },
      { address: 'Park Place', city: 'Raleigh', state: 'NC', postalCode: '27601' },
      { address: 'Lake Shore Dr', city: 'Chicago', state: 'IL', postalCode: '60614' },
    ];
    const addr = addresses[Math.floor(Math.random() * addresses.length)];
    const houseNum = Math.floor(100 + Math.random() * 9000);

    return {
      firstName,
      lastName,
      birthdate: `${month}/${day}/${year}`,
      address: `${houseNum} ${addr.address}`,
      city: addr.city,
      state: addr.state,
      postalCode: addr.postalCode
    };
  }
}
