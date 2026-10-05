/**
 * Tests for Log Analysis modules
 *
 * Tests:
 *  1. Parser — multi-line joining, JSON Logger extraction
 *  2. Error Context — correlation-based and time-window context
 *  3. Error Grouper — clustering similar errors
 *  4. Pattern Detector — template extraction
 *  5. Stats Calculator — level distribution, error rate, noise
 *  6. Full Pipeline — analyzeLogs end-to-end
 */

import { describe, it, expect } from 'vitest';
import { parseRawLogs } from '../../src/analysis/parser.js';
import { buildErrorContexts } from '../../src/analysis/error-context.js';
import { groupErrors } from '../../src/analysis/error-grouper.js';
import { detectPatterns } from '../../src/analysis/pattern-detector.js';
import { calculateStats } from '../../src/analysis/stats.js';
import { analyzeLogs } from '../../src/analysis/LogAnalyzer.js';
import { templatize, isNoise } from '../../src/analysis/normalize.js';
import {
    SAMPLE_JSON_LOGGER_INFO,
    SAMPLE_JSON_LOGGER_ERROR,
    SAMPLE_HTTP_DEBUG,
    SAMPLE_EXCEPTION_LISTENER,
    SAMPLE_SCHEDULER_WARN,
    SAMPLE_STARTUP_INFO,
    SAMPLE_ERROR_CONTEXT_CHAIN,
    SAMPLE_MIXED_LEVELS,
    SAMPLE_PLAIN_ERROR_STACK,
    SAMPLE_INTERLEAVED_CORRELATIONS,
    SAMPLE_TIME_WINDOW,
    SAMPLE_REPEATED_WARN,
    REPEATED_WARN_TEMPLATE,
    APP,
    CORR_1,
    CORR_3,
    CORR_4,
    FLOW_POST_ORDERS,
    FLOW_CREATE_ORDER,
    ERR_DOWNSTREAM,
    MSG_ORDER_FAILED,
} from './fixtures/sample-logs.js';

// ── Parser Tests ─────────────────────────────────────────

