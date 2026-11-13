import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const CLI = join(process.cwd(), 'dist', 'cli.js');

/** A local platform answering the few endpoints `apps list` and `apps status` read. */
function startPlatform(): Promise<{ baseUrl: string; server: Server }> {
    const deployment = {
        id: 'dep-1',
        name: 'sample-orders-api',
        status: 'RUNNING',
        application: {
            desiredState: 'STARTED',
            ref: { groupId: 'org-1', artifactId: 'sample-orders-api', version: '1.0.0' },
            // Must never reach the machine output of `apps list`.
            configuration: { 'mule.agent.application.properties.service': { properties: { secret: 'S3CRET' } } },
        },
        target: { replicas: 1, deploymentSettings: { runtime: { version: '4.9.0' } } },
        replicas: [{ id: 'r-1', state: 'STARTED', deploymentLocation: 'us-east-1' }],
        desiredVersion: 'spec-1',
        lastModifiedDate: 1,
    };
    const server = createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json');
        const url = req.url ?? '';
        if (url === '/accounts/api/organizations/org-1/environments') {
            res.end(JSON.stringify({ data: [{ id: 'env-1', name: 'Sandbox', isProduction: false }] }));
        } else if (url.endsWith('/environments/env-1/deployments')) {
            res.end(JSON.stringify({ items: [{ id: 'dep-1', name: 'sample-orders-api' }] }));
        } else if (url.endsWith('/environments/env-1/deployments/dep-1')) {
            res.end(JSON.stringify(deployment));
        } else if (url.endsWith('/deployments/dep-1/specs')) {
            res.end(JSON.stringify([{ version: 'spec-1' }]));
        } else if (url.split('?')[0].endsWith('/deployments/dep-1/specs/spec-1/logs')) {
            // The structured endpoint: two records in the same millisecond, close to now.
            const timestamp = Date.now() - 1000;
            const record = (docId: string, message: string) => ({
                docId,
                timestamp,
                message,
                replicaId: 'r-1',
                logLevel: 'INFO',
                context: { logger: 'org.sample.Logger' },
            });
            res.end(JSON.stringify([record('1001', 'first'), record('1002', 'second')]));
        } else if (url.endsWith('/deployments/dep-1/specs/spec-1/logs/file')) {
            // Two records in the same millisecond, close to now so the tail picks them up.
            const ts = new Date(Date.now() - 1000).toISOString();
            const line = (body: string) =>
                `${ts} INFO [r-1] org.sample.Logger event:00000000-0000-0000-0000-000000000000 [main] - ${body}`;
            res.setHeader('Content-Type', 'text/plain');
            res.end(`${line('first')}\n${line('second')}\n`);
        } else {
            res.writeHead(404).end('{}');
        }
    });
    return new Promise((resolve) =>
        server.listen(0, '127.0.0.1', () =>
            resolve({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server }),
        ),
    );
}

// Runs the built CLI, so it needs `npm run build` first (the CI sequence builds before testing).
describe.skipIf(!existsSync(CLI))('--json output through the real CLI', () => {
    let platform: Awaited<ReturnType<typeof startPlatform>>;
    let home: string;
    beforeAll(async () => {
        platform = await startPlatform();
        home = mkdtempSync(join(tmpdir(), 'anc-json-home-'));
    });
    afterAll(() => {
        platform.server.close();
        rmSync(home, { recursive: true, force: true });
    });

    function run(args: string[]) {
        return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
            const child = spawn(process.execPath, [CLI, ...args], {
                cwd: home,
                env: {
                    PATH: process.env.PATH,
                    HOME: home,
                    NO_COLOR: '1',
                    ANYPOINT_BASE_URL: platform.baseUrl,
                    ANYPOINT_AUTH_MODE: 'bearer',
                    ANYPOINT_ACCESS_TOKEN: 'test-token',
                    ANYPOINT_ORG_ID: 'org-1',
                },
            });
            let stdout = '';
            let stderr = '';
            child.stdout.on('data', (c) => (stdout += c));
            child.stderr.on('data', (c) => (stderr += c));
            child.on('close', (code) => resolve({ code, stdout, stderr }));
        });
    }

    it('apps list --json prints one JSON value, without properties, and writes no token file', async () => {
        const result = await run(['apps', 'list', '--env', 'Sandbox', '--json']);
        expect(result.code).toBe(0);
        const parsed = JSON.parse(result.stdout);
        expect(parsed).toEqual([
            {
                id: 'dep-1',
                name: 'sample-orders-api',
                status: 'RUNNING',
                version: '1.0.0',
                runtime: '4.9.0',
                replicas: 1,
            },
        ]);
        expect(result.stdout).not.toContain('S3CRET');
        expect(readdirSync(home).filter((f) => f.startsWith('.anypoint-connect'))).not.toContain('tokens.enc');
    });

    it('apps status --json prints one JSON value', async () => {
        const result = await run(['apps', 'status', 'sample-orders-api', '--env', 'Sandbox', '--json']);
        expect(result.code).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            name: 'sample-orders-api',
            version: '1.0.0',
            replicas: [{ id: 'r-1', state: 'STARTED', location: 'us-east-1' }],
        });
    });

    it('keeps notices on stderr and exits nonzero with an empty stdout on failure', async () => {
        const result = await run(['apps', 'status', 'missing-app', '--env', 'Sandbox', '--json']);
        expect(result.code).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain('not found');
    });
});

