import { getSupabaseClient } from '../../config/supabase';
import { AccountRegistry, SkipperAccount } from '../AccountRegistry';
import puppeteer from 'puppeteer-extra';
// @ts-ignore
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import crypto from 'crypto';

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

  constructor() {
    this.registry = new AccountRegistry();
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
        console.error(`[SkipperFactory] ❌ Failed to register ${account.email}:`, err instanceof Error ? err.message : err);
        failed.push(account.email);
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

    const browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined, // Railway Docker: /usr/bin/chromium
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    });

    try {
      const page = await browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36');
      await page.setViewport({ width: 1280, height: 800 });

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
          await tosCheckbox.click();
          console.log(`[SkipperFactory] Checked TOS checkbox.`);
        }
      }
      await new Promise(r => setTimeout(r, 500));

      // Screenshot before submit
      await page.screenshot({ path: `/tmp/factory_before_submit_${account.email.split('@')[0]}.png` });

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
      await new Promise(r => setTimeout(r, 5000));
      await page.screenshot({ path: `/tmp/factory_otp_result_${account.email.split('@')[0]}.png` });

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
