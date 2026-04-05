import { CircuitBreaker } from './CircuitBreaker';
import { DisneyAPIClient } from './DisneyAPIClient';
import { SessionManager } from './SessionManager';
import { ThemeParksWikiClient } from './ThemeParksWikiClient';
import { EndpointHealth, CircuitState } from './types';

/**
 * HealthProbe — Scheduled Disney endpoint health checks.
 *
 * Runs every 5 minutes via BullMQ repeatable job.
 * Pings read-only Disney endpoints (via an active Skipper session)
 * and ThemeParks.wiki to detect outages BEFORE customers hit them.
 *
 * Results stored in Redis for the /api/admin/disney-health dashboard.
 */
export class HealthProbe {
  private disneyClient: DisneyAPIClient;
  private sessionManager: SessionManager;
  private breaker: CircuitBreaker;
  private wikiClient: ThemeParksWikiClient;

  constructor(
    disneyClient: DisneyAPIClient,
    sessionManager: SessionManager,
    breaker: CircuitBreaker,
    wikiClient: ThemeParksWikiClient
  ) {
    this.disneyClient = disneyClient;
    this.sessionManager = sessionManager;
    this.breaker = breaker;
    this.wikiClient = wikiClient;
  }

  /**
   * Run a full health check across all Disney integration points.
   */
  async runHealthCheck(): Promise<HealthCheckResult> {
    const startTime = Date.now();
    const results: ProbeResult[] = [];

    // 1. Check ThemeParks.wiki (no auth needed)
    results.push(await this.probeThemeParksWiki());

    // 2. Check Disney endpoints (needs Skipper session)
    const session = await this.sessionManager.getAnyHealthySession('WDW');
    if (session) {
      results.push(await this.probeDisneyExperiences(session.skipperId));
    } else {
      results.push({
        endpoint: 'disney.experiences',
        status: 'SKIP',
        message: 'No active sessions — cannot probe Disney API',
        latencyMs: 0,
      });
    }

    // 3. Get circuit breaker status for all endpoints
    const circuitHealth = await this.breaker.getAllHealth();
    const trippedCircuits = circuitHealth.filter(h => h.state !== CircuitState.CLOSED);

    const overallStatus: HealthStatus =
      trippedCircuits.length > 0 ? 'DEGRADED' :
      results.some(r => r.status === 'FAIL') ? 'DEGRADED' :
      results.every(r => r.status === 'OK' || r.status === 'SKIP') ? 'HEALTHY' :
      'UNKNOWN';

    return {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - startTime,
      probes: results,
      circuits: circuitHealth,
      trippedCircuits: trippedCircuits.length,
      activeSessions: await this.sessionManager.getActiveSessionCount(),
    };
  }

  // ── Individual Probes ──────────────────────────────────────

  private async probeThemeParksWiki(): Promise<ProbeResult> {
    const start = Date.now();
    try {
      const data = await this.wikiClient.getLiveData('MK');
      return {
        endpoint: 'themeparks.wiki',
        status: data.length > 0 ? 'OK' : 'WARN',
        message: data.length > 0
          ? `OK — ${data.length} entities returned`
          : 'Empty response from ThemeParks.wiki',
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      return {
        endpoint: 'themeparks.wiki',
        status: 'FAIL',
        message: `ThemeParks.wiki unreachable: ${err instanceof Error ? err.message : 'unknown'}`,
        latencyMs: Date.now() - start,
      };
    }
  }

  private async probeDisneyExperiences(skipperId: string): Promise<ProbeResult> {
    const start = Date.now();
    try {
      const experiences = await this.disneyClient.getExperiences(
        '80007944', // Magic Kingdom
        new Date().toISOString().split('T')[0]!,
        skipperId,
        'WDW'
      );
      return {
        endpoint: 'disney.experiences',
        status: experiences.length > 0 ? 'OK' : 'WARN',
        message: experiences.length > 0
          ? `OK — ${experiences.length} experiences returned`
          : 'Empty response from Disney tipboard',
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      return {
        endpoint: 'disney.experiences',
        status: 'FAIL',
        message: `Disney API error: ${err instanceof Error ? err.message : 'unknown'}`,
        latencyMs: Date.now() - start,
      };
    }
  }
}

// ── Types ────────────────────────────────────────────────────────────

export type ProbeStatus = 'OK' | 'WARN' | 'FAIL' | 'SKIP';
export type HealthStatus = 'HEALTHY' | 'DEGRADED' | 'DOWN' | 'UNKNOWN';

export interface ProbeResult {
  endpoint: string;
  status: ProbeStatus;
  message: string;
  latencyMs: number;
}

export interface HealthCheckResult {
  status: HealthStatus;
  timestamp: string;
  durationMs: number;
  probes: ProbeResult[];
  circuits: EndpointHealth[];
  trippedCircuits: number;
  activeSessions: number;
}
