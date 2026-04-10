-- ============================================================
-- Disney Sessions & Sync Infrastructure
-- Migration 006
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- Table: skipper_sessions
-- Active Disney auth sessions per Skipper account
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS skipper_sessions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    skipper_id      UUID NOT NULL REFERENCES skipper_accounts(id) ON DELETE CASCADE,
    swid            TEXT NOT NULL,              -- Disney Subscriber-Wide ID
    access_token    TEXT NOT NULL,              -- Bearer token (encrypted at rest by Supabase)
    token_expires   TIMESTAMPTZ NOT NULL,       -- When the Disney token expires
    device_id       TEXT,                       -- Simulated device fingerprint for this session
    user_agent      TEXT,                       -- Simulated User-Agent string
    last_used_at    TIMESTAMPTZ DEFAULT NOW(),
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(skipper_id)                          -- One active session per Skipper
);

CREATE INDEX IF NOT EXISTS idx_session_skipper ON skipper_sessions(skipper_id);
CREATE INDEX IF NOT EXISTS idx_session_expires ON skipper_sessions(token_expires);

-- ────────────────────────────────────────────────────────────
-- Table: disney_endpoint_registry
-- Versioned endpoint configuration (Redis is primary, this is backup)
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS disney_endpoint_registry (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    version         TEXT NOT NULL,              -- e.g., '2026.04.05'
    source_commit   TEXT,                       -- BG1 commit hash this was derived from
    endpoints       JSONB NOT NULL,             -- Full endpoint map (ll + vq paths)
    is_active       BOOLEAN DEFAULT TRUE,       -- Only one active at a time
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    activated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_registry_active ON disney_endpoint_registry(is_active);

-- ────────────────────────────────────────────────────────────
-- Table: bg1_sync_log
-- Audit trail of BG1 commit processing
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bg1_sync_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    commit_sha      TEXT NOT NULL UNIQUE,
    commit_message  TEXT,
    files_changed   TEXT[],                     -- Array of changed file paths
    classification  TEXT NOT NULL
                    CHECK (classification IN ('auto_patched', 'manual_review', 'ignored')),
    patch_applied   JSONB,                      -- What was changed in the registry
    alert_sent      BOOLEAN DEFAULT FALSE,
    processed_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sync_log_sha ON bg1_sync_log(commit_sha);
CREATE INDEX IF NOT EXISTS idx_sync_log_classification ON bg1_sync_log(classification);

-- ────────────────────────────────────────────────────────────
-- Add encrypted_password column to skipper_accounts
-- Required for programmatic Disney login automation
-- ────────────────────────────────────────────────────────────
ALTER TABLE skipper_accounts ADD COLUMN IF NOT EXISTS
    encrypted_password TEXT;

-- ────────────────────────────────────────────────────────────
-- RLS: Service role only
-- ────────────────────────────────────────────────────────────
ALTER TABLE skipper_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE disney_endpoint_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE bg1_sync_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access" ON skipper_sessions
    FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service role full access" ON disney_endpoint_registry
    FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service role full access" ON bg1_sync_log
    FOR ALL USING (auth.role() = 'service_role');
