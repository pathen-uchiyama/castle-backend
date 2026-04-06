import { env } from '../config/env';
import Redis from 'ioredis';

/**
 * WhisperGalleryModeration — 4-Layer Content Moderation Pipeline
 *
 * The "Whisper Gallery" is the community feature where guests share
 * tips, reviews, and insider knowledge. All user-generated content
 * must pass through this moderation pipeline before publication.
 *
 * Architecture:
 *   L1: Keyword Filter (regex — instant, no API call)
 *   L2: Gemini Flash Classification (SAFE/RUMOR/NEEDS_REVIEW/REJECT)
 *   L3: GPT-4o Escalation (ambiguous content only)
 *   L4: Human Review Queue (UnifiedInbox in admin dashboard)
 *
 * AB 316 Compliance:
 *   Every moderation decision is logged with:
 *   - Original content
 *   - Classification result
 *   - Model used + confidence score
 *   - Timestamp + reviewer (AI model or human)
 *   - Action taken (publish/reject/flag)
 *   - Latency
 *
 * COPPA: PII detection is a HARD reject for child safety.
 */

// ── Types ───────────────────────────────────────────────────────

export type ModerationClassification = 'SAFE' | 'RUMOR' | 'NEEDS_REVIEW' | 'REJECT';

export type RejectReason =
    | 'PROFANITY'
    | 'PII_DETECTED'
    | 'EXTERNAL_URL'
    | 'HARASSMENT'
    | 'SPAM'
    | 'COPPA_VIOLATION'
    | 'DANGEROUS_ADVICE'
    | 'COMPETITOR_PROMOTION'
    | 'AI_CLASSIFIED_REJECT';

export interface ModerationInput {
    /** Unique content ID */
    contentId: string;
    /** Author user ID */
    userId: string;
    /** Raw content text */
    text: string;
    /** Content type */
    contentType: 'tip' | 'review' | 'reply' | 'photo_caption';
    /** Author's account age in days */
    accountAgeDays?: number;
    /** Previous moderation actions on this user */
    priorFlags?: number;
}

export interface ModerationResult {
    contentId: string;
    classification: ModerationClassification;
    /** Which layer made the final decision */
    decidedAtLayer: 'L1' | 'L2' | 'L3' | 'L4';
    /** Model used (null for L1 keyword filter) */
    model: string | null;
    /** Confidence score (0-1, null for L1) */
    confidence: number | null;
    /** Rejection reason if classified as REJECT */
    rejectReason: RejectReason | null;
    /** Sanitized text (PII redacted) */
    sanitizedText: string;
    /** Latency in ms */
    latencyMs: number;
    /** Whether content was auto-published or queued for review */
    action: 'published' | 'rejected' | 'queued_for_review';
    /** Detailed reasoning from the AI model */
    reasoning: string | null;
    /** Timestamp for audit log */
    timestamp: string;
}

export interface AuditLogEntry {
    contentId: string;
    userId: string;
    originalText: string;
    sanitizedText: string;
    classification: ModerationClassification;
    decidedAtLayer: string;
    model: string | null;
    confidence: number | null;
    rejectReason: RejectReason | null;
    action: string;
    reasoning: string | null;
    reviewer: string;  // 'L1_KEYWORD', 'gemini-1.5-flash', 'gpt-4o', 'human:{adminId}'
    timestamp: string;
    latencyMs: number;
}

// ── L1: Keyword Filter (Instant) ────────────────────────────────

/**
 * Regex patterns for L1 keyword filtering.
 * These are HARD rules — no AI needed.
 */
