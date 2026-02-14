/**
 * Tests for Formatter utilities
 */
import { describe, it, expect, vi } from 'vitest';
import {
    formatDate,
    formatMs,
    formatBytes,
    printTable,
} from '../../src/utils/formatter.js';

describe('formatDate', () => {
    it('should format a timestamp into a readable date string', () => {
        const ts = new Date('2026-02-14T00:00:00Z').getTime();
        const result = formatDate(ts);
        expect(result).toBeTruthy();
        expect(typeof result).toBe('string');
    });

    it('should format a Date object', () => {
        const date = new Date('2026-01-01T12:00:00Z');
        const result = formatDate(date.getTime());
        expect(result).toBeTruthy();
    });

    it('should format an ISO string', () => {
        const result = formatDate('2026-06-15T10:30:00Z');
        expect(typeof result).toBe('string');
        expect(result.length).toBeGreaterThan(0);
    });
});

describe('formatMs', () => {
    it('should format small milliseconds', () => {
        expect(formatMs(500)).toBe('500ms');
    });

    it('should format seconds', () => {
        expect(formatMs(2500)).toBe('2.5s');
    });

    it('should format minutes', () => {
        expect(formatMs(120000)).toBe('2.0min');
    });

    it('should handle zero', () => {
        expect(formatMs(0)).toBe('0ms');
    });

    it('should round sub-milliseconds', () => {
        expect(formatMs(1)).toBe('1ms');
    });
});

describe('formatBytes', () => {
    it('should format bytes', () => {
        expect(formatBytes(500)).toBe('500 B');
    });

    it('should format kilobytes', () => {
        expect(formatBytes(1024)).toBe('1.0 KB');
    });

    it('should format megabytes', () => {
        expect(formatBytes(1048576)).toBe('1.0 MB');
    });

    it('should format gigabytes', () => {
        expect(formatBytes(1073741824)).toBe('1.0 GB');
    });

    it('should handle zero bytes', () => {
        expect(formatBytes(0)).toBe('0 B');
    });
});

describe('printTable', () => {
    it('should print table output to console', () => {
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });

        const headers = ['Name', 'Status'];
        const rows = [
            ['my-api', 'APPLIED'],
            ['order-svc', 'STARTED'],
        ];
        printTable(headers, rows);

        // Should have printed: header, separator, 2 rows = 4 console.log calls
        expect(consoleSpy).toHaveBeenCalledTimes(4);

        // Check the output contains expected content
        const allOutput = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
        expect(allOutput).toContain('Name');
        expect(allOutput).toContain('my-api');
        expect(allOutput).toContain('APPLIED');

        consoleSpy.mockRestore();
    });

    it('should handle empty rows', () => {
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });

        printTable(['Col1'], []);

        // Header + separator = 2 calls, no row calls
        expect(consoleSpy).toHaveBeenCalledTimes(2);

        consoleSpy.mockRestore();
    });
});
