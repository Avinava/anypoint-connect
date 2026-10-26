/**
 * Tests for the shared log filter, the histogram and summary helpers, and the parser
 * behaviour the log search depends on (start-up regression fixture).
 */

import { describe, expect, it } from 'vitest';
import { parseRawLogs } from '../../src/analysis/parser.js';
import { buildFilter, clampLimit, filterEntries, MAX_LOG_LINES, searchEntries } from '../../src/analysis/filter.js';
import { calculateStats, histogram, topCounts, UNKNOWN_LOGGER } from '../../src/analysis/stats.js';
import { formatEntry, summarizeEntries, MAX_HISTOGRAM_ROWS } from '../../src/analysis/summary.js';
import { analyzeLogs } from '../../src/analysis/LogAnalyzer.js';
import { STARTUP_BANNER_TS, STARTUP_ERROR_TS, STARTUP_LOG } from './fixtures/startup-logs.js';
import { SAMPLE_MIXED_LEVELS } from './fixtures/sample-logs.js';

const entries = parseRawLogs(STARTUP_LOG);
const iso = (ms: number) => new Date(ms).toISOString();

describe('parseRawLogs on start-up output', () => {
    it('joins every continuation line to the entry that starts the block', () => {
        expect(entries).toHaveLength(36);
        const banner = entries.find((e) => e.message.includes("Started app 'orders-sapi'"));
        expect(iso(banner!.timestamp)).toBe(STARTUP_BANNER_TS);
        expect(banner!.priority).toBe('INFO');
    });

    it('keeps the previous entry timestamp and level on continuation lines', () => {
        const error = entries.find((e) => e.priority === 'ERROR')!;
        expect(iso(error.timestamp)).toBe(STARTUP_ERROR_TS);
        expect(error.message).toContain('Message               : HTTP POST');
        expect(error.message).toContain('Error type            : HTTP:CONNECTIVITY');
        expect(error.stackTrace).toContain('HttpRequester.doRequest');
        expect(error.eventId).toBe('c0ffee00-0000-4000-8000-000000000042');
    });

    it('keeps a header without logger and thread as a whole message', () => {
        const last = entries[entries.length - 1];
        expect(last.message).toBe('Replica ready');
        expect(last.loggerName).toBeUndefined();
        expect(last.instanceId).toBe('orders-sapi-6d5f7c9b8-abcde');
    });

    it('handles CRLF line endings and numeric offsets', () => {
        const parsed = parseRawLogs(
            '2026-10-26T10:00:00.000+0000 INFO [r-1] Poller event:x t - first\r\n  continued\r\n2026-10-26T10:00:01.000+00:00 WARN [r-1] Poller event:x t - second\r\n',
        );
        expect(parsed.map((e) => [iso(e.timestamp), e.priority, e.message])).toEqual([
            ['2026-10-26T10:00:00.000Z', 'INFO', 'first\n  continued'],
            ['2026-10-26T10:00:01.000Z', 'WARN', 'second'],
        ]);
    });
});

describe('buildFilter', () => {
    it('matches search across message, logger, thread and stack trace', () => {
        const count = (search: string) => filterEntries(entries, { search }).length;
        expect(count('connection refused')).toBe(1);
        expect(count('OnErrorPropagateHandler')).toBe(1);
        expect(count('token-flow.CPU_LITE')).toBe(1);
        expect(count('HttpRequester.doRequest')).toBe(1);
        expect(count('event:c0ffee00-0000-4000-8000-000000000042')).toBe(1);
    });

    it('matches the JSON Logger payload', () => {
        const parsed = parseRawLogs(
            [
                '2026-10-26T10:00:00.000Z INFO [r-1] JsonLogger event:x t - {',
                '  "correlationId": "c0ffee00-0000-4000-8000-000000000007",',
                '  "message": "Order accepted",',
                '  "content": { "orderId": "ORD-7731" }',
                '}',
            ].join('\n'),
        );
        expect(parsed[0].message).toBe('Order accepted');
        expect(filterEntries(parsed, { search: 'ORD-7731' })).toHaveLength(1);
    });

    it('anchors a regex to the message', () => {
        expect(filterEntries(entries, { search: '^Token cache', regex: true })).toHaveLength(1);
        expect(filterEntries(entries, { search: 'retrying in \\d+s$', regex: true })).toHaveLength(1);
    });

    it('filters by level, logger and time', () => {
        expect(filterEntries(entries, { level: 'warning' }).map((e) => e.priority)).toEqual(['ERROR', 'WARN']);
        expect(filterEntries(entries, { logger: 'tokencache' })).toHaveLength(1);
        const window = filterEntries(entries, {
            startTime: Date.parse(STARTUP_BANNER_TS),
            endTime: Date.parse(STARTUP_ERROR_TS),
        });
        expect(window.map((e) => e.priority)).toEqual(['INFO', 'ERROR']);
    });

    it('rejects an unknown level and an invalid regex', () => {
        expect(() => buildFilter({ level: 'LOUD' })).toThrow('Unknown log level "LOUD"');
        expect(() => buildFilter({ search: '(', regex: true })).toThrow('Invalid search regex');
        expect(() => buildFilter({ search: 'a'.repeat(501), regex: true })).toThrow('longer than 500');
    });
});

