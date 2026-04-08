/**
 * Re-seed UNREGISTERED skipper accounts with human-readable emails.
 * Replaces bot-looking s####@domain format with firstname.lastname##@domain
 * 
 * Usage: npx tsx scripts/reseed-human-emails.ts
 */
import { getSupabaseClient } from '../src/config/supabase';

const FIRST_NAMES = [
  'sarah', 'michael', 'jessica', 'ryan', 'emily', 'chris', 'amanda', 'david',
  'lauren', 'brian', 'katie', 'josh', 'ashley', 'kevin', 'nicole', 'matt',
  'rachel', 'tyler', 'megan', 'andrew', 'taylor', 'james', 'olivia', 'daniel',
  'sophia', 'ethan', 'hannah', 'alex', 'natalie', 'brandon', 'heather', 'jacob',
  'samantha', 'nathan', 'stephanie', 'connor', 'morgan', 'dylan', 'victoria', 'logan'
];

const LAST_NAMES = [
  'johnson', 'williams', 'brown', 'jones', 'garcia', 'miller', 'davis', 'wilson',
  'taylor', 'clark', 'lewis', 'walker', 'hall', 'allen', 'young', 'king',
  'wright', 'lopez', 'hill', 'scott', 'green', 'adams', 'baker', 'nelson',
  'carter', 'mitchell', 'perez', 'roberts', 'turner', 'phillips', 'campbell', 'parker'
];

// Email format variations to look natural
const PATTERNS = [
  (f: string, l: string, n: number) => `${f}.${l}${n}`,        // sarah.johnson85
  (f: string, l: string, n: number) => `${f}${l}${n}`,          // sarahjohnson85
  (f: string, l: string, n: number) => `${f}.${l.charAt(0)}${n}`, // sarah.j85
  (f: string, l: string, n: number) => `${f[0]}${l}${n}`,       // sjohnson85
  (f: string, l: string, n: number) => `${f}_${l}${n}`,         // sarah_johnson85
  (f: string, l: string, n: number) => `${f}${n}${l.charAt(0)}`, // sarah85j
];

function generateHumanEmail(domain: string, usedEmails: Set<string>): { email: string; displayName: string } {
  let attempts = 0;
  while (attempts < 100) {
    const first = FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)];
    const last = LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)];
    const num = Math.floor(Math.random() * 90) + 10; // 10-99
    const pattern = PATTERNS[Math.floor(Math.random() * PATTERNS.length)];
    
    const localPart = pattern(first, last, num);
    const email = `${localPart}@${domain}`;
    
    if (!usedEmails.has(email)) {
      usedEmails.add(email);
      const displayFirst = first.charAt(0).toUpperCase() + first.slice(1);
      const displayLast = last.charAt(0).toUpperCase() + last.slice(1);
      return { email, displayName: `${displayFirst} ${displayLast}` };
    }
    attempts++;
  }
  throw new Error(`Could not generate unique email for ${domain}`);
}

async function reseed() {
  const db = getSupabaseClient();
  
  // Get all UNREGISTERED accounts with bot-style emails (s####@)
  const { data: accounts, error } = await db
    .from('skipper_accounts')
    .select('id, email, domain_id, status')
    .eq('status', 'UNREGISTERED');
    
  if (error) {
    console.error('Failed to fetch accounts:', error);
    return;
  }
  
  if (!accounts || accounts.length === 0) {
    console.log('No UNREGISTERED accounts to update.');
    return;
  }
  
  // Get domain info
  const domainIds = [...new Set(accounts.map(a => a.domain_id))];
  const { data: domains } = await db
    .from('utility_domains')
    .select('id, domain_name')
    .in('id', domainIds);
  
  const domainMap = new Map(domains?.map(d => [d.id, d.domain_name]) || []);
  const usedEmails = new Set<string>();
  
  // Collect existing emails to avoid collisions  
  const { data: allAccounts } = await db.from('skipper_accounts').select('email');
  allAccounts?.forEach(a => usedEmails.add(a.email));
  
  console.log(`Found ${accounts.length} UNREGISTERED accounts to update.`);
  
  let updated = 0;
  for (const account of accounts) {
    // Skip if already human-looking (has a dot or underscore before @)
    const localPart = account.email.split('@')[0];
    if (localPart.includes('.') || localPart.includes('_')) {
      console.log(`  Skipping ${account.email} (already human-looking)`);
      continue;
    }
    
    const domain = domainMap.get(account.domain_id);
    if (!domain) {
      console.log(`  Skipping ${account.email} (unknown domain)`);
      continue;
    }
    
    const { email: newEmail, displayName } = generateHumanEmail(domain, usedEmails);
    
    const { error: updateErr } = await db
      .from('skipper_accounts')
      .update({ email: newEmail, display_name: displayName })
      .eq('id', account.id);
    
    if (updateErr) {
      console.error(`  ❌ Failed to update ${account.email}: ${updateErr.message}`);
    } else {
      console.log(`  ✅ ${account.email} → ${newEmail} (${displayName})`);
      updated++;
    }
  }
  
  console.log(`\nDone. Updated ${updated}/${accounts.length} accounts.`);
}

reseed().catch(console.error);
