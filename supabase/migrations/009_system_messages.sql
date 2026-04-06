-- System Messages Table
-- Stores system notifications, alerts, and messages for the UnifiedInbox dashboard page.

CREATE TABLE IF NOT EXISTS system_messages (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('sms', 'email', 'system', 'alert')),
  subject TEXT NOT NULL,
  body TEXT,
  sender TEXT DEFAULT 'system',
  recipient TEXT,
  read BOOLEAN DEFAULT false,
  priority TEXT DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'critical')),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Seed some initial system messages
INSERT INTO system_messages (type, subject, body, sender, priority) VALUES
  ('system', 'Castle Companion Backend Online', 'The Railway backend has been successfully deployed and is serving live data to all dashboard panels.', 'system', 'normal'),
  ('alert', 'Redis Connection Restored', 'The Redis connection was briefly interrupted during deployment but has auto-reconnected. No data loss occurred.', 'monitoring', 'high'),
  ('system', 'ThemeParks Wiki Polling Active', 'Live wait time polling is active for all 6 Disney parks (MK, EP, HS, AK, DL, DCA). Data refreshes every 5 minutes.', 'polling-service', 'normal')
ON CONFLICT DO NOTHING;
