import { ParkStatusRegistry } from '../services/ParkStatusRegistry';
import { KnowledgeLayer } from '../services/KnowledgeLayer';
import { AttractionStatus, ParkID } from '../models/types';
import { HistoricalAnalytics } from '../services/disney/HistoricalAnalytics';
import { WaitTimeSnapshot } from '../services/disney/types';
import { ThemeParksWikiClient } from '../services/disney/ThemeParksWikiClient';

/**
 * ScraperPipeline — Multi-source ingestion service for live park data.
 *
 * This is the "Strategy Scraper" from the blueprint. It handles 4 data sources:
 *
 * 1. Live Wait Times   → ParkStatusRegistry (Redis, every 1-5 min)
 * 2. Official Feeds    → KnowledgeLayer (Pinecone, daily)
 * 3. Strategy Blogs    → KnowledgeLayer (Pinecone, hourly)
 * 4. Community Intel   → KnowledgeLayer (Pinecone, 15-min)
 *
 * In the MVP, sources 1-2 are implemented. Sources 3-4 are scaffolded
 * with TODO hooks for when blog/Reddit scrapers are built.
 */
export class ScraperPipeline {
    private parkRegistry: ParkStatusRegistry;
    private knowledgeLayer: KnowledgeLayer;

    constructor() {
        this.parkRegistry = new ParkStatusRegistry();
        this.knowledgeLayer = new KnowledgeLayer();
    }

    // ── Source 1: Live Wait Times ────────────────────────────────────────
    //
    // Uses the ThemeParks API (https://api.themeparks.wiki/v1/)
    // Free, community-maintained, no auth required.
    // Returns real-time wait times for WDW + DL attractions.

    /**
     * Fetches live wait times from the ThemeParks Wiki API and updates
     * the ParkStatusRegistry. Called by the Scout BullMQ job every 60s.
     */
    async pollLiveWaitTimes(parkId: ParkID): Promise<number> {
        try {
            const client = new ThemeParksWikiClient();
            const liveData = await client.getLiveData(parkId);

            if (!liveData || liveData.length === 0) {
                console.warn(`[Scraper] No live data returned from ThemeParksWiki for ${parkId}`);
                return 0;
            }

            let updatedCount = 0;
            const snapshots: WaitTimeSnapshot[] = [];

            for (const entity of liveData) {
                if (entity.entityType !== 'ATTRACTION' && entity.entityType !== 'SHOW') continue;

                const isOpen = entity.status === 'OPERATING';
                const waitMinutes = isOpen ? (entity.queue?.STANDBY?.waitTime ?? null) : null;

                const status: AttractionStatus = {
                    attractionId: entity.id,
                    name: entity.name,
                    parkId: parkId,
                    status: this.mapApiStatus(entity.status),
                    currentWaitMins: waitMinutes ?? undefined,
                    lastUpdated: new Date().toISOString(),
                };

                if (status.status === 'CLOSED' || status.status === 'DELAYED') {
                    status.closureReason = `Reported as ${entity.status} by ThemeParksWiki`;
                }

                await this.parkRegistry.updateAttractionStatus(status);
                updatedCount++;

                // Build unified snapshot
                snapshots.push({
                    parkId,
                    attractionId: entity.id,
                    waitMinutes,
                    isOpen,
                    statusString: entity.status,
                    llPrice: entity.queue?.PAID_RETURN_TIME?.price?.formatted ?? undefined,
                    llState: entity.queue?.PAID_RETURN_TIME?.state ?? entity.queue?.RETURN_TIME?.state ?? undefined,
                    recordedAt: new Date().toISOString(),
                });
            }

            console.log(`[Scraper] Updated ${updatedCount} attractions for ${parkId} (ThemeParksWiki)`);
            return updatedCount;

        } catch (error) {
            console.error(`[Scraper] Wait time poll failed for ${parkId}:`, error);
            return 0;
        }
    }

    /**
     * Maps the ThemeParks API status strings to our AttractionOperatingStatus type.
     */
    private mapApiStatus(apiStatus: string): AttractionStatus['status'] {
        switch (apiStatus.toUpperCase()) {
            case 'OPERATING':
                return 'OPEN';
            case 'CLOSED':
            case 'CLOSED_TEMPORARILY':
                return 'CLOSED';
            case 'REFURBISHMENT':
                return 'REFURB';
            case 'DOWN':
                return 'DELAYED';
            default:
                return 'OPEN'; // Default to open for unknown states
        }
    }