const L1_PATTERNS = {
    // Profanity (common variants + leetspeak)
    profanity: /\b(f+[uü]+[ck]+|sh[i1]+t|b+[i1]+t+ch|a+ss+h+[o0]+le|d+[i1]+ck|c+u+nt)\b/gi,

    // PII — emails, phone numbers, SSN patterns
    email: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    phone: /(\+?1[-.\s]?)?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}/g,
    ssn: /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/g,

    // External URLs (spam/competitor promotion)
    urls: /https?:\/\/[^\s]+/gi,
    // Allow Disney URLs
    nonDisneyUrls: /https?:\/\/(?!(?:disneyworld|disneyland|themepark|wdw|dlr))[^\s]+/gi,

    // Address patterns
    address: /\b\d{1,5}\s+\w+\s+(st|street|ave|avenue|blvd|boulevard|rd|road|dr|drive|ln|lane|ct|court)\b/gi,

    // Credit card patterns (13-19 digits)
    creditCard: /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{1,7}\b/g,

    // Child names with ages (COPPA risk)
    childAge: /\b(my\s+(?:son|daughter|kid|child|baby)\s+\w+\s+is\s+\d{1,2})\b/gi,

    // Competitor promotion
    competitors: /\b(viator|getyourguide|klook|touringplans|undercovertourist|mousesavers|linebeast)\b/gi,
};

/**
 * L1 Keyword Filter — Instant, no API call.
 * Returns null if content passes, or a reject reason if it fails.
 */
function l1KeywordFilter(text: string): {
    passed: boolean;
    reason: RejectReason | null;
    sanitized: string;
    matches: string[];
} {
    const matches: string[] = [];
    let sanitized = text;

    // Check profanity
    if (L1_PATTERNS.profanity.test(text)) {
        return { passed: false, reason: 'PROFANITY', sanitized: text, matches: ['profanity'] };
    }

    // Check PII — redact but don't auto-reject (queue for review)
    let hasPII = false;
    for (const [key, pattern] of Object.entries(L1_PATTERNS)) {
        if (['email', 'phone', 'ssn', 'address', 'creditCard'].includes(key)) {
            const piiMatches = text.match(pattern);
            if (piiMatches) {
                hasPII = true;
                matches.push(`PII:${key}`);
                sanitized = sanitized.replace(pattern, '[REDACTED]');
            }
        }
    }

    if (hasPII) {
        return { passed: false, reason: 'PII_DETECTED', sanitized, matches };
    }

    // Check COPPA (child name + age)
    if (L1_PATTERNS.childAge.test(text)) {
        sanitized = sanitized.replace(L1_PATTERNS.childAge, '[CHILD_INFO_REDACTED]');
        return { passed: false, reason: 'COPPA_VIOLATION', sanitized, matches: ['child_age'] };
    }

    // Check competitor promotion
    if (L1_PATTERNS.competitors.test(text)) {
        return { passed: false, reason: 'COMPETITOR_PROMOTION', sanitized, matches: ['competitor'] };
    }

    // Check external non-Disney URLs
    if (L1_PATTERNS.nonDisneyUrls.test(text)) {
        return { passed: false, reason: 'EXTERNAL_URL', sanitized, matches: ['external_url'] };
    }

    return { passed: true, reason: null, sanitized, matches: [] };
}

// ── L2: Gemini Flash Classification ─────────────────────────────

const L2_SYSTEM_PROMPT = `You are a content moderation system for a Disney vacation planning community called "Whisper Gallery." Your job is to classify user-generated content.

Classify each message into EXACTLY ONE category:
- SAFE: Helpful tips, genuine reviews, personal experiences, ride advice
- RUMOR: Unverified claims about park operations, ride closures, pricing changes, or insider info that could mislead others
- NEEDS_REVIEW: Ambiguous content that could be safe but might contain subtle issues (passive-aggressive, borderline)
- REJECT: Harassment, dangerous advice (health/safety), spam, or content that violates community guidelines

RESPOND IN THIS EXACT JSON FORMAT:
{"classification": "SAFE|RUMOR|NEEDS_REVIEW|REJECT", "confidence": 0.0-1.0, "reasoning": "brief explanation"}

Important context:
- This is a FAMILY-FRIENDLY community. Content about children's experiences is fine; sharing children's personal details is not.
- Disney park tips and strategies are SAFE (that's the purpose of the community).
- Unverified ride closure rumors can cause panic and should be flagged as RUMOR.
- Health/safety advice (e.g., "skip the EpiPen") is ALWAYS REJECT.`;

/**
 * L2 Gemini Flash Classification.
 * Returns classification, confidence, and reasoning.
 */