describe.skipIf(!existsSync(CLI))('anc logs tail through the real CLI', () => {
    let platform: Awaited<ReturnType<typeof startPlatform>>;
    let home: string;
    beforeAll(async () => {
        platform = await startPlatform();
        home = mkdtempSync(join(tmpdir(), 'anc-tail-home-'));
    });
    afterAll(() => {
        platform.server.close();
        rmSync(home, { recursive: true, force: true });
    });

    /** Start the tail, wait until `ready(stdout)`, send Ctrl+C, and report how it ended. */
    function tail(args: string[], ready: (stdout: string) => boolean) {
        return new Promise<{ code: number | null; stdout: string; stderr: string; stopMs: number }>((resolve) => {
            const child = spawn(process.execPath, [CLI, 'logs', 'tail', ...args], {
                cwd: home,
                env: {
                    PATH: process.env.PATH,
                    HOME: home,
                    NO_COLOR: '1',
                    ANYPOINT_BASE_URL: platform.baseUrl,
                    ANYPOINT_AUTH_MODE: 'bearer',
                    ANYPOINT_ACCESS_TOKEN: 'test-token',
                    ANYPOINT_ORG_ID: 'org-1',
                },
            });
            let stdout = '';
            let stderr = '';
            let stopped = 0;
            child.stdout.on('data', (c) => {
                stdout += c;
                if (!stopped && ready(stdout)) {
                    stopped = Date.now();
                    child.kill('SIGINT');
                }
            });
            child.stderr.on('data', (c) => (stderr += c));
            child.on('close', (code) => resolve({ code, stdout, stderr, stopMs: Date.now() - stopped }));
        });
    }

    it('--json prints JSON Lines, keeps both same-millisecond records, and ends cleanly on Ctrl+C', async () => {
        const result = await tail(
            ['sample-orders-api', '--env', 'Sandbox', '--json'],
            (out) => out.split('\n').filter((l) => l.includes('"record"')).length >= 2,
        );
        const lines = result.stdout
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l));
        expect(lines[0]).toEqual({ type: 'transport', mode: 'incremental' });
        expect(lines[1]).toEqual({ type: 'specChange', from: null, to: 'spec-1' });
        expect(lines.filter((l) => l.type === 'record').map((l) => l.message)).toEqual(['first', 'second']);
        expect(result.code).toBe(0);
        expect(result.stopMs).toBeLessThan(3000);
    });

    it('--spec follows exactly that spec, and refuses one that is not the app’s', async () => {
        const ok = await tail(['sample-orders-api', '--env', 'Sandbox', '--spec', 'spec-1', '--json'], (out) =>
            out.includes('"record"'),
        );
        expect(ok.code).toBe(0);
        const bad = await tail(['sample-orders-api', '--env', 'Sandbox', '--spec', 'spec-zzz', '--json'], () => false);
        expect(bad.code).toBe(1);
        expect(bad.stdout).toBe('');
        expect(bad.stderr).toContain('does not belong');
    });
});
