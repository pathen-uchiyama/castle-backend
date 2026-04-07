-- ============================================================
-- Alpha Lockdown: Registration Whitelist
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- Table: allowed_registrations
-- Tracks emails authorized to create accounts
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.allowed_registrations (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email       TEXT NOT NULL UNIQUE,
    notes       TEXT,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    created_by  UUID -- Reference to the admin who added this
);

-- Enable RLS
ALTER TABLE public.allowed_registrations ENABLE ROW LEVEL SECURITY;

-- Only service role (backend/admin) can manage this
CREATE POLICY "Service role full access" ON public.allowed_registrations
    FOR ALL USING (auth.role() = 'service_role');

-- ────────────────────────────────────────────────────────────
-- Function: check_registration_whitelist
-- Validates that the signing-up email is in the whitelist
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.check_registration_whitelist()
RETURNS TRIGGER AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.allowed_registrations
        WHERE email = NEW.email
    ) THEN
        RAISE EXCEPTION 'Registration failed: Email % is not authorized for this Alpha release.', NEW.email;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ────────────────────────────────────────────────────────────
-- Trigger: on_auth_user_created
-- Intercepts user creation in auth.users
-- ────────────────────────────────────────────────────────────
-- Note: In Supabase, this trigger should run on auth.users (schema 'auth')
-- But triggers on 'auth' schema require superuser or specific permissions.
-- We can also use a "Before Insert" trigger if we have access, 
-- or handle it via a hook if using an Edge Function.
-- For local development/standard migration, we use the trigger on auth.users.

DROP TRIGGER IF EXISTS trg_check_whitelist ON auth.users;
CREATE TRIGGER trg_check_whitelist
    BEFORE INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.check_registration_whitelist();

-- ────────────────────────────────────────────────────────────
-- Seed: Add initial authorized users
-- ────────────────────────────────────────────────────────────
-- Replace with the user's email if known, or leave empty for them to add via Dashboard
-- INSERT INTO public.allowed_registrations (email, notes) VALUES ('admin@example.com', 'Initial Admin');
