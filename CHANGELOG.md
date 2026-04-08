# Changelog

## [1.1.0] - 2026-04-08

### Added
- Created `GET /api/admin/ai-depth` for fetching live reasoning engine performance metrics.
- Created `GET /api/admin/scraper-fleet` to supply fleet scaling latency and node activity counts.
- Created `GET /api/skipper/pool-stats` to export Skipper session ban thresholds and proxy health counts across remote networks.

### Fixed
- Fixed UI payload mapping drops; structured missing UI nodes within endpoints allowing downstream React components to render gracefully.