describe('parseRawLogs', () => {
    it('should join JSON Logger blocks into a single enriched entry', () => {
        const entries = parseRawLogs(SAMPLE_JSON_LOGGER_INFO);

        expect(entries).toHaveLength(1);
        expect(entries[0].priority).toBe('INFO');
        expect(entries[0].loggerName).toBe('JsonLogger');
        expect(entries[0].correlationId).toBe(CORR_1);
        expect(entries[0].elapsed).toBe(1200);
        expect(entries[0].tracePoint).toBe('START');
        expect(entries[0].flowName).toBe(FLOW_POST_ORDERS);
        expect(entries[0].message).toBe('Order request received');
        expect(entries[0].threadName).toContain(`[${APP}]`);
        expect(entries[0].jsonPayload).toBeDefined();
        expect(entries[0].jsonPayload?.environment).toBe('dev');
    });

    it('should parse JSON Logger ERROR entries with errorType and stacktrace', () => {
        const entries = parseRawLogs(SAMPLE_JSON_LOGGER_ERROR);

        expect(entries).toHaveLength(1);
        expect(entries[0].priority).toBe('ERROR');
        // Top-level errorType takes precedence over content.errorType
        expect(entries[0].errorType).toBe(ERR_DOWNSTREAM);
        expect(entries[0].flowName).toBe(FLOW_CREATE_ORDER);
        expect(entries[0].message).toBe(MSG_ORDER_FAILED);
        expect(entries[0].stackTrace).toContain('Connection refused');
        expect(entries[0].correlationId).toBe(CORR_1);
    });

    it('should parse HTTP listener DEBUG with continuation lines', () => {
        const entries = parseRawLogs(SAMPLE_HTTP_DEBUG);

        expect(entries).toHaveLength(1);
        expect(entries[0].priority).toBe('DEBUG');
        // Continuation lines (HTTP headers) should be captured in message
        expect(entries[0].message).toContain('READ: 512B POST /api/orders');
        expect(entries[0].message).toContain('Content-Type: application/json');
        expect(entries[0].threadName).toBe('http.listener.01');
    });

    it('should parse DefaultExceptionListener with stack trace continuation', () => {
        const entries = parseRawLogs(SAMPLE_EXCEPTION_LISTENER);

        expect(entries).toHaveLength(1);
        expect(entries[0].priority).toBe('ERROR');
        expect(entries[0].loggerName).toBe('DefaultExceptionListener');
        // Continuation lines should be captured in stackTrace or message
        const fullText = (entries[0].stackTrace || '') + (entries[0].message || '');
        expect(fullText).toContain('Element DSL');
        expect(fullText).toContain(ERR_DOWNSTREAM);
        expect(fullText).toContain(MSG_ORDER_FAILED);
    });

    it('should collect indented stack frames of a plain-text ERROR into stackTrace', () => {
        const entries = parseRawLogs(SAMPLE_PLAIN_ERROR_STACK);

        expect(entries).toHaveLength(1);
        expect(entries[0].priority).toBe('ERROR');
        expect(entries[0].message).toBe('Inventory lookup failed');
        expect(entries[0].eventId).toBeUndefined();
        expect(entries[0].correlationId).toBeUndefined();
        expect(entries[0].jsonPayload).toBeUndefined();
        expect(entries[0].stackTrace).toContain('at com.example.orders.InventoryClient.lookup');
        expect(entries[0].stackTrace).toContain('Caused by: java.net.ConnectException');
        expect(entries[0].stackTrace).toContain('... 12 more');
    });

    it('should parse scheduler WARN entries', () => {
        const entries = parseRawLogs(SAMPLE_SCHEDULER_WARN);

        expect(entries).toHaveLength(1);
        expect(entries[0].priority).toBe('WARN');
        expect(entries[0].threadName).toBe('http.listener.01');
        expect(entries[0].message).toMatch(/^Task rejected/);
        // Only the first " - " separates thread from message
        expect(entries[0].message).toContain(' - org.mule.runtime');
    });

    it('should parse multiple entries from mixed log text', () => {
        const entries = parseRawLogs(SAMPLE_MIXED_LEVELS);

        expect(entries).toHaveLength(8);
        const levels = entries.map((e) => e.priority);
        expect(levels).toContain('INFO');
        expect(levels).toContain('DEBUG');
        expect(levels).toContain('WARN');
        expect(levels).toContain('ERROR');
    });

    it('should handle empty input', () => {
        const entries = parseRawLogs('');
        expect(entries).toHaveLength(0);
    });

    it('should parse error context chain with multiple same-correlation entries', () => {
        const entries = parseRawLogs(SAMPLE_ERROR_CONTEXT_CHAIN);

        expect(entries).toHaveLength(5);

        const correlated = entries.filter((e) => e.correlationId === CORR_1);
        expect(correlated).toHaveLength(4);

        const errors = entries.filter((e) => e.priority === 'ERROR');
        expect(errors).toHaveLength(3);
    });
});

// ── Error Context Tests ──────────────────────────────────

