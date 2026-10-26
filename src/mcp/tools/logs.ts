/**
 * MCP Tool Registrar - Log tools
 * get_logs, download_logs, and the log fetch shared with the analysis tools
 */

import * as fs from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AnypointClient } from '../../client/AnypointClient.js';
import type { Environment } from '../../api/AccessManagementApi.js';
import type { LogSource } from '../../api/LogsApi.js';
import type { EnrichedLogEntry } from '../../analysis/types.js';
import { parseRawLogs } from '../../analysis/parser.js';
import { buildFilter, MAX_LOG_LINES, searchEntries } from '../../analysis/filter.js';
import { formatEntries, summarizeEntries } from '../../analysis/summary.js';
import { BUCKETS, type Bucket } from '../../analysis/stats.js';
import { resolveWritablePath } from '../../safety/paths.js';
import { mcpError, mcpText, resolveEnvironment } from './shared.js';

/** Default and largest `maxLines` for download_logs. */
export const DOWNLOAD_DEFAULT_LINES = 2000;
export const DOWNLOAD_MAX_LINES = 20000;

export interface FetchedLogs {
    orgId: string;
    env: Environment;
    text: string;
    source: LogSource;
}

/**
 * Resolve the environment and the app's log file in one place, for every log and analysis tool.
 * Reads the desired spec's file, or the last successful spec's when the desired one is still empty.
 */
export async function fetchLogText(client: AnypointClient, appName: string, environment: string): Promise<FetchedLogs> {
    const { orgId, env } = await resolveEnvironment(client, environment);
    const { text, ...source } = await client.logs.getLogFile(orgId, env.id, appName);
    return { orgId, env, text, source };
}

/** A note for responses read from the fallback spec, or undefined. */
export function sourceNotice(source: LogSource): string | undefined {
    if (!source.fallbackFromSpecId) return undefined;
    return `The current spec ${source.fallbackFromSpecId} has no log lines yet (the app was just changed or started), so these are the logs of the last successful spec ${source.specId}. Retry in a few minutes for the new replicas.`;
}

export interface LogWindowInput {
    hoursBack?: number;
    startTime?: string;
    endTime?: string;
}

/** Turn hoursBack or startTime/endTime into an epoch window plus ISO strings for the response. */
export function logWindow(
    input: LogWindowInput,
    defaultHours?: number,
): { startTime?: number; endTime?: number; period?: { from: string; to: string } } {
    if (input.hoursBack !== undefined && (input.startTime || input.endTime)) {
        throw new Error('Pass hoursBack or startTime/endTime, not both');
    }
    const parse = (value: string, name: string) => {
        const ms = Date.parse(value);
        if (Number.isNaN(ms)) throw new Error(`${name} is not an ISO 8601 date: ${value}`);
        return ms;
    };
    if (input.startTime || input.endTime) {
        const startTime = input.startTime ? parse(input.startTime, 'startTime') : undefined;
        const endTime = input.endTime ? parse(input.endTime, 'endTime') : undefined;
        if (startTime !== undefined && endTime !== undefined && startTime > endTime) {
            throw new Error('startTime is after endTime');
        }
        return {
            startTime,
            endTime,
            period: {
                from: startTime !== undefined ? new Date(startTime).toISOString() : 'start of log',
                to: endTime !== undefined ? new Date(endTime).toISOString() : 'now',
            },
        };
    }
    const hours = input.hoursBack ?? defaultHours;
    if (hours === undefined) return {};
    const now = Date.now();
    const startTime = now - hours * 60 * 60 * 1000;
    return { startTime, period: { from: new Date(startTime).toISOString(), to: new Date(now).toISOString() } };
}

/** Inputs shared by every tool that filters log entries. */
export const logFilterInputs = {
    level: z
        .string()
        .optional()
        .describe('Minimum log level: TRACE, DEBUG, INFO, WARN, ERROR or FATAL. Entries at or above it are kept.'),
    search: z
        .string()
        .optional()
        .describe(
            'Text to find, case-insensitive. Matches the message, logger, thread, event ID, stack trace and JSON Logger payload of each entry, including its continuation lines.',
        ),
    regex: z.boolean().optional().describe('Treat search as a case-insensitive JavaScript regular expression'),
    logger: z.string().optional().describe('Only entries whose logger name contains this text (case-insensitive)'),
};

