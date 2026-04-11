import * as dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { SkipperFactory } from './src/services/disney/SkipperFactory';

dotenv.config();

const db = createClient(process.env.SUPABASE_URL as string, process.env.SUPABASE_SERVICE_KEY as string);

async function selectCandidates() {
  const { data: domains, error } = await db.from('utility_domains').select('id, domain_name').eq('status', 'ACTIVE').limit(5);
  
  if (error) console.error('Database Error:', error);

  if (!domains || domains.length === 0) {
      console.log('No active domains found in utility_domains table.');
      return [];
  }

  const candidates = [];
  for (const domain of domains) {
    let { data: account } = await db.from('skipper_accounts')
      .select('id, email, domain_id, display_name')
      .eq('status', 'UNREGISTERED')
      .eq('domain_id', domain.id)
      .order('created_at', { ascending: true })
      .limit(1)
      .single();
    
    if (!account) {
        const randomStr = Math.random().toString(36).substring(2, 8);
        const email = `agent_${randomStr}@${domain.domain_name}`;
        
        console.log(`Seeding new candidate: ${email}`);
        const { data: newAccount, error } = await db.from('skipper_accounts')
            .insert({
                email,
                domain_id: domain.id,
                display_name: 'Skipper Agent',
                status: 'UNREGISTERED',
                resort_capability: 'UNIVERSAL'
            }).select().single();
            
        if (error) console.error('Error seeding account:', error);
        account = newAccount;
    }

    if (account) {
      candidates.push(account);
    }
  }
  return candidates;
}

async function main() {
  console.log('=== Castle Companion — First Batch Registration ===\n');
  
  const candidates = await selectCandidates();
  if (candidates.length === 0) {
    console.log('No candidates found or created. Exiting.');
    process.exit(0);
  }

  console.log('Registration Plan:');
  candidates.forEach((c, i) => {
    console.log(`  ${i + 1}. ${c.email}`);
  });
  
  console.log('\\nStarting factory...');

  try {
    const factory = new SkipperFactory();
    
    const result = await factory.provisionBatch(candidates.length);
    
    console.log('\\n=== REGISTRATION RESULTS ===');
    console.log('Succeeded:', result.succeeded);
    console.log('Failed:', result.failed);
    process.exit(0);

  } catch (err: any) {
    console.error('Failed to run factory pipeline:', err.message);
    process.exit(1);
  }
}

main().catch(console.error);