describe('buildErrorContexts', () => {
    it('should use correlation-based context when correlationId is available', () => {
        const entries = parseRawLogs(SAMPLE_ERROR_CONTEXT_CHAIN);
        const contexts = buildErrorContexts(entries);

        expect(contexts.length).toBeGreaterThan(0);
        const firstCtx = contexts[0];
        expect(firstCtx.correlationId).toBe(CORR_1);
        expect(firstCtx.before).toHaveLength(2);
        // Before entries should include the flow start
        expect(firstCtx.before.some((e) => e.message?.includes('started'))).toBe(true);
    });

    it('should build flow trace from context entries', () => {
        const entries = parseRawLogs(SAMPLE_ERROR_CONTEXT_CHAIN);
        const contexts = buildErrorContexts(entries);

        const firstCtx = contexts[0];
        expect(firstCtx.flowTrace).toEqual([FLOW_POST_ORDERS, FLOW_CREATE_ORDER]);
    });

    it('should not mix entries from interleaved correlation IDs', () => {
        const entries = parseRawLogs(SAMPLE_INTERLEAVED_CORRELATIONS);
        const contexts = buildErrorContexts(entries);

        expect(entries).toHaveLength(7);
        expect(contexts).toHaveLength(1);
        const ctx = contexts[0];
        expect(ctx.correlationId).toBe(CORR_3);
        expect(ctx.before).toHaveLength(2);
        expect(ctx.before.every((e) => e.correlationId === CORR_3)).toBe(true);
        expect(ctx.after).toHaveLength(0);
        expect(ctx.flowTrace).toEqual([FLOW_POST_ORDERS, FLOW_CREATE_ORDER]);
    });

    it('should use time-window fallback when no correlationId exists', () => {
        const entries = parseRawLogs(SAMPLE_MIXED_LEVELS);
        const contexts = buildErrorContexts(entries);

        expect(contexts).toHaveLength(2);
        // The ForwardingToListenerHandler line has no JSON Logger body, so it lacks a correlationId
        const noCorr = contexts.find((c) => !c.correlationId);
        expect(noCorr).toBeDefined();
        // Startup INFO lines are an hour earlier and fall outside the 30s window
        expect(noCorr!.before).toHaveLength(5);
        expect(noCorr!.before.some((e) => e.priority === 'INFO')).toBe(false);
    });

    it('should exclude entries outside the 30s window in time-window fallback', () => {
        const entries = parseRawLogs(SAMPLE_TIME_WINDOW);
        const contexts = buildErrorContexts(entries);

        expect(contexts).toHaveLength(1);
        expect(contexts[0].correlationId).toBeUndefined();
        expect(contexts[0].before.map((e) => e.message)).toEqual(['Inventory feed batch received']);
        expect(contexts[0].after.map((e) => e.message)).toEqual(['Inventory feed retry scheduled']);
    });

    it('should return empty for logs with no errors', () => {
        const entries = parseRawLogs(SAMPLE_STARTUP_INFO);
        const contexts = buildErrorContexts(entries);
        expect(contexts).toHaveLength(0);
    });
});

// ── Error Grouper Tests ──────────────────────────────────

describe('groupErrors', () => {
    it('should group errors by errorType', () => {
        const entries = parseRawLogs(SAMPLE_ERROR_CONTEXT_CHAIN);
        const contexts = buildErrorContexts(entries);
        const groups = groupErrors(contexts);

        // Same errorType but different message templates → separate groups; JSON-less error → UNKNOWN
        expect(groups).toHaveLength(3);
        const downstreamGroup = groups.find((g) => g.errorType === ERR_DOWNSTREAM && g.template === MSG_ORDER_FAILED);
        expect(downstreamGroup).toBeDefined();
        expect(downstreamGroup!.count).toBe(1);
        expect(downstreamGroup!.affectedFlows).toEqual([FLOW_CREATE_ORDER]);
        expect(downstreamGroup!.samples.length).toBeLessThanOrEqual(3);
        expect(groups.some((g) => g.errorType === 'UNKNOWN')).toBe(true);
    });

    it('should respect maxGroups option', () => {
        const entries = parseRawLogs(SAMPLE_ERROR_CONTEXT_CHAIN);
        const contexts = buildErrorContexts(entries);
        const groups = groupErrors(contexts, { maxGroups: 1 });

        expect(groups.length).toBeLessThanOrEqual(1);
    });
});

// ── Pattern Detector Tests ───────────────────────────────

describe('detectPatterns', () => {
    it('should identify recurring message templates', () => {
        const entries = parseRawLogs(SAMPLE_MIXED_LEVELS);
        const patterns = detectPatterns(entries);

        expect(patterns.length).toBeGreaterThan(0);
        expect(patterns[0].count).toBeGreaterThan(0);
        expect(patterns[0].percentage).toBeGreaterThan(0);
    });

    it('should filter HTTP noise when excludeNoise is true', () => {
        const entries = parseRawLogs(SAMPLE_MIXED_LEVELS);
        const withNoise = detectPatterns(entries, { excludeNoise: false });
        const withoutNoise = detectPatterns(entries, { excludeNoise: true });

        // Noise-inclusive should have more entries counted
        const totalWithNoise = withNoise.reduce((s, p) => s + p.count, 0);
        const totalWithoutNoise = withoutNoise.reduce((s, p) => s + p.count, 0);
        expect(totalWithNoise).toBe(8);
        expect(totalWithoutNoise).toBe(5);
    });

    it('should collapse WARN lines that differ only in variable tokens into one template', () => {
        const entries = parseRawLogs(SAMPLE_REPEATED_WARN);
        const patterns = detectPatterns(entries);

        expect(patterns).toHaveLength(2);
        expect(patterns[0]).toMatchObject({
            level: 'WARN',
            count: 3,
            percentage: 75,
            template: REPEATED_WARN_TEMPLATE,
        });
        expect(patterns[0].loggerName).toBe('DownstreamClient');
    });
});

