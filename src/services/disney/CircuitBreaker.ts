import Redis from 'ioredis';
import { env } from '../../config/env';
import { CircuitState, EndpointHealth } from './types';

/**
 * CircuitBreaker — Per-endpoint failure detection and auto-recovery.
 *
 * When a Disney endpoint fails 3 consecutive times:
 * 1. Circuit OPENS — all requests to that endpoint are blocked
 * 2. Alert fires (webhook to n8n for SMS/email)
 * 3. After 60s, ONE probe request is allowed (HALF_OPEN)
 * 4. If probe succeeds → circuit CLOSES, backlog drains
 * 5. If probe fails → circuit stays OPEN, timer resets
 *
 * State is persisted in Redis so it survives process restarts.
 */
export class CircuitBreaker {
  private redis: Redis;
  private readonly FAILURE_THRESHOLD: number;
  private readonly RECOVERY_TIMEOUT_MS: number;
  private readonly ALERT_COOLDOWN_MS: number;
  private lastAlertTime: number = 0;
  private static readonly REDIS_PREFIX = 'disney:circuit:';

  constructor(options?: {
    failureThreshold?: number;
    recoveryTimeoutMs?: number;
    alertCooldownMs?: number;
  }) {
    this.redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
    this.FAILURE_THRESHOLD = options?.failureThreshold ?? 3;
    this.RECOVERY_TIMEOUT_MS = options?.recoveryTimeoutMs ?? 60_000;
    this.ALERT_COOLDOWN_MS = options?.alertCooldownMs ?? 300_000;
  }

  /**
   * Check if a request to this endpoint should be allowed.
   */
  async canRequest(endpoint: string): Promise<boolean> {
    const health = await this.getHealth(endpoint);

    switch (health.state) {
      case CircuitState.CLOSED:
        return true;

      case CircuitState.OPEN: {
        const lastFailure = health.lastFailure
          ? new Date(health.lastFailure).getTime()
          : 0;
        const elapsed = Date.now() - lastFailure;

        if (elapsed > this.RECOVERY_TIMEOUT_MS) {
          // Transition to HALF_OPEN — allow one probe request
          await this.setState(endpoint, CircuitState.HALF_OPEN);
          console.log(`[CircuitBreaker] ${endpoint} → HALF_OPEN (recovery probe)`);
          return true;
        }
        return false;
      }

      case CircuitState.HALF_OPEN:
        // Already probing — block additional requests until probe resolves
        return false;
    }
  }

  /**
   * Record a successful response from a Disney endpoint.
   */
  async recordSuccess(endpoint: string): Promise<void> {
    const health = await this.getHealth(endpoint);

    if (health.state === CircuitState.HALF_OPEN) {
      console.log(`[CircuitBreaker] ✅ ${endpoint} recovered — circuit CLOSED`);
    }

    await this.setHealth(endpoint, {
      ...health,
      state: CircuitState.CLOSED,
      failureCount: 0,
      lastSuccess: new Date().toISOString(),
    });
  }

  /**
   * Record a failure from a Disney endpoint.
   */
  async recordFailure(
    endpoint: string,
    statusCode: number,
    body?: string
  ): Promise<void> {
    const health = await this.getHealth(endpoint);
    const newFailureCount = health.failureCount + 1;

    const updated: EndpointHealth = {
      ...health,
      failureCount: newFailureCount,
      lastFailure: new Date().toISOString(),
      lastErrorCode: statusCode,
      lastErrorBody: body?.substring(0, 500) ?? null,
    };

    if (health.state === CircuitState.HALF_OPEN) {
      // Recovery probe failed — re-open
      updated.state = CircuitState.OPEN;
      const isDrift = (statusCode === 403 || statusCode === 400);
      console.error(`[CircuitBreaker] 🚨 ${endpoint} recovery FAILED — circuit re-OPENED${isDrift ? ' (API DRIFT)' : ''}`);
      await this.fireAlert(updated, isDrift ? 'API_DRIFT' : 'RECOVERY_FAILED');
    } else if (newFailureCount >= this.FAILURE_THRESHOLD) {
      // Threshold reached — trip the circuit
      updated.state = CircuitState.OPEN;
      const isDrift = (statusCode === 403 || statusCode === 400);
      console.error(`[CircuitBreaker] 🚨 ${endpoint} TRIPPED after ${newFailureCount} failures${isDrift ? ' (API DRIFT)' : ''}`);
      await this.fireAlert(updated, isDrift ? 'API_DRIFT' : 'CIRCUIT_TRIPPED');
    }

    await this.setHealth(endpoint, updated);
  }

