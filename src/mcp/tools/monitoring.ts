/**
 * MCP Tool Registrar — Monitoring tools
 * get_metrics, get_performance_metrics, get_metrics_timeseries,
 * get_worker_metrics, compare_environments
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AnypointClient } from '../../client/AnypointClient.js';
import { mcpError } from './shared.js';

export function registerMonitoringTools(server: McpServer, client: AnypointClient) {
    server.registerTool(
        'get_metrics',
        {
            title: 'Get Application Metrics',
            description:
                'Fetches runtime performance metrics for applications in an environment using Anypoint Monitoring AMQL queries. Returns inbound request count, average response time (ms), outbound request count, and outbound average response time. Use this to identify performance bottlenecks or traffic patterns.',
            inputSchema: {
                environment: z.string().describe('Environment name or ID'),
                hoursBack: z
                    .number()
                    .optional()
                    .describe('Time window in hours (default: 24). Use 1 for recent, 168 for weekly trends.'),
                appName: z
                    .string()
                    .optional()
                    .describe('Filter to a specific application name. Omit to get metrics for all apps.'),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ environment, hoursBack, appName }) => {
            try {
                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, environment);

                const to = Date.now();
                const from = to - (hoursBack || 24) * 60 * 60 * 1000;

                const metrics = await client.monitoring.getAppMetrics(orgId, env.id, from, to, appName);

                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(
                                {
                                    environment: env.name,
                                    period: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
                                    apps: metrics,
                                },
                                null,
                                2,
                            ),
                        },
                    ],
                };
            } catch (error) {
                return mcpError(error);
            }
        },
    );

    server.registerTool(
        'get_performance_metrics',
        {
            title: 'Get Performance Metrics (Percentiles)',
            description:
                'Fetches detailed percentile-based performance metrics per application: p50, p95, p99 response times, min/max latency, and request count. Use this for SLA validation, identifying tail latency issues, and performance baselining. For basic request counts and averages, use get_metrics instead.',
            inputSchema: {
                environment: z
                    .string()
                    .describe('Environment name (e.g. "Development", "Production") or environment ID'),
                hoursBack: z
                    .number()
                    .optional()
                    .describe('Time window in hours (default: 24). Use 1 for recent, 168 for weekly trends'),
                appName: z
                    .string()
                    .optional()
                    .describe('Filter to a specific application name. Omit to get metrics for all apps'),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ environment, hoursBack, appName }) => {
            try {
                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, environment);

                const to = Date.now();
                const from = to - (hoursBack || 24) * 60 * 60 * 1000;

                const metrics = await client.monitoring.getPerformanceMetrics(orgId, env.id, from, to, appName);

                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(
                                {
                                    environment: env.name,
                                    period: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
                                    apps: metrics,
                                },
                                null,
                                2,
                            ),
                        },
                    ],
                };
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
                'Fetches time-series metrics for trending analysis. Returns timestamped buckets with request count, average response time, and p95 latency per app. Use this to spot degradation trends, traffic spikes, or correlate performance changes with deployments.',
            inputSchema: {
                environment: z
                    .string()
                    .describe('Environment name (e.g. "Development", "Production") or environment ID'),
                hoursBack: z
                    .number()
                    .optional()
                    .describe('Time window in hours (default: 24). Use 1 for recent, 168 for weekly trends'),
                granularity: z
                    .enum(['5m', '15m', '30m', '1h', '1d'])
                    .optional()
                    .describe('Time bucket size (default: "1h"). Use "5m" for short windows, "1d" for weekly'),
                appName: z
                    .string()
                    .optional()
                    .describe('Filter to a specific application name. Omit to get time series for all apps'),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ environment, hoursBack, granularity, appName }) => {
            try {
                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, environment);

                const to = Date.now();
                const from = to - (hoursBack || 24) * 60 * 60 * 1000;

                const granularityMap: Record<string, 'PT5M' | 'PT15M' | 'PT30M' | 'PT1H' | 'P1D'> = {
                    '5m': 'PT5M',
                    '15m': 'PT15M',
                    '30m': 'PT30M',
                    '1h': 'PT1H',
                    '1d': 'P1D',
                };
                const g = granularityMap[granularity || '1h'];

                const data = await client.monitoring.getTimeSeries(orgId, env.id, from, to, g, appName);

                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(
                                {
                                    environment: env.name,
                                    period: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
                                    granularity: granularity || '1h',
                                    dataPoints: data,
                                },
                                null,
                                2,
                            ),
                        },
                    ],
                };
            } catch (error) {
                return mcpError(error);
            }
        },
    );

    server.registerTool(
        'get_worker_metrics',
        {
            title: 'Get Worker/Replica Metrics',
            description:
                'Fetches per-worker (per-replica) performance metrics: request count, average response time, max latency, and p95 for each worker ID. Use this to detect unhealthy replicas, identify load imbalance between workers, or pinpoint specific instances with elevated latency.',
            inputSchema: {
                environment: z
                    .string()
                    .describe('Environment name (e.g. "Development", "Production") or environment ID'),
                hoursBack: z
                    .number()
                    .optional()
                    .describe('Time window in hours (default: 24). Use 1 for recent, 168 for weekly trends'),
                appName: z
                    .string()
                    .optional()
                    .describe('Filter to a specific application name. Omit to get worker metrics for all apps'),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ environment, hoursBack, appName }) => {
            try {
                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, environment);

                const to = Date.now();
                const from = to - (hoursBack || 24) * 60 * 60 * 1000;

                const metrics = await client.monitoring.getWorkerMetrics(orgId, env.id, from, to, appName);

                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(
                                {
                                    environment: env.name,
                                    period: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
                                    workers: metrics,
                                },
                                null,
                                2,
                            ),
                        },
                    ],
                };
            } catch (error) {
                return mcpError(error);
            }
        },
    );

    server.registerTool(
        'compare_env_performance',
        {
            title: 'Compare Environment Performance',
            description:
                'Compares application response-time performance across all environments (Development, Sandbox, Production) without requiring an environment filter. Returns per-app, per-environment metrics including request count, average response time, p95, and p99 latency. Use this to validate that staging matches production behavior, spot environment-specific degradation, or baseline performance across the org.',
            inputSchema: {
                hoursBack: z
                    .number()
                    .optional()
                    .describe('Time window in hours (default: 24). Use 1 for recent, 168 for weekly trends'),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ hoursBack }) => {
            try {
                const orgId = await client.getDefaultOrgId();

                const to = Date.now();
                const from = to - (hoursBack || 24) * 60 * 60 * 1000;

                const metrics = await client.monitoring.getCrossEnvMetrics(orgId, from, to);

                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(
                                {
                                    period: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
                                    environments: metrics,
                                },
                                null,
                                2,
                            ),
                        },
                    ],
                };
            } catch (error) {
                return mcpError(error);
            }
        },
    );

    server.registerTool(
        'get_memory_metrics',
        {
            title: 'Get JVM Memory Metrics',
            description:
                'Fetches JVM memory and infrastructure metrics per application: average heap used/committed, max heap, GC count and time, and thread count. Use this to identify memory pressure, potential leaks, or apps approaching heap limits. Queries the mulesoft.jvm datasource via AMQL.',
            inputSchema: {
                environment: z
                    .string()
                    .describe('Environment name (e.g. "Development", "Production") or environment ID'),
                hoursBack: z
                    .number()
                    .optional()
                    .describe('Time window in hours (default: 24). Use 1 for recent, 168 for weekly trends'),
                appName: z
                    .string()
                    .optional()
                    .describe('Filter to a specific application name. Omit to get memory metrics for all apps'),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ environment, hoursBack, appName }) => {
            try {
                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, environment);

                const to = Date.now();
                const from = to - (hoursBack || 24) * 60 * 60 * 1000;

                const metrics = await client.monitoring.getMemoryMetrics(orgId, env.id, from, to, appName);

                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(
                                {
                                    environment: env.name,
                                    period: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
                                    apps: metrics,
                                },
                                null,
                                2,
                            ),
                        },
                    ],
                };
            } catch (error) {
                return mcpError(error);
            }
        },
    );

    server.registerTool(
        'raw_amql_query',
        {
            title: 'Execute Raw AMQL Query',
            description:
                'Executes a freeform AMQL (Anypoint Monitoring Query Language) query against the monitoring API. Use this for ad-hoc analysis when the pre-built metric tools don\'t answer a specific question. Datasources: "mulesoft.app.inbound" (inbound requests), "mulesoft.app.outbound" (outbound calls), "mulesoft.jvm" (memory/GC/threads). Supports SELECT, COUNT, AVG, SUM, MAX, MIN, PERCENTILE, GROUP BY, TIMESERIES, WHERE with timestamp BETWEEN.',
            inputSchema: {
                query: z
                    .string()
                    .describe(
                        'AMQL query string. Example: SELECT COUNT(requests) AS "count", AVG(response_time) AS "avg_rt", "app.name" FROM "mulesoft.app.inbound" WHERE "sub_org.id" = \'<orgId>\' AND timestamp BETWEEN <from> AND <to> GROUP BY "app.name"',
                    ),
                limit: z
                    .number()
                    .optional()
                    .describe('Maximum number of data points to return (default: 200, max: 1000)'),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ query, limit }) => {
            try {
                const data = await client.monitoring.search(query, limit || 200);
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({ rowCount: data.length, data }, null, 2),
                        },
                    ],
                };
            } catch (error) {
                return mcpError(error);
            }
        },
    );

    server.registerTool(
        'get_memory_timeseries',
        {
            title: 'Get Memory Usage Time Series',
            description:
                'Fetches time-series JVM memory metrics for trending analysis. Returns timestamped buckets with average heap used, heap committed, and GC count per app. Use this to spot memory growth trends, correlate GC spikes with latency, or detect slow memory leaks over time.',
            inputSchema: {
                environment: z
                    .string()
                    .describe('Environment name (e.g. "Development", "Production") or environment ID'),
                hoursBack: z
                    .number()
                    .optional()
                    .describe('Time window in hours (default: 24). Use 1 for recent, 168 for weekly trends'),
                granularity: z
                    .enum(['5m', '15m', '30m', '1h', '1d'])
                    .optional()
                    .describe('Time bucket size (default: "1h"). Use "5m" for short windows, "1d" for weekly'),
                appName: z
                    .string()
                    .optional()
                    .describe('Filter to a specific application name. Omit to get time series for all apps'),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ environment, hoursBack, granularity, appName }) => {
            try {
                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, environment);

                const to = Date.now();
                const from = to - (hoursBack || 24) * 60 * 60 * 1000;

                const granularityMap: Record<string, 'PT5M' | 'PT15M' | 'PT30M' | 'PT1H' | 'P1D'> = {
                    '5m': 'PT5M',
                    '15m': 'PT15M',
                    '30m': 'PT30M',
                    '1h': 'PT1H',
                    '1d': 'P1D',
                };
                const g = granularityMap[granularity || '1h'];

                const data = await client.monitoring.getMemoryTimeSeries(orgId, env.id, from, to, g, appName);

                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(
                                {
                                    environment: env.name,
                                    period: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
                                    granularity: granularity || '1h',
                                    dataPoints: data,
                                },
                                null,
                                2,
                            ),
                        },
                    ],
                };
            } catch (error) {
                return mcpError(error);
            }
        },
    );
}
