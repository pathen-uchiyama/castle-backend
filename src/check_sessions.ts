import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../.env') });
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY!);

async function main() {
    const { data: accounts } = await supabase.from('skipper_accounts').select('id');
    const { data: sessions } = await supabase.from('skipper_sessions').select('skipper_id, token_expires');
    console.log(`Skipper Accounts: ${accounts?.length || 0}`);
    console.log(`Skipper Sessions: ${sessions?.length || 0}`);
    if (sessions && sessions.length > 0) {
        console.log('Sample session expiration:', sessions[0].token_expires);
        console.log('Current time:', new Date().toISOString());
    }
}
main();