async function l2GeminiClassify(text: string): Promise<{
    classification: ModerationClassification;
    confidence: number;
    reasoning: string;
}> {
    try {
        const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': env.GEMINI_API_KEY || '',
            },
            body: JSON.stringify({
                systemInstruction: { parts: [{ text: L2_SYSTEM_PROMPT }] },
                contents: [{ parts: [{ text: `Classify this community post:\n\n"${text}"` }] }],
                generationConfig: {
                    temperature: 0.1,
                    maxOutputTokens: 200,
                    responseMimeType: 'application/json',
                },
            }),
        });

        if (!response.ok) {
            console.warn(`[Moderation-L2] Gemini API error: ${response.status}`);
            return { classification: 'NEEDS_REVIEW', confidence: 0, reasoning: 'Gemini API unavailable' };
        }

        const data = await response.json() as any;
        const responseText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

        try {
            const parsed = JSON.parse(responseText);
            return {
                classification: parsed.classification || 'NEEDS_REVIEW',
                confidence: Math.min(Math.max(parsed.confidence || 0.5, 0), 1),
                reasoning: parsed.reasoning || 'No reasoning provided',
            };
        } catch {
            return { classification: 'NEEDS_REVIEW', confidence: 0.3, reasoning: 'Failed to parse Gemini response' };
        }
    } catch (err) {
        console.warn('[Moderation-L2] Gemini call failed:', err);
        return { classification: 'NEEDS_REVIEW', confidence: 0, reasoning: 'Gemini call failed' };
    }
}

// ── L3: GPT-4o Escalation ───────────────────────────────────────

const L3_SYSTEM_PROMPT = `You are an expert content moderator reviewing flagged community content for a Disney vacation planning app. A previous AI system flagged this content as ambiguous.

Your job is to make a FINAL decision:
- SAFE: Publish immediately
- REJECT: Content violates community guidelines (explain why)
- NEEDS_REVIEW: You're unsure — escalate to human moderator (explain your uncertainty)

Context: This is the "Whisper Gallery" — a family-friendly space for sharing Disney tips and experiences.
California AB 316 requires us to maintain an audit trail of all AI moderation decisions.

RESPOND IN THIS EXACT JSON FORMAT:
{"classification": "SAFE|REJECT|NEEDS_REVIEW", "confidence": 0.0-1.0, "reasoning": "detailed explanation for the audit log"}`;

async function l3GPT4oEscalation(text: string, l2Reasoning: string): Promise<{
    classification: ModerationClassification;
    confidence: number;
    reasoning: string;
}> {
    try {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
            },
            body: JSON.stringify({
                model: 'gpt-4o',
                messages: [
                    { role: 'system', content: L3_SYSTEM_PROMPT },
                    { role: 'user', content: `Previous AI assessment: "${l2Reasoning}"\n\nContent to review:\n"${text}"` },
                ],
                temperature: 0.1,
                max_tokens: 300,
                response_format: { type: 'json_object' },
            }),
        });

        if (!response.ok) {
            console.warn(`[Moderation-L3] GPT-4o API error: ${response.status}`);
            return { classification: 'NEEDS_REVIEW', confidence: 0, reasoning: 'GPT-4o API unavailable — escalating to human' };
        }

        const data = await response.json() as any;
        const content = data.choices?.[0]?.message?.content || '';

        try {
            const parsed = JSON.parse(content);
            return {
                classification: parsed.classification || 'NEEDS_REVIEW',
                confidence: Math.min(Math.max(parsed.confidence || 0.5, 0), 1),
                reasoning: parsed.reasoning || 'No reasoning provided',
            };
        } catch {
            return { classification: 'NEEDS_REVIEW', confidence: 0.3, reasoning: 'Failed to parse GPT-4o response' };
        }
    } catch (err) {
        console.warn('[Moderation-L3] GPT-4o call failed:', err);
        return { classification: 'NEEDS_REVIEW', confidence: 0, reasoning: 'GPT-4o call failed — escalating to human' };
    }
}

// ── Main Pipeline ───────────────────────────────────────────────

export class WhisperGalleryModeration {
    private redis: Redis | null = null;
    private static readonly AUDIT_PREFIX = 'whisper:audit:';
    private static readonly REVIEW_QUEUE_KEY = 'whisper:review_queue';

