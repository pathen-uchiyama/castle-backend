-- ============================================================
-- Skipper Factory: Supabase Schema Migration
-- Phase 6A — Account Registry & Pool Management
-- ============================================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ────────────────────────────────────────────────────────────
-- Table: utility_domains
-- Tracks provisioned utility domains (e.g., cc-ops-01.com)
-- ────────────────────────────────────────────────────────────
CREATE TABLE utility_domains (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    domain_name     TEXT NOT NULL UNIQUE,
    cloudflare_zone_id TEXT,
    status          TEXT NOT NULL DEFAULT 'PROVISIONING'
                    CHECK (status IN ('PROVISIONING', 'ACTIVE', 'SUSPENDED', 'RETIRED')),
    spf_configured  BOOLEAN DEFAULT FALSE,
    dkim_configured BOOLEAN DEFAULT FALSE,
    dmarc_configured BOOLEAN DEFAULT FALSE,
    worker_deployed BOOLEAN DEFAULT FALSE,
    max_accounts    INTEGER DEFAULT 50,       -- Max skippers per domain
    current_accounts INTEGER DEFAULT 0,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ────────────────────────────────────────────────────────────
-- Table: skipper_accounts
-- Managed Disney companion accounts in the Skipper Pool
-- ────────────────────────────────────────────────────────────
CREATE TABLE skipper_accounts (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email           TEXT NOT NULL UNIQUE,      -- e.g., s102@cc-ops-01.com
    domain_id       UUID REFERENCES utility_domains(id),
    disney_id       TEXT,                      -- Disney account ID once created
    display_name    TEXT,                      -- Display name on Disney profile
    status          TEXT NOT NULL DEFAULT 'AVAILABLE'
                    CHECK (status IN (
                        'AVAILABLE',           -- Ready to be assigned
                        'PENDING',             -- Registration initiated
                        'VERIFICATION_SENT',   -- Awaiting email verification
                        'VERIFIED',            -- Email verified, account created
                        'LINKING',             -- Friend request sent to user
                        'ACTIVE',              -- Linked and serving a trip
                        'RETIRED',             -- Trip ended, cooling down
                        'BANNED',              -- Flagged/banned by Disney
                        'SUSPENDED'            -- Temporarily suspended
                    )),
    resort_capability TEXT NOT NULL DEFAULT 'UNIVERSAL'
                    CHECK (resort_capability IN ('UNIVERSAL', 'WDW', 'DLR')), -- Supports Walt Disney World vs Disneyland
    friend_count    INTEGER DEFAULT 0,
    max_friends     INTEGER DEFAULT 10,        -- Disney friend cap per account
    assigned_trip_id TEXT,                     -- Currently serving this trip
    assigned_user_id TEXT,                     -- Currently linked to this user
    proxy_fingerprint TEXT,                    -- Last used residential proxy ID
    last_activity_at TIMESTAMPTZ,
    verified_at     TIMESTAMPTZ,
    linked_at       TIMESTAMPTZ,
    retired_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ────────────────────────────────────────────────────────────
-- Table: friend_links
-- Tracks friend connections between Skippers and real users
-- ────────────────────────────────────────────────────────────
CREATE TABLE friend_links (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    skipper_id      UUID REFERENCES skipper_accounts(id) ON DELETE CASCADE,
    user_disney_id  TEXT NOT NULL,             -- The real user's Disney ID
    trip_id         TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'REMOVED')),
    requested_at    TIMESTAMPTZ DEFAULT NOW(),
    accepted_at     TIMESTAMPTZ,
    removed_at      TIMESTAMPTZ
);

-- ────────────────────────────────────────────────────────────
-- Table: verification_codes
-- Temporary storage for intercepted Disney verification codes
-- ────────────────────────────────────────────────────────────
CREATE TABLE verification_codes (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email           TEXT NOT NULL,
    code            TEXT NOT NULL,
    used            BOOLEAN DEFAULT FALSE,
    received_at     TIMESTAMPTZ DEFAULT NOW(),
    used_at         TIMESTAMPTZ,
    expires_at      TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '15 minutes')
);

-- ────────────────────────────────────────────────────────────
-- Indexes
-- ────────────────────────────────────────────────────────────
CREATE INDEX idx_skipper_status ON skipper_accounts(status);
CREATE INDEX idx_skipper_domain ON skipper_accounts(domain_id);
CREATE INDEX idx_skipper_trip ON skipper_accounts(assigned_trip_id);
CREATE INDEX idx_friend_links_skipper ON friend_links(skipper_id);
CREATE INDEX idx_friend_links_user ON friend_links(user_disney_id);
CREATE INDEX idx_verification_email ON verification_codes(email);
CREATE INDEX idx_verification_unused ON verification_codes(used, expires_at);
CREATE INDEX idx_domains_status ON utility_domains(status);

-- ────────────────────────────────────────────────────────────
-- Auto-update timestamps
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_skipper_updated
    BEFORE UPDATE ON skipper_accounts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_domains_updated
    BEFORE UPDATE ON utility_domains
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ────────────────────────────────────────────────────────────
-- Row Level Security (RLS)
-- Only the service role can access these tables
-- ────────────────────────────────────────────────────────────
ALTER TABLE utility_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE skipper_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE friend_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE verification_codes ENABLE ROW LEVEL SECURITY;

-- Service role bypass (backend uses service key)
CREATE POLICY "Service role full access" ON utility_domains
    FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service role full access" ON skipper_accounts
    FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service role full access" ON friend_links
    FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service role full access" ON verification_codes
    FOR ALL USING (auth.role() = 'service_role');
