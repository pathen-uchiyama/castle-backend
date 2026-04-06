-- Feature Flags Table
-- Stores runtime-toggleable feature flags for the admin dashboard (GlobalOps page).
-- Uses Supabase for instant toggleability without redeployment.

CREATE TABLE IF NOT EXISTS feature_flags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled BOOLEAN DEFAULT false,
  description TEXT,
  category TEXT DEFAULT 'general',
  tier TEXT DEFAULT 'Standard' CHECK (tier IN ('Standard', 'Elite')),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Seed default feature flags
INSERT INTO feature_flags (id, name, enabled, description, category, tier) VALUES
  ('ll_sniper', 'Lightning Lane Sniper', true, 'Automatically monitors and books LL return times at optimal windows.', 'automation', 'Standard'),
  ('dining_scout', 'Dining Reservation Scout', true, 'Recursively scans for cancelled reservations at target restaurants.', 'automation', 'Standard'),
  ('vq_auto', 'Virtual Queue Auto-Join', false, 'Automatically joins Virtual Queue at drop time. Requires active session.', 'automation', 'Elite'),
  ('crowd_predictions', 'AI Crowd Predictions', true, 'Uses historical + real-time data to forecast crowd levels per land.', 'intelligence', 'Standard'),
  ('genie_intercept', 'Genie+ Strategy Intercept', false, 'Overrides Disney Genie+ suggestions with Castle Companion logic.', 'intelligence', 'Elite'),
  ('human_mimicry', 'Human Mimicry Engine', true, 'Randomizes request timing and headers to avoid bot detection.', 'stealth', 'Standard'),
  ('proxy_rotation', 'Proxy IP Rotation', true, 'Cycles egress IPs across residential proxy pool.', 'stealth', 'Standard'),
  ('memory_maker', 'Memory Maker Integration', false, 'Auto-downloads PhotoPass images to user accounts.', 'experience', 'Elite'),
  ('ride_advisories', 'Ride Advisory System', true, 'Surfaces height, accessibility, and motion warnings for attractions.', 'safety', 'Standard'),
  ('mobile_notifications', 'Push Notifications', false, 'Sends real-time alerts to Castle Companion mobile app.', 'engagement', 'Standard')
ON CONFLICT (id) DO NOTHING;
