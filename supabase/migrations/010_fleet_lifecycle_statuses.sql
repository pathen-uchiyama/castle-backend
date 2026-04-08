-- Migration 010: Add UNREGISTERED and INCUBATING statuses to skipper_accounts
-- These statuses are required for the full fleet lifecycle:
--   UNREGISTERED → Factory registers with Disney → INCUBATING → 72hr warming → AVAILABLE

-- Drop old constraint
ALTER TABLE skipper_accounts DROP CONSTRAINT IF EXISTS skipper_accounts_status_check;

-- Add new constraint with full lifecycle statuses
ALTER TABLE skipper_accounts ADD CONSTRAINT skipper_accounts_status_check 
  CHECK (status IN (
    'UNREGISTERED',        -- DB row exists, not yet registered with Disney
    'INCUBATING',          -- Registered with Disney, warming for 72 hours
    'AVAILABLE',           -- Warm and ready for customer trip allocation
    'PENDING',             -- Allocation requested, awaiting processing
    'VERIFICATION_SENT',   -- Disney OTP requested during auth
    'VERIFIED',            -- OTP verified, session pending
    'LINKING',             -- Friend request sent to customer
    'ACTIVE',              -- Actively serving a customer trip
    'RETIRED',             -- Trip complete, in 24hr cooldown or emergency reserve
    'BANNED',              -- Detected/flagged by Disney
    'SUSPENDED'            -- Manually paused by admin
  ));

-- Add incubation tracking columns
ALTER TABLE skipper_accounts 
  ADD COLUMN IF NOT EXISTS incubation_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS incubation_actions INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS disney_password_hash TEXT,
  ADD COLUMN IF NOT EXISTS ban_detected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS replaced_by UUID REFERENCES skipper_accounts(id);