// ── Stats Tests ──────────────────────────────────────────

describe('calculateStats', () => {
    it('should calculate level distribution and error rate', () => {
        const entries = parseRawLogs(SAMPLE_MIXED_LEVELS);
        const stats = calculateStats(entries, 10);

        expect(stats.totalEntries).toBe(entries.length);
        expect(stats.totalLines).toBe(10);
        expect(stats.byLevel).toEqual({ INFO: 2, DEBUG: 3, WARN: 1, ERROR: 2 });
        expect(stats.errorRate).toBe(25);
        expect(stats.timeRange.start).toBeTruthy();
        expect(stats.timeRange.end).toBeTruthy();
    });

    it('should calculate noise percentage', () => {
        const entries = parseRawLogs(SAMPLE_MIXED_LEVELS);
        const stats = calculateStats(entries, 10);

        // 3 HTTP listener DEBUG entries out of 8
        expect(stats.noisePercentage).toBe(37.5);
    });

    it('should count unique correlation IDs across interleaved requests', () => {
        const entries = parseRawLogs(SAMPLE_INTERLEAVED_CORRELATIONS);
        const stats = calculateStats(entries, 0);

        expect(stats.uniqueCorrelationIds).toBe(2);
        expect(entries.some((e) => e.correlationId === CORR_4)).toBe(true);
    });
});

// ── Utility Tests ────────────────────────────────────────

describe('templatize', () => {
    it('should replace UUIDs with <*>', () => {
        const result = templatize('event:c0ffee00-0000-4000-8000-000000000001 started');
        expect(result).toContain('<*>');
        expect(result).not.toContain('c0ffee00');
    });

    it('should replace long numbers with <*>', () => {
        const result = templatize('READ: 10150 bytes from port 80814');
        expect(result).toContain('<*>');
    });

    it('should truncate long messages', () => {
        const longMsg = 'x'.repeat(300);
        const result = templatize(longMsg);
        expect(result.length).toBeLessThanOrEqual(204); // 200 + "..."
    });
});

describe('isNoise', () => {
    it('should detect HTTP listener DEBUG as noise', () => {
        const entries = parseRawLogs(SAMPLE_HTTP_DEBUG);
        expect(entries.length).toBe(1);
        expect(isNoise(entries[0])).toBe(true);
    });

    it('should not flag INFO entries as noise', () => {
        const entries = parseRawLogs(SAMPLE_STARTUP_INFO);
        expect(entries.length).toBe(1);
        expect(isNoise(entries[0])).toBe(false);
    });
});

// ── Full Pipeline Test ───────────────────────────────────

describe('analyzeLogs', () => {
    it('should run the full pipeline end-to-end', () => {
        const result = analyzeLogs(SAMPLE_ERROR_CONTEXT_CHAIN);

        expect(result.entries.length).toBeGreaterThan(0);
        expect(result.errorContexts.length).toBeGreaterThan(0);
        expect(result.errorGroups.length).toBeGreaterThan(0);
        expect(result.stats.totalEntries).toBeGreaterThan(0);
        expect(result.stats.errorRate).toBeGreaterThan(0);
    });

    it('should handle the mixed levels log', () => {
        const result = analyzeLogs(SAMPLE_MIXED_LEVELS);

        expect(result.entries).toHaveLength(8);
        expect(result.stats.byLevel['DEBUG']).toBeGreaterThan(0);
        expect(result.stats.byLevel['INFO']).toBeGreaterThan(0);
        expect(result.stats.byLevel['ERROR']).toBeGreaterThan(0);
        expect(result.stats.noisePercentage).toBeGreaterThan(0);
    });

    it('should filter by level', () => {
        const result = analyzeLogs(SAMPLE_MIXED_LEVELS, { level: 'WARN' });

        const levels = result.entries.map((e) => e.priority);
        expect(levels).not.toContain('INFO');
        expect(levels).not.toContain('DEBUG');
    });

    it('should return empty for empty input', () => {
        const result = analyzeLogs('');
        expect(result.entries).toHaveLength(0);
        expect(result.errorGroups).toHaveLength(0);
        expect(result.stats.totalEntries).toBe(0);
    });
});
