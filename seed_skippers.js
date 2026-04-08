require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const skippers = [
  { email: 'sarah.parks85@auth.castlecompanion.com', display_name: 'Sarah Parks' },
  { email: 'ryanjenkins88@auth.castlecompanion.com', display_name: 'Ryan Jenkins' },
  { email: 'ethompson91@auth.castlecompanion.com', display_name: 'Emily Thompson' },
  { email: 'michael.davis79@auth.castlecompanion.com', display_name: 'Michael Davis' },
  { email: 'jessicamiller94@auth.castlecompanion.com', display_name: 'Jessica Miller' }
];

async function run() {
  console.log('Fetching auth.castlecompanion.com domain...');
  let existing = await supabase.from('utility_domains').select('*').eq('domain_name', 'auth.castlecompanion.com').single();
  let domainId = existing?.data?.id;

  if (!domainId) {
     const { data: domain, error: domainErr } = await supabase
       .from('utility_domains')
       .insert({ domain_name: 'auth.castlecompanion.com', status: 'ACTIVE', spf_configured: true, dkim_configured: true, dmarc_configured: true, worker_deployed: true })
       .select().single();
     domainId = domain?.id;
  }

  console.log('Inserting 5 profiles into skipper_accounts without encrypted_password...');
  const inserts = skippers.map(s => ({
     email: s.email,
     display_name: s.display_name,
     domain_id: domainId,
     status: 'AVAILABLE',
     resort_capability: 'UNIVERSAL'
  }));

  const { data, error } = await supabase.from('skipper_accounts').insert(inserts).select();
  if (error && error.code !== '23505') console.error('Error inserting skippers:', error);
  else if (error && error.code === '23505') console.log('Skippers already exist, skipping insert.');
  else console.log('Successfully inserted skippers.');

  const res = await supabase.from('skipper_accounts').select('*');
  console.log("Current accounts:", res.data);
}

run();
