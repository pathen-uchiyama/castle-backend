-- Migration 004: Ride Advisory Tags
-- Supabase table for ride advisory metadata
-- Referenced by itinerary engine for scheduling intelligence

CREATE TABLE IF NOT EXISTS ride_advisories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attraction_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  park_id TEXT NOT NULL,
  land TEXT NOT NULL,
  height_requirement_inches INTEGER,

  -- Operational Status
  operational_status TEXT NOT NULL DEFAULT 'open'
    CHECK (operational_status IN ('open', 'temporary_closure', 'refurbishment', 'seasonal_closure', 'permanent_closure', 'under_construction')),
  reopen_date DATE,
  reopen_date_confirmed BOOLEAN DEFAULT FALSE,
  closure_notes TEXT,
  permanent_closure_date DATE,
  is_new_attraction BOOLEAN DEFAULT FALSE,
  expected_open_date DATE,
  expected_open_date_confirmed BOOLEAN DEFAULT FALSE,

  -- Physical / Sensory
  motion_sickness_risk TEXT NOT NULL DEFAULT 'none'
    CHECK (motion_sickness_risk IN ('none', 'mild', 'moderate', 'intense')),
  has_3d_glasses BOOLEAN DEFAULT FALSE,
  has_strobe_effects BOOLEAN DEFAULT FALSE,
  has_dark_enclosed BOOLEAN DEFAULT FALSE,
  noise_level TEXT NOT NULL DEFAULT 'moderate'
    CHECK (noise_level IN ('quiet', 'moderate', 'loud')),
  spin_intensity TEXT NOT NULL DEFAULT 'none'
    CHECK (spin_intensity IN ('none', 'mild', 'moderate', 'intense')),
  height_drop TEXT NOT NULL DEFAULT 'none'
    CHECK (height_drop IN ('none', 'small', 'large')),
  water_exposure TEXT NOT NULL DEFAULT 'dry'
    CHECK (water_exposure IN ('dry', 'may_get_sprayed', 'will_get_soaked')),
  motion_roughness TEXT NOT NULL DEFAULT 'smooth'
    CHECK (motion_roughness IN ('smooth', 'moderate', 'rough')),

  -- Accessibility
  wheelchair_access TEXT NOT NULL DEFAULT 'must_transfer'
    CHECK (wheelchair_access IN ('stay_in_chair', 'must_transfer', 'must_transfer_from_ecv')),
  restraint_type TEXT NOT NULL DEFAULT 'none'
    CHECK (restraint_type IN ('none', 'lap_bar', 'seat_belt', 'over_shoulder')),
  service_animal_permitted BOOLEAN DEFAULT FALSE,
  expectant_mothers_advised BOOLEAN DEFAULT FALSE,
  back_neck_advisory BOOLEAN DEFAULT FALSE,

  -- Practical
  lockers_required BOOLEAN DEFAULT FALSE,
  lockers_recommended BOOLEAN DEFAULT FALSE,
  single_rider_available BOOLEAN DEFAULT FALSE,
  rider_swap_available BOOLEAN DEFAULT FALSE,
  photo_pass_moment BOOLEAN DEFAULT FALSE,

  -- Notes
  advisory_notes JSONB DEFAULT '[]'::jsonb,

  -- Metadata
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Index for park-level queries
CREATE INDEX idx_ride_advisories_park ON ride_advisories(park_id);
CREATE INDEX idx_ride_advisories_status ON ride_advisories(operational_status);
CREATE INDEX idx_ride_advisories_motion ON ride_advisories(motion_sickness_risk);

-- RLS: advisories are publicly readable
ALTER TABLE ride_advisories ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ride_advisories_public_read" ON ride_advisories
  FOR SELECT USING (true);
