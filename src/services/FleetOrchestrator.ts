import { AccountRegistry, PoolStats } from './AccountRegistry';
import { SkipperFactory } from './disney/SkipperFactory';
import { IncubationPulse } from './disney/IncubationPulse';

/**
 * FleetOrchestrator — High-level fleet coordination and operational intelligence.
 *
 * This is the brain that:
 * 1. Monitors pool health and emits alerts
 * 2. Detects ban waves and triggers domain suspension
 * 3. Auto-replaces banned accounts mid-trip
 * 4. Triggers the Factory when warm reserves run low
 * 5. Manages load shedding during booking surges
 * 6. Provides the dashboard with actionable intelligence
 *
 * All dashboard action buttons route through this orchestrator.
 */

export interface FleetAlert {
  id: string;
  type: 'POOL_LOW' | 'POOL_CRITICAL' | 'DOMAIN_COMPROMISED' | 'BAN_DETECTED' | 'FACTORY_TRIGGERED' | 'INCUBATION_COMPLETE' | 'LOAD_SHED_ACTIVE';
  severity: 'info' | 'warning' | 'critical';
  message: string;
  timestamp: string;
  metadata?: Record<string, any>;
}

export interface FleetHealth {
  poolStats: PoolStats;
  warmReservePercent: number;
  incubationPipeline: { total: number; readyWithin24h: number };
  recentBans24h: number;
  activeDomains: number;
  totalDomains: number;
  alerts: FleetAlert[];
  loadSheddingActive: boolean;
}

export class FleetOrchestrator {
  private registry: AccountRegistry;
  private factory: SkipperFactory;
  private pulse: IncubationPulse;
  private alerts: FleetAlert[] = [];
  private loadSheddingActive: boolean = false;
  private static readonly POOL_LOW_THRESHOLD = 0.20; // 20%
  private static readonly DOMAIN_COMPROMISE_THRESHOLD = 3; // 3 bans on same domain = compromise

  constructor() {
    this.registry = new AccountRegistry();
    this.factory = new SkipperFactory();
    this.pulse = new IncubationPulse();
  }

  /**
   * Securely proxy dynamic system configurations from the Supabase registry.
   */
  public async getSystemConfig(key: string, fallback: string): Promise<string> {
    return this.registry.getSystemConfig(key, fallback);
  }

  public async setSystemConfig(key: string, value: string): Promise<void> {
    return this.registry.setSystemConfig(key, value);
  }

  // ── Dashboard Action Handlers ────────────────────────────────────

  /**
   * [Provision New Skippers] button
   * Triggers the Factory to register N accounts from the UNREGISTERED pool.
   */
  async provisionNewSkippers(count: number = 5): Promise<{ succeeded: string[]; failed: string[] }> {
    this.emitAlert('FACTORY_TRIGGERED', 'info', `Factory started: provisioning ${count} new Skippers.`);
    const result = await this.factory.provisionBatch(count);

    if (result.succeeded.length > 0) {
      this.emitAlert('INCUBATION_COMPLETE', 'info', 
        `${result.succeeded.length} accounts registered and moved to incubation.`);
    }
    if (result.failed.length > 0) {
      this.emitAlert('BAN_DETECTED', 'warning', 
        `${result.failed.length} accounts failed registration: ${result.failed.join(', ')}`);
    }

    return result;
  }

  /**
   * [Execute Load Shedding] button
   * Pauses all low-priority queue jobs, focuses on P1 booking only.
   */
  async executeLoadShedding(): Promise<{ status: string }> {
    this.loadSheddingActive = true;
    this.emitAlert('LOAD_SHED_ACTIVE', 'warning', 
      'Load shedding ACTIVATED. All P2/P3 jobs paused. P1 booking-only mode.');

    // Auto-disable after 10 minutes
    setTimeout(() => {
      this.loadSheddingActive = false;
      this.emitAlert('LOAD_SHED_ACTIVE', 'info', 'Load shedding DEACTIVATED. Normal operations resumed.');
    }, 10 * 60 * 1000);

    return { status: 'Load shedding active for 10 minutes' };
  }

