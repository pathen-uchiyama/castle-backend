import { getSupabaseClient } from '../../config/supabase';
import { HistoricalAverage, SellOutPrediction, WaitTimeSnapshot } from './types';

/**
 * HistoricalAnalytics — DIY Thrill Data query engine.
 *
 * Queries the wait_time_history and ll_availability_history tables
 * (populated by ScraperPipeline + ThemeParksWikiClient) to provide:
 *
 * - Historical average wait times by attraction, hour, and day-of-week
 * - LL sell-out time predictions per attraction
 * - Crowd level trends ("is today busier than average?")
 * - Priority scoring inputs for RepeatVoteScoring
 *
 * After 90 days of data collection, this replaces the need for
 * a Thrill-Data.com subscription.
 */
export class HistoricalAnalytics {
  /**
   * Record a batch of wait time snapshots.
   * Called by ScraperPipeline after each poll cycle.
   */
  async recordWaitTimes(snapshots: WaitTimeSnapshot[]): Promise<number> {
    if (snapshots.length === 0) return 0;

    try {
      const db = getSupabaseClient();
      const rows = snapshots.map(s => ({
        park_id: s.parkId,
        attraction_id: s.attractionId,
        attraction_name: (s as WaitTimeSnapshot & { attractionName?: string }).attractionName ?? null,
        wait_minutes: s.waitMinutes,
        is_open: s.isOpen,
        recorded_at: s.recordedAt,
      }));

      const { error } = await db.from('wait_time_history').insert(rows);
      if (error) throw error;

      return rows.length;
    } catch (err) {
      console.error('[HistoricalAnalytics] Failed to record wait times:', err);
      return 0;
    }
  }

  /**
   * Record LL availability snapshot (from ThemeParks.wiki).
   * Tracks when each attraction's LL becomes available/unavailable.
   */
  async recordLLAvailability(records: LLAvailabilityRecord[]): Promise<number> {
    if (records.length === 0) return 0;

    try {
      const db = getSupabaseClient();
      const rows = records.map(r => ({
        park_id: r.parkId,
        attraction_id: r.attractionId,
        attraction_name: r.attractionName ?? null,
        ll_type: r.llType,
        is_available: r.isAvailable,
        next_return_time: r.nextReturnTime ?? null,
        display_price: r.displayPrice ?? null,
        recorded_at: new Date().toISOString(),
      }));

      const { error } = await db.from('ll_availability_history').insert(rows);
      if (error) throw error;

      return rows.length;
    } catch (err) {
      console.error('[HistoricalAnalytics] Failed to record LL availability:', err);
      return 0;
    }
  }

  /**
   * Get historical average wait times for an attraction.
   * Groups by day-of-week and hour-of-day.
   *
   * Uses the pre-computed materialized view for performance.
   * Falls back to a live query if the view hasn't been refreshed.
   */
  async getHourlyAverages(attractionId: string): Promise<HistoricalAverage[]> {
    try {
      const db = getSupabaseClient();

      // Try materialized view first
      const { data, error } = await db
        .from('mv_hourly_wait_averages')
        .select('*')
        .eq('attraction_id', attractionId)
        .order('day_of_week')
        .order('hour_of_day');

      if (data && data.length > 0) {
        return data.map(row => ({
          attractionId: row.attraction_id,
          attractionName: row.attraction_name,
          dayOfWeek: row.day_of_week,
          hourOfDay: row.hour_of_day,
          avgWaitMinutes: row.avg_wait_minutes,
          sampleCount: row.sample_count,
        }));
      }

      // Fallback: live query (slower, but works before first view refresh)
      return this.getHourlyAveragesLive(attractionId);
    } catch (err) {
      console.error('[HistoricalAnalytics] Hourly averages query failed:', err);
      return [];
    }
  }

  /**
   * Get the predicted wait time for an attraction at a specific time.
   * Used by ItineraryProcessor for optimal scheduling.
   */
  async getPredictedWait(
    attractionId: string,
    dayOfWeek: number, // 0=Sunday, 6=Saturday
    hourOfDay: number  // 0-23
  ): Promise<number | null> {
    const averages = await this.getHourlyAverages(attractionId);
    const match = averages.find(
      a => a.dayOfWeek === dayOfWeek && a.hourOfDay === hourOfDay
    );
    return match?.avgWaitMinutes ?? null;
  }

  /**
   * Get LL sell-out time predictions for all attractions in a park.
   * Returns the average time each ride's LL typically sells out.
   */
  async getSellOutPredictions(parkId?: string): Promise<SellOutPrediction[]> {
    try {
      const db = getSupabaseClient();

      let query = db
        .from('mv_ll_sellout_predictions')
        .select('*');

      // Filter by park if provided
      if (parkId) {
        query = query.like('attraction_id', `${parkId}_%`);
      }

      const { data } = await query;
      if (!data) return [];

      return data
        .filter(row => row.sellout_samples >= 5) // Need enough data
        .map(row => ({
          attractionId: row.attraction_id,
          attractionName: row.attraction_name,
          avgSellOutTime: row.avg_sellout_time ?? 'N/A',
          confidence: Math.min(1, row.sellout_samples / 30), // 30+ samples = high confidence
        }));
    } catch (err) {
      console.error('[HistoricalAnalytics] Sell-out predictions query failed:', err);
      return [];
    }
  }

