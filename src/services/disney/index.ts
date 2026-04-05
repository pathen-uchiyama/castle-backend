/**
 * Disney API Integration — Barrel Export
 *
 * Clean-room implementation of Disney park API client with:
 * - Hot-swappable endpoint registry
 * - Circuit breaker + alerting
 * - Human mimicry (jitter, fingerprint, non-linear pathing)
 * - Per-Skipper session management
 * - Programmatic auth with OTP automation
 * - ThemeParks.wiki free data integration
 * - DIY historical analytics (replaces Thrill Data)
 * - BG1 auto-sync engine (monitors upstream for endpoint changes)
 */

export { DisneyAPIClient, DisneyAPIError } from './DisneyAPIClient';
export { DisneyAuthClient, AuthError } from './DisneyAuthClient';
export { SessionManager } from './SessionManager';
export type { SkipperSession } from './SessionManager';
export { EndpointRegistry } from './EndpointRegistry';
export { CircuitBreaker } from './CircuitBreaker';
export { HumanMimicry } from './HumanMimicry';
export type { SkipperFingerprint } from './HumanMimicry';
export { HealthProbe } from './HealthProbe';
export type { HealthCheckResult, ProbeResult } from './HealthProbe';
export { BG1SyncEngine } from './BG1SyncEngine';
export type { SyncResult, SyncStatus } from './BG1SyncEngine';
export { ThemeParksWikiClient } from './ThemeParksWikiClient';
export type { ShowtimeInfo, LLReturnTimeInfo, VQStatusInfo } from './ThemeParksWikiClient';
export { HistoricalAnalytics } from './HistoricalAnalytics';
export type { CrowdLevel, VarianceInfo, LLAvailabilityRecord } from './HistoricalAnalytics';
export * from './types';
