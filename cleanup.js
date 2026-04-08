require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
(async () => {
  // Clear verification codes for clean slate
  await db.from('verification_codes').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  
  // Mark andrew as banned
  await db.from('skipper_accounts').update({ status: 'BANNED' }).eq('email', 'andrew.g74@cc-ops-gateway.net');
  console.log('Cleanup complete');
  process.exit(0);
})();