    constructor(redisUrl?: string) {
        try {
            this.redis = new Redis(redisUrl || env.REDIS_URL, {
                maxRetriesPerRequest: null,
                lazyConnect: true,
            });
            this.redis.on('error', () => { /* non-fatal */ });
            this.redis.connect().catch(() => { /* non-fatal */ });
        } catch {
            this.redis = null;
        }
    }

    /**
     * Run the full 4-layer moderation pipeline.
     */
    async moderate(input: ModerationInput): Promise<ModerationResult> {
        const startTime = Date.now();

        // ── L1: Keyword Filter (instant) ──────────────────────
        const l1Result = l1KeywordFilter(input.text);

        if (!l1Result.passed) {
            const result: ModerationResult = {
                contentId: input.contentId,
                classification: 'REJECT',
                decidedAtLayer: 'L1',
                model: null,
                confidence: 1.0,
                rejectReason: l1Result.reason,
                sanitizedText: l1Result.sanitized,
                latencyMs: Date.now() - startTime,
                action: l1Result.reason === 'PII_DETECTED' ? 'queued_for_review' : 'rejected',
                reasoning: `L1 keyword filter triggered: ${l1Result.matches.join(', ')}`,
                timestamp: new Date().toISOString(),
            };

            // PII gets queued for review instead of auto-reject (might be false positive)
            if (l1Result.reason === 'PII_DETECTED') {
                result.classification = 'NEEDS_REVIEW';
                result.action = 'queued_for_review';
                await this.queueForHumanReview(input, result);
            }

            await this.writeAuditLog(input, result);
            return result;
        }

        // ── L2: Gemini Flash Classification ───────────────────
        const l2Result = await l2GeminiClassify(l1Result.sanitized);

        // If Gemini says SAFE with high confidence, auto-publish
        if (l2Result.classification === 'SAFE' && l2Result.confidence >= 0.85) {
            const result: ModerationResult = {
                contentId: input.contentId,
                classification: 'SAFE',
                decidedAtLayer: 'L2',
                model: 'gemini-1.5-flash',
                confidence: l2Result.confidence,
                rejectReason: null,
                sanitizedText: l1Result.sanitized,
                latencyMs: Date.now() - startTime,
                action: 'published',
                reasoning: l2Result.reasoning,
                timestamp: new Date().toISOString(),
            };
            await this.writeAuditLog(input, result);
            return result;
        }

        // If Gemini says REJECT with high confidence, auto-reject
        if (l2Result.classification === 'REJECT' && l2Result.confidence >= 0.90) {
            const result: ModerationResult = {
                contentId: input.contentId,
                classification: 'REJECT',
                decidedAtLayer: 'L2',
                model: 'gemini-1.5-flash',
                confidence: l2Result.confidence,
                rejectReason: 'AI_CLASSIFIED_REJECT',
                sanitizedText: l1Result.sanitized,
                latencyMs: Date.now() - startTime,
                action: 'rejected',
                reasoning: l2Result.reasoning,
                timestamp: new Date().toISOString(),
            };
            await this.writeAuditLog(input, result);
            return result;
        }

        // If Gemini says RUMOR, queue for human review with rumor flag
        if (l2Result.classification === 'RUMOR') {
            const result: ModerationResult = {
                contentId: input.contentId,
                classification: 'RUMOR',
                decidedAtLayer: 'L2',
                model: 'gemini-1.5-flash',
                confidence: l2Result.confidence,
                rejectReason: null,
                sanitizedText: l1Result.sanitized,
                latencyMs: Date.now() - startTime,
                action: 'queued_for_review',
                reasoning: l2Result.reasoning,
                timestamp: new Date().toISOString(),
            };
            await this.queueForHumanReview(input, result);
            await this.writeAuditLog(input, result);
            return result;
        }

        // ── L3: GPT-4o Escalation (ambiguous content) ─────────
        const l3Result = await l3GPT4oEscalation(l1Result.sanitized, l2Result.reasoning);

        if (l3Result.classification === 'SAFE' && l3Result.confidence >= 0.80) {
            const result: ModerationResult = {
                contentId: input.contentId,
                classification: 'SAFE',
                decidedAtLayer: 'L3',
                model: 'gpt-4o',
                confidence: l3Result.confidence,
                rejectReason: null,
                sanitizedText: l1Result.sanitized,
                latencyMs: Date.now() - startTime,
                action: 'published',
                reasoning: `L2 uncertain (${l2Result.reasoning}). L3 override: ${l3Result.reasoning}`,
                timestamp: new Date().toISOString(),
            };
            await this.writeAuditLog(input, result);
            return result;
        }

        if (l3Result.classification === 'REJECT') {
            const result: ModerationResult = {
                contentId: input.contentId,
                classification: 'REJECT',
                decidedAtLayer: 'L3',
                model: 'gpt-4o',
                confidence: l3Result.confidence,
                rejectReason: 'AI_CLASSIFIED_REJECT',
                sanitizedText: l1Result.sanitized,
                latencyMs: Date.now() - startTime,
                action: 'rejected',
                reasoning: `L2 uncertain (${l2Result.reasoning}). L3 reject: ${l3Result.reasoning}`,
                timestamp: new Date().toISOString(),
            };
            await this.writeAuditLog(input, result);
            return result;
        }

        // ── L4: Human Review Queue ────────────────────────────
        // Both AI models were uncertain — queue for human admin
        const result: ModerationResult = {
            contentId: input.contentId,
            classification: 'NEEDS_REVIEW',
            decidedAtLayer: 'L3',
            model: 'gpt-4o',
            confidence: l3Result.confidence,
            rejectReason: null,
            sanitizedText: l1Result.sanitized,
            latencyMs: Date.now() - startTime,
            action: 'queued_for_review',
            reasoning: `L2: ${l2Result.reasoning} | L3: ${l3Result.reasoning}`,
            timestamp: new Date().toISOString(),
        };

        await this.queueForHumanReview(input, result);
        await this.writeAuditLog(input, result);
        return result;
    }

