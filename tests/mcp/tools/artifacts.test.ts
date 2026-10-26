import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { registerArtifactTools } from '../../../src/mcp/tools/artifacts.js';
import { PROJECT_ROOT_ENV } from '../../../src/safety/paths.js';

const FLOW = '<mule><flow name="orders-main"/></mule>\n';

function buildJar(files: Record<string, string>): Buffer {
    return Buffer.from(
        zipSync(Object.fromEntries(Object.entries(files).map(([name, content]) => [name, strToU8(content)]))),
    );
}

describe('compare_deployed_artifact', () => {
    const handlers = new Map<string, (input: any) => Promise<any>>();
    const server = {
        registerTool: vi.fn((name: string, _definition: unknown, handler: (input: any) => Promise<any>) => {
            handlers.set(name, handler);
        }),
    };
    const deployedJar = buildJar({ 'orders-sapi.xml': FLOW, 'config.yaml': 'a: 1\n' });
    const client = {
        getDefaultOrgId: vi.fn(),
        accessManagement: { resolveEnvironment: vi.fn() },
        cloudHub2: { findDetailByName: vi.fn() },
        exchange: { downloadAppJar: vi.fn() },
    };
    const parse = (result: any) => JSON.parse(result.content[0].text);
    let root: string;

    beforeEach(() => {
        handlers.clear();
        vi.clearAllMocks();
        root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'anc-artifacts-')));
        process.env[PROJECT_ROOT_ENV] = root;
        client.getDefaultOrgId.mockResolvedValue('org-1');
        client.accessManagement.resolveEnvironment.mockResolvedValue({ id: 'env-1', name: 'Sandbox' });
        client.cloudHub2.findDetailByName.mockResolvedValue({
            application: { ref: { groupId: 'org-1', artifactId: 'orders-sapi', version: '1.0.0' } },
        });
        client.exchange.downloadAppJar.mockResolvedValue({
            buffer: deployedJar,
            sha256: createHash('sha256').update(deployedJar).digest('hex'),
            md5Matches: true,
            fileName: 'orders-sapi-1.0.0-mule-application.jar',
        });
        registerArtifactTools(server as any, client as any);
    });

    afterEach(() => {
        delete process.env[PROJECT_ROOT_ENV];
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('downloads the jar of the deployed ref and reports identical against the same jar', async () => {
        fs.writeFileSync(path.join(root, 'local.jar'), deployedJar);
        const result = await handlers.get('compare_deployed_artifact')!({
            appName: 'orders-sapi',
            environment: 'Sandbox',
            against: { jarPath: 'local.jar' },
        });
        const body = parse(result);
        expect(client.exchange.downloadAppJar).toHaveBeenCalledWith(
            'org-1',
            'org-1',
            'orders-sapi',
            '1.0.0',
            expect.objectContaining({ maxBytes: expect.any(Number) }),
        );
        expect(body).toMatchObject({
            verdict: 'identical',
            deployed: { groupId: 'org-1', artifactId: 'orders-sapi', version: '1.0.0' },
            sha256: { match: true },
        });
    });

    it('reports a differing jar by entry name without contents', async () => {
        fs.writeFileSync(path.join(root, 'local.jar'), buildJar({ 'orders-sapi.xml': '<mule><secret-ish/></mule>' }));
        const result = await handlers.get('compare_deployed_artifact')!({
            appName: 'orders-sapi',
            environment: 'Sandbox',
            against: { jarPath: 'local.jar' },
        });
        const body = parse(result);
        expect(body.verdict).toBe('differs');
        expect(body.changed.map((c: any) => c.path)).toEqual(['orders-sapi.xml']);
        expect(body.missingInRepo.map((c: any) => c.path)).toEqual(['config.yaml']);
        expect(result.content[0].text).not.toContain('secret-ish');
    });

    it('compares against a git checkout including the working tree', async () => {
        const git = (...args: string[]) =>
            execFileSync(
                'git',
                ['-c', 'user.email=dev@example.com', '-c', 'user.name=dev', '-c', 'commit.gpgsign=false', ...args],
                { cwd: root, stdio: 'ignore' },
            );
        git('init', '-q');
        fs.mkdirSync(path.join(root, 'src/main/mule'), { recursive: true });
        fs.mkdirSync(path.join(root, 'src/main/resources'), { recursive: true });
        fs.writeFileSync(path.join(root, 'src/main/mule/orders-sapi.xml'), FLOW);
        fs.writeFileSync(path.join(root, 'src/main/resources/config.yaml'), 'a: 1\n');
        git('add', '-A');
        git('-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'init');

        const call = (against: Record<string, unknown>) =>
            handlers.get('compare_deployed_artifact')!({ appName: 'orders-sapi', environment: 'Sandbox', against });

        expect(parse(await call({ repoPath: '.' })).verdict).toBe('identical');

        fs.writeFileSync(path.join(root, 'src/main/resources/config.yaml'), 'a: 2\n');
        const body = parse(await call({ repoPath: '.', includeWorkingTree: true }));
        expect(body.verdict).toBe('differs');
        expect(body.changed.map((c: any) => c.path)).toEqual(['src/main/resources/config.yaml']);
        expect(body.workingTreeChanges).toEqual([{ path: 'src/main/resources/config.yaml', status: 'M' }]);
    });

    it('refuses paths outside the project root before downloading', async () => {
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'anc-outside-'));
        try {
            fs.writeFileSync(path.join(outside, 'x.jar'), deployedJar);
            for (const against of [
                { jarPath: path.join(outside, 'x.jar') },
                { jarPath: '../x.jar' },
                { repoPath: outside },
            ]) {
                const result = await handlers.get('compare_deployed_artifact')!({
                    appName: 'orders-sapi',
                    environment: 'Sandbox',
                    against,
                });
                expect(result.isError).toBe(true);
                expect(result.content[0].text).toMatch(/inside the project root|not found/);
            }
            expect(client.exchange.downloadAppJar).not.toHaveBeenCalled();
        } finally {
            fs.rmSync(outside, { recursive: true, force: true });
        }
    });

    it('reports an unknown application', async () => {
        client.cloudHub2.findDetailByName.mockResolvedValue(null);
        fs.writeFileSync(path.join(root, 'local.jar'), deployedJar);
        const result = await handlers.get('compare_deployed_artifact')!({
            appName: 'missing-app',
            environment: 'Sandbox',
            against: { jarPath: 'local.jar' },
        });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Application "missing-app" not found in Sandbox');
    });
});
