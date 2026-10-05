/**
 * MCP Tool Registrar — Monitoring tools
 * get_metrics, get_runtime_metrics, get_metrics_timeseries, raw_amql_query
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AnypointClient } from '../../client/AnypointClient.js';
import { AMQL_MAX_LIMIT, GRANULARITIES, TIME_SERIES_SIGNALS } from '../../api/MonitoringApi.js';
import { mcpError, mcpText, resolveEnvironment, timeWindow } from './shared.js';

const hoursBackSchema = z
    .number()
    .positive()
    .optional()
    .describe('Time window in hours ending now (default: 24). Use 1 for recent activity, 168 for weekly trends.');

const appNameSchema = z.string().optional().describe('Limit to one application name. Omit for every app.');

export function registerMonitoringTools(server: McpServer, client: AnypointClient) {
    server.registerTool(
        'get_metrics',
        {
            title: 'Get Traffic Metrics',
            description:
                'Traffic, latency and failures from Anypoint Monitoring. Per app (default), per worker/replica, or per HTTP route: inbound request count, failed count and failure rate, average/min/max and p50/p75/p90/p95/p99 response time (ms), outbound call count/failures/average, and Mule message count/errors. Omit `environment` to compare every environment side by side. Use groupBy "worker" to spot an unhealthy or overloaded replica, and "route" to find which inbound or outbound route is failing.',
            inputSchema: {
                environment: z
                    .string()
                    .optional()
                    .describe('Environment name or ID. Omit to compare every environment.'),
                hoursBack: hoursBackSchema,
                appName: appNameSchema,
                groupBy: z.enum(['app', 'worker', 'route']).optional().describe('Row grouping (default: "app").'),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ environment, hoursBack, appName, groupBy = 'app' }) => {
            try {
                const { from, to, period } = timeWindow(hoursBack);
                const resolved = environment ? await resolveEnvironment(client, environment) : undefined;
                const orgId = resolved?.orgId ?? (await client.getDefaultOrgId());
                const scope = { orgId, envId: resolved?.env.id, from, to, appName };

                if (groupBy === 'route') {
                    return mcpText({
                        environment: resolved?.env.name ?? 'all',
                        period,
                        routes: await client.monitoring.getRouteMetrics(scope),
                    });
                }
                return mcpText({
                    environment: resolved?.env.name ?? 'all',
                    period,
                    groupBy,
                    rows: await client.monitoring.getMetrics(scope, groupBy),
                });
            } catch (error) {
                return mcpError(error);
            }
        },
    );

    server.registerTool(
        'get_runtime_metrics',
        {
            title: 'Get Runtime (JVM and Host) Metrics',
            description:
                'JVM and host health per worker/replica: total heap used (avg/peak) and committed; the old-generation pool with its limit and peak-to-limit ratio (the memory-pressure and leak signal); metaspace; old-generation GC collections and GC time inside the window; CPU count and physical RAM; system and process CPU load (avg/max); and average free physical memory. Memory sizes are bytes, CPU loads are 0–1 fractions, GC time is milliseconds.',
            inputSchema: {
                environment: z.string().describe('Environment name or ID'),
                hoursBack: hoursBackSchema,
                appName: appNameSchema,
            },
            annotations: { readOnlyHint: true },
        },
        async ({ environment, hoursBack, appName }) => {
            try {
                const { orgId, env } = await resolveEnvironment(client, environment);
                const { from, to, period } = timeWindow(hoursBack);
                return mcpText({
                    environment: env.name,
                    period,
                    workers: await client.monitoring.getRuntimeMetrics({ orgId, envId: env.id, from, to, appName }),
                });
            } catch (error) {
                return mcpError(error);
            }
        },
    );

    server.registerTool(
        'get_metrics_timeseries',
        {
            title: 'Get Metrics Time Series',
            description:
                'Bucketed metrics for trend and incident analysis. Signals: "traffic" (requests, failed, avg and p95 latency per app), "latency" (p50/p75/p90/p95/p99 per app), "memory" (heap, old-generation and metaspace bytes per worker), "cpu" (system/process CPU load and free physical memory per worker), "gc" (collections and GC milliseconds per bucket per worker, old-generation split out). Use "1m" or "5m" buckets for incident windows of a few hours and "1h"/"1d" for multi-day trends such as a rising old-generation baseline.',
            inputSchema: {
                environment: z.string().describe('Environment name or ID'),
                signal: z.enum(TIME_SERIES_SIGNALS as [string, ...string[]]).describe('Which signal to chart'),
                hoursBack: hoursBackSchema,
                granularity: z
                    .enum(GRANULARITIES as [string, ...string[]])
                    .optional()
                    .describe('Bucket size (default: "1h").'),
                appName: appNameSchema,
            },
            annotations: { readOnlyHint: true },
        },
        async ({ environment, signal, hoursBack, granularity = '1h', appName }) => {
            try {
                const { orgId, env } = await resolveEnvironment(client, environment);
                const { from, to, period } = timeWindow(hoursBack);
                const points = await client.monitoring.getTimeSeries(
                    { orgId, envId: env.id, from, to, appName },
                    signal as (typeof TIME_SERIES_SIGNALS)[number],
                    granularity as (typeof GRANULARITIES)[number],
                );
                return mcpText({ environment: env.name, period, signal, granularity, points });
            } catch (error) {
                return mcpError(error);
            }
        },
    );

    server.registerTool(
        'raw_amql_query',
        {
            title: 'Execute Raw AMQL Query',
            description: `Runs a freeform AMQL query against Anypoint Monitoring when the other metric tools do not answer the question. Platform errors are returned as-is (they name the bad token or attribute). Always filter on "sub_org.id" and a "timestamp BETWEEN <fromMs> AND <toMs>" range; add "env.id" and "app.name" as needed.
Datasources:
- "mulesoft.app.inbound" / "mulesoft.app.outbound": requests, response_time, "response.status" ('FAILED'), "http.route" (outbound), "worker.id", "app.name", "env.name"
- "mulesoft.message": total_count, error_count
- "mulesoft.app.jvm.memory": usage, committed, init, "limit" (quote it; -1 = unbounded), "type" (heap|off-heap), "pool" (total-heap, tenured_gen, eden_space, survivor_space, metaspace, …)
- "mulesoft.app.jvm.gc": count and duration (ms) are CUMULATIVE per worker — use MAX − MIN, never SUM; filter or group by name (collector)
- "mulesoft.app.jvm.cpu": available_processors, total_physical_memory_size
- "mulesoft.app.memory": system_cpu_load, process_cpu_load, free_physical_memory_size (AVG only — MIN/MAX on memory sizes fail server-side)
- "mulesoft.entity": entity-level view keyed by "entity.id"/"entity.name" (no "app.name")
Syntax: COUNT, SUM, AVG, MIN, MAX, PERCENTILE(field, 0.95), LATEST(field), GROUP BY, ORDER BY, TIMESERIES PT1M|PT5M|PT15M|PT30M|PT1H|P1D. SELECT * is not supported; single-letter aliases such as h, d, t are reserved; escape quotes in string literals by doubling them. An in-query LIMIT is ignored — use the limit argument.`,
            inputSchema: {
                query: z.string().describe('AMQL query string'),
                limit: z
                    .number()
                    .int()
                    .positive()
                    .max(AMQL_MAX_LIMIT)
                    .optional()
                    .describe(`Rows per page (default: 200, max: ${AMQL_MAX_LIMIT})`),
                offset: z.number().int().min(0).optional().describe('Row offset for paging (default: 0)'),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ query, limit, offset }) => {
            try {
                const data = await client.monitoring.search(query, { limit: limit ?? 200, offset });
                return mcpText({ rowCount: data.length, data });
            } catch (error) {
                return mcpError(error);
            }
        },
    );
}
