import { getSupabaseClient } from '../config/supabase';
import { SupabaseClient } from '@supabase/supabase-js';

/**
 * AccountRegistry — Manages the Skipper Pool lifecycle.
 *
 * Handles account allocation, verification, friend-linking, retirement,
 * and friend-count cap tracking against the Supabase-backed registry.
 *
 * Lifecycle: AVAILABLE → PENDING → VERIFICATION_SENT → VERIFIED → LINKING → ACTIVE → RETIRED
 */

// ── Types ────────────────────────────────────────────────────────────

export type SkipperStatus =
    | 'UNREGISTERED'
    | 'INCUBATING'
    | 'AVAILABLE'
    | 'PENDING'
    | 'VERIFICATION_SENT'
    | 'VERIFIED'
    | 'LINKING'
    | 'ACTIVE'
    | 'RETIRED'
    | 'BANNED'
    | 'SUSPENDED';

export type DomainStatus = 'PROVISIONING' | 'ACTIVE' | 'SUSPENDED' | 'RETIRED';
export type FriendLinkStatus = 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED' | 'REMOVED';
export type ResortCapability = 'UNIVERSAL' | 'WDW' | 'DLR';

export interface SkipperAccount {
    id: string;
    email: string;
    domain_id: string;
    disney_id?: string;
    display_name?: string;
    status: SkipperStatus;
    resort_capability: ResortCapability;
    friend_count: number;
    max_friends: number;
    assigned_trip_id?: string;
    assigned_user_id?: string;
    proxy_fingerprint?: string;
    last_activity_at?: string;
    verified_at?: string;
    linked_at?: string;
    retired_at?: string;
    incubation_started_at?: string;
    incubation_actions?: number;
    disney_password_hash?: string;
    ban_detected_at?: string;
    replaced_by?: string;
    created_at: string;
    updated_at: string;
}

export interface UtilityDomain {
    id: string;
    domain_name: string;
    cloudflare_zone_id?: string;
    status: DomainStatus;
    spf_configured: boolean;
    dkim_configured: boolean;
    dmarc_configured: boolean;
    worker_deployed: boolean;
    max_accounts: number;
    current_accounts: number;
    created_at: string;
    updated_at: string;
}

export interface SubPoolStats {
    total: number;
    available: number;
    active: number;
    incubating: number;
    unregistered: number;
    pending: number;
    banned: number;
    friendCapUtilization: number; // 0–1
}

export interface PoolStats extends SubPoolStats {
    domains: number;
    activeDomains: number;
    wdw: SubPoolStats;
    dlr: SubPoolStats;
}

// ── Service ──────────────────────────────────────────────────────────

export class AccountRegistry {
    private db: SupabaseClient;

    constructor() {
        this.db = getSupabaseClient();
    }

    // ── Pool Allocation ──────────────────────────────────────────────

    /**
     * Allocates an available Skipper account for a trip.
     * Selects the account with the lowest friend count from a non-full domain.
     * Supports matching a specific resort (WDW or DLR).
     */
    async allocateSkipper(tripId: string, userId: string, resort: 'WDW' | 'DLR' = 'WDW'): Promise<SkipperAccount | null> {
        // Find an available skipper with room for more friends
        const { data: skipper, error } = await this.db
            .from('skipper_accounts')
            .select('*')
            .eq('status', 'AVAILABLE')
            .in('resort_capability', ['UNIVERSAL', resort]) // Must support the requested resort
            .lt('friend_count', 10) // Below friend cap
            .order('friend_count', { ascending: true })
            .limit(1)
            .single();

        if (error || !skipper) {
            console.warn(`[AccountRegistry] No available Skippers in pool for ${resort}`);
            return null;
        }

        // Transition: AVAILABLE → LINKING
        const { data: updated, error: updateError } = await this.db
            .from('skipper_accounts')
            .update({
                status: 'LINKING',
                assigned_trip_id: tripId,
                assigned_user_id: userId,
                last_activity_at: new Date().toISOString()
            })
            .eq('id', skipper.id)
            .eq('status', 'AVAILABLE') // Optimistic lock
            .select()
            .single();

        if (updateError || !updated) {
            console.warn('[AccountRegistry] Race condition — retrying allocation');
            return this.allocateSkipper(tripId, userId, resort); // Retry
        }

        console.log(`[AccountRegistry] Allocated Skipper ${updated.email} for trip ${tripId}`);
        return updated as SkipperAccount;
    }

    // ── Lifecycle Transitions ────────────────────────────────────────

