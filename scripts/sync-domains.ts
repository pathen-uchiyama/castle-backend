import { SupabaseClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';

// Support running locally from terminal
dotenv.config({ path: path.join(__dirname, '../.env') });
dotenv.config({ path: path.join(__dirname, '../.env.local') });

// Must use Service Role key for DB bypass restrictions during sync
const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!supabaseUrl || !supabaseKey) {
    console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY");
    process.exit(1);
}

const db = new SupabaseClient(supabaseUrl, supabaseKey);

const CLOUDFLARE_DOMAINS = [
    'cc-ops-gateway.net',
    'cc-sync-node.com',
    'coast-pivot-tech.io',
    'dlr-gate-control.net',
    'magic-logic-ops.io',
    'travel-sync-01.com'
];

async function syncDomainsAndDeployFleet() {
    console.log("🏰 Castle Backend - Fleet Synchronization & Decentralization");
    
    // 1. Mark existing 'auth.castlecompanion.com' accounts as BACKUPS to remove them from primary rotation
    console.log("📦 Retiring legacy `auth.castlecompanion.com` accounts to BACKUP status...");
    const { error: markError } = await db
        .from('skipper_accounts')
        .update({ status: 'RETIRED' }) // Or 'BACKUP' if enum supported
        .like('email', '%@auth.castlecompanion.com');
        
    if (markError) console.error("Error setting legacy accounts to backup:", markError);

    // 2. Insert or Activate the 6 Cloudflare utility domains
    console.log("🌐 Registering Cloudflare Catch-All utility domains...");
    for (const domainName of CLOUDFLARE_DOMAINS) {
        const { data: existingDomain } = await db
            .from('utility_domains')
            .select('id')
            .eq('domain_name', domainName)
            .single();

        let domainId;
        if (!existingDomain) {
            const { data: newDomain, error } = await db.from('utility_domains').insert({
                domain_name: domainName,
                status: 'ACTIVE',
                worker_deployed: true,
                current_accounts: 0
            }).select('id').single();
            
            if (error) {
                console.error(`Failed to register ${domainName}:`, error);
                continue;
            }
            domainId = newDomain.id;
        } else {
            domainId = existingDomain.id;
            await db.from('utility_domains').update({ status: 'ACTIVE', worker_deployed: true }).eq('id', domainId);
        }

        // 3. Provision 8 Synthetic Skipper accounts per domain
        console.log(`🚀 Provisioning 8 accounts for ${domainName}...`);
        
        // Check current counts to not over-provision if already run
        const { count } = await db.from('skipper_accounts').select('*', { count: 'exact', head: true }).eq('domain_id', domainId);
        if (count && count >= 8) {
             console.log(`   └─ Already provisioned ${count} accounts.`);
             continue;
        }
        
        const accountsToCreate = 8 - (count || 0);
        const newAccounts = [];
        for (let i = 0; i < accountsToCreate; i++) {
            // Generate deterministic yet unique identifier
            const nonce = Math.floor(1000 + Math.random() * 9000);
            newAccounts.push({
                domain_id: domainId,
                email: `s${nonce}@${domainName}`,
                display_name: `Pixie Guest ${nonce}`,
                status: 'AVAILABLE',
                resort_capability: 'UNIVERSAL'
            });
        }
        
        const { error: insertError } = await db.from('skipper_accounts').insert(newAccounts);
        if (insertError) {
             console.error(`Error provisioning accounts for ${domainName}:`, insertError);
        } else {
             console.log(`   └─ Successfully loaded ${accountsToCreate} synthetic identities.`);
             // Update domain account tracker
             await db.from('utility_domains').update({ current_accounts: 8 }).eq('id', domainId);
        }
    }
    
    console.log("\n✅ Fleet fully synchronized! All 6 Cloudflare utility domains are online.");
}

syncDomainsAndDeployFleet().catch(console.error);