  /**
   * Get health status for a specific endpoint.
   */
  async getHealth(endpoint: string): Promise<EndpointHealth> {
    try {
      const stored = await this.redis.get(CircuitBreaker.REDIS_PREFIX + endpoint);
      if (stored) {
        return JSON.parse(stored) as EndpointHealth;
      }
    } catch (err) {
      console.warn('[CircuitBreaker] Redis read failed:', err);
    }

    return {
      endpoint,
      state: CircuitState.CLOSED,
      failureCount: 0,
      lastFailure: null,
      lastSuccess: null,
      lastErrorCode: null,
      lastErrorBody: null,
    };
  }

  /**
   * Get health status for ALL tracked endpoints.
   */
  async getAllHealth(): Promise<EndpointHealth[]> {
    try {
      const keys = await this.redis.keys(CircuitBreaker.REDIS_PREFIX + '*');
      if (keys.length === 0) return [];

      const values = await this.redis.mget(...keys);
      return values
        .filter((v): v is string => v !== null)
        .map(v => JSON.parse(v) as EndpointHealth);
    } catch (err) {
      console.error('[CircuitBreaker] Failed to get all health:', err);
      return [];
    }
  }

  /**
   * Check if ANY endpoint is currently tripped.
   */
  async hasTrippedCircuits(): Promise<boolean> {
    const all = await this.getAllHealth();
    return all.some(h => h.state === CircuitState.OPEN);
  }

  /**
   * Manually reset a circuit to CLOSED state.
   */
  async resetCircuit(endpoint: string): Promise<void> {
    await this.setHealth(endpoint, {
      endpoint,
      state: CircuitState.CLOSED,
      failureCount: 0,
      lastFailure: null,
      lastSuccess: new Date().toISOString(),
      lastErrorCode: null,
      lastErrorBody: null,
    });
    console.log(`[CircuitBreaker] ♻️ ${endpoint} manually reset to CLOSED`);
  }

  // ── Private ────────────────────────────────────────────────

  private async setHealth(endpoint: string, health: EndpointHealth): Promise<void> {
    await this.redis.set(
      CircuitBreaker.REDIS_PREFIX + endpoint,
      JSON.stringify(health),
      'EX',
      86400 // 24h TTL — auto-cleanup stale entries
    );
  }

  private async setState(endpoint: string, state: CircuitState): Promise<void> {
    const health = await this.getHealth(endpoint);
    health.state = state;
    await this.setHealth(endpoint, health);
  }

  private async fireAlert(
    health: EndpointHealth,
    reason: 'CIRCUIT_TRIPPED' | 'RECOVERY_FAILED' | 'API_DRIFT'
  ): Promise<void> {
    const now = Date.now();
    if (now - this.lastAlertTime < this.ALERT_COOLDOWN_MS) return;
    this.lastAlertTime = now;

    const alert = {
      severity: 'CRITICAL',
      reason,
      endpoint: health.endpoint,
      failureCount: health.failureCount,
      lastErrorCode: health.lastErrorCode,
      lastErrorBody: health.lastErrorBody,
      timestamp: new Date().toISOString(),
      action: reason === 'API_DRIFT'
        ? 'API Signatures or WAF rules have changed! Initialize MITM Walkthrough in Dashboard immediately.'
        : reason === 'CIRCUIT_TRIPPED'
        ? 'Disney endpoint failing. Requests paused. Check BG1 commits for API changes.'
        : 'Recovery probe failed. Disney API may have changed. Manual investigation required.',
    };

    console.error(`[CircuitBreaker] 🚨 ALERT:`, JSON.stringify(alert));

    // Fire webhook to n8n for SMS/email routing
    const webhookUrl = (env as Record<string, unknown>).ALERT_WEBHOOK_URL as string | undefined;
    if (webhookUrl) {
      try {
        await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(alert),
        });
      } catch (err) {
        console.error('[CircuitBreaker] Alert webhook delivery failed:', err);
      }
    }
  }
}