    /**
     * Marks a Skipper as ACTIVE after the user accepts the friend request.
     */
    async activateSkipper(skipperId: string): Promise<void> {
        await this.db
            .from('skipper_accounts')
            .update({
                status: 'ACTIVE',
                linked_at: new Date().toISOString(),
            })
            .eq('id', skipperId);

        // Increment friend count
        await this.db.rpc('increment_friend_count', { skipper_uuid: skipperId });
        console.log(`[AccountRegistry] Skipper ${skipperId} → ACTIVE`);
    }

    /**
     * Retires a Skipper after trip completion.
     * Returns it to the Available pool after a cooldown period.
     */
    async retireSkipper(skipperId: string): Promise<void> {
        await this.db
            .from('skipper_accounts')
            .update({
                status: 'RETIRED',
                assigned_trip_id: null,
                assigned_user_id: null,
                retired_at: new Date().toISOString()
            })
            .eq('id', skipperId);

        console.log(`[AccountRegistry] Skipper ${skipperId} → RETIRED (cooldown started)`);

        // Schedule return to AVAILABLE after 24h cooldown
        // In production this would be a BullMQ delayed job
        setTimeout(async () => {
            await this.db
                .from('skipper_accounts')
                .update({ status: 'AVAILABLE', retired_at: null })
                .eq('id', skipperId)
                .eq('status', 'RETIRED');
            console.log(`[AccountRegistry] Skipper ${skipperId} → AVAILABLE (cooldown complete)`);
        }, 24 * 60 * 60 * 1000);
    }

    /**
     * Updates a Skipper's status during the registration/verification flow.
     */
    async updateStatus(skipperId: string, status: SkipperStatus, extra?: Record<string, any>): Promise<void> {
        await this.db
            .from('skipper_accounts')
            .update({ status, ...extra })
            .eq('id', skipperId);
    }

    /**
     * Marks a Skipper as banned (detected by Disney).
     */
    async banSkipper(skipperId: string): Promise<void> {
        await this.db
            .from('skipper_accounts')
            .update({
                status: 'BANNED',
                assigned_trip_id: null,
                assigned_user_id: null
            })
            .eq('id', skipperId);
        console.warn(`[AccountRegistry] ⚠️ Skipper ${skipperId} → BANNED`);
    }

    // ── Verification Code Management ─────────────────────────────────

    /**
     * Stores a verification code intercepted by the Cloudflare Email Worker.
     * Called by the /verify-account endpoint.
     */
    async storeVerificationCode(email: string, code: string): Promise<void> {
        await this.db
            .from('verification_codes')
            .insert({
                email,
                code,
                expires_at: new Date(Date.now() + 15 * 60000).toISOString()
            });

        // Also update the Skipper status
        await this.db
            .from('skipper_accounts')
            .update({ status: 'VERIFIED', verified_at: new Date().toISOString() })
            .eq('email', email)
            .eq('status', 'VERIFICATION_SENT');

        console.log(`[AccountRegistry] Verification code stored for ${email}`);
    }

    /**
     * Retrieves and consumes a pending verification code.
     */
    async consumeVerificationCode(email: string): Promise<string | null> {
        const { data, error } = await this.db
            .from('verification_codes')
            .select('id, code')
            .eq('email', email)
            .eq('used', false)
            .gt('expires_at', new Date().toISOString())
            .order('received_at', { ascending: false })
            .limit(1)
            .single();

        if (error || !data) return null;

        // Mark as consumed
        await this.db
            .from('verification_codes')
            .update({ used: true, used_at: new Date().toISOString() })
            .eq('id', data.id);

        return data.code;
    }

    // ── Friend Link Management ───────────────────────────────────────

    /**
     * Creates a friend link record when a Skipper sends a friend request.
     */
    async createFriendLink(skipperId: string, userDisneyId: string, tripId: string): Promise<void> {
        await this.db
            .from('friend_links')
            .insert({
                skipper_id: skipperId,
                user_disney_id: userDisneyId,
                trip_id: tripId,
                status: 'PENDING'
            });
    }

    /**
     * Marks a friend request as accepted.
     */
    async acceptFriendLink(skipperId: string, userDisneyId: string): Promise<void> {
        await this.db
            .from('friend_links')
            .update({
                status: 'ACCEPTED',
                accepted_at: new Date().toISOString()
            })
            .eq('skipper_id', skipperId)
            .eq('user_disney_id', userDisneyId)
            .eq('status', 'PENDING');
    }

    /**
     * Removes a friend link when trip ends.
     */
    async removeFriendLink(skipperId: string, userDisneyId: string): Promise<void> {
        await this.db
            .from('friend_links')
            .update({
                status: 'REMOVED',
                removed_at: new Date().toISOString()
            })
            .eq('skipper_id', skipperId)
            .eq('user_disney_id', userDisneyId);
    }

