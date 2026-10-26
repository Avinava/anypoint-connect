import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { registerLogTools, logWindow } from '../../../src/mcp/tools/logs.js';
import { PROJECT_ROOT_ENV } from '../../../src/safety/paths.js';
import { STARTUP_ERROR_TS, STARTUP_LOG } from '../../analysis/fixtures/startup-logs.js';

/** `count` one-line INFO entries, one per minute from 10:00 UTC. */
function minuteLog(count: number): string {
    return Array.from({ length: count }, (_, i) => {
        const ts = new Date(Date.UTC(2026, 9, 26, 10, i)).toISOString();
        return `${ts} INFO [r-1] com.example.orders.Poller event:x poll-thread - tick ${i}`;
    }).join('\n');
}

describe('log MCP tools', () => {
    const handlers = new Map<string, (input: any) => Promise<any>>();
    const server = {
        registerTool: vi.fn((name: string, _definition: unknown, handler: (input: any) => Promise<any>) => {
            handlers.set(name, handler);
        }),
    };
    const client = {
        getDefaultOrgId: vi.fn(),
        accessManagement: { resolveEnvironment: vi.fn() },
        logs: { getLogFile: vi.fn() },
    };
    const parse = (result: any) => JSON.parse(result.content[0].text);
    let root: string;

    beforeEach(() => {
        handlers.clear();
        vi.clearAllMocks();
        root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'anc-logs-')));
        process.env[PROJECT_ROOT_ENV] = root;
        client.getDefaultOrgId.mockResolvedValue('org-1');
        client.accessManagement.resolveEnvironment.mockResolvedValue({ id: 'env-1', name: 'Sandbox' });
        client.logs.getLogFile.mockResolvedValue({ deploymentId: 'dep-1', specId: 'spec-2', text: STARTUP_LOG });
        registerLogTools(server as any, client as any);
    });

    afterEach(() => {
        delete process.env[PROJECT_ROOT_ENV];
        fs.rmSync(root, { recursive: true, force: true });
    });

    describe('get_logs', () => {
        it('finds text on continuation lines and reports total and returned', async () => {
            const body = parse(
                await handlers.get('get_logs')!({
                    appName: 'orders-sapi',
                    environment: 'Sandbox',
                    level: 'ERROR',
                    search: 'Connection refused',
                }),
            );

            expect(client.logs.getLogFile).toHaveBeenCalledWith('org-1', 'env-1', 'orders-sapi', {
                previousSpecs: undefined,
            });
            expect(body).toMatchObject({ total: 1, returned: 1, truncated: false, specId: 'spec-2' });
            expect(body.specIds).toBeUndefined();
            expect(body.entries[0]).toMatchObject({
                timestamp: STARTUP_ERROR_TS,
                level: 'ERROR',
                logger: 'org.mule.runtime.core.internal.exception.OnErrorPropagateHandler',
            });
            expect(body.entries[0].stackTrace).toContain('Caused by: java.net.ConnectException');
        });

        it('reads earlier specs on request and merges them by time', async () => {
            client.logs.getLogFile.mockResolvedValue({
                deploymentId: 'dep-1',
                specId: 'spec-2',
                specIds: ['spec-1', 'spec-2'],
                // One block per spec; the old generation's last tick is later than the new one's first.
                text: `${minuteLog(3)}\n2026-10-26T10:00:30.000Z INFO [r-2] com.example.orders.Poller event:x poll-thread - new tick\n`,
            });
            const body = parse(
                await handlers.get('get_logs')!({ appName: 'orders-sapi', environment: 'Sandbox', previousSpecs: 1 }),
            );

            expect(client.logs.getLogFile).toHaveBeenCalledWith('org-1', 'env-1', 'orders-sapi', { previousSpecs: 1 });
            expect(body.specIds).toEqual(['spec-1', 'spec-2']);
            expect(body.entries.map((e: any) => e.replica)).toEqual(['r-1', 'r-1', 'r-2', 'r-1']);
        });

        it('applies lines after counting every match', async () => {
            const body = parse(
                await handlers.get('get_logs')!({ appName: 'orders-sapi', environment: 'Sandbox', lines: 2 }),
            );
            expect(body).toMatchObject({ total: 36, returned: 2, truncated: true });
            expect(body.entries.map((e: any) => e.message)).toEqual(['Replica ready', 'Mule is up and kicking']);
        });

        it('filters by logger and by regex', async () => {
            const byLogger = parse(
                await handlers.get('get_logs')!({
                    appName: 'orders-sapi',
                    environment: 'Sandbox',
                    logger: 'TokenCache',
                }),
            );
            expect(byLogger.entries.map((e: any) => e.level)).toEqual(['WARN']);

            const byRegex = parse(
                await handlers.get('get_logs')!({
                    appName: 'orders-sapi',
                    environment: 'Sandbox',
                    search: '^polled \\d+ orders \\(batch 2[89]\\)$',
                    regex: true,
                }),
            );
            expect(byRegex.total).toBe(2);
        });

        it('filters by an explicit ISO window', async () => {
            const body = parse(
                await handlers.get('get_logs')!({
                    appName: 'orders-sapi',
                    environment: 'Sandbox',
                    startTime: '2026-10-26T10:00:07Z',
                    endTime: '2026-10-26T10:00:08Z',
                }),
            );
            expect(body.total).toBe(2);
            expect(body.period).toEqual({ from: '2026-10-26T10:00:07.000Z', to: '2026-10-26T10:00:08.000Z' });
        });

        it('says when logs come from the last successful spec', async () => {
            client.logs.getLogFile.mockResolvedValue({
                deploymentId: 'dep-1',
                specId: 'spec-1',
                fallbackFromSpecId: 'spec-2',
                text: STARTUP_LOG,
            });
            const body = parse(await handlers.get('get_logs')!({ appName: 'orders-sapi', environment: 'Sandbox' }));
            expect(body.specId).toBe('spec-1');
            expect(body.notice).toContain('spec-2 has no log lines yet');
        });

        it('returns a tool error for an invalid regex or level', async () => {
            const badRegex = await handlers.get('get_logs')!({
                appName: 'orders-sapi',
                environment: 'Sandbox',
                search: '(',
                regex: true,
            });
            expect(badRegex.isError).toBe(true);
            expect(badRegex.content[0].text).toContain('Invalid search regex');

            const badLevel = await handlers.get('get_logs')!({
                appName: 'orders-sapi',
                environment: 'Sandbox',
                level: 'LOUD',
            });
            expect(badLevel.isError).toBe(true);
            expect(badLevel.content[0].text).toContain('Unknown log level');
        });
    });

    describe('download_logs', () => {
        const base = { appName: 'orders-sapi', environment: 'Sandbox', startTime: '2026-10-26T00:00:00Z' };

        it('returns lines oldest first with logger and stack trace', async () => {
            const result = await handlers.get('download_logs')!({ ...base, level: 'WARN' });
            const text: string = result.content[0].text;
            const lines = text.split('\n');

            expect(lines[0]).toBe(
                `${STARTUP_ERROR_TS} [ERROR] org.mule.runtime.core.internal.exception.OnErrorPropagateHandler - `,
            );
            expect(text).toContain('Caused by: java.net.ConnectException');
            expect(lines.at(-1)).toBe(
                '2026-10-26T10:00:08.000Z [WARN] com.example.orders.TokenCache - Token cache empty, retrying in 30s',
            );
        });

        it('keeps the newest maxLines entries and says how many matched', async () => {
            client.logs.getLogFile.mockResolvedValue({ deploymentId: 'dep-1', specId: 'spec-2', text: minuteLog(50) });

            const text: string = (await handlers.get('download_logs')!({ ...base, maxLines: 10 })).content[0].text;
            const lines = text.split('\n');

            expect(lines[0]).toContain('Truncated: showing the newest 10 of 50 matching entries');
            expect(lines).toHaveLength(11);
            expect(lines[1]).toContain('tick 40');
            expect(lines[10]).toContain('tick 49');
        });

        it('applies search, regex and logger filters', async () => {
            const text: string = (
                await handlers.get('download_logs')!({
                    ...base,
                    search: 'batch 1\\d\\)',
                    regex: true,
                    logger: 'Logger',
                })
            ).content[0].text;
            expect(text.split('\n')).toHaveLength(10);
        });

        it('summarizes by level, logger, time bucket and template', async () => {
            client.logs.getLogFile.mockResolvedValue({ deploymentId: 'dep-1', specId: 'spec-2', text: minuteLog(50) });

            const body = parse(await handlers.get('download_logs')!({ ...base, mode: 'summary', bucket: '15m' }));

            expect(body).toMatchObject({
                app: 'orders-sapi',
                environment: 'Sandbox',
                specId: 'spec-2',
                totalEntries: 50,
                byLevel: { INFO: 50 },
                loggerCount: 1,
                byLogger: [{ name: 'com.example.orders.Poller', count: 50 }],
            });
            expect(body.histogram.bucket).toBe('15m');
            expect(body.histogram.rows.map((r: any) => [r.start, r.total])).toEqual([
                ['2026-10-26T10:00:00.000Z', 15],
                ['2026-10-26T10:15:00.000Z', 15],
                ['2026-10-26T10:30:00.000Z', 15],
                ['2026-10-26T10:45:00.000Z', 5],
            ]);
            expect(body.topTemplates[0]).toMatchObject({ level: 'INFO', logger: 'com.example.orders.Poller' });
        });

        it('writes the full filtered result to outputFile and returns only the path and counts', async () => {
            client.logs.getLogFile.mockResolvedValue({ deploymentId: 'dep-1', specId: 'spec-2', text: minuteLog(50) });

            const body = parse(
                await handlers.get('download_logs')!({ ...base, maxLines: 5, outputFile: 'orders.log' }),
            );

            const target = path.join(root, 'orders.log');
            expect(body).toMatchObject({ mode: 'lines', outputFile: target, matched: 50 });
            expect(JSON.stringify(body)).not.toContain('tick');
            const written = fs.readFileSync(target, 'utf-8').trimEnd().split('\n');
            expect(written).toHaveLength(50);
            expect(fs.statSync(target).mode & 0o777).toBe(0o600);
        });

        it('writes a summary file in summary mode', async () => {
            const body = parse(
                await handlers.get('download_logs')!({ ...base, mode: 'summary', outputFile: 'summary.json' }),
            );
            expect(body).toMatchObject({ mode: 'summary', matched: 36 });
            expect(JSON.parse(fs.readFileSync(path.join(root, 'summary.json'), 'utf-8')).totalEntries).toBe(36);
        });

        it('refuses an outputFile outside the project root before downloading', async () => {
            const outside = path.join(path.dirname(root), 'escape.log');
            for (const outputFile of ['../escape.log', outside]) {
                const result = await handlers.get('download_logs')!({ ...base, outputFile });
                expect(result.isError).toBe(true);
                expect(result.content[0].text).toContain('inside the project root');
            }
            expect(client.logs.getLogFile).not.toHaveBeenCalled();
            expect(fs.existsSync(outside)).toBe(false);
        });

        it('refuses to replace an existing file unless overwrite is set', async () => {
            fs.writeFileSync(path.join(root, 'orders.log'), 'keep');

            const refused = await handlers.get('download_logs')!({ ...base, outputFile: 'orders.log' });
            expect(refused.isError).toBe(true);
            expect(refused.content[0].text).toContain('Pass overwrite');
            expect(fs.readFileSync(path.join(root, 'orders.log'), 'utf-8')).toBe('keep');

            const replaced = await handlers.get('download_logs')!({
                ...base,
                outputFile: 'orders.log',
                overwrite: true,
            });
            expect(replaced.isError).toBeUndefined();
            expect(fs.readFileSync(path.join(root, 'orders.log'), 'utf-8')).toContain('Mule is up and kicking');
        });

        it('rejects hoursBack together with startTime', async () => {
            const result = await handlers.get('download_logs')!({ ...base, hoursBack: 2 });
            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain('not both');
        });
    });
});

describe('logWindow', () => {
    it('uses the default look-back when nothing is given', () => {
        const before = Date.now();
        const window = logWindow({}, 24);
        expect(window.startTime! - (before - 24 * 3600_000)).toBeGreaterThanOrEqual(0);
        expect(window.endTime).toBeUndefined();
    });

    it('returns no window without a default', () => {
        expect(logWindow({})).toEqual({});
    });

    it('rejects an invalid or reversed ISO window', () => {
        expect(() => logWindow({ startTime: 'yesterday' })).toThrow('not an ISO 8601 date');
        expect(() => logWindow({ startTime: '2026-10-26T11:00:00Z', endTime: '2026-10-26T10:00:00Z' })).toThrow(
            'after endTime',
        );
    });
});
