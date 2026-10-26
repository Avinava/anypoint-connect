import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const mocks = vi.hoisted(() => ({
    createClient: vi.fn(),
    printTable: vi.fn(),
    log: {
        info: vi.fn(),
        success: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        header: vi.fn(),
        kv: vi.fn(),
        dim: vi.fn(),
        logLine: vi.fn(),
    },
}));

vi.mock('../../src/commands/shared.js', () => ({ createClient: mocks.createClient }));
vi.mock('../../src/utils/logger.js', () => ({ log: mocks.log }));
vi.mock('../../src/utils/formatter.js', () => ({ printTable: mocks.printTable }));

import { createLogsCommand } from '../../src/commands/logs.js';
import { LogsApi } from '../../src/api/LogsApi.js';
import { STARTUP_LOG } from '../analysis/fixtures/startup-logs.js';

describe('logs CLI', () => {
    const download = vi.fn();
    const ch2 = {
        findByName: vi.fn(),
        getDeployment: vi.fn(),
    };
    const client = {
        getDefaultOrgId: vi.fn(),
        accessManagement: { resolveEnvironment: vi.fn() },
        logs: new LogsApi({ download } as any, ch2 as any),
    };
    const run = (...args: string[]) => createLogsCommand().parseAsync(['node', 'logs', ...args]);
    let dir: string;

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.createClient.mockReturnValue(client);
        client.getDefaultOrgId.mockResolvedValue('org-1');
        client.accessManagement.resolveEnvironment.mockResolvedValue({ id: 'env-1', name: 'Sandbox' });
        ch2.findByName.mockResolvedValue({ id: 'dep-1', name: 'orders-sapi' });
        ch2.getDeployment.mockResolvedValue({ id: 'dep-1', desiredVersion: 'spec-2', lastSuccessfulVersion: 'spec-2' });
        download.mockResolvedValue(Buffer.from(STARTUP_LOG));
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anc-logs-cli-'));
        process.exitCode = undefined;
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
        process.exitCode = undefined;
    });

    describe('search', () => {
        it('prints matching entries oldest first with the match count', async () => {
            await run('search', 'orders-sapi', '-e', 'Sandbox', '--grep', 'token', '--logger', 'TokenCache');

            expect(mocks.log.logLine).toHaveBeenCalledTimes(1);
            expect(mocks.log.logLine.mock.calls[0][0]).toBe('WARN');
            expect(mocks.log.logLine.mock.calls[0][1]).toContain('Token cache empty');
            expect(mocks.log.info).toHaveBeenCalledWith('1 matching entries (spec spec-2)');
        });

        it('supports --regex, --level, --since and --limit', async () => {
            await run(
                'search',
                'orders-sapi',
                '-e',
                'Sandbox',
                '--grep',
                '^polled \\d+ orders',
                '--regex',
                '--level',
                'INFO',
                '--since',
                '2026-10-26T09:20:00Z',
                '--limit',
                '3',
            );

            const messages = mocks.log.logLine.mock.calls.map((c) => c[1] as string);
            expect(messages).toHaveLength(3);
            expect(messages[0]).toContain('batch 27');
            expect(messages[2]).toContain('batch 29');
            expect(mocks.log.info).toHaveBeenCalledWith('Showing the newest 3 of 10 matching entries (spec spec-2)');
        });

        it('prints the stack trace of a matching error', async () => {
            await run('search', 'orders-sapi', '-e', 'Sandbox', '--grep', 'Connection refused', '--level', 'ERROR');
            expect(mocks.log.logLine).toHaveBeenCalledTimes(1);
            expect(mocks.log.dim).toHaveBeenCalledWith(expect.stringContaining('Caused by: java.net.ConnectException'));
        });

        it('rejects a limit above the cap', async () => {
            await run('search', 'orders-sapi', '-e', 'Sandbox', '--limit', '5000');
            expect(mocks.log.error).toHaveBeenCalledWith(expect.stringContaining('--limit must be'));
            expect(process.exitCode).toBe(1);
            expect(download).not.toHaveBeenCalled();
        });
    });

    describe('download', () => {
        it('writes filtered lines to the output file', async () => {
            const output = path.join(dir, 'orders.log');
            await run(
                'download',
                'orders-sapi',
                '-e',
                'Sandbox',
                '--from',
                '2026-10-26T00:00:00Z',
                '--grep',
                'token',
                '-o',
                output,
            );

            const lines = fs.readFileSync(output, 'utf-8').trimEnd().split('\n');
            expect(lines[0]).toMatch(/^2026-10-26T10:00:07.000Z \[ERROR\] /);
            expect(lines.at(-1)).toContain('[WARN] com.example.orders.TokenCache - Token cache empty');
            expect(mocks.log.success).toHaveBeenCalledWith(expect.stringContaining('Downloaded 2 log entries'));
        });

        it('--summary prints tables and writes the summary as JSON', async () => {
            const output = path.join(dir, 'summary.json');
            await run(
                'download',
                'orders-sapi',
                '-e',
                'Sandbox',
                '--from',
                '2026-10-26T00:00:00Z',
                '--summary',
                '--bucket',
                '15m',
                '--logger',
                'LoggerMessageProcessor',
                '-o',
                output,
            );

            expect(mocks.log.kv).toHaveBeenCalledWith('Entries', 30);
            expect(mocks.log.header).toHaveBeenCalledWith('By time (15m buckets)');
            const summary = JSON.parse(fs.readFileSync(output, 'utf-8'));
            expect(summary.totalEntries).toBe(30);
            expect(summary.histogram.rows.map((r: any) => r.total)).toEqual([15, 15]);
        });

        it('rejects an unknown bucket', async () => {
            await run('download', 'orders-sapi', '-e', 'Sandbox', '--from', '1h', '--summary', '--bucket', '2h');
            expect(mocks.log.error).toHaveBeenCalledWith(expect.stringContaining('--bucket must be one of'));
            expect(process.exitCode).toBe(1);
        });
    });
});