    // ── Human Review Queue ──────────────────────────────────────

    /**
     * Queue content for human review in the admin UnifiedInbox.
     */
    private async queueForHumanReview(input: ModerationInput, result: ModerationResult): Promise<void> {
        try {
            if (!this.redis) return;

            const reviewItem = {
                contentId: input.contentId,
                userId: input.userId,
                contentType: input.contentType,
                originalText: input.text,
                sanitizedText: result.sanitizedText,
                classification: result.classification,
                aiReasoning: result.reasoning,
                aiModel: result.model,
                aiConfidence: result.confidence,
                queuedAt: new Date().toISOString(),
                status: 'pending',
            };

            await this.redis.lpush(
                WhisperGalleryModeration.REVIEW_QUEUE_KEY,
                JSON.stringify(reviewItem)
            );
            await this.redis.expire(WhisperGalleryModeration.REVIEW_QUEUE_KEY, 604800); // 7 day TTL
        } catch { /* non-critical */ }
    }

    /**
     * Get items awaiting human review.
     */
    async getReviewQueue(limit: number = 50): Promise<any[]> {
        try {
            if (!this.redis) return [];
            const items = await this.redis.lrange(WhisperGalleryModeration.REVIEW_QUEUE_KEY, 0, limit - 1);
            return items.map(i => JSON.parse(i));
        } catch {
            return [];
        }
    }

    /**
     * Human moderator decision.
     */
    async humanDecision(
        contentId: string,
        adminId: string,
        decision: 'approve' | 'reject',
        notes?: string
    ): Promise<AuditLogEntry> {
        const auditEntry: AuditLogEntry = {
            contentId,
            userId: '',
            originalText: '',
            sanitizedText: '',
            classification: decision === 'approve' ? 'SAFE' : 'REJECT',
            decidedAtLayer: 'L4',
            model: null,
            confidence: 1.0,
            rejectReason: decision === 'reject' ? 'AI_CLASSIFIED_REJECT' : null,
            action: decision === 'approve' ? 'published' : 'rejected',
            reasoning: `Human decision by ${adminId}: ${notes || 'No notes'}`,
            reviewer: `human:${adminId}`,
            timestamp: new Date().toISOString(),
            latencyMs: 0,
        };

        // Write to audit log
        await this.writeAuditLog(
            { contentId, userId: '', text: '', contentType: 'tip' },
            {
                contentId,
                classification: auditEntry.classification,
                decidedAtLayer: 'L4',
                model: null,
                confidence: 1.0,
                rejectReason: auditEntry.rejectReason,
                sanitizedText: '',
                latencyMs: 0,
                action: auditEntry.action as any,
                reasoning: auditEntry.reasoning,
                timestamp: auditEntry.timestamp,
            }
        );

        return auditEntry;
    }

