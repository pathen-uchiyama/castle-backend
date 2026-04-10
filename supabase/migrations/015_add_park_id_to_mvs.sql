-- ============================================================
-- Fix Materialized Views Missing park_id
-- Migration 015
-- ============================================================
-- Queue-Times IDs were prefixed with park slugs (e.g., MK_1234),
-- so `.like('MK_%')` worked for slicing analytics by park.
-- ThemeParksWiki UUIDs (20d20ef8-...) broke this assumption.
-- This migration surfaces `park_id` natively into the three 
-- primary Strategy materialized views.

-- ────────────────────────────────────────────────────────────
-- 1. Hourly Wait Averages
-- ────────────────────────────────────────────────────────────
DROP MATERIALIZED VIEW IF EXISTS mv_hourly_wait_averages;
CREATE MATERIALIZED VIEW mv_hourly_wait_averages AS
SELECT
    park_id,
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
GROUP BY park_id, attraction_id, attraction_name,
         EXTRACT(DOW FROM recorded_at),
         EXTRACT(HOUR FROM recorded_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_hourly_avg
    ON mv_hourly_wait_averages(attraction_id, day_of_week, hour_of_day);

-- ────────────────────────────────────────────────────────────
-- 2. LL Sell-out Predictions
-- ────────────────────────────────────────────────────────────
DROP MATERIALIZED VIEW IF EXISTS mv_ll_sellout_predictions;
CREATE MATERIALIZED VIEW mv_ll_sellout_predictions AS
SELECT
    park_id,
    attraction_id,
    attraction_name,
    EXTRACT(DOW FROM recorded_at) AS day_of_week,
    TO_CHAR(
        MIN(recorded_at) FILTER (WHERE is_available = FALSE),
        'HH24:MI'
    ) AS earliest_sellout_time,
    TO_CHAR(
        AVG(EXTRACT(EPOCH FROM recorded_at)) FILTER (WHERE is_available = FALSE)
        * INTERVAL '1 second' + DATE '2000-01-01',
        'HH24:MI'
    ) AS avg_sellout_time,
    COUNT(*) FILTER (WHERE is_available = FALSE) AS sellout_samples,
    COUNT(*) AS total_samples
FROM ll_availability_history
GROUP BY park_id, attraction_id, attraction_name, EXTRACT(DOW FROM recorded_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_ll_sellout
    ON mv_ll_sellout_predictions(attraction_id, day_of_week);

-- ────────────────────────────────────────────────────────────
-- 3. Attraction Reliability (Closures)
-- ────────────────────────────────────────────────────────────
DROP MATERIALIZED VIEW IF EXISTS mv_attraction_reliability;
CREATE MATERIALIZED VIEW mv_attraction_reliability AS
SELECT 
    park_id,
    attraction_id,
    attraction_name,
    closure_type,
    COUNT(*) AS total_incidents,
    ROUND(AVG(duration_minutes))::INTEGER AS avg_downtime_minutes,
    ROUND(PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY duration_minutes))::INTEGER AS p90_downtime_minutes,
    MAX(duration_minutes) AS max_downtime_minutes,
    ROUND((COUNT(*) / 90.0)::NUMERIC, 2) AS incidents_per_day
FROM attraction_closures
WHERE reopened_at IS NOT NULL
  AND closed_at > NOW() - INTERVAL '90 days'
GROUP BY park_id, attraction_id, attraction_name, closure_type;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_reliability_attr_type 
    ON mv_attraction_reliability(attraction_id, closure_type);