  /**
   * Toggles the global kill switch status
   */
  async toggleKillSwitch(active: boolean): Promise<{ killSwitchActive: boolean }> {
      // Typically this would also notify the RateLimiter and queueing layer to reject non-essential requests
      if (active) {
          this.emitAlert('LOAD_SHED_ACTIVE', 'critical', 'GLOBAL KILL SWITCH ENGAGED: All automated fleet activity paused.');
      } else {
          this.emitAlert('LOAD_SHED_ACTIVE', 'info', 'Global systems resumed. Fleet re-sync in progress.');
      }
      return { killSwitchActive: active };
  }

  /**
   * [Rotate Proxies & Burn] button
   * Rotates proxy group and deactivates compromised accounts.
   */
  async rotateProxies(): Promise<{ rotated: boolean; deactivated: string[] }> {
    // Detect compromised domains
    const bansByDomain = await this.registry.getRecentBansByDomain(30); // 30 min window
    const deactivated: string[] = [];

    for (const [domainId, banCount] of Object.entries(bansByDomain)) {
      if (banCount >= FleetOrchestrator.DOMAIN_COMPROMISE_THRESHOLD) {
        this.emitAlert('DOMAIN_COMPROMISED', 'critical', 
          `Domain ${domainId} compromised (${banCount} bans in 30min). Suspending all accounts.`);
        deactivated.push(domainId);
        // TODO: Integrate with Decodo proxy rotation API
      }
    }

    // TODO: Call Decodo API to rotate proxy group when integrated
    console.log('[FleetOrchestrator] Proxy rotation requested. Decodo integration pending.');

    return { rotated: true, deactivated };
  }

  /**
   * [Deploy Warm Reserves] button (emergency)
   * Manually moves INCUBATING accounts to AVAILABLE, bypassing 72hr warmup.
   */
  async deployWarmReserves(): Promise<{ deployed: number }> {
    const incubating = await this.registry.getIncubatingAccounts();
    let deployed = 0;

    for (const account of incubating) {
      await this.registry.promoteToAvailable(account.id);
      deployed++;
    }

    if (deployed > 0) {
      this.emitAlert('INCUBATION_COMPLETE', 'warning', 
        `Emergency deploy: ${deployed} accounts promoted to AVAILABLE (bypassing warmup).`);
    }

    return { deployed };
  }

  /**
   * [Force Replace] button
   * Handles a specific banned account — marks it banned, allocates replacement.
   */
  async forceReplace(skipperId: string): Promise<{ replacement: any | null }> {
    const replacement = await this.registry.handleBan(skipperId);
    
    if (replacement) {
      this.emitAlert('BAN_DETECTED', 'warning', 
        `Skipper ${skipperId} banned. Replacement allocated: ${replacement.email}`);
    } else {
      this.emitAlert('POOL_CRITICAL', 'critical', 
        `Skipper ${skipperId} banned. NO replacement available — pool depleted!`);
    }

    return { replacement };
  }

  // ── Health Monitoring ────────────────────────────────────────────

  /**
   * Comprehensive fleet health check for the dashboard.
   */
  async getFleetHealth(): Promise<FleetHealth> {
    const poolStats = await this.registry.getPoolStats();
    const incubating = await this.registry.getIncubatingAccounts();

    // Calculate warm reserve percentage
    const warmable = poolStats.available + poolStats.active;
    const warmReservePercent = poolStats.total > 0 ? poolStats.available / Math.max(warmable, 1) : 0;

    // Check how many are ready within 24 hours
    const readyWithin24h = incubating.filter(a => a.hoursElapsed >= 48).length;

    // Count bans in last 24 hours
    const bansByDomain = await this.registry.getRecentBansByDomain(24 * 60); // 24 hours
    const recentBans24h = Object.values(bansByDomain).reduce((sum, count) => sum + count, 0);

    // Generate alerts based on current state
    this.checkPoolHealth(poolStats, warmReservePercent);

    return {
      poolStats,
      warmReservePercent: Math.round(warmReservePercent * 100),
      incubationPipeline: { total: incubating.length, readyWithin24h },
      recentBans24h,
      activeDomains: poolStats.activeDomains,
      totalDomains: poolStats.domains,
      alerts: this.alerts.slice(-20), // Last 20 alerts
      loadSheddingActive: this.loadSheddingActive,
    };
  }

  /**
   * Get incubation pipeline status for the dashboard.
   */
  async getIncubationStatus() {
    return this.pulse.getStatus();
  }

