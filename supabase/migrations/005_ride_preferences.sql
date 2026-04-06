-- Migration 005: Ride Preferences (Repeat Voting + Priority Weighting)
-- Allows users to indicate how many times they want to ride each attraction
-- and rank priority. Repeat count is weighted into itinerary generation.

CREATE TABLE IF NOT EXISTS ride_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id UUID NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  attraction_id TEXT NOT NULL,
  attraction_name TEXT NOT NULL,
  park_id TEXT NOT NULL,

  -- Repeat voting: how many times do they want to ride this?
  repeat_count INTEGER NOT NULL DEFAULT 1
    CHECK (repeat_count >= 1 AND repeat_count <= 5),

  -- Priority tier: Must-Do, Like-to, or Will-Avoid
  priority_tier TEXT NOT NULL DEFAULT 'must_do'
    CHECK (priority_tier IN ('must_do', 'like_to', 'will_avoid')),

  -- Manual rank within tier (1 = highest priority)
  priority_rank INTEGER,

  -- Notes from user (e.g., "Kids love this one, ride at least twice")
  user_notes TEXT,

  -- Metadata
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),

  -- One preference per attraction per trip per user
  UNIQUE(trip_id, user_id, attraction_id)
);

-- Indexes for itinerary generation queries
CREATE INDEX idx_ride_prefs_trip ON ride_preferences(trip_id);
CREATE INDEX idx_ride_prefs_user_trip ON ride_preferences(user_id, trip_id);
CREATE INDEX idx_ride_prefs_priority ON ride_preferences(trip_id, priority_tier, priority_rank);

-- RLS: users can only see/edit their own trip preferences
ALTER TABLE ride_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ride_prefs_own_read" ON ride_preferences
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "ride_prefs_own_insert" ON ride_preferences
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "ride_prefs_own_update" ON ride_preferences
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "ride_prefs_own_delete" ON ride_preferences
  FOR DELETE USING (auth.uid() = user_id);

-- Split party groups table (from 02_TRD_Backend_Spec.md §5a)
-- Hard cap: max 3 groups per trip, no nested splits
CREATE TABLE IF NOT EXISTS split_party_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id UUID NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  group_label TEXT NOT NULL,
  members UUID[] NOT NULL,
  itinerary_track_id UUID,
  current_zone TEXT,
  constraints JSONB,
  override_state TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (override_state IN ('ACTIVE', 'FROZEN_PENDING_SYNC', 'FROZEN_PENDING_CALLBACK')),
  callback_status TEXT
    CHECK (callback_status IS NULL OR callback_status IN ('requested', 'on_my_way', 'arrived')),
  callback_details JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Application-level enforcement: max 3 groups per trip
-- (CHECK constraints can't reference the same table in Postgres,
--  so this is enforced via trigger)
CREATE OR REPLACE FUNCTION enforce_max_three_groups()
RETURNS TRIGGER AS $$
BEGIN
  IF (SELECT COUNT(*) FROM split_party_groups WHERE trip_id = NEW.trip_id) >= 3 THEN
    RAISE EXCEPTION 'Maximum of 3 split party groups per trip (no nested splits allowed)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_max_three_groups
  BEFORE INSERT ON split_party_groups
  FOR EACH ROW EXECUTE FUNCTION enforce_max_three_groups();

CREATE INDEX idx_split_party_trip ON split_party_groups(trip_id);

ALTER TABLE split_party_groups ENABLE ROW LEVEL SECURITY;
CREATE POLICY "split_party_trip_access" ON split_party_groups
  FOR ALL USING (
    trip_id IN (SELECT id FROM trips WHERE user_id = auth.uid())
  );