    // ── Domain Management ────────────────────────────────────────────

    /**
     * Registers a new utility domain in the registry.
     */
    async registerDomain(domainName: string, cloudflareZoneId?: string): Promise<UtilityDomain> {
        const { data, error } = await this.db
            .from('utility_domains')
            .insert({
                domain_name: domainName,
                cloudflare_zone_id: cloudflareZoneId,
                status: 'PROVISIONING'
            })
            .select()
            .single();

        if (error) throw new Error(`Failed to register domain: ${error.message}`);
        console.log(`[AccountRegistry] Domain registered: ${domainName}`);
        return data as UtilityDomain;
    }

    /**
     * Marks a domain as fully provisioned (DNS + Worker deployed).
     */
    async activateDomain(domainId: string): Promise<void> {
        await this.db
            .from('utility_domains')
            .update({
                status: 'ACTIVE',
                spf_configured: true,
                dkim_configured: true,
                dmarc_configured: true,
                worker_deployed: true
            })
            .eq('id', domainId);
    }

    /**
     * Creates a batch of Skipper accounts for a domain.
     */
    async provisionSkippers(domainId: string, domainName: string, count: number, resort: ResortCapability = 'UNIVERSAL'): Promise<number> {
        const accounts = Array.from({ length: count }, (_, i) => ({
            email: `s${String(i + 1).padStart(3, '0')}@${domainName}`,
            domain_id: domainId,
            display_name: `Castle Guest ${Math.floor(1000 + Math.random() * 9000)}`,
            status: 'UNREGISTERED' as SkipperStatus,
            resort_capability: resort
        }));

        const { data, error } = await this.db
            .from('skipper_accounts')
            .insert(accounts)
            .select();

        if (error) {
            console.error(`[AccountRegistry] Failed to provision skippers:`, error.message);
            return 0;
        }

        // Update domain account count
        await this.db
            .from('utility_domains')
            .update({ current_accounts: count })
            .eq('id', domainId);

        console.log(`[AccountRegistry] Provisioned ${data.length} Skippers on ${domainName}`);
        return data.length;
    }

    // ── Incubation Lifecycle ─────────────────────────────────────────

    /**
     * Gets all accounts currently in INCUBATING state with their progress.
     */
    async getIncubatingAccounts(): Promise<{ id: string; email: string; started: string; actions: number; hoursElapsed: number }[]> {
        const { data } = await this.db
            .from('skipper_accounts')
            .select('id, email, incubation_started_at, incubation_actions')
            .eq('status', 'INCUBATING');

        return (data || []).map((a: any) => {
            const started = a.incubation_started_at || new Date().toISOString();
            const hoursElapsed = (Date.now() - new Date(started).getTime()) / (1000 * 60 * 60);
            return { id: a.id, email: a.email, started, actions: a.incubation_actions || 0, hoursElapsed };
        });
    }

    /**
     * Promotes an INCUBATING account to AVAILABLE after warmup completes.
     */
    async promoteToAvailable(skipperId: string): Promise<void> {
        await this.db
            .from('skipper_accounts')
            .update({ status: 'AVAILABLE' })
            .eq('id', skipperId)
            .eq('status', 'INCUBATING');
        console.log(`[AccountRegistry] Skipper ${skipperId} → AVAILABLE (incubation complete)`);
    }

    /**
     * Records an incubation warming action for an account.
     */
    async recordIncubationAction(skipperId: string): Promise<void> {
        // Increment the action counter via raw update
        const { data } = await this.db
            .from('skipper_accounts')
            .select('incubation_actions')
            .eq('id', skipperId)
            .single();
        
        const current = data?.incubation_actions || 0;
        await this.db
            .from('skipper_accounts')
            .update({ 
                incubation_actions: current + 1,
                last_activity_at: new Date().toISOString()
            })
            .eq('id', skipperId);
    }

    /**
     * Gets UNREGISTERED accounts ready for factory registration.
     */
    async getUnregisteredAccounts(limit: number = 5): Promise<SkipperAccount[]> {
        const { data } = await this.db
            .from('skipper_accounts')
            .select('*')
            .eq('status', 'UNREGISTERED')
            .order('created_at', { ascending: true })
            .limit(limit);
        return (data || []) as SkipperAccount[];
    }

    /**
     * Moves an account from UNREGISTERED to INCUBATING after Disney registration.
     */
    async startIncubation(skipperId: string, disneyPasswordHash: string): Promise<void> {
        await this.db
            .from('skipper_accounts')
            .update({
                status: 'INCUBATING',
                incubation_started_at: new Date().toISOString(),
                disney_password_hash: disneyPasswordHash
            })
            .eq('id', skipperId)
            .eq('status', 'UNREGISTERED');
        console.log(`[AccountRegistry] Skipper ${skipperId} → INCUBATING (registration complete)`);
    }

