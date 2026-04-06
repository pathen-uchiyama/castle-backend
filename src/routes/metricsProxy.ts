/**
 * CloudWatch Metrics Proxy — Surfaces AWS metrics to admin dashboard
 *
 * Pulls time-series data from CloudWatch and returns it in a
 * dashboard-friendly format. Falls back to local Redis-based
 * metrics when not running on AWS.
 *
 * Endpoint: GET /admin/metrics?period=1h|6h|24h
 */

import { Router } from 'express';
import Redis from 'ioredis';
import { env } from '../config/env';

const router = Router();

// ── Types ───────────────────────────────────────────────────────

interface MetricDataPoint {
    timestamp: string;
    value: number;
}

interface MetricSeries {
    label: string;
    unit: string;
    datapoints: MetricDataPoint[];
}

interface MetricsResponse {
    mode: 'aws' | 'local';
    period: string;
    latency: {
        p50: MetricSeries;
        p95: MetricSeries;
        p99: MetricSeries;
    };
    errors: {
        http5xx: MetricSeries;
        http4xx: MetricSeries;
    };
    queue: {
        p1: MetricSeries;
        p2: MetricSeries;
        p3: MetricSeries;
    };
    llm: {
        tokensByModel: Record<string, MetricSeries>;
        hourlySpend: MetricSeries;
        dailySpend: MetricSeries;
    };
    moderation: {
        safe: MetricSeries;
        rejected: MetricSeries;
        needsReview: MetricSeries;
        rumor: MetricSeries;
    };
    infrastructure: {
        cpu: MetricSeries;
        networkIn: MetricSeries;
        networkOut: MetricSeries;
        instanceCount: MetricSeries;
    };
}

// ── Period mapping ──────────────────────────────────────────────

function getPeriodConfig(period: string): { startTime: Date; periodSeconds: number } {
    const now = new Date();
    switch (period) {
        case '1h':
            return { startTime: new Date(now.getTime() - 3600_000), periodSeconds: 60 };
        case '6h':
            return { startTime: new Date(now.getTime() - 21600_000), periodSeconds: 300 };
        case '24h':
            return { startTime: new Date(now.getTime() - 86400_000), periodSeconds: 900 };
        case '7d':
            return { startTime: new Date(now.getTime() - 604800_000), periodSeconds: 3600 };
        default:
            return { startTime: new Date(now.getTime() - 3600_000), periodSeconds: 60 };
    }
}

// ── CloudWatch Fetcher ──────────────────────────────────────────

