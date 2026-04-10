-- Migration 016: Disney API Schemas for Zero-Downtime Shimming
-- Purpose: Allows modifying the expected JSON structure of Disney API requests without redeploying the backend.

CREATE TABLE disney_api_schemas (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    endpoint_name VARCHAR(255) NOT NULL UNIQUE,
    schema_mutation JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Enable RLS
ALTER TABLE disney_api_schemas ENABLE ROW LEVEL SECURITY;

-- Policies
CREATE POLICY "Admins can manage api schemas" ON disney_api_schemas
    FOR ALL USING (auth.role() = 'service_role' OR auth.jwt() ->> 'role' = 'admin');

CREATE POLICY "Anyone can read schemas" ON disney_api_schemas
    FOR SELECT USING (true);

-- Insert initial schemas (baseline as of April 2026)
INSERT INTO disney_api_schemas (endpoint_name, schema_mutation) VALUES
('ll.guests', '{"facilityId": "facilityId"}'),
('ll.join', '{"facilityId": "facilityId", "slotId": "slotId"}')
ON CONFLICT (endpoint_name) DO NOTHING;

-- Create an updated_at trigger
CREATE TRIGGER update_disney_api_schemas_updated_at
    BEFORE UPDATE ON disney_api_schemas
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