describe('searchEntries', () => {
    it('counts every match before the limit and returns the newest first', () => {
        const result = searchEntries(entries, { search: 'polled', limit: 2 });
        expect(result).toMatchObject({ total: 30, returned: 2, truncated: true });
        expect(result.entries.map((e) => e.message)).toEqual([
            'Polled 0 orders (batch 29)',
            'Polled 0 orders (batch 28)',
        ]);
    });

    it('lists entries that share a timestamp newest first', () => {
        const parsed = parseRawLogs(
            ['a', 'b', 'c'].map((m) => `2026-10-26T10:00:00.000Z INFO [r-1] L event:x t - ${m}`).join('\n'),
        );
        expect(searchEntries(parsed).entries.map((e) => e.message)).toEqual(['c', 'b', 'a']);
    });

    it('clamps the limit to 1..MAX_LOG_LINES', () => {
        expect(clampLimit(undefined)).toBe(100);
        expect(clampLimit(0)).toBe(1);
        expect(clampLimit(MAX_LOG_LINES * 10)).toBe(MAX_LOG_LINES);
    });
});

describe('stats helpers', () => {
    it('counts entries by logger', () => {
        const stats = calculateStats(entries, 0);
        expect(stats.byLogger['org.mule.runtime.core.internal.processor.LoggerMessageProcessor']).toBe(30);
        expect(stats.byLogger[UNKNOWN_LOGGER]).toBe(1);
        expect(topCounts(stats.byLogger, 1)).toEqual([
            { name: 'org.mule.runtime.core.internal.processor.LoggerMessageProcessor', count: 30 },
        ]);
    });

    it('buckets entries on clock-aligned boundaries, oldest first', () => {
        const hourly = histogram(entries, '1h');
        expect(hourly.map((b) => [b.start, b.total])).toEqual([
            ['2026-10-26T09:00:00.000Z', 30],
            ['2026-10-26T10:00:00.000Z', 6],
        ]);
        expect(hourly[1].byLevel).toEqual({ INFO: 4, ERROR: 1, WARN: 1 });

        const quarter = histogram(entries, '15m');
        expect(quarter.map((b) => b.total)).toEqual([15, 15, 6]);

        expect(histogram(entries, '5m')).toHaveLength(7);
    });
});

describe('summarizeEntries', () => {
    it('returns level, logger, histogram and template counts', () => {
        const summary = summarizeEntries(entries, { bucket: '1h', topLoggers: 2, topTemplates: 3 });
        expect(summary.totalEntries).toBe(36);
        expect(summary.byLevel).toEqual({ INFO: 34, ERROR: 1, WARN: 1 });
        expect(summary.loggerCount).toBe(7);
        expect(summary.byLogger).toHaveLength(2);
        expect(summary.histogram.rows).toHaveLength(2);
        expect(summary.histogram.truncated).toBeUndefined();
        expect(summary.topTemplates).toHaveLength(3);
    });

    it('keeps only the newest histogram rows when there are too many', () => {
        const many = parseRawLogs(
            Array.from(
                { length: MAX_HISTOGRAM_ROWS + 10 },
                (_, i) => `${iso(Date.UTC(2026, 0, 1) + i * 3600_000)} INFO [r-1] L event:x t - tick`,
            ).join('\n'),
        );
        const summary = summarizeEntries(many);
        expect(summary.histogram.rows).toHaveLength(MAX_HISTOGRAM_ROWS);
        expect(summary.histogram.truncated).toEqual({ kept: MAX_HISTOGRAM_ROWS, total: MAX_HISTOGRAM_ROWS + 10 });
        expect(summary.histogram.rows[0].start).toBe(iso(Date.UTC(2026, 0, 1) + 10 * 3600_000));
    });

    it('formats an entry with logger and stack trace', () => {
        const warn = entries.find((e) => e.priority === 'WARN')!;
        expect(formatEntry(warn)).toBe(
            '2026-10-26T10:00:08.000Z [WARN] com.example.orders.TokenCache - Token cache empty, retrying in 30s',
        );
        const error = entries.find((e) => e.priority === 'ERROR')!;
        expect(formatEntry(error).split('\n').at(-1)).toBe(
            '    Caused by: java.net.ConnectException: Connection refused',
        );
    });
});

describe('analyzeLogs filters', () => {
    it('search and logger narrow stats and patterns', () => {
        const result = analyzeLogs(STARTUP_LOG, { logger: 'LoggerMessageProcessor' });
        expect(result.stats.totalEntries).toBe(30);
        expect(result.errorGroups).toHaveLength(0);
    });

    it('errorLevel WARN analyzes warnings as errors', () => {
        expect(analyzeLogs(STARTUP_LOG).errorContexts).toHaveLength(1);
        expect(analyzeLogs(STARTUP_LOG, { errorLevel: 'WARN' }).errorContexts).toHaveLength(2);
    });

    it('keeps unfiltered context around a filtered error', () => {
        const result = analyzeLogs(SAMPLE_MIXED_LEVELS, { search: 'Exception caught' });
        expect(result.errorContexts).toHaveLength(1);
        expect(result.errorContexts[0].before.length).toBeGreaterThan(0);
    });

    it('counts FATAL entries as errors', () => {
        const result = analyzeLogs('2026-10-26T10:00:00.000Z FATAL [r-1] Boot event:x main - Out of memory');
        expect(result.errorContexts).toHaveLength(1);
    });

    it('applies an explicit time window', () => {
        const result = analyzeLogs(STARTUP_LOG, {
            startTime: Date.parse('2026-10-26T10:00:00.000Z'),
            endTime: Date.parse(STARTUP_ERROR_TS),
        });
        expect(result.stats.totalEntries).toBe(3);
    });
});
