/**
 * MCP Tool Registrar — Log Analysis tools
 * analyze_errors, get_log_patterns, get_log_stats
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AnypointClient } from '../../client/AnypointClient.js';
import { analyzeLogs } from '../../analysis/LogAnalyzer.js';
import type { ErrorWithContext, EnrichedLogEntry } from '../../analysis/LogAnalyzer.js';
import { mcpError } from './shared.js';

/**
 * Format an ErrorWithContext into a readable string for the LLM.
 */
function formatErrorContext(ctx: ErrorWithContext): string {
    const lines: string[] = [];

    if (ctx.correlationId) {
        lines.push(`── Correlation: ${ctx.correlationId} ──`);
    }
    if (ctx.flowTrace.length > 0) {
        lines.push(`Flow path: ${ctx.flowTrace.join(' → ')}`);
    }

    if (ctx.before.length > 0) {
        lines.push('─── Before ───');
        for (const e of ctx.before) {
            lines.push(formatEntry(e));
        }
    }

    lines.push('─── Error ───');
    lines.push(formatEntry(ctx.error));
    if (ctx.error.stackTrace) {
        lines.push(ctx.error.stackTrace);
    }

    if (ctx.after.length > 0) {
        lines.push('─── After ───');
        for (const e of ctx.after) {
            lines.push(formatEntry(e));
        }
    }

    return lines.join('\n');
}

function formatEntry(e: EnrichedLogEntry): string {
    const ts = new Date(e.timestamp).toISOString().split('T')[1].replace('Z', '');
    const flow = e.flowName ? ` [${e.flowName}]` : '';
    const elapsed = e.elapsed !== undefined ? ` (${e.elapsed}ms)` : '';
    return `  ${ts} ${e.priority.padEnd(5)} ${e.message || ''}${flow}${elapsed}`;
}