    /**
     * Records a ban detection and finds a replacement from the warm pool.
     */
    async handleBan(skipperId: string): Promise<SkipperAccount | null> {
        // Read the trip assignment BEFORE clearing it (avoid race condition)
        const { data: banned } = await this.db
            .from('skipper_accounts')
            .select('assigned_trip_id, assigned_user_id, resort_capability')
            .eq('id', skipperId)
            .single();

        // Mark the account as banned and clear assignments
        await this.db
            .from('skipper_accounts')
            .update({
                status: 'BANNED',
                ban_detected_at: new Date().toISOString(),
                assigned_trip_id: null,
                assigned_user_id: null
            })
            .eq('id', skipperId);
        console.warn(`[AccountRegistry] ⚠️ Skipper ${skipperId} → BANNED`);

        if (banned?.assigned_trip_id) {
            // Auto-allocate a replacement
            const replacement = await this.allocateSkipper(
                banned.assigned_trip_id, 
                banned.assigned_user_id, 
                banned.resort_capability === 'DLR' ? 'DLR' : 'WDW'
            );
            if (replacement) {
                await this.db
                    .from('skipper_accounts')
                    .update({ replaced_by: replacement.id })
                    .eq('id', skipperId);
                console.log(`[AccountRegistry] Replacement allocated: ${replacement.email}`);
            }
            return replacement;
        }
        return null;
    }

    /**
     * Gets recent bans grouped by domain for compromise detection.
     */
    async getRecentBansByDomain(withinMinutes: number = 10): Promise<Record<string, number>> {
        const cutoff = new Date(Date.now() - withinMinutes * 60 * 1000).toISOString();
        const { data } = await this.db
            .from('skipper_accounts')
            .select('domain_id')
            .eq('status', 'BANNED')
            .gte('ban_detected_at', cutoff);

        const counts: Record<string, number> = {};
        (data || []).forEach((a: any) => {
            counts[a.domain_id] = (counts[a.domain_id] || 0) + 1;
        });
        return counts;
    }

    // ── Pool Analytics ───────────────────────────────────────────────

    /**
     * Returns current pool statistics for the admin dashboard,
     * including global metrics and broken down by WDW vs DLR capabilities.
     */
    async getPoolStats(): Promise<PoolStats> {
        const { data: accounts } = await this.db
            .from('skipper_accounts')
            .select('status, friend_count, max_friends, resort_capability');

        const { data: domains } = await this.db
            .from('utility_domains')
            .select('status');

        const all: any[] = accounts || [];
        const doms: any[] = domains || [];

        // Helper to calculate stats for a specific subset of accounts
        const calcStats = (subset: any[]): SubPoolStats => {
            const totalFriendCap = subset.reduce((sum: number, a: any) => sum + Number(a.max_friends || 10), 0);
            const totalFriends = subset.reduce((sum: number, a: any) => sum + Number(a.friend_count || 0), 0);
            return {
                total: subset.length,
                available: subset.filter((a: any) => a.status === 'AVAILABLE').length,
                active: subset.filter((a: any) => a.status === 'ACTIVE').length,
                incubating: subset.filter((a: any) => a.status === 'INCUBATING').length,
                unregistered: subset.filter((a: any) => a.status === 'UNREGISTERED').length,
                pending: subset.filter((a: any) => ['PENDING', 'VERIFICATION_SENT', 'VERIFIED', 'LINKING'].includes(a.status)).length,
                banned: subset.filter((a: any) => a.status === 'BANNED').length,
                friendCapUtilization: totalFriendCap > 0 ? totalFriends / totalFriendCap : 0,
            };
        };

        const globalStats = calcStats(all);
        const wdwAccounts = all.filter((a: any) => ['UNIVERSAL', 'WDW'].includes(a.resort_capability));
        const dlrAccounts = all.filter((a: any) => ['UNIVERSAL', 'DLR'].includes(a.resort_capability));

        return {
            ...globalStats,
            domains: doms.length,
            activeDomains: doms.filter((d: any) => d.status === 'ACTIVE').length,
            wdw: calcStats(wdwAccounts),
            dlr: calcStats(dlrAccounts),
        };
    }

    /**
     * Checks if the pool needs more accounts (auto-scaling trigger).
     * Returns true if available accounts drop below 20% of total.
     */
    async needsScaling(): Promise<boolean> {
        const stats = await this.getPoolStats();
        if (stats.total === 0) return true;
        return (stats.available / stats.total) < 0.2;
    }
}
