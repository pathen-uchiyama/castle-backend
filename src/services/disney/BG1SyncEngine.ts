import { getSupabaseClient } from '../../config/supabase';
import Redis from 'ioredis';
import { env } from '../../config/env';
import { EndpointRegistry } from './EndpointRegistry';
import { BG1Commit, SyncClassification, SyncLogEntry } from './types';

/**
 * BG1SyncEngine — Auto-monitors joelface/bg1 for endpoint changes.
 *
 * Runs as a BullMQ repeatable job every 15 minutes:
 * 1. Fetches latest commits from BG1's mickey branch via GitHub public API
 * 2. Filters for commits touching src/api/* files
 * 3. Parses the diff for endpoint path changes
 * 4. Classifies changes:
 *    - AUTO_PATCH: endpoint path changed → update EndpointRegistry in Redis
 *    - MANUAL_REVIEW: schema/structure changed → alert admin
 *    - IGNORED: cosmetic changes → log and skip
 * 5. Applies auto-patches to EndpointRegistry (zero-downtime)
 * 6. Alerts admin for manual-review items
 *
 * This is the "BG1 Canary" — the first layer of the 3-layer monitoring system.
 */
export class BG1SyncEngine {
  private registry: EndpointRegistry;
  private redis: Redis;
  private static readonly GITHUB_API = 'https://api.github.com';
  private static readonly REPO = 'joelface/bg1';
  private static readonly BRANCH = 'mickey';
  private static readonly LAST_CHECK_KEY = 'disney:bg1sync:last_check';
  private static readonly API_FILE_PATTERNS = [
    'src/api/ll',
    'src/api/vq',
    'src/api/client',
    'src/api/auth',
    'src/api/resort',
  ];