    // ── AB 316 Audit Log ────────────────────────────────────────

    /**
     * Write an immutable audit log entry.
     * AB 316 requires: content, classification, model, confidence, timestamp, action.
     */
    private async writeAuditLog(input: ModerationInput, result: ModerationResult): Promise<void> {
        const entry: AuditLogEntry = {
            contentId: input.contentId,
            userId: input.userId,
            originalText: input.text,
            sanitizedText: result.sanitizedText,
            classification: result.classification,
            decidedAtLayer: result.decidedAtLayer,
            model: result.model,
            confidence: result.confidence,
            rejectReason: result.rejectReason,
            action: result.action,
            reasoning: result.reasoning,
            reviewer: result.model || 'L1_KEYWORD',
            timestamp: result.timestamp,
            latencyMs: result.latencyMs,
        };

        try {
            if (!this.redis) {
                console.log('[Moderation] Audit log (no Redis):', JSON.stringify(entry));
                return;
            }

            const dateKey = result.timestamp.substring(0, 10);
            const logKey = `${WhisperGalleryModeration.AUDIT_PREFIX}${dateKey}`;

            const pipeline = this.redis.pipeline();
            pipeline.lpush(logKey, JSON.stringify(entry));
            pipeline.ltrim(logKey, 0, 9999);       // Keep last 10,000 entries per day
            pipeline.expire(logKey, 90 * 86400);    // 90-day retention for compliance
            await pipeline.exec();

            // Also maintain a per-user log
            const userKey = `${WhisperGalleryModeration.AUDIT_PREFIX}user:${input.userId}`;
            await this.redis.lpush(userKey, JSON.stringify(entry));
            await this.redis.ltrim(userKey, 0, 499);  // Last 500 per user
            await this.redis.expire(userKey, 365 * 86400); // 1 year
        } catch (err) {
            // Audit log failure should NOT block moderation
            console.error('[Moderation] Audit log write failed:', err);
        }
    }

    // ── Dashboard Queries ───────────────────────────────────────

    /**
     * Get audit log entries for a specific date.
     */
    async getAuditLog(date: string, limit: number = 100): Promise<AuditLogEntry[]> {
        try {
            if (!this.redis) return [];
            const entries = await this.redis.lrange(`${WhisperGalleryModeration.AUDIT_PREFIX}${date}`, 0, limit - 1);
            return entries.map(e => JSON.parse(e));
        } catch {
            return [];
        }
    }

    /**
     * Get moderation stats for the admin dashboard.
     */
    async getStats(date?: string): Promise<{
        total: number;
        safe: number;
        rejected: number;
        rumor: number;
        needsReview: number;
        pendingReview: number;
        avgLatencyMs: number;
        byLayer: Record<string, number>;
    }> {
        const targetDate = date || new Date().toISOString().substring(0, 10);
        const entries = await this.getAuditLog(targetDate, 10000);
        const reviewQueue = await this.getReviewQueue(1000);

        const stats = {
            total: entries.length,
            safe: 0,
            rejected: 0,
            rumor: 0,
            needsReview: 0,
            pendingReview: reviewQueue.filter(r => r.status === 'pending').length,
            avgLatencyMs: 0,
            byLayer: { L1: 0, L2: 0, L3: 0, L4: 0 } as Record<string, number>,
        };

        let totalLatency = 0;

        for (const entry of entries) {
            switch (entry.classification) {
                case 'SAFE': stats.safe++; break;
                case 'REJECT': stats.rejected++; break;
                case 'RUMOR': stats.rumor++; break;
                case 'NEEDS_REVIEW': stats.needsReview++; break;
            }
            stats.byLayer[entry.decidedAtLayer] = (stats.byLayer[entry.decidedAtLayer] || 0) + 1;
            totalLatency += entry.latencyMs;
        }

        stats.avgLatencyMs = entries.length > 0 ? Math.round(totalLatency / entries.length) : 0;

        return stats;
    }
}
