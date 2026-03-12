/**
 * Log Analysis — Types
 * Shared type definitions for the analysis pipeline.
 */

import type { LogEntry } from '../api/LogsApi.js';

export interface EnrichedLogEntry extends LogEntry {
    /** Correlation ID from JSON Logger or event field */
    correlationId?: string;
    /** Elapsed time in ms from JSON Logger */
    elapsed?: number;
    /** Mule flow name */
    flowName?: string;
    /** START, END, or EXCEPTION tracepoint */
    tracePoint?: string;
    /** Mule error type (e.g. APP:SALESFORCE_ACCESS_ERROR) */
    errorType?: string;
    /** Parsed JSON payload from JsonLogger entries */
    jsonPayload?: Record<string, unknown>;
    /** Joined stack trace text */
    stackTrace?: string;
    /** Logger class name (JsonLogger, DefaultExceptionListener, etc.) */
    loggerName?: string;
    /** Raw event ID from the log line */
    eventId?: string;
}

export interface ErrorWithContext {
    error: EnrichedLogEntry;
    before: EnrichedLogEntry[];
    after: EnrichedLogEntry[];
    correlationId?: string;
    flowTrace: string[];
}

export interface ErrorGroup {
    errorType: string;
    template: string;
    count: number;
    firstSeen: string;
    lastSeen: string;
    samples: ErrorWithContext[];
    affectedFlows: string[];
}

export interface LogPattern {
    template: string;
    count: number;
    level: string;
    percentage: number;
    loggerName?: string;
}

export interface ErrorSpike {
    window: string;
    count: number;
    rate: number;
}

export interface LogStats {
    totalLines: number;
    totalEntries: number;
    byLevel: Record<string, number>;
    errorRate: number;
    timeRange: { start: string; end: string };
    errorSpikes: ErrorSpike[];
    topErrors: ErrorGroup[];
    topPatterns: LogPattern[];
    noisePercentage: number;
    uniqueCorrelationIds: number;
}

export interface AnalysisOptions {
    hoursBack?: number;
    level?: string;
    contextBefore?: number;
    contextAfter?: number;
    maxErrorGroups?: number;
    maxPatterns?: number;
}

export interface AnalysisResult {
    entries: EnrichedLogEntry[];
    errorContexts: ErrorWithContext[];
    errorGroups: ErrorGroup[];
    patterns: LogPattern[];
    stats: LogStats;
}
