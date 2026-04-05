-- ============================================================
-- DIY Thrill Data: Historical Wait Time Collection
-- Migration 007
-- ============================================================
-- Records every wait-time poll to build historical averages.
-- After 90 days: per-attraction averages by hour, day-of-week, season.
-- Replaces Thrill-Data.com subscription for LL priority scoring.

-- ────────────────────────────────────────────────────────────
-- Table: wait_time_history
-- Append-only time-series of wait time snapshots
-- ────────────────────────────────────────────────────────────
CREATE TABLE wait_time_history (
    id              BIGSERIAL PRIMARY KEY,
    park_id         TEXT NOT NULL,              -- e.g., 'MK', 'EP', 'HS', 'AK'
    attraction_id   TEXT NOT NULL,              -- e.g., 'MK_12345'
    attraction_name TEXT,                       -- Human-readable name
    wait_minutes    INTEGER,                    -- NULL if ride is closed
    is_open         BOOLEAN NOT NULL DEFAULT TRUE,
    recorded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Optimized indexes for time-series queries
CREATE INDEX idx_wait_history_attraction_time
    ON wait_time_history(attraction_id, recorded_at DESC);
CREATE INDEX idx_wait_history_park_time
    ON wait_time_history(park_id, recorded_at DESC);
CREATE INDEX idx_wait_history_recorded
    ON wait_time_history(recorded_at DESC);

-- ────────────────────────────────────────────────────────────
-- Table: ll_availability_history
-- Tracks when LL return times become available / sell out
-- Used to predict sell-out times per attraction
-- ────────────────────────────────────────────────────────────
CREATE TABLE ll_availability_history (
    id              BIGSERIAL PRIMARY KEY,
    park_id         TEXT NOT NULL,
    attraction_id   TEXT NOT NULL,
    attraction_name TEXT,
    ll_type         TEXT NOT NULL CHECK (ll_type IN ('FLEX', 'INDIVIDUAL', 'VQ')),
    is_available    BOOLEAN NOT NULL,
    next_return_time TEXT,                      -- HH:mm:ss — next available return window
    display_price   TEXT,                       -- For Individual LL pricing history
    recorded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ll_history_attraction_time
    ON ll_availability_history(attraction_id, recorded_at DESC);

-- ────────────────────────────────────────────────────────────
-- Materialized View: Hourly Averages
-- Pre-computed for fast ItineraryProcessor lookups
-- Refresh every 6 hours via BullMQ job
-- ────────────────────────────────────────────────────────────
CREATE MATERIALIZED VIEW mv_hourly_wait_averages AS
SELECT
    attraction_id,
    attraction_name,
    EXTRACT(DOW FROM recorded_at) AS day_of_week,   -- 0=Sunday
    EXTRACT(HOUR FROM recorded_at) AS hour_of_day,   -- 0-23
    ROUND(AVG(wait_minutes))::INTEGER AS avg_wait_minutes,
    ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY wait_minutes))::INTEGER AS p75_wait_minutes,
    ROUND(PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY wait_minutes))::INTEGER AS p90_wait_minutes,
    COUNT(*) AS sample_count
FROM wait_time_history
WHERE is_open = TRUE
  AND wait_minutes IS NOT NULL
  AND recorded_at > NOW() - INTERVAL '90 days'
GROUP BY attraction_id, attraction_name,
         EXTRACT(DOW FROM recorded_at),
         EXTRACT(HOUR FROM recorded_at);

CREATE UNIQUE INDEX idx_mv_hourly_avg
    ON mv_hourly_wait_averages(attraction_id, day_of_week, hour_of_day);

-- ────────────────────────────────────────────────────────────
-- Materialized View: LL Sell-Out Times
-- Predicts when each ride's LL typically becomes unavailable
-- ────────────────────────────────────────────────────────────
CREATE MATERIALIZED VIEW mv_ll_sellout_predictions AS
SELECT
    attraction_id,
    attraction_name,
    EXTRACT(DOW FROM recorded_at) AS day_of_week,
    -- The earliest time of day when LL became unavailable
    TO_CHAR(
        MIN(recorded_at) FILTER (WHERE is_available = FALSE),
        'HH24:MI'
    ) AS earliest_sellout_time,
    TO_CHAR(
        AVG(EXTRACT(EPOCH FROM recorded_at) FILTER (WHERE is_available = FALSE))
        * INTERVAL '1 second' + DATE '2000-01-01',
        'HH24:MI'
    ) AS avg_sellout_time,
    COUNT(*) FILTER (WHERE is_available = FALSE) AS sellout_samples,
    COUNT(*) AS total_samples
FROM ll_availability_history
WHERE ll_type = 'FLEX'
  AND recorded_at > NOW() - INTERVAL '90 days'
GROUP BY attraction_id, attraction_name,
         EXTRACT(DOW FROM recorded_at);

-- ────────────────────────────────────────────────────────────
-- Auto-cleanup: Partition old data after 180 days
-- (Run via scheduled BullMQ job)
-- ────────────────────────────────────────────────────────────
-- DELETE FROM wait_time_history WHERE recorded_at < NOW() - INTERVAL '180 days';
-- DELETE FROM ll_availability_history WHERE recorded_at < NOW() - INTERVAL '180 days';
-- REFRESH MATERIALIZED VIEW CONCURRENTLY mv_hourly_wait_averages;
-- REFRESH MATERIALIZED VIEW CONCURRENTLY mv_ll_sellout_predictions;

-- ────────────────────────────────────────────────────────────
-- RLS: Service role only
-- ────────────────────────────────────────────────────────────
ALTER TABLE wait_time_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE ll_availability_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access" ON wait_time_history
    FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service role full access" ON ll_availability_history
    FOR ALL USING (auth.role() = 'service_role');