  // Regex patterns for extracting endpoint paths from BG1 source code
  private static readonly PATH_EXTRACTORS = [
    // path: '/ea-vas/planning/api/v1/...'
    /path:\s*['"`]([^'"`]+)['"`]/g,
    // url: `${origin}/tipboard-vas/...`
    /\$\{[^}]*\}(\/[a-zA-Z0-9\-_/{}]+)/g,
    // fetch(`https://...${path}`)
    /['"`](\/[a-zA-Z\-]+\/[a-zA-Z0-9\-_/{}]+)['"`]/g,
  ];

  // Regex patterns for origin URL changes
  private static readonly ORIGIN_EXTRACTORS = [
    /origins?\s*[=:]\s*\{[^}]*WDW:\s*['"`]([^'"`]+)['"`]/g,
    /origin\s*=\s*['"`](https:\/\/[^'"`]+)['"`]/g,
  ];

  constructor(registry: EndpointRegistry) {
    this.registry = registry;
    this.redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  }

  /**
   * Main sync loop. Called by BullMQ every 15 minutes.
   */
  async sync(): Promise<SyncResult> {
    console.log('[BG1Sync] Starting sync check...');

    const result: SyncResult = {
      commitsProcessed: 0,
      autoPatched: 0,
      manualReview: 0,
      ignored: 0,
      errors: [],
    };

    try {
      // Get last check timestamp
      const lastCheck = await this.getLastCheckTime();

      // Fetch recent commits from BG1
      const commits = await this.fetchRecentCommits(lastCheck ?? undefined);
      if (commits.length === 0) {
        console.log('[BG1Sync] No new commits since last check');
        await this.setLastCheckTime();
        return result;
      }

      console.log(`[BG1Sync] Found ${commits.length} new commit(s)`);

      for (const commit of commits) {
        try {
          // Check if we already processed this commit
          if (await this.isCommitProcessed(commit.sha)) {
            continue;
          }

          // Only process commits that touch API files
          const apiFiles = commit.filesChanged.filter(f =>
            BG1SyncEngine.API_FILE_PATTERNS.some(pattern => f.includes(pattern))
          );

          if (apiFiles.length === 0) {
            await this.logCommit(commit, 'ignored', null);
            result.ignored++;
            result.commitsProcessed++;
            continue;
          }

          // Fetch the diff for this commit
          const diff = await this.fetchCommitDiff(commit.sha);
          if (!diff) {
            result.errors.push(`Failed to fetch diff for ${commit.sha}`);
            continue;
          }

          // Parse the diff for endpoint changes
          const changes = this.parseDiff(diff);

          if (changes.pathChanges.length > 0) {
            // Auto-patchable: endpoint paths changed
            for (const change of changes.pathChanges) {
              await this.registry.patchEndpoint(
                change.group,
                change.endpoint,
                change.newPath,
                commit.sha
              );
              console.log(`[BG1Sync] Auto-patched: ${change.group}.${change.endpoint}`);
            }

            await this.logCommit(commit, 'auto_patched', {
              changes: changes.pathChanges.map(c => ({
                [`${c.group}.${c.endpoint}`]: { old: c.oldPath, new: c.newPath },
              })),
            });

            result.autoPatched++;
          } else if (changes.structuralChanges.length > 0) {
            // Manual review needed: request/response structure changed
            await this.logCommit(commit, 'manual_review', {
              structuralChanges: changes.structuralChanges,
            });

            await this.sendAlert(commit, changes.structuralChanges);
            result.manualReview++;
          } else {
            // No meaningful API changes
            await this.logCommit(commit, 'ignored', null);
            result.ignored++;
          }

          result.commitsProcessed++;

        } catch (err) {
          const errorMsg = `Error processing commit ${commit.sha}: ${err}`;
          console.error(`[BG1Sync] ${errorMsg}`);
          result.errors.push(errorMsg);
        }
      }

      // Update last check time
      await this.setLastCheckTime();

    } catch (err) {
      const errorMsg = `Sync cycle failed: ${err}`;
      console.error(`[BG1Sync] ${errorMsg}`);
      result.errors.push(errorMsg);
    }

    console.log(
      `[BG1Sync] Complete: ${result.commitsProcessed} processed, ` +
      `${result.autoPatched} auto-patched, ${result.manualReview} need review, ` +
      `${result.ignored} ignored`
    );

    return result;
  }

  /**
   * Get the sync status for the admin dashboard.
   */
  async getStatus(): Promise<SyncStatus> {
    const lastCheck = await this.getLastCheckTime();
    const db = getSupabaseClient();

    const { data: recent } = await db
      .from('bg1_sync_log')
      .select('*')
      .order('processed_at', { ascending: false })
      .limit(10);

    const { count: totalPatches } = await db
      .from('bg1_sync_log')
      .select('*', { count: 'exact', head: true })
      .eq('classification', 'auto_patched');

    const { count: pendingReviews } = await db
      .from('bg1_sync_log')
      .select('*', { count: 'exact', head: true })
      .eq('classification', 'manual_review')
      .eq('alert_sent', false);

    return {
      lastCheck: lastCheck ?? 'never',
      registryVersion: await this.registry.getVersion(),
      totalAutoPatches: totalPatches ?? 0,
      pendingManualReviews: pendingReviews ?? 0,
      recentActivity: (recent ?? []) as SyncLogEntry[],
    };
  }

  // ── GitHub API ─────────────────────────────────────────────

  private async fetchRecentCommits(since?: string): Promise<BG1Commit[]> {
    let url = `${BG1SyncEngine.GITHUB_API}/repos/${BG1SyncEngine.REPO}/commits?sha=${BG1SyncEngine.BRANCH}&per_page=10`;
    if (since) {
      url += `&since=${since}`;
    }

    try {
      const response = await fetch(url, {
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'CastleCompanion-BG1Sync/1.0',
        },
      });

      if (response.status === 403) {
        // Rate limited (60 req/hr unauthenticated)
        console.warn('[BG1Sync] GitHub API rate limited — will retry next cycle');
        return [];
      }

      if (!response.ok) {
        throw new Error(`GitHub API returned ${response.status}`);
      }

      const commits = await response.json() as GitHubCommit[];

      return commits.map(c => ({
        sha: c.sha,
        message: c.commit.message,
        date: c.commit.committer.date,
        filesChanged: c.files?.map(f => f.filename) ?? [],
      }));
    } catch (err) {
      console.error('[BG1Sync] Failed to fetch commits:', err);
      return [];
    }
  }

  private async fetchCommitDiff(sha: string): Promise<string | null> {
    try {
      const response = await fetch(
        `${BG1SyncEngine.GITHUB_API}/repos/${BG1SyncEngine.REPO}/commits/${sha}`,
        {
          headers: {
            'Accept': 'application/vnd.github.v3.diff',
            'User-Agent': 'CastleCompanion-BG1Sync/1.0',
          },
        }
      );

      if (!response.ok) return null;
      return await response.text();
    } catch {
      return null;
    }
  }

  // ── Diff Parser ────────────────────────────────────────────

  private parseDiff(diff: string): DiffAnalysis {
    const pathChanges: PathChange[] = [];
    const structuralChanges: string[] = [];

    const lines = diff.split('\n');
    let removedPaths: string[] = [];
    let addedPaths: string[] = [];
    let currentFile = '';

    for (const line of lines) {
      // Track current file
      if (line.startsWith('diff --git')) {
        // Process accumulated paths from previous file
        if (removedPaths.length > 0 && addedPaths.length > 0) {
          this.matchPathChanges(currentFile, removedPaths, addedPaths, pathChanges);
        }
        currentFile = line.split(' b/')[1] ?? '';
        removedPaths = [];
        addedPaths = [];
        continue;
      }

      // Extract paths from removed lines
      if (line.startsWith('-') && !line.startsWith('---')) {
        for (const extractor of BG1SyncEngine.PATH_EXTRACTORS) {
          const regex = new RegExp(extractor.source, extractor.flags);
          let match;
          while ((match = regex.exec(line)) !== null) {
            const path = match[1];
            if (path && path.includes('/') && path.length > 10) {
              removedPaths.push(path);
            }
          }
        }
      }

      // Extract paths from added lines
      if (line.startsWith('+') && !line.startsWith('+++')) {
        for (const extractor of BG1SyncEngine.PATH_EXTRACTORS) {
          const regex = new RegExp(extractor.source, extractor.flags);
          let match;
          while ((match = regex.exec(line)) !== null) {
            const path = match[1];
            if (path && path.includes('/') && path.length > 10) {
              addedPaths.push(path);
            }
          }
        }

        // Detect structural changes (new types, removed fields, etc.)
        if (
          line.includes('interface ') ||
          line.includes('type ') ||
          line.includes('extends ') ||
          line.includes('enum ')
        ) {
          structuralChanges.push(line.trim());
        }
      }
    }

    // Process last file
    if (removedPaths.length > 0 && addedPaths.length > 0) {
      this.matchPathChanges(currentFile, removedPaths, addedPaths, pathChanges);
    }

    return { pathChanges, structuralChanges };
  }

  /**
   * Match removed paths to added paths to detect endpoint URL changes.
   */
  private matchPathChanges(
    file: string,
    removed: string[],
    added: string[],
    changes: PathChange[]
  ): void {
    // Simple matching: pair removed and added paths that look similar
    for (const oldPath of removed) {
      for (const newPath of added) {
        if (oldPath === newPath) continue; // Not a change

        // Check if paths are similar enough to be the same endpoint
        const similarity = this.pathSimilarity(oldPath, newPath);
        if (similarity > 0.7) {
          // Determine which endpoint group this belongs to
          const group = this.categorizeEndpoint(file, oldPath);
          if (group) {
            changes.push({
              group: group.group,
              endpoint: group.endpoint,
              oldPath,
              newPath,
              file,
            });
          }
        }
      }
    }
  }

  /**
   * Calculate similarity between two paths (0 to 1).
   */
  private pathSimilarity(a: string, b: string): number {
    const partsA = a.split('/').filter(Boolean);
    const partsB = b.split('/').filter(Boolean);
    const maxLen = Math.max(partsA.length, partsB.length);
    if (maxLen === 0) return 0;

    let matches = 0;
    for (let i = 0; i < Math.min(partsA.length, partsB.length); i++) {
      if (partsA[i] === partsB[i]) matches++;
    }

    return matches / maxLen;
  }

  /**
   * Map a file path and endpoint path to our endpoint group/name.
   */
  private categorizeEndpoint(
    file: string,
    path: string
  ): { group: 'll' | 'vq'; endpoint: string } | null {
    if (file.includes('vq') || path.includes('getQueues') || path.includes('joinQueue')) {
      if (path.includes('getQueues')) return { group: 'vq', endpoint: 'getQueues' };
      if (path.includes('getLinkedGuests')) return { group: 'vq', endpoint: 'getLinkedGuests' };
      if (path.includes('joinQueue')) return { group: 'vq', endpoint: 'joinQueue' };
    }

    if (file.includes('ll') || path.includes('experiences') || path.includes('offerset')) {
      if (path.includes('tipboard')) return { group: 'll', endpoint: 'experiences' };
      if (path.includes('guest/guests')) return { group: 'll', endpoint: 'guests' };
      if (path.includes('bundles')) return { group: 'll', endpoint: 'availabilityBundle' };
      if (path.includes('mod/offerset/generate')) return { group: 'll', endpoint: 'offerGenerateMod' };
      if (path.includes('offerset/generate')) return { group: 'll', endpoint: 'offerGenerate' };
      if (path.includes('mod/offerset/times/fulfill')) return { group: 'll', endpoint: 'offerTimesModFulfill' };
      if (path.includes('offerset/times/fulfill')) return { group: 'll', endpoint: 'offerTimesFulfill' };
      if (path.includes('offerset/times')) return { group: 'll', endpoint: 'offerTimes' };
      if (path.includes('mod/entitlements/book')) return { group: 'll', endpoint: 'bookMod' };
      if (path.includes('entitlements/book')) return { group: 'll', endpoint: 'book' };
      if (path.includes('entitlements')) return { group: 'll', endpoint: 'cancel' };
    }

    return null;
  }

  // ── Persistence ────────────────────────────────────────────

  private async getLastCheckTime(): Promise<string | null> {
    return await this.redis.get(BG1SyncEngine.LAST_CHECK_KEY);
  }

  private async setLastCheckTime(): Promise<void> {
    await this.redis.set(BG1SyncEngine.LAST_CHECK_KEY, new Date().toISOString());
  }

  private async isCommitProcessed(sha: string): Promise<boolean> {
    const db = getSupabaseClient();
    const { data } = await db
      .from('bg1_sync_log')
      .select('id')
      .eq('commit_sha', sha)
      .single();
    return !!data;
  }

  private async logCommit(
    commit: BG1Commit,
    classification: SyncClassification,
    patchData: Record<string, unknown> | null
  ): Promise<void> {
    try {
      const db = getSupabaseClient();
      await db.from('bg1_sync_log').insert({
        commit_sha: commit.sha,
        commit_message: commit.message.substring(0, 500),
        files_changed: commit.filesChanged,
        classification,
        patch_applied: patchData,
        alert_sent: classification === 'manual_review',
        processed_at: new Date().toISOString(),
      });
    } catch (err) {
      console.error(`[BG1Sync] Failed to log commit ${commit.sha}:`, err);
    }
  }

  // ── Alerting ───────────────────────────────────────────────

  private async sendAlert(commit: BG1Commit, structuralChanges: string[]): Promise<void> {
    const alert = {
      severity: 'WARNING',
      source: 'BG1SyncEngine',
      title: `Disney API structure change detected in BG1`,
      commit: {
        sha: commit.sha.substring(0, 8),
        message: commit.message,
        url: `https://github.com/${BG1SyncEngine.REPO}/commit/${commit.sha}`,
      },
      structuralChanges: structuralChanges.slice(0, 10),
      action: 'Review the BG1 commit for Disney API schema changes that may require client updates.',
      timestamp: new Date().toISOString(),
    };

    console.warn(`[BG1Sync] ⚠️ MANUAL REVIEW NEEDED:`, JSON.stringify(alert, null, 2));

    // Fire webhook to n8n for SMS/email
    const webhookUrl = (env as Record<string, unknown>).ALERT_WEBHOOK_URL as string | undefined;
    if (webhookUrl) {
      try {
        await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(alert),
        });
      } catch (err) {
        console.error('[BG1Sync] Alert webhook failed:', err);
      }
    }
  }
}

// ── Types ────────────────────────────────────────────────────────────

interface GitHubCommit {
  sha: string;
  commit: {
    message: string;
    committer: { date: string };
  };
  files?: Array<{ filename: string }>;
}

interface PathChange {
  group: 'll' | 'vq';
  endpoint: string;
  oldPath: string;
  newPath: string;
  file: string;
}

interface DiffAnalysis {
  pathChanges: PathChange[];
  structuralChanges: string[];
}

export interface SyncResult {
  commitsProcessed: number;
  autoPatched: number;
  manualReview: number;
  ignored: number;
  errors: string[];
}

export interface SyncStatus {
  lastCheck: string;
  registryVersion: string;
  totalAutoPatches: number;
  pendingManualReviews: number;
  recentActivity: SyncLogEntry[];
}
