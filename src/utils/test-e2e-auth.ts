import { getSupabaseClient } from '../config/supabase';
import { SkipperFactoryClient } from '../services/SkipperFactoryClient';

async function runE2E() {
    console.log('[E2E Auth Test] Starting synthetic account auth cycle...');
    const factory = new SkipperFactoryClient();
    
    // Attempt to register 1 skipper
    await factory.runFactoryBatch(1);
    
    // Check if there is an incubating account
    const supabase = getSupabaseClient();
    const { data: accounts } = await supabase
        .from('skipper_accounts')
        .select('email')
        .eq('status', 'INCUBATING')
        .order('id', { ascending: false })
        .limit(1);
        
    if (accounts && accounts.length > 0) {
        const testEmail = accounts[0].email;
        console.log(`[E2E Auth Test] Provisioning cycle ran for ${testEmail}!`);
        console.log(`[E2E Auth Test] The factory should have sent an OTP request to the Cloudflare Email Worker.`);
        console.log(`[E2E Auth Test] Please monitor the database or the logs to confirm the OTP was parsed and stored.`);
        
        // Wait 30 seconds for the cloudflare worker to process the incoming email
        console.log(`[E2E Auth Test] Waiting 30s to check Supabase for the intercepted code...`);
        setTimeout(async () => {
            const { data } = await supabase
                .from('verification_codes')
                .select('code')
                .eq('email', testEmail)
                .single();
            
            if (data?.code) {
                console.log(`[E2E Auth Test] SUCCESS: Found intercepted OTP code [${data.code}] in DB!`);
            } else {
                console.error(`[E2E Auth Test] FAILED: No OTP code found in DB after 30s.`);
                console.error(`Check Cloudflare Email Routing configuration or ensure the email arrived.`);
            }
            process.exit(0);
        }, 30000);

    } else {
        console.error(`[E2E Auth Test] Provisioning failed for the test account (No incubating account found).`);
        process.exit(1);
    }
}

runE2E();
