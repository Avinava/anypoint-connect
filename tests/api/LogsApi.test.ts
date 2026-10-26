/**
 * Tests for LogsApi: spec resolution, parsing and search over the CH2 log file.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LogsApi, MAX_LOG_LINES } from '../../src/api/LogsApi.js';
import {
    STARTUP_BANNER_TS,
    STARTUP_ERROR_TS,
    STARTUP_LAST_TS,
    STARTUP_LOG,
} from '../analysis/fixtures/startup-logs.js';

const mockDownload = vi.fn();
const mockHttp = { download: mockDownload } as any;
const ch2 = { findByName: vi.fn(), getDeployment: vi.fn() };

const LOG_URL = (spec: string) =>
    `/amc/application-manager/api/v2/organizations/org-1/environments/env-1/deployments/dep-1/specs/${spec}/logs/file`;

describe('LogsApi', () => {
    let api: LogsApi;

    beforeEach(() => {
        vi.resetAllMocks();
        api = new LogsApi(mockHttp, ch2 as any);
        ch2.findByName.mockResolvedValue({ id: 'dep-1', name: 'orders-sapi' });
        ch2.getDeployment.mockResolvedValue({ id: 'dep-1', desiredVersion: 'spec-2', lastSuccessfulVersion: 'spec-1' });
        mockDownload.mockResolvedValue(Buffer.from(STARTUP_LOG));
    });

    describe('regression: search right after a start', () => {
        it('finds error text that sits on unprefixed lines when a level filter is set', async () => {
            // Before the fix this returned [] because "Connection refused" sat on an INFO-stamped continuation line.
            const entries = await api.getLogs('org-1', 'env-1', 'orders-sapi', {
                level: 'ERROR',
                search: 'connection refused',
            });

            expect(entries).toHaveLength(1);
            expect(entries[0].priority).toBe('ERROR');
            expect(new Date(entries[0].timestamp).toISOString()).toBe(STARTUP_ERROR_TS);
            expect(entries[0].message).toContain('Error type            : HTTP:CONNECTIVITY');
            expect(entries[0].stackTrace).toContain('Caused by: java.net.ConnectException');
        });

        it('keeps continuation lines on the entry they belong to, with its timestamp', async () => {
            const result = await api.searchLogs('org-1', 'env-1', 'orders-sapi', {
                search: "Started app 'orders-sapi'",
            });

            expect(result.total).toBe(1);
            expect(new Date(result.entries[0].timestamp).toISOString()).toBe(STARTUP_BANNER_TS);
            expect(result.entries[0].loggerName).toBe(
                'org.mule.runtime.module.deployment.internal.DefaultArchiveDeployer',
            );
        });

        it('returns the newest real lines first, not unprefixed lines stamped with the fetch time', async () => {
            const result = await api.searchLogs('org-1', 'env-1', 'orders-sapi', { limit: 3 });

            expect(result.returned).toBe(3);
            expect(result.total).toBe(36);
            expect(result.truncated).toBe(true);
            expect(result.entries.map((e) => e.message)).toEqual([
                'Replica ready',
                'Mule is up and kicking',
                'Token cache empty, retrying in 30s',
            ]);
            expect(new Date(result.entries[1].timestamp).toISOString()).toBe(STARTUP_LAST_TS);
        });

        it('reads the desired spec file', async () => {
            await api.searchLogs('org-1', 'env-1', 'orders-sapi', {});
            expect(mockDownload).toHaveBeenCalledWith(LOG_URL('spec-2'), expect.anything());
        });
    });

    describe('spec fallback', () => {
        it('falls back to the last successful spec when the desired spec has no log lines yet', async () => {
            mockDownload.mockImplementation(async (url: string) =>
                Buffer.from(url === LOG_URL('spec-2') ? '\n' : STARTUP_LOG),
            );

            const file = await api.getLogFile('org-1', 'env-1', 'orders-sapi');

            expect(file).toMatchObject({ deploymentId: 'dep-1', specId: 'spec-1', fallbackFromSpecId: 'spec-2' });
            expect(file.text).toBe(STARTUP_LOG);
        });

        it('falls back when the desired spec log file does not exist yet', async () => {
            mockDownload.mockImplementation(async (url: string) => {
                if (url === LOG_URL('spec-2'))
                    throw Object.assign(new Error('Not Found'), { response: { status: 404 } });
                return Buffer.from(STARTUP_LOG);
            });

            const file = await api.getLogFile('org-1', 'env-1', 'orders-sapi');
            expect(file.specId).toBe('spec-1');
        });

        it('does not hide other download errors', async () => {
            mockDownload.mockRejectedValue(Object.assign(new Error('Forbidden'), { response: { status: 403 } }));
            await expect(api.getLogFile('org-1', 'env-1', 'orders-sapi')).rejects.toThrow('Forbidden');
        });

        it('uses the desired spec alone when it is also the last successful one', async () => {
            ch2.getDeployment.mockResolvedValue({
                id: 'dep-1',
                desiredVersion: 'spec-2',
                lastSuccessfulVersion: 'spec-2',
            });
            mockDownload.mockResolvedValue(Buffer.from(''));

            const file = await api.getLogFile('org-1', 'env-1', 'orders-sapi');
            expect(file).toMatchObject({ specId: 'spec-2', text: '' });
            expect(file.fallbackFromSpecId).toBeUndefined();
            expect(mockDownload).toHaveBeenCalledTimes(1);
        });

        it('explains a missing app', async () => {
            ch2.findByName.mockResolvedValue(null);
            await expect(api.getLogFile('org-1', 'env-1', 'orders-sapi')).rejects.toThrow('not found');
        });
    });

    describe('search', () => {
        it('matches the logger name and the stack trace', async () => {
            const byLogger = await api.searchLogs('org-1', 'env-1', 'orders-sapi', { search: 'TokenCache' });
            expect(byLogger.entries.map((e) => e.priority)).toEqual(['WARN']);

            const byStack = await api.searchLogs('org-1', 'env-1', 'orders-sapi', {
                search: 'HttpRequester.doRequest',
            });
            expect(byStack.entries.map((e) => e.priority)).toEqual(['ERROR']);
        });

        it('supports regex search', async () => {
            const result = await api.searchLogs('org-1', 'env-1', 'orders-sapi', {
                search: 'batch (1|2)\\d\\)$',
                regex: true,
            });
            expect(result.total).toBe(20);
        });

        it('rejects an invalid regex with a clear message', async () => {
            await expect(api.searchLogs('org-1', 'env-1', 'orders-sapi', { search: '(', regex: true })).rejects.toThrow(
                'Invalid search regex',
            );
        });

        it('filters by logger substring', async () => {
            const result = await api.searchLogs('org-1', 'env-1', 'orders-sapi', { logger: 'loggermessageprocessor' });
            expect(result.total).toBe(30);
        });

        it('filters by time window', async () => {
            const result = await api.searchLogs('org-1', 'env-1', 'orders-sapi', {
                startTime: Date.parse('2026-10-26T10:00:00.000Z'),
                endTime: Date.parse(STARTUP_LAST_TS),
            });
            expect(result.total).toBe(5);
        });

        it('caps limit at the maximum line count', async () => {
            const many = Array.from(
                { length: MAX_LOG_LINES + 50 },
                (_, i) => `2026-10-26T10:00:00.${String(i).padStart(3, '0')}Z INFO [r-1] Logger event:x t - line ${i}`,
            ).join('\n');
            mockDownload.mockResolvedValue(Buffer.from(many));

            const result = await api.searchLogs('org-1', 'env-1', 'orders-sapi', { limit: 5000 });
            expect(result.returned).toBe(MAX_LOG_LINES);
            expect(result.total).toBe(MAX_LOG_LINES + 50);
        });
    });
});
