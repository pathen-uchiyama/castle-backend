import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { env } from '../config/env';

/**
 * Singleton Supabase client for the Skipper Factory.
 * Uses the service_role key (bypasses RLS) for server-side operations.
 */
let client: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
    if (client) return client;

    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
        console.warn('⚠️ Supabase not configured — Skipper Factory running in MOCK mode');
        // Return a mock-safe client that won't crash but won't persist
        client = createClient(
            env.SUPABASE_URL || 'http://localhost:54321',
            env.SUPABASE_SERVICE_KEY || 'mock-key'
        );
    } else {
        client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
        console.log('🗄️ Supabase client initialized for Skipper Factory');
    }

    return client;
}