export function registerAnalysisTools(server: McpServer, client: AnypointClient) {
    // ── analyze_errors ───────────────────────────────────

    server.registerTool(
        'analyze_errors',
        {
            title: 'Analyze Application Errors',
            description:
                'Analyzes error patterns in a Mule application\'s logs. Groups similar errors, shows occurrence counts, affected flows, and provides full context (what happened before and after each error). Use this to diagnose why an app is failing — it shows the causal chain leading to each error type.',
            inputSchema: {
                appName: z.string().describe('Application name exactly as deployed'),
                environment: z.string().describe('Environment name or ID'),
                hoursBack: z
                    .number()
                    .optional()
                    .describe('How many hours of logs to analyze (default: all available)'),
                limit: z
                    .number()
                    .optional()
                    .describe('Maximum number of error groups to return (default: 10)'),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ appName, environment, hoursBack, limit }) => {
            try {
                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, environment);
                const rawText = await client.logs.getRawText(orgId, env.id, appName);

                const result = analyzeLogs(rawText, {
                    hoursBack,
                    maxErrorGroups: limit || 10,
                });

                if (result.errorGroups.length === 0) {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: `No errors found in ${appName} logs${hoursBack ? ` for the last ${hoursBack} hours` : ''}.`,
                            },
                        ],
                    };
                }

                const sections: string[] = [];
                sections.push(
                    `## Error Analysis for ${appName} in ${env.name}`,
                    `Total: ${result.stats.byLevel['ERROR'] || 0} errors (${result.stats.errorRate}% error rate)`,
                    `Time range: ${result.stats.timeRange.start} → ${result.stats.timeRange.end}`,
                    '',
                );

                for (const group of result.errorGroups) {
                    sections.push(
                        `### ${group.errorType} — ${group.count} occurrences`,
                        `Pattern: ${group.template}`,
                        `First: ${group.firstSeen} | Last: ${group.lastSeen}`,
                        `Affected flows: ${group.affectedFlows.join(', ') || 'unknown'}`,
                        '',
                    );

                    for (let i = 0; i < group.samples.length; i++) {
                        sections.push(`**Sample ${i + 1}:**`);
                        sections.push(formatErrorContext(group.samples[i]));
                        sections.push('');
                    }
                }

                return {
                    content: [{ type: 'text', text: sections.join('\n') }],
                };
            } catch (error) {
                return mcpError(error);
            }
        },
    );

    // ── get_log_patterns ─────────────────────────────────

    server.registerTool(
        'get_log_patterns',
        {
            title: 'Get Log Message Patterns',
            description:
                'Identifies the most common recurring log message patterns in an application. Shows what the app is doing at a glance — which flows are active, how often certain operations run, and what percentage of log volume each pattern accounts for. HTTP listener noise is filtered out.',
            inputSchema: {
                appName: z.string().describe('Application name exactly as deployed'),
                environment: z.string().describe('Environment name or ID'),
                hoursBack: z
                    .number()
                    .optional()
                    .describe('How many hours of logs to analyze (default: all available)'),
                topN: z.number().optional().describe('Number of top patterns to return (default: 15)'),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ appName, environment, hoursBack, topN }) => {
            try {
                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, environment);
                const rawText = await client.logs.getRawText(orgId, env.id, appName);

                const result = analyzeLogs(rawText, {
                    hoursBack,
                    maxPatterns: topN || 15,
                });

                const lines: string[] = [
                    `## Log Patterns for ${appName} in ${env.name}`,
                    `${result.stats.totalEntries} entries analyzed (${result.stats.noisePercentage}% HTTP noise filtered)`,
                    '',
                    '| # | Level | Count | % | Pattern |',
                    '|---|-------|-------|---|---------|',
                ];

                result.patterns.forEach((p, i) => {
                    lines.push(`| ${i + 1} | ${p.level} | ${p.count} | ${p.percentage}% | ${p.template} |`);
                });

                return {
                    content: [{ type: 'text', text: lines.join('\n') }],
                };
            } catch (error) {
                return mcpError(error);
            }
        },
    );

    // ── get_log_stats ────────────────────────────────────

    server.registerTool(
        'get_log_stats',
        {
            title: 'Get Log Statistics',
            description:
                'Returns a statistical health summary of an application\'s logs: level distribution, error rate, error spikes (time windows with elevated errors), noise percentage, and unique transaction count. Use this for quick health checks without reading individual log lines.',
            inputSchema: {
                appName: z.string().describe('Application name exactly as deployed'),
                environment: z.string().describe('Environment name or ID'),
                hoursBack: z
                    .number()
                    .optional()
                    .describe('How many hours of logs to analyze (default: all available)'),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ appName, environment, hoursBack }) => {
            try {
                const orgId = await client.getDefaultOrgId();
                const env = await client.accessManagement.resolveEnvironment(orgId, environment);
                const rawText = await client.logs.getRawText(orgId, env.id, appName);

                const result = analyzeLogs(rawText, { hoursBack });
                const s = result.stats;

                const lines: string[] = [
                    `## Log Stats for ${appName} in ${env.name}`,
                    '',
                    `**Volume:** ${s.totalEntries} entries from ${s.totalLines} raw lines`,
                    `**Time range:** ${s.timeRange.start} → ${s.timeRange.end}`,
                    `**Noise:** ${s.noisePercentage}% HTTP listener DEBUG traffic`,
                    `**Unique transactions:** ${s.uniqueCorrelationIds}`,
                    '',
                    '### Level Distribution',
                    ...Object.entries(s.byLevel)
                        .sort((a, b) => b[1] - a[1])
                        .map(([level, count]) => `- **${level}**: ${count} (${((count / s.totalEntries) * 100).toFixed(1)}%)`),
                    '',
                    `**Error rate:** ${s.errorRate}%`,
                ];

                if (s.errorSpikes.length > 0) {
                    lines.push('', '### Error Spikes (above-average windows)');
                    for (const spike of s.errorSpikes) {
                        lines.push(`- ${spike.window}: ${spike.count} errors (${spike.rate}% rate)`);
                    }
                }

                if (s.topErrors.length > 0) {
                    lines.push('', '### Top Error Types');
                    for (const eg of s.topErrors.slice(0, 5)) {
                        lines.push(`- **${eg.errorType}**: ${eg.count}× — ${eg.template}`);
                    }
                }

                return {
                    content: [{ type: 'text', text: lines.join('\n') }],
                };
            } catch (error) {
                return mcpError(error);
            }
        },
    );
}