  /**
   * Get the current "crowd level" for a park compared to historical averages.
   * Returns a score from 1 (empty) to 10 (packed).
   */
  async getCrowdLevel(parkId: string): Promise<CrowdLevel> {
    try {
      const db = getSupabaseClient();
      const now = new Date();
      const dayOfWeek = now.getDay();
      const hourOfDay = now.getHours();

      // Get current average wait across all rides in the park
      const { data: currentData } = await db
        .from('wait_time_history')
        .select('wait_minutes')
        .eq('park_id', parkId)
        .eq('is_open', true)
        .gte('recorded_at', new Date(Date.now() - 5 * 60 * 1000).toISOString()) // Last 5 min
        .not('wait_minutes', 'is', null);

      if (!currentData || currentData.length === 0) {
        return { level: 5, label: 'UNKNOWN', currentAvgWait: 0, historicalAvgWait: 0, comparison: 'NO_DATA' };
      }

      const currentAvg = currentData.reduce((sum, r) => sum + r.wait_minutes, 0) / currentData.length;

      // Get historical average for this day/hour
      const { data: histData } = await db
        .from('mv_hourly_wait_averages')
        .select('avg_wait_minutes')
        .like('attraction_id', `${parkId}_%`)
        .eq('day_of_week', dayOfWeek)
        .eq('hour_of_day', hourOfDay);

      const historicalAvg = histData && histData.length > 0
        ? histData.reduce((sum, r) => sum + r.avg_wait_minutes, 0) / histData.length
        : 30; // Default historical baseline

      // Score 1-10 based on current vs historical
      const ratio = currentAvg / Math.max(historicalAvg, 1);
      const level = Math.max(1, Math.min(10, Math.round(ratio * 5)));

      let label: CrowdLevel['label'];
      let comparison: CrowdLevel['comparison'];

      if (ratio < 0.7) { label = 'LIGHT'; comparison = 'BELOW_AVERAGE'; }
      else if (ratio < 1.0) { label = 'MODERATE'; comparison = 'BELOW_AVERAGE'; }
      else if (ratio < 1.3) { label = 'MODERATE'; comparison = 'ABOVE_AVERAGE'; }
      else if (ratio < 1.7) { label = 'HEAVY'; comparison = 'ABOVE_AVERAGE'; }
      else { label = 'EXTREME'; comparison = 'ABOVE_AVERAGE'; }

      return { level, label, currentAvgWait: Math.round(currentAvg), historicalAvgWait: Math.round(historicalAvg), comparison };
    } catch (err) {
      console.error('[HistoricalAnalytics] Crowd level query failed:', err);
      return { level: 5, label: 'UNKNOWN', currentAvgWait: 0, historicalAvgWait: 0, comparison: 'NO_DATA' };
    }
  }

  /**
   * Get the top-N attractions with the highest wait time variance.
   * These are rides where timing matters most — LL priority targets.
   */
  async getHighVarianceAttractions(parkId: string, limit = 10): Promise<VarianceInfo[]> {
    try {
      const db = getSupabaseClient();

      // Calculate variance across all hours for each attraction
      const { data } = await db.rpc('get_wait_variance', {
        p_park_id: parkId,
        p_limit: limit,
      });

      if (!data) {
        // Fallback: simple query
        return this.getHighVarianceAttractionsSimple(parkId, limit);
      }

      return data;
    } catch {
      return this.getHighVarianceAttractionsSimple(parkId, limit);
    }
  }

  /**
   * Refresh materialized views. Called by BullMQ job every 6 hours.
   */
  async refreshViews(): Promise<void> {
    try {
      const db = getSupabaseClient();
      await db.rpc('refresh_wait_time_views');
      console.log('[HistoricalAnalytics] Materialized views refreshed');
    } catch (err) {
      console.warn('[HistoricalAnalytics] View refresh failed (may not exist yet):', err);
      // Non-fatal — views will be created when first migration runs
    }
  }