/** Inputs for a time window: a look-back in hours, or explicit ISO bounds. */
export const logWindowInputs = {
    hoursBack: z.number().positive().optional().describe('Only entries from the last N hours'),
    startTime: z
        .string()
        .optional()
        .describe('Only entries at or after this ISO 8601 time. Do not combine with hoursBack.'),
    endTime: z
        .string()
        .optional()
        .describe('Only entries at or before this ISO 8601 time. Do not combine with hoursBack.'),
};

function entryView(e: EnrichedLogEntry) {
    return {
        timestamp: new Date(e.timestamp).toISOString(),
        level: e.priority,
        ...(e.loggerName ? { logger: e.loggerName } : {}),
        ...(e.instanceId ? { replica: e.instanceId } : {}),
        ...(e.correlationId ? { correlationId: e.correlationId } : {}),
        message: e.message,
        ...(e.stackTrace ? { stackTrace: e.stackTrace } : {}),
    };
}

/** Write text to a file inside the project root, refusing to replace a file unless asked. */
function writeOutput(file: string, content: string, overwrite?: boolean): string {
    const target = resolveWritablePath(file, { overwrite });
    fs.writeFileSync(target, content, { encoding: 'utf-8', mode: 0o600, flag: overwrite ? 'w' : 'wx' });
    return target;
}