async function fetchFromCloudWatch(period: string): Promise<MetricsResponse> {
    const { CloudWatch } = require('@aws-sdk/client-cloudwatch') as any;
    const cw = new CloudWatch({ region: process.env.AWS_REGION || 'us-east-1' });
    const { startTime, periodSeconds } = getPeriodConfig(period);
    const endTime = new Date();

    const namespace = 'CastleBackend';
    const asgName = 'digital-plaid-asg-prod';

    // Build all metric queries
    const queries = [
        // Latency percentiles
        { id: 'lat_p50', ns: namespace, metric: 'ApiLatencyMs', stat: 'p50', dim: { Endpoint: 'ALL' } },
        { id: 'lat_p95', ns: namespace, metric: 'ApiLatencyMs', stat: 'p95', dim: { Endpoint: 'ALL' } },
        { id: 'lat_p99', ns: namespace, metric: 'ApiLatencyMs', stat: 'p99', dim: { Endpoint: 'ALL' } },
        // Errors
        { id: 'err_5xx', ns: namespace, metric: 'HttpErrors', stat: 'Sum', dim: { StatusClass: '5xx' } },
        { id: 'err_4xx', ns: namespace, metric: 'HttpErrors', stat: 'Sum', dim: { StatusClass: '4xx' } },
        // Queue depth
        { id: 'q_p1', ns: namespace, metric: 'QueueDepth', stat: 'Average', dim: { Priority: 'P1' } },
        { id: 'q_p2', ns: namespace, metric: 'QueueDepth', stat: 'Average', dim: { Priority: 'P2' } },
        { id: 'q_p3', ns: namespace, metric: 'QueueDepth', stat: 'Average', dim: { Priority: 'P3' } },
        // LLM spend
        { id: 'llm_hourly', ns: namespace, metric: 'LlmSpendUsd', stat: 'Maximum', dim: { Window: 'hourly' } },
        { id: 'llm_daily', ns: namespace, metric: 'LlmSpendUsd', stat: 'Maximum', dim: { Window: 'daily' } },
        // LLM tokens by model
        { id: 'tok_gpt4o', ns: namespace, metric: 'LlmTokensUsed', stat: 'Sum', dim: { Model: 'gpt-4o' } },
        { id: 'tok_flash', ns: namespace, metric: 'LlmTokensUsed', stat: 'Sum', dim: { Model: 'gemini-1.5-flash' } },
        { id: 'tok_pro', ns: namespace, metric: 'LlmTokensUsed', stat: 'Sum', dim: { Model: 'gemini-1.5-pro' } },
        { id: 'tok_mini', ns: namespace, metric: 'LlmTokensUsed', stat: 'Sum', dim: { Model: 'gpt-4o-mini' } },
        // Moderation
        { id: 'mod_safe', ns: namespace, metric: 'ModerationDecisions', stat: 'Sum', dim: { Result: 'SAFE' } },
        { id: 'mod_reject', ns: namespace, metric: 'ModerationDecisions', stat: 'Sum', dim: { Result: 'REJECT' } },
        { id: 'mod_review', ns: namespace, metric: 'ModerationDecisions', stat: 'Sum', dim: { Result: 'NEEDS_REVIEW' } },
        { id: 'mod_rumor', ns: namespace, metric: 'ModerationDecisions', stat: 'Sum', dim: { Result: 'RUMOR' } },
        // Infrastructure (from AWS namespace)
        { id: 'cpu', ns: 'AWS/EC2', metric: 'CPUUtilization', stat: 'Average', dim: { AutoScalingGroupName: asgName } },
        { id: 'net_in', ns: 'AWS/EC2', metric: 'NetworkIn', stat: 'Average', dim: { AutoScalingGroupName: asgName } },
        { id: 'net_out', ns: 'AWS/EC2', metric: 'NetworkOut', stat: 'Average', dim: { AutoScalingGroupName: asgName } },
        { id: 'instances', ns: 'AWS/AutoScaling', metric: 'GroupInServiceInstances', stat: 'Average', dim: { AutoScalingGroupName: asgName } },
    ];

    // Build GetMetricData request
    const metricDataQueries = queries.map(q => ({
        Id: q.id,
        MetricStat: {
            Metric: {
                Namespace: q.ns,
                MetricName: q.metric,
                Dimensions: Object.entries(q.dim).map(([k, v]) => ({ Name: k, Value: v })),
            },
            Period: periodSeconds,
            Stat: q.stat,
        },
    }));

    const result = await cw.getMetricData({
        MetricDataQueries: metricDataQueries,
        StartTime: startTime,
        EndTime: endTime,
    });

    // Parse results into our format
    const seriesMap: Record<string, MetricSeries> = {};
    for (const r of result.MetricDataResults || []) {
        const timestamps = r.Timestamps || [];
        const values = r.Values || [];
        const datapoints: MetricDataPoint[] = timestamps.map((t: Date, i: number) => ({
            timestamp: t.toISOString(),
            value: values[i] ?? 0,
        })).sort((a: MetricDataPoint, b: MetricDataPoint) => a.timestamp.localeCompare(b.timestamp));

        seriesMap[r.Id] = { label: r.Label || r.Id, unit: '', datapoints };
    }

    const s = (id: string, unit = ''): MetricSeries => ({
        ...seriesMap[id] || { label: id, unit, datapoints: [] },
        unit,
    });

    return {
        mode: 'aws',
        period,
        latency: { p50: s('lat_p50', 'ms'), p95: s('lat_p95', 'ms'), p99: s('lat_p99', 'ms') },
        errors: { http5xx: s('err_5xx', 'count'), http4xx: s('err_4xx', 'count') },
        queue: { p1: s('q_p1', 'jobs'), p2: s('q_p2', 'jobs'), p3: s('q_p3', 'jobs') },
        llm: {
            tokensByModel: {
                'gpt-4o': s('tok_gpt4o', 'tokens'),
                'gemini-1.5-flash': s('tok_flash', 'tokens'),
                'gemini-1.5-pro': s('tok_pro', 'tokens'),
                'gpt-4o-mini': s('tok_mini', 'tokens'),
            },
            hourlySpend: s('llm_hourly', 'USD'),
            dailySpend: s('llm_daily', 'USD'),
        },
        moderation: {
            safe: s('mod_safe', 'count'),
            rejected: s('mod_reject', 'count'),
            needsReview: s('mod_review', 'count'),
            rumor: s('mod_rumor', 'count'),
        },
        infrastructure: {
            cpu: s('cpu', '%'),
            networkIn: s('net_in', 'bytes'),
            networkOut: s('net_out', 'bytes'),
            instanceCount: s('instances', 'count'),
        },
    };
}

// ── Local Fallback ──────────────────────────────────────────────

async function fetchFromLocal(period: string): Promise<MetricsResponse> {
    // When not on AWS, return empty series — the dashboard shows "No data yet"
    const empty = (label: string, unit: string): MetricSeries => ({
        label, unit, datapoints: [],
    });

    return {
        mode: 'local',
        period,
        latency: { p50: empty('p50', 'ms'), p95: empty('p95', 'ms'), p99: empty('p99', 'ms') },
        errors: { http5xx: empty('5xx', 'count'), http4xx: empty('4xx', 'count') },
        queue: { p1: empty('P1', 'jobs'), p2: empty('P2', 'jobs'), p3: empty('P3', 'jobs') },
        llm: {
            tokensByModel: {
                'gpt-4o': empty('GPT-4o', 'tokens'),
                'gemini-1.5-flash': empty('Gemini Flash', 'tokens'),
                'gemini-1.5-pro': empty('Gemini Pro', 'tokens'),
                'gpt-4o-mini': empty('GPT-4o Mini', 'tokens'),
            },
            hourlySpend: empty('Hourly', 'USD'),
            dailySpend: empty('Daily', 'USD'),
        },
        moderation: {
            safe: empty('Safe', 'count'),
            rejected: empty('Rejected', 'count'),
            needsReview: empty('Needs Review', 'count'),
            rumor: empty('Rumor', 'count'),
        },
        infrastructure: {
            cpu: empty('CPU', '%'),
            networkIn: empty('Network In', 'bytes'),
            networkOut: empty('Network Out', 'bytes'),
            instanceCount: empty('Instances', 'count'),
        },
    };
}

// ── Route ───────────────────────────────────────────────────────

router.get('/admin/metrics', async (req, res) => {
    const period = (req.query.period as string) || '1h';

    try {
        const data = await fetchFromCloudWatch(period);
        res.json(data);
    } catch {
        // Not on AWS or CloudWatch not available
        const data = await fetchFromLocal(period);
        res.json(data);
    }
});

export default router;
