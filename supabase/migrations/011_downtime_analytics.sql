-- ============================================================
-- DIY Thrill Data: Historical Downtime Analytics
-- Migration 011
-- ============================================================
-- Uses "Gaps and Islands" window functions to aggregate individual
-- down/up pings in wait_time_history into unified Outage Events.

CREATE MATERIALIZED VIEW mv_downtime_statistics AS
WITH status_changes AS (
  SELECT 
    park_id,
    attraction_id,
    attraction_name,
    recorded_at,
    is_open,
    -- Mark 1 whenever status changes compared to the prior chronological record
    CASE 
      WHEN is_open = LAG(is_open) OVER (PARTITION BY attraction_id ORDER BY recorded_at) THEN 0 
      ELSE 1 
    END AS status_changed
  FROM wait_time_history
  WHERE recorded_at > NOW() - INTERVAL '90 days'
),
status_groups AS (
  SELECT
    park_id,
    attraction_id,
    attraction_name,
    recorded_at,
    is_open,
    -- Running total creates a unique grouping identifier per "streak" of status
    SUM(status_changed) OVER (PARTITION BY attraction_id ORDER BY recorded_at) AS group_id
  FROM status_changes
),
downtime_events AS (
  SELECT
    park_id,
    attraction_id,
    attraction_name,
    MIN(recorded_at) AS offline_at,
    MAX(recorded_at) AS online_at,
    -- Compare start and end of the streak to calculate minutes down
    EXTRACT(EPOCH FROM (MAX(recorded_at) - MIN(recorded_at))) / 60 AS duration_minutes
  FROM status_groups
  WHERE is_open = FALSE
  GROUP BY park_id, attraction_id, attraction_name, group_id
)
SELECT
  park_id,
  attraction_id,
  MAX(attraction_name) AS attraction_name,
  ROUND(AVG(duration_minutes))::INTEGER AS avg_downtime_minutes,
  COUNT(*) AS total_outages,
  MAX(offline_at) AS last_outage_at
FROM downtime_events
WHERE duration_minutes > 1 -- Standard threshold to ignore momentary 60-second scrape blips
GROUP BY park_id, attraction_id;

CREATE UNIQUE INDEX idx_mv_downtime_stats ON mv_downtime_statistics(attraction_id);

-- Expose via RLS to service_role like previously defined views
ALTER MATERIALIZED VIEW mv_downtime_statistics OWNER TO postgres;

-- End of File