    // ── Source 2: Official Disney Feeds (Nightly Scraper) ────────────────
    //
    // Scrapes Disney's "Know Before You Go" and refurbishment calendar pages.
    // Chunks the text, embeds it, and upserts into Pinecone via KnowledgeLayer.

    /**
     * Scrapes official Disney pages for rules and closure updates.
     * Called by a BullMQ cron job at 3:00 AM EST nightly.
     */
    async scrapeOfficialFeeds(): Promise<number> {
        const feeds = [
            {
                id: 'wdw_know_before_you_go',
                url: 'https://disneyworld.disney.go.com/experience-updates/',
                label: 'WDW Know Before You Go'
            },
            {
                id: 'dl_know_before_you_go',
                url: 'https://disneyland.disney.go.com/experience-updates/',
                label: 'DL Know Before You Go'
            },
            {
                id: 'wdw_refurb_calendar',
                url: 'https://disneyworld.disney.go.com/calendars/',
                label: 'WDW Refurbishment Calendar'
            },
        ];

        let scrapedCount = 0;

        for (const feed of feeds) {
            try {
                const response = await fetch(feed.url);
                if (!response.ok) {
                    console.warn(`[Scraper] Could not reach ${feed.label}: ${response.status}`);
                    continue;
                }

                const html = await response.text();

                // Extract meaningful text from the HTML
                // In production, use a proper HTML parser like cheerio
                const textContent = this.extractTextFromHtml(html);

                if (textContent.length > 100) {
                    // Chunk the content (max ~2000 chars per chunk for good embedding quality)
                    const chunks = this.chunkText(textContent, 2000);

                    for (let i = 0; i < chunks.length; i++) {
                        await this.knowledgeLayer.upsertDocument(
                            `${feed.id}_chunk_${i}`,
                            chunks[i],
                            {
                                source: feed.label,
                                sourceUrl: feed.url,
                                type: 'official_feed',
                                scrapedAt: new Date().toISOString()
                            }
                        );
                    }

                    scrapedCount++;
                    console.log(`[Scraper] Ingested ${chunks.length} chunks from ${feed.label}`);
                }
            } catch (error) {
                console.error(`[Scraper] Failed to scrape ${feed.label}:`, error);
            }
        }

        return scrapedCount;
    }

    // ── Source 3: Strategy Blogs (Hourly) ────────────────────────────────
    //
    // TODO (Phase 5B+): Scrape Disney Food Blog, Mickey Visit, Inside the Magic
    // for strategy tips, menu updates, and crowd predictions.
    // Will use RSS feeds where available for efficiency.

    async scrapeStrategyBlogs(): Promise<number> {
        console.log('[Scraper] Strategy blog scraping not yet implemented (Phase 5B+)');
        // Placeholder for blog RSS feed parsing
        // Target sources:
        //   - https://www.disneyfoodblog.com/feed/
        //   - https://www.mickeyvisit.com/feed/
        //   - https://insidethemagic.net/feed/
        return 0;
    }

    // ── Source 4: Community Intel (15-min) ───────────────────────────────
    //
    // TODO (Phase 5B+): Monitor Reddit (r/WaltDisneyWorld) and WDWMagic forums
    // for real-time breakdown reports and crowd conditions.

    async scrapeCommunityIntel(): Promise<number> {
        console.log('[Scraper] Community intel scraping not yet implemented (Phase 5B+)');
        // Placeholder for Reddit API integration
        // Target subreddits:
        //   - r/WaltDisneyWorld
        //   - r/Disneyland
        // WDWMagic forums: https://forums.wdwmagic.com/
        return 0;
    }

    // ── Utilities ────────────────────────────────────────────────────────

    /**
     * Basic HTML-to-text extraction. In production, use cheerio or similar.
     */
    private extractTextFromHtml(html: string): string {
        return html
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    /**
     * Splits text into chunks of approximately `maxLength` characters,
     * breaking at sentence boundaries when possible.
     */
    private chunkText(text: string, maxLength: number): string[] {
        const chunks: string[] = [];
        let remaining = text;

        while (remaining.length > 0) {
            if (remaining.length <= maxLength) {
                chunks.push(remaining);
                break;
            }

            // Find the last sentence boundary within maxLength
            let breakPoint = remaining.lastIndexOf('. ', maxLength);
            if (breakPoint === -1 || breakPoint < maxLength * 0.5) {
                breakPoint = maxLength; // Fall back to hard break
            } else {
                breakPoint += 2; // Include the period and space
            }

            chunks.push(remaining.substring(0, breakPoint).trim());
            remaining = remaining.substring(breakPoint).trim();
        }

        return chunks;
    }
}