export function registerLogTools(server: McpServer, client: AnypointClient) {
    server.registerTool(
        'get_logs',
        {
            title: 'Get Application Logs',
            description: `Fetches the most recent log entries of a Mule application, newest first. Multi-line entries (stack traces, error reports, JSON Logger bodies) are returned whole, with the timestamp and level of the line that starts them. Returns total (all matches), returned and truncated, so a cut result is visible. Filter by level, logger, text or regex, and time window. Right after a start or change, logs come from the last successful spec until the new one has lines, and the response says so. For summaries or large exports, use download_logs.`,
            inputSchema: {
                appName: z.string().describe('Application name exactly as deployed'),
                environment: z.string().describe('Environment name or ID'),
                lines: z
                    .number()
                    .int()
                    .min(1)
                    .max(MAX_LOG_LINES)
                    .optional()
                    .describe(`Number of most recent matching entries to return (default: 100, max: ${MAX_LOG_LINES})`),
                ...logFilterInputs,
                ...logWindowInputs,
            },
            annotations: { readOnlyHint: true },
        },
        async ({ appName, environment, lines, level, search, regex, logger, hoursBack, startTime, endTime }) => {
            try {
                const window = logWindow({ hoursBack, startTime, endTime });
                const { text, source } = await fetchLogText(client, appName, environment);
                const result = searchEntries(parseRawLogs(text), {
                    limit: lines ?? 100,
                    level,
                    search,
                    regex,
                    logger,
                    startTime: window.startTime,
                    endTime: window.endTime,
                });
                const notice = sourceNotice(source);

                return mcpText({
                    total: result.total,
                    returned: result.returned,
                    truncated: result.truncated,
                    ...(window.period ? { period: window.period } : {}),
                    specId: source.specId,
                    ...(notice ? { notice } : {}),
                    entries: result.entries.map(entryView),
                });
            } catch (error) {
                return mcpError(error);
            }
        },
    );

    server.registerTool(
        'download_logs',
        {
            title: 'Download Logs for Time Range',
            description: `Reads the full application log file for a time window and filters it by level, logger, text or regex. mode "lines" (default) returns matching entries oldest first as text (timestamp [LEVEL] logger - message, plus stack traces), keeping the newest maxLines entries with a truncation notice that gives the total. mode "summary" returns counts by level, by logger and by time bucket, and the top message templates, instead of lines. outputFile writes the full filtered result (every line, or the summary JSON) to a file inside the project root and returns only the path and counts. For a quick look at recent lines, use get_logs.`,
            inputSchema: {
                appName: z.string().describe('Application name exactly as deployed'),
                environment: z.string().describe('Environment name or ID'),
                hoursBack: z
                    .number()
                    .positive()
                    .optional()
                    .describe(
                        'How many hours of logs to read (default 24; e.g. 1 for the last hour, 168 for the last week)',
                    ),
                startTime: logWindowInputs.startTime,
                endTime: logWindowInputs.endTime,
                ...logFilterInputs,
                mode: z
                    .enum(['lines', 'summary'])
                    .optional()
                    .describe('lines (default): the log text. summary: counts and top message templates only.'),
                bucket: z
                    .enum(Object.keys(BUCKETS) as [Bucket, ...Bucket[]])
                    .optional()
                    .describe('Time bucket for the summary histogram: 5m, 15m or 1h (default 1h)'),
                maxLines: z
                    .number()
                    .int()
                    .min(1)
                    .max(DOWNLOAD_MAX_LINES)
                    .optional()
                    .describe(
                        `Most entries returned in lines mode (default ${DOWNLOAD_DEFAULT_LINES}, max ${DOWNLOAD_MAX_LINES}). The newest are kept. Ignored with outputFile, which writes every entry.`,
                    ),
                outputFile: z
                    .string()
                    .optional()
                    .describe(
                        'Write the full filtered result to this file, relative to the project root (must stay inside it). The response then holds only the path and counts.',
                    ),
                overwrite: z.boolean().optional().describe('Replace outputFile if it already exists'),
            },
            // Not read-only: outputFile writes a local file. It never changes the platform.
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
        },
        async (input) => {
            try {
                const window = logWindow(input, 24);
                // Validate the filter before the download, so a bad regex fails fast.
                const keep = buildFilter({ ...input, startTime: window.startTime, endTime: window.endTime });
                if (input.outputFile) resolveWritablePath(input.outputFile, { overwrite: input.overwrite });

                const { env, text, source } = await fetchLogText(client, input.appName, input.environment);
                const entries = parseRawLogs(text).filter(keep);
                const notice = sourceNotice(source);
                const context = {
                    app: input.appName,
                    environment: env.name,
                    period: window.period,
                    specId: source.specId,
                    ...(notice ? { notice } : {}),
                };

                if (input.mode === 'summary') {
                    const summary = { ...context, ...summarizeEntries(entries, { bucket: input.bucket }) };
                    if (input.outputFile) {
                        const content = JSON.stringify(summary, null, 2);
                        const path = writeOutput(input.outputFile, content, input.overwrite);
                        return mcpText({ ...context, mode: 'summary', outputFile: path, matched: entries.length });
                    }
                    return mcpText(summary);
                }

                if (input.outputFile) {
                    const content = formatEntries(entries);
                    const path = writeOutput(input.outputFile, content ? content + '\n' : '', input.overwrite);
                    return mcpText({
                        ...context,
                        mode: 'lines',
                        outputFile: path,
                        matched: entries.length,
                        bytes: Buffer.byteLength(content),
                    });
                }

                if (entries.length === 0) {
                    return mcpText(
                        [notice, 'No log entries found for the specified period.'].filter(Boolean).join('\n'),
                    );
                }

                const maxLines = input.maxLines ?? DOWNLOAD_DEFAULT_LINES;
                const shown = entries.slice(-maxLines);
                const header: string[] = [];
                if (notice) header.push(`[${notice}]`);
                if (shown.length < entries.length) {
                    header.push(
                        `[Truncated: showing the newest ${shown.length} of ${entries.length} matching entries. Narrow with search, level, logger or a shorter window, use mode "summary", or pass outputFile to write all of them.]`,
                    );
                }
                return mcpText([...header, formatEntries(shown)].join('\n'));
            } catch (error) {
                return mcpError(error);
            }
        },
    );
}
