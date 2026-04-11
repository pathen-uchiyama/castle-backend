# Changelog

## [1.1.0] - 2026-04-08

### Added
- Created `GET /api/admin/ai-depth` for fetching live reasoning engine performance metrics.
- Created `GET /api/admin/scraper-fleet` to supply fleet scaling latency and node activity counts.
- Created `GET /api/skipper/pool-stats` to export Skipper session ban thresholds and proxy health counts across remote networks.
- Migrated Fleet constraints from static infrastructure environment variables into dynamic `system_configurations` database cache.
- Added `/api/admin/fleet/config` endpoints to read and immediately write `TARGET_FLEET_SIZE` bounding logic and `MASTER_ORCHESTRATOR_ACTIVE` kill-switch controls without requiring Railway deployment.
- Added `/api/admin/fleet/execute-remediation` endpoint router mapping heuristic alert strings to backend operations (e.g., `REC-01`, `REC-02`).
- Removed static `RUN_WORKER` environment dependency from the BullMQ queue manager to continuously enable background processing. Automated provisioning and incubation (via `auto-replenish-fleet`) is now strictly and dynamically governed by the `MASTER_ORCHESTRATOR_ACTIVE` system toggle.

### Fixed
- Fixed UI payload mapping drops; structured missing UI nodes within endpoints allowing downstream React components to render gracefully.
- Explicitly pass backend source identity string (`DISNEY_API` vs `THEMEPARKS_WIKI`) in LiveWaitTime API payload.
