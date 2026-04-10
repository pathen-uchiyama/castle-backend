-- ============================================================
-- Attraction closures tracking: technical vs weather
-- Migration 013
-- ============================================================

CREATE TABLE IF NOT EXISTS attraction_closures (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    attraction_id       TEXT NOT NULL,
    park_id             TEXT NOT NULL,
    attraction_name     TEXT,
    closure_type        TEXT NOT NULL DEFAULT 'Unknown' CHECK (closure_type IN ('Technical', 'Weather', 'Refurbishment', 'Capacity', 'Unknown')),
    closed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reopened_at         TIMESTAMPTZ, -- NULL means currently closed
    duration_minutes    INTEGER      -- Calculated upon reopening for fast analytics
);

CREATE INDEX IF NOT EXISTS idx_closures_attraction_time 
    ON attraction_closures(attraction_id, closed_at DESC);
CREATE INDEX IF NOT EXISTS idx_closures_park_status 
    ON attraction_closures(park_id, reopened_at) WHERE reopened_at IS NULL;

-- ────────────────────────────────────────────────────────────
-- Materialized View: Closures Reliability Analytics
-- Groups by closure_type so we can filter out 'Weather'
-- ────────────────────────────────────────────────────────────
DROP MATERIALIZED VIEW IF EXISTS mv_attraction_reliability;
CREATE MATERIALIZED VIEW mv_attraction_reliability AS
SELECT 
    attraction_id,
    attraction_name,
    closure_type,
    COUNT(*) AS total_incidents,
    ROUND(AVG(duration_minutes))::INTEGER AS avg_downtime_minutes,
    ROUND(PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY duration_minutes))::INTEGER AS p90_downtime_minutes,
    MAX(duration_minutes) AS max_downtime_minutes,
    -- Simple heuristic for 'daily failure rate' based on the 90 days span
    ROUND((COUNT(*) / 90.0)::NUMERIC, 2) AS incidents_per_day
FROM attraction_closures
WHERE reopened_at IS NOT NULL
  AND closed_at > NOW() - INTERVAL '90 days'
GROUP BY attraction_id, attraction_name, closure_type;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_reliability_attr_type 
    ON mv_attraction_reliability(attraction_id, closure_type);

-- ────────────────────────────────────────────────────────────
-- RLS: Service role only
-- ────────────────────────────────────────────────────────────
ALTER TABLE attraction_closures ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access" ON attraction_closures;
CREATE POLICY "Service role full access" ON attraction_closures
    FOR ALL USING (auth.role() = 'service_role');
