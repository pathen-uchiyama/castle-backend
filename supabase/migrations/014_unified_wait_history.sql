-- ============================================================
-- DIY Thrill Data: Unified Historical Telemetry
-- Migration 014
-- ============================================================
-- Enhances the wait_time_history table to capture exact
-- API status strings (e.g., NOT_YET_OPEN, DELAYED) and LL 
-- pricing dynamically bound to the standby snapshot.

ALTER TABLE wait_time_history
ADD COLUMN IF NOT EXISTS status_display TEXT,
ADD COLUMN IF NOT EXISTS ll_price TEXT,
ADD COLUMN IF NOT EXISTS ll_state TEXT;