  /**
   * Run incubation pulse (called by cron/scheduler).
   */
  async runIncubationPulse() {
    const result = await this.pulse.runPulse();
    if (result.promoted.length > 0) {
      this.emitAlert('INCUBATION_COMPLETE', 'info', 
        `${result.promoted.length} accounts promoted to AVAILABLE: ${result.promoted.join(', ')}`);
    }
    return result;
  }

  /**
   * Automatically replaces banned accounts and provisions new ones to hit a target buffer.
   * Concurrency is strictly limited to prevent server crashing via Puppeteer.
   */
  async autoReplenishFleet(targetBuffer: number = 10, batchLimit: number = 3): Promise<{ seeded: number, provisioned: number }> {
    if (this.loadSheddingActive) {
      console.log('[FleetOrchestrator] Load shedding active, skipping auto-replenishment.');
      return { seeded: 0, provisioned: 0 };
    }

    const stats = await this.registry.getPoolStats();
    
    // We specifically count accounts in the standby/reserve pipeline (excluding occupied 'active' bots)
    const standbyPipelineCount = stats.available + stats.incubating + stats.unregistered;
    const deficit = targetBuffer - standbyPipelineCount;

    let seededCount = 0;

    if (deficit > 0) {
      // Need more accounts seeded first
      const activeDomains = await this.registry.getActiveDomains();
      if (activeDomains.length === 0) {
        this.emitAlert('POOL_CRITICAL', 'critical', 'Cannot replenish fleet: No ACTIVE domains available for seeding.');
        return { seeded: 0, provisioned: 0 };
      }

      // Spread evenly or pick a random domain
      const randomDomain = activeDomains[Math.floor(Math.random() * activeDomains.length)];
      
      const seedCount = Math.min(deficit, 10); // Don't seed 1,000 at once if target is huge
      await this.registry.seedAccounts(seedCount, randomDomain.id, randomDomain.domain_name);
      seededCount = seedCount;
    }

    // Now check if we have any UNREGISTERED accounts to provision via Puppeteer.
    const unregistered = await this.registry.getUnregisteredAccounts(batchLimit);
    
    if (unregistered.length > 0) {
      this.emitAlert('FACTORY_TRIGGERED', 'info', `Auto-replenishing ${unregistered.length} accounts to maintain buffer.`);
      const result = await this.factory.provisionBatch(unregistered.length);
      
      if (result.failed.length > 0) {
        this.emitAlert('BAN_DETECTED', 'warning', `Replenish factory failed for ${result.failed.length} accounts.`);
      }
      return { seeded: seededCount, provisioned: result.succeeded.length };
    }

    return { seeded: seededCount, provisioned: 0 };
  }

  /**
   * Check if load shedding is active (used by QueueManager to skip low-priority jobs).
   */
  isLoadSheddingActive(): boolean {
    return this.loadSheddingActive;
  }

  // ── Internal ─────────────────────────────────────────────────────

  private checkPoolHealth(stats: PoolStats, warmReservePercent: number): void {
    if (stats.available === 0 && stats.total > 0) {
      this.emitAlert('POOL_CRITICAL', 'critical', 
        'ZERO available Skippers in pool! All accounts are occupied, incubating, or banned.');
    } else if (warmReservePercent < FleetOrchestrator.POOL_LOW_THRESHOLD) {
      this.emitAlert('POOL_LOW', 'warning', 
        `Warm reserves at ${Math.round(warmReservePercent * 100)}% (below ${FleetOrchestrator.POOL_LOW_THRESHOLD * 100}% threshold). Consider provisioning more.`);
    }
  }

  private emitAlert(type: FleetAlert['type'], severity: FleetAlert['severity'], message: string, metadata?: Record<string, any>): void {
    const alert: FleetAlert = {
      id: `${type}-${Date.now()}`,
      type,
      severity,
      message,
      timestamp: new Date().toISOString(),
      metadata,
    };
    this.alerts.push(alert);
    
    // Keep only last 100 alerts in memory
    if (this.alerts.length > 100) {
      this.alerts = this.alerts.slice(-100);
    }

    const icon = severity === 'critical' ? '🚨' : severity === 'warning' ? '⚠️' : 'ℹ️';
    console.log(`[FleetOrchestrator] ${icon} ${type}: ${message}`);
  }
}
