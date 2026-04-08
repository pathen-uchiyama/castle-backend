import { getSupabaseClient } from './config/supabase';

async function seed() {
    console.log("Seeding mock Skipper Session...");
    const supabase = getSupabaseClient();
    
    // Future expiration (1 month)
    const futureDate = new Date();
    futureDate.setMonth(futureDate.getMonth() + 1);
    
    const { data, error } = await supabase.from('skipper_sessions').upsert({
        skipper_id: '00000000-0000-0000-0000-000000000001',
        swid: '{mock-swid}',
        access_token: 'mock-access-token',
        token_expires: futureDate.toISOString(),
        device_id: 'mock-device-id',
        user_agent: 'mock-user-agent',
        last_used_at: new Date().toISOString()
    }, { onConflict: 'skipper_id' });
    
    if (error) {
        console.error("Failed:", error);
    } else {
        console.log("Success! Seeded mock skipper session.");
    }
}

seed().catch(console.error);
