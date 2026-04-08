require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const emailToWatch = 'andrew.g74@cc-ops-gateway.net';
console.log(`Starting watcher for ${emailToWatch}...`);
console.log('Go to Disney registration and enter the details. When you click send, the OTP will appear here.');

setInterval(async () => {
    const { data } = await db.from('verification_codes')
        .select('*')
        .eq('email', emailToWatch)
        .order('received_at', { ascending: false })
        .limit(1);
    
    if (data && data.length > 0) {
        console.log('\n\n===========================================');
        console.log(`🎉 OTP ARRIVED FOR ${emailToWatch}:  ➔  ${data[0].code}  🔥`);
        console.log('===========================================\n');
        process.exit(0);
    }
}, 2500);