  /**
   * Smart downsampling — 3-tier data retention:
   *
   * Tier 1 (0-7 days):   Keep every raw 60s snapshot (real-time debugging)
   * Tier 2 (7-30 days):  Compact to 15-min averages (recent patterns)
   * Tier 3 (30+ days):   Keep only hourly averages (materialized views handle this)
   *                      Delete all raw + 15-min data beyond 30 days
   *
   * Called by BullMQ weekly. Cuts storage ~97% vs keeping everything.
   */
  async downsampleAndCleanup(): Promise<{ compacted: number; deleted: number }> {
    const result = { compacted: 0, deleted: 0 };

    try {
      const db = getSupabaseClient();
      const now = Date.now();

      // ── Tier 2: Compact 7-30 day old raw data into 15-min averages ──

      const tier2Start = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
      const tier2End = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();

      // Insert 15-min averages for data that hasn't been compacted yet
      const { error: compactErr } = await db.rpc('compact_wait_times_15min', {
        p_start: tier2Start,
        p_end: tier2End,
      });

      if (compactErr) {
        // RPC might not exist yet — fall back to direct delete
        console.warn('[HistoricalAnalytics] compact_wait_times_15min RPC not found, using direct cleanup');
      }

      // Delete raw data older than 7 days (15-min averages preserved by RPC above)
      const { count: rawDeleted } = await db
        .from('wait_time_history')
        .delete({ count: 'exact' })
        .lt('recorded_at', tier2End);

      result.deleted += rawDeleted ?? 0;

      // ── Tier 3: Delete everything older than 30 days ──
      // (Materialized views already computed hourly averages from this data)

      const tier3Cutoff = tier2Start;

      const { count: oldWait } = await db
        .from('wait_time_history')
        .delete({ count: 'exact' })
        .lt('recorded_at', tier3Cutoff);

      const { count: oldLL } = await db
        .from('ll_availability_history')
        .delete({ count: 'exact' })
        .lt('recorded_at', tier3Cutoff);

      result.deleted += (oldWait ?? 0) + (oldLL ?? 0);

      if (result.deleted > 0) {
        console.log(
          `[HistoricalAnalytics] Downsampled: ${result.compacted} compacted, ${result.deleted} raw records deleted`
        );
      } else {
        console.log('[HistoricalAnalytics] Nothing to downsample yet');
      }

      return result;
    } catch (err) {
      console.error('[HistoricalAnalytics] Downsample failed:', err);
      return result;
    }
  }

  // ── Private ────────────────────────────────────────────────

  private async getHourlyAveragesLive(attractionId: string): Promise<HistoricalAverage[]> {
    const db = getSupabaseClient();
    const { data } = await db
      .from('wait_time_history')
      .select('wait_minutes, recorded_at')
      .eq('attraction_id', attractionId)
      .eq('is_open', true)
      .not('wait_minutes', 'is', null)
      .gte('recorded_at', new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString())
      .order('recorded_at', { ascending: false })
      .limit(5000);

    if (!data || data.length === 0) return [];

    // Group by day-of-week + hour
    const groups = new Map<string, number[]>();
    for (const row of data) {
      const d = new Date(row.recorded_at);
      const key = `${d.getDay()}-${d.getHours()}`;
      const arr = groups.get(key) ?? [];
      arr.push(row.wait_minutes);
      groups.set(key, arr);
    }

    return Array.from(groups.entries()).map(([key, waits]) => {
      const [dow, hour] = key.split('-').map(Number);
      return {
        attractionId,
        dayOfWeek: dow!,
        hourOfDay: hour!,
        avgWaitMinutes: Math.round(waits.reduce((a, b) => a + b, 0) / waits.length),
        sampleCount: waits.length,
      };
    });
  }

  private async getHighVarianceAttractionsSimple(parkId: string, limit: number): Promise<VarianceInfo[]> {
    // Simple implementation: get attractions with highest max-min spread
    const db = getSupabaseClient();
    const { data } = await db
      .from('mv_hourly_wait_averages')
      .select('attraction_id, attraction_name, avg_wait_minutes')
      .like('attraction_id', `${parkId}_%`);

    if (!data || data.length === 0) return [];

    // Group by attraction, calculate variance
    const grouped = new Map<string, { name: string; waits: number[] }>();
    for (const row of data) {
      const existing = grouped.get(row.attraction_id) ?? { name: row.attraction_name as string, waits: [] as number[] };
      existing.waits.push(Number(row.avg_wait_minutes));
      grouped.set(row.attraction_id, existing);
    }

    return Array.from(grouped.entries())
      .map(([id, { name, waits }]) => {
        const avg = waits.reduce((a, b) => a + b, 0) / waits.length;
        const variance = waits.reduce((sum, w) => sum + Math.pow(w - avg, 2), 0) / waits.length;
        return {
          attractionId: id,
          attractionName: name,
          variance: Math.round(variance),
          stdDev: Math.round(Math.sqrt(variance)),
          minAvg: Math.min(...waits),
          maxAvg: Math.max(...waits),
        };
      })
      .sort((a, b) => b.variance - a.variance)
      .slice(0, limit);
  }
}

// ── Types ────────────────────────────────────────────────────────────

export interface LLAvailabilityRecord {
  parkId: string;
  attractionId: string;
  attractionName?: string;
  llType: 'FLEX' | 'INDIVIDUAL' | 'VQ';
  isAvailable: boolean;
  nextReturnTime?: string;
  displayPrice?: string;
}

export interface CrowdLevel {
  level: number;         // 1-10
  label: 'LIGHT' | 'MODERATE' | 'HEAVY' | 'EXTREME' | 'UNKNOWN';
  currentAvgWait: number;
  historicalAvgWait: number;
  comparison: 'BELOW_AVERAGE' | 'ABOVE_AVERAGE' | 'NO_DATA';
}

export interface VarianceInfo {
  attractionId: string;
  attractionName: string;
  variance: number;
  stdDev: number;
  minAvg: number;
  maxAvg: number;
}
