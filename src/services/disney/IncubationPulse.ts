import { AccountRegistry } from '../AccountRegistry';
import { DisneyAuthClient } from './DisneyAuthClient';
import { SessionManager } from './SessionManager';
import { HumanMimicry } from './HumanMimicry';

/**
 * IncubationPulse — Keeps INCUBATING accounts warm with human-like activity.
 *
 * Every 4-6 hours, performs browsing actions on each INCUBATING account:
 *   - Browse restaurant menus
 *   - Check wait times for a random park
 *   - View attraction pages
 *
 * After 72 hours of incubation, promotes the account to AVAILABLE.
 *
 * Can be triggered by:
 *   - BullMQ repeatable job (if Redis available)
 *   - REST endpoint called by Railway cron
 *   - Manual admin trigger
 */
export class IncubationPulse {
  private registry: AccountRegistry;
  private authClient: DisneyAuthClient;
  private mimicry: HumanMimicry;
  private static readonly INCUBATION_HOURS = 72;
  private static readonly ACTIONS_PER_PULSE = 3;

  constructor() {
    this.registry = new AccountRegistry();
    this.mimicry = new HumanMimicry({});
    const sessionMgr = new SessionManager(this.mimicry);
    this.authClient = new DisneyAuthClient(sessionMgr);
  }

  /**
   * Run a single pulse across all INCUBATING accounts.
   * Called every 4-6 hours by the scheduler.
   */
  async runPulse(): Promise<{ promoted: string[]; warmed: string[]; errors: string[] }> {
    const accounts = await this.registry.getIncubatingAccounts();
    console.log(`[IncubationPulse] Running pulse for ${accounts.length} INCUBATING accounts...`);

    const promoted: string[] = [];
    const warmed: string[] = [];
    const errors: string[] = [];

    for (const account of accounts) {
      try {
        // Check if incubation is complete (72 hours)
        if (account.hoursElapsed >= IncubationPulse.INCUBATION_HOURS) {
          await this.registry.promoteToAvailable(account.id);
          promoted.push(account.email);
          console.log(`[IncubationPulse] ✅ ${account.email} → AVAILABLE (incubation complete after ${Math.round(account.hoursElapsed)}h)`);
          continue;
        }

        // Perform warming actions
        await this.warmAccount(account.id, account.email);
        warmed.push(account.email);

      } catch (err) {
        console.error(`[IncubationPulse] ❌ Error warming ${account.email}:`, err instanceof Error ? err.message : err);
        errors.push(account.email);
      }

      // Small delay between accounts to look natural
      await this.mimicry.applyJitter();
    }

    console.log(`[IncubationPulse] Pulse complete. Promoted: ${promoted.length}, Warmed: ${warmed.length}, Errors: ${errors.length}`);
    return { promoted, warmed, errors };
  }

  /**
   * Perform 2-3 human-like browsing actions on a single account.
   */
  private async warmAccount(skipperId: string, email: string): Promise<void> {
    console.log(`[IncubationPulse] Warming ${email}...`);

    // Try to authenticate (this exercises the login flow and keeps the session alive)
    try {
      await this.authClient.refreshSession(skipperId);
    } catch (err) {
      // Auth failure during incubation is non-fatal — account may not be fully verified yet
      console.warn(`[IncubationPulse] Auth refresh failed for ${email} (non-fatal):`, err instanceof Error ? err.message : err);
    }

    // Simulate browsing actions (these are lightweight API hits)
    const actions = [
      () => this.browseRestaurants(),
      () => this.checkWaitTimes(),
      () => this.viewAttractionPage(),
      () => this.browseParkHours(),
      () => this.viewShoppingPage(),
    ];

    // Pick 2-3 random actions
    const shuffled = actions.sort(() => Math.random() - 0.5);
    const toRun = shuffled.slice(0, IncubationPulse.ACTIONS_PER_PULSE);

    for (const action of toRun) {
      try {
        await action();
        await this.registry.recordIncubationAction(skipperId);
        await this.mimicry.applyJitter(); // Human-like pause between actions
      } catch (err) {
        // Individual action failures are non-fatal
        console.warn(`[IncubationPulse] Action failed for ${email}:`, err instanceof Error ? err.message : err);
      }
    }
  }

  // ── Warming Action Implementations ───────────────────────────────

  private async browseRestaurants(): Promise<void> {
    const restaurants = [
      'be-our-guest-restaurant', 'cinderellas-royal-table', 'space-220',
      'ohana', 'boma-flavors-of-africa', 'tusker-house', 'sci-fi-dine-in'
    ];
    const pick = restaurants[Math.floor(Math.random() * restaurants.length)];
    const url = `https://disneyworld.disney.go.com/dining/${pick}/`;

    // Light fetch — just load the page to generate impression traffic
    try {
      await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Accept': 'text/html',
        }
      });
      console.log(`[IncubationPulse] Browsed restaurant: ${pick}`);
    } catch (e) { /* non-fatal */ }
  }

  private async checkWaitTimes(): Promise<void> {
    const parks = ['magic-kingdom', 'epcot', 'hollywood-studios', 'animal-kingdom'];
    const park = parks[Math.floor(Math.random() * parks.length)];
    const url = `https://disneyworld.disney.go.com/parks/${park}/wait-times/`;

    try {
      await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Accept': 'text/html',
        }
      });
      console.log(`[IncubationPulse] Checked wait times: ${park}`);
    } catch (e) { /* non-fatal */ }
  }

  private async viewAttractionPage(): Promise<void> {
    const attractions = [
      'seven-dwarfs-mine-train', 'space-mountain', 'splash-mountain',
      'haunted-mansion', 'big-thunder-mountain', 'pirates-of-the-caribbean',
      'rock-n-roller-coaster', 'tower-of-terror', 'rise-of-the-resistance'
    ];
    const pick = attractions[Math.floor(Math.random() * attractions.length)];
    const url = `https://disneyworld.disney.go.com/attractions/${pick}/`;

    try {
      await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Accept': 'text/html',
        }
      });
      console.log(`[IncubationPulse] Viewed attraction: ${pick}`);
    } catch (e) { /* non-fatal */ }
  }

  private async browseParkHours(): Promise<void> {
    const url = 'https://disneyworld.disney.go.com/calendars/';
    try {
      await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Accept': 'text/html',
        }
      });
      console.log('[IncubationPulse] Browsed park hours calendar');
    } catch (e) { /* non-fatal */ }
  }

  private async viewShoppingPage(): Promise<void> {
    const url = 'https://disneyworld.disney.go.com/shops/';
    try {
      await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Accept': 'text/html',
        }
      });
      console.log('[IncubationPulse] Browsed shopping page');
    } catch (e) { /* non-fatal */ }
  }

  /**
   * Get current incubation pipeline status for the dashboard.
   */
  async getStatus(): Promise<{
    total: number;
    accounts: { email: string; hoursElapsed: number; actions: number; readyIn: string }[];
  }> {
    const accounts = await this.registry.getIncubatingAccounts();
    return {
      total: accounts.length,
      accounts: accounts.map(a => ({
        email: a.email,
        hoursElapsed: Math.round(a.hoursElapsed * 10) / 10,
        actions: a.actions,
        readyIn: a.hoursElapsed >= IncubationPulse.INCUBATION_HOURS
          ? 'Ready!'
          : `${Math.round(IncubationPulse.INCUBATION_HOURS - a.hoursElapsed)}h remaining`
      }))
    };
  }
}
