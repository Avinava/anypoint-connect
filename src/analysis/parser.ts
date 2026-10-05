/**
 * Log Analysis — Parser
 * Parses raw CloudHub log text into enriched entries, joining multi-line blocks.
 * Handles: JSON Logger blocks, stack traces, HTTP dumps, continuation lines.
 */

import type { EnrichedLogEntry } from './types.js';

/**
 * Enhanced log line regex that captures:
 *  - timestamp, level, instanceId, loggerName, eventId, thread, message
 */
const LOG_LINE_REGEX =
    /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+(TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\s+\[([^\]]*)\]\s+(\S+)\s+(?:event:(\S+)\s+)?(.+?)(?:\s+-\s+(.*))?$/;

/**
 * Parse raw log text into enriched entries, joining multi-line blocks.
 */
export function parseRawLogs(rawText: string): EnrichedLogEntry[] {
    const lines = rawText.split('\n');
    const entries: EnrichedLogEntry[] = [];
    let current: EnrichedLogEntry | null = null;
    let jsonBuffer: string[] | null = null;
    let jsonBraceDepth = 0;

    for (const line of lines) {
        if (!line.trim()) continue;

        const match = line.match(LOG_LINE_REGEX);

        if (match) {
            // Flush any pending entry
            if (current) {
                if (jsonBuffer) {
                    finalizeJsonEntry(current, jsonBuffer);
                    jsonBuffer = null;
                    jsonBraceDepth = 0;
                }
                entries.push(current);
            }

            const [, timestamp, level, instanceId, loggerName, eventId, threadOrMessage, messageAfterDash] = match;

            current = {
                timestamp: new Date(timestamp).getTime(),
                priority: level,
                instanceId,
                loggerName,
                eventId,
                threadName: messageAfterDash !== undefined ? threadOrMessage : undefined,
                message: messageAfterDash !== undefined ? messageAfterDash : threadOrMessage,
            };

            // Check if this is a JSON Logger entry starting with "{"
            if (current.message !== undefined) {
                const trimmedMsg = current.message.trim();
                if (trimmedMsg === '{' || trimmedMsg.endsWith('- {')) {
                    jsonBuffer = ['{'];
                    jsonBraceDepth = 1;
                    if (trimmedMsg.endsWith('- {')) {
                        current.message = trimmedMsg.slice(0, -3).trim();
                    } else {
                        current.message = '';
                    }
                }
            }
        } else {
            // Continuation line — no timestamp prefix
            if (jsonBuffer !== null) {
                jsonBuffer.push(line);
                for (const ch of line) {
                    if (ch === '{') jsonBraceDepth++;
                    else if (ch === '}') jsonBraceDepth--;
                }
                if (jsonBraceDepth <= 0) {
                    if (current) {
                        finalizeJsonEntry(current, jsonBuffer);
                    }
                    jsonBuffer = null;
                    jsonBraceDepth = 0;
                }
            } else if (current) {
                if (current.stackTrace) {
                    current.stackTrace += '\n' + line;
                } else if (line.match(/^\s+(at |Caused by:|\.{3}\s+\d+\s+more|Error type|Element DSL)/)) {
                    current.stackTrace = line;
                } else {
                    current.message = (current.message || '') + '\n' + line;
                }
            }
        }
    }

    // Flush last entry
    if (current) {
        if (jsonBuffer) {
            finalizeJsonEntry(current, jsonBuffer);
        }
        entries.push(current);
    }

    return entries;
}

/** Logger payloads name the stack trace field differently (stackTrace, stacktrace, stack_trace, …). */
const STACK_TRACE_KEY = /^stack_?trace/i;

function findStackTrace(payload: unknown): string | undefined {
    if (!payload || typeof payload !== 'object') return undefined;
    for (const [key, value] of Object.entries(payload)) {
        if (STACK_TRACE_KEY.test(key) && typeof value === 'string' && value.trim()) return value;
    }
    return undefined;
}

/**
 * Parse accumulated JSON lines and enrich the log entry with structured fields.
 */
function finalizeJsonEntry(entry: EnrichedLogEntry, jsonLines: string[]): void {
    const jsonText = jsonLines.join('\n');
    try {
        const parsed = JSON.parse(jsonText);
        entry.jsonPayload = parsed;
        entry.correlationId = parsed.correlationId || entry.correlationId;
        entry.elapsed = parsed.elapsed;
        entry.tracePoint = parsed.tracePoint;
        entry.flowName = parsed.content?.flowName || parsed.locationInfo?.rootContainer;
        entry.errorType = parsed.errorType || parsed.content?.errorType || parsed.content?.errorCode;
        if (parsed.message && (!entry.message || entry.message.trim() === '')) {
            entry.message = parsed.message;
        }
        const stackTrace = findStackTrace(parsed) ?? findStackTrace(parsed.content);
        if (stackTrace) entry.stackTrace = stackTrace;
    } catch {
        entry.message = (entry.message || '') + '\n' + jsonText;
    }
}
