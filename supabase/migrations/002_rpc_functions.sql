-- ============================================================
-- Skipper Factory: RPC Functions
-- Atomic operations that can't be done via REST safely
-- ============================================================

-- Atomically increment a skipper's friend count
CREATE OR REPLACE FUNCTION increment_friend_count(skipper_uuid UUID)
RETURNS VOID AS $$
BEGIN
    UPDATE skipper_accounts
    SET friend_count = friend_count + 1,
        updated_at = NOW()
    WHERE id = skipper_uuid;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Atomically decrement a skipper's friend count
CREATE OR REPLACE FUNCTION decrement_friend_count(skipper_uuid UUID)
RETURNS VOID AS $$
BEGIN
    UPDATE skipper_accounts
    SET friend_count = GREATEST(friend_count - 1, 0),
        updated_at = NOW()
    WHERE id = skipper_uuid;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Cleanup expired verification codes (run periodically)
CREATE OR REPLACE FUNCTION cleanup_expired_codes()
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM verification_codes
    WHERE expires_at < NOW()
    AND used = FALSE;
    
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
