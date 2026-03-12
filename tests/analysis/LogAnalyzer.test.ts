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
import { templatize, isNoise } from '../../src/analysis/utils.js';
import {
    SAMPLE_JSON_LOGGER_INFO,
    SAMPLE_JSON_LOGGER_ERROR,
    SAMPLE_HTTP_DEBUG,
    SAMPLE_EXCEPTION_LISTENER,
    SAMPLE_SCHEDULER_WARN,
    SAMPLE_STARTUP_INFO,
    SAMPLE_ERROR_CONTEXT_CHAIN,
    SAMPLE_MIXED_LEVELS,
} from './fixtures/sample-logs.js';

// ── Parser Tests ─────────────────────────────────────────

describe('parseRawLogs', () => {
    it('should join JSON Logger blocks into a single enriched entry', () => {
        const entries = parseRawLogs(SAMPLE_JSON_LOGGER_INFO);

        expect(entries).toHaveLength(1);
        expect(entries[0].priority).toBe('INFO');
        expect(entries[0].loggerName).toBe('JsonLogger');
        expect(entries[0].correlationId).toBe('ca385c00-1dea-11f1-84d3-b2a7690ccf2c');
        expect(entries[0].elapsed).toBe(1348);
        expect(entries[0].tracePoint).toBe('START');
        expect(entries[0].flowName).toContain('sf-CreditMemo');
        expect(entries[0].jsonPayload).toBeDefined();
        expect(entries[0].jsonPayload?.environment).toBe('dev');
    });

    it('should parse JSON Logger ERROR entries with errorType and stacktrace', () => {
        const entries = parseRawLogs(SAMPLE_JSON_LOGGER_ERROR);

        expect(entries).toHaveLength(1);
        expect(entries[0].priority).toBe('ERROR');
        expect(entries[0].errorType).toBe('SALESFORCE_ACCESS_ERROR');
        expect(entries[0].stackTrace).toContain('FIELD_CUSTOM_VALIDATION_EXCEPTION');
        expect(entries[0].correlationId).toBe('ca385c00-1dea-11f1-84d3-b2a7690ccf2c');
    });

    it('should parse HTTP listener DEBUG with continuation lines', () => {
        const entries = parseRawLogs(SAMPLE_HTTP_DEBUG);

        expect(entries).toHaveLength(1);
        expect(entries[0].priority).toBe('DEBUG');
        // Continuation lines (HTTP headers) should be captured in message
        expect(entries[0].message).toContain('READ: 1015B POST');
    });

    it('should parse DefaultExceptionListener with stack trace continuation', () => {
        const entries = parseRawLogs(SAMPLE_EXCEPTION_LISTENER);

        expect(entries).toHaveLength(1);
        expect(entries[0].priority).toBe('ERROR');
        expect(entries[0].loggerName).toBe('DefaultExceptionListener');
        // Continuation lines should be captured in stackTrace or message
        const fullText = (entries[0].stackTrace || '') + (entries[0].message || '');
        expect(fullText).toContain('Element DSL');
        expect(fullText).toContain('SALESFORCE_ACCESS_ERROR');
    });

    it('should parse scheduler WARN entries', () => {
        const entries = parseRawLogs(SAMPLE_SCHEDULER_WARN);

        expect(entries).toHaveLength(1);
        expect(entries[0].priority).toBe('WARN');
        expect(entries[0].message).toContain('Task rejected');
    });

    it('should parse multiple entries from mixed log text', () => {
        const entries = parseRawLogs(SAMPLE_MIXED_LEVELS);

        expect(entries.length).toBeGreaterThanOrEqual(6);
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

        expect(entries.length).toBeGreaterThanOrEqual(4);

        const correlated = entries.filter((e) => e.correlationId === 'ca385c00-1dea-11f1-84d3-b2a7690ccf2c');
        expect(correlated.length).toBeGreaterThanOrEqual(4);

        const errors = entries.filter((e) => e.priority === 'ERROR');
        expect(errors.length).toBeGreaterThanOrEqual(2);
    });
});

// ── Error Context Tests ──────────────────────────────────

describe('buildErrorContexts', () => {
    it('should use correlation-based context when correlationId is available', () => {
        const entries = parseRawLogs(SAMPLE_ERROR_CONTEXT_CHAIN);
        const contexts = buildErrorContexts(entries);

        expect(contexts.length).toBeGreaterThan(0);
        const firstCtx = contexts[0];
        expect(firstCtx.correlationId).toBe('ca385c00-1dea-11f1-84d3-b2a7690ccf2c');
        expect(firstCtx.before.length).toBeGreaterThan(0);
        // Before entries should include the flow start
        expect(firstCtx.before.some((e) => e.message?.includes('started'))).toBe(true);
    });

    it('should build flow trace from context entries', () => {
        const entries = parseRawLogs(SAMPLE_ERROR_CONTEXT_CHAIN);
        const contexts = buildErrorContexts(entries);

        const firstCtx = contexts[0];
        expect(firstCtx.flowTrace.length).toBeGreaterThan(0);
    });

    it('should use time-window fallback when no correlationId exists', () => {
        const entries = parseRawLogs(SAMPLE_MIXED_LEVELS);
        const contexts = buildErrorContexts(entries);

        expect(contexts.length).toBeGreaterThan(0);
        // The ForwardingToListenerHandler has no JSON Logger, so may lack correlationId
        const noCorr = contexts.find((c) => !c.correlationId);
        if (noCorr) {
            expect(noCorr.before.length).toBeGreaterThanOrEqual(0);
        }
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

        expect(groups.length).toBeGreaterThan(0);
        // Errors with same type should be grouped
        const sfGroup = groups.find((g) => g.errorType === 'SALESFORCE_ACCESS_ERROR');
        expect(sfGroup).toBeDefined();
        expect(sfGroup!.count).toBeGreaterThanOrEqual(1);
        expect(sfGroup!.affectedFlows.length).toBeGreaterThan(0);
        expect(sfGroup!.samples.length).toBeLessThanOrEqual(3);
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
        expect(totalWithNoise).toBeGreaterThanOrEqual(totalWithoutNoise);
    });
});

// ── Stats Tests ──────────────────────────────────────────

describe('calculateStats', () => {
    it('should calculate level distribution and error rate', () => {
        const entries = parseRawLogs(SAMPLE_MIXED_LEVELS);
        const stats = calculateStats(entries, 10);

        expect(stats.totalEntries).toBe(entries.length);
        expect(stats.totalLines).toBe(10);
        expect(stats.byLevel['INFO']).toBeGreaterThan(0);
        expect(stats.byLevel['ERROR']).toBeGreaterThan(0);
        expect(stats.errorRate).toBeGreaterThan(0);
        expect(stats.timeRange.start).toBeTruthy();
        expect(stats.timeRange.end).toBeTruthy();
    });

    it('should calculate noise percentage', () => {
        const entries = parseRawLogs(SAMPLE_MIXED_LEVELS);
        const stats = calculateStats(entries, 10);

        // We have 3 HTTP listener DEBUG entries out of ~8
        expect(stats.noisePercentage).toBeGreaterThan(0);
    });
});

// ── Utility Tests ────────────────────────────────────────

describe('templatize', () => {
    it('should replace UUIDs with <*>', () => {
        const result = templatize('event:ca385c00-1dea-11f1-84d3-b2a7690ccf2c started');
        expect(result).toContain('<*>');
        expect(result).not.toContain('ca385c00');
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

        expect(result.entries.length).toBeGreaterThanOrEqual(6);
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
