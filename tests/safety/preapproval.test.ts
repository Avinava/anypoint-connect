import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const question = vi.hoisted(() => vi.fn());
vi.mock('readline', () => ({
    createInterface: () => ({ question, close: vi.fn() }),
}));

import {
    approvalsFile,
    checkPreapproval,
    checkUnmarkedAllowance,
    ignoredProjectApprovalWarning,
    readApprovalState,
    savePreapproval,
    saveUnmarkedAllowance,
    validatePreapproval,
} from '../../src/safety/preapproval.js';
import { confirmProductionWrite } from '../../src/safety/guards.js';
import { registerAppDeployTools } from '../../src/mcp/tools/apps-deploy.js';
import { registerAppLifecycleTools } from '../../src/mcp/tools/apps-lifecycle.js';
import { registerIdentityTools } from '../../src/mcp/tools/identity.js';
import { registerProfileTools } from '../../src/mcp/tools/profile.js';

const ORG = 'org-1';
const production = { id: 'env-prod', name: 'Production', isProduction: true };
const sandbox = { id: 'env-sbx', name: 'Sandbox', isProduction: false };
const FUTURE = '2999-01-01T00:00:00Z';
const PAST = '2000-01-01T00:00:00Z';
const scope = { orgId: ORG, environmentId: production.id };

let dir: string;
beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'anc-preapproval-')));
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    question.mockReset();
    fs.rmSync(approvalsFile(), { force: true });
});
afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(approvalsFile(), { force: true });
});

function writeStore(content: object) {
    fs.writeFileSync(approvalsFile(), JSON.stringify(content));
}

describe('production pre-approval rules', () => {
    it('validates IDs, tools, expiry and project path', () => {
        expect(validatePreapproval({ ...scope, tools: 'all-mutating' })).toEqual({ ...scope, tools: 'all-mutating' });
        expect(() => validatePreapproval({ ...scope, environmentId: 'env-*', tools: ['update_app'] })).toThrow(
            'wildcards',
        );
        expect(() => validatePreapproval({ orgId: ORG, tools: ['update_app'] })).toThrow('environmentId');
        expect(() => validatePreapproval({ ...scope, tools: ['list_apps'] })).toThrow('not a pre-approvable tool');
        expect(() => validatePreapproval({ ...scope, tools: ['update_app'], expires: 'soon' })).toThrow('expires');
        expect(() => validatePreapproval({ ...scope, tools: ['update_app'], projectPath: 'rel' })).toThrow('absolute');
        expect(() => validatePreapproval({ ...scope, tools: ['update_app'], environments: ['x'] })).toThrow(
            'unknown fields',
        );
    });

    it('matches organization and environment IDs, never names', () => {
        savePreapproval(scope, { ...scope, environmentName: 'Production', tools: ['update_app'], expires: FUTURE });
        expect(checkPreapproval({ orgId: ORG, env: production }, 'update_app')).toMatchObject({
            productionPreapproved: true,
            preapprovalExpires: FUTURE,
        });
        expect(checkPreapproval({ orgId: ORG, env: production }, 'update_app').preapprovalSource).toContain(
            'production-approvals.json',
        );
        expect(checkPreapproval({ orgId: ORG, env: production }, 'deploy_jar').productionPreapproved).toBe(false);
        // Same display name, another environment ID
        expect(checkPreapproval({ orgId: ORG, env: { id: 'env-other' } }, 'update_app').productionPreapproved).toBe(
            false,
        );
        // Same environment ID under another organization (switched credentials)
        expect(checkPreapproval({ orgId: 'org-2', env: production }, 'update_app').productionPreapproved).toBe(false);
    });

    it('ignores expired and invalid entries', () => {
        writeStore({
            productionPreapprovals: [
                { ...scope, tools: 'all-mutating', expires: PAST },
                { orgId: ORG, environments: ['Production'], tools: 'all-mutating' },
            ],
        });
        const state = readApprovalState();
        expect(state.productionPreapprovals).toHaveLength(1);
        expect(state.productionPreapprovals[0].expired).toBe(true);
        expect(state.invalid).toHaveLength(1);
        expect(checkPreapproval({ orgId: ORG, env: production }, 'update_app').productionPreapproved).toBe(false);
    });

    it('all-mutating does not cover delete_app unless it is named', () => {
        savePreapproval(scope, { ...scope, tools: 'all-mutating' });
        expect(checkPreapproval({ orgId: ORG, env: production }, 'restart_app').productionPreapproved).toBe(true);
        expect(checkPreapproval({ orgId: ORG, env: production }, 'delete_app').productionPreapproved).toBe(false);
        savePreapproval(scope, { ...scope, tools: ['delete_app'] });
        expect(checkPreapproval({ orgId: ORG, env: production }, 'delete_app').productionPreapproved).toBe(true);
    });

    it('honors a project-scoped entry only in that project', () => {
        savePreapproval(
            { ...scope, projectPath: '/sample/repo' },
            { ...scope, projectPath: '/sample/repo', tools: ['update_app'] },
        );
        const target = { orgId: ORG, env: production };
        expect(checkPreapproval(target, 'update_app', { projectRoot: '/sample/repo' }).productionPreapproved).toBe(
            true,
        );
        expect(checkPreapproval(target, 'update_app', { projectRoot: '/sample/other' }).productionPreapproved).toBe(
            false,
        );
    });

    it('replaces an entry of the same scope and stores the file owner-only', () => {
        savePreapproval(scope, { ...scope, tools: ['update_app'] });
        savePreapproval(scope, { ...scope, tools: ['deploy_jar'] });
        expect(readApprovalState().productionPreapprovals.map((e) => e.tools)).toEqual([['deploy_jar']]);
        expect(fs.statSync(approvalsFile()).mode & 0o777).toBe(0o600);
        savePreapproval(scope, null);
        expect(readApprovalState().productionPreapprovals).toEqual([]);
    });

    it('regression: an approval planted in the project file is ignored and reported', () => {
        fs.writeFileSync(
            path.join(dir, '.anypoint-connect.json'),
            JSON.stringify({ productionPreapproval: { environments: ['Production'], tools: 'all-mutating' } }),
        );
        expect(checkPreapproval({ orgId: ORG, env: production }, 'update_app').productionPreapproved).toBe(false);
        expect(ignoredProjectApprovalWarning()).toContain('is ignored');
    });

    it('scopes unmarked-artifact allowances the same way', () => {
        saveUnmarkedAllowance(scope, { ...scope, expires: FUTURE });
        expect(checkUnmarkedAllowance({ orgId: ORG, env: production })).toMatchObject({
            unmarkedAllowed: true,
            expires: FUTURE,
        });
        expect(checkUnmarkedAllowance({ orgId: 'org-2', env: production }).unmarkedAllowed).toBe(false);
        saveUnmarkedAllowance(scope, { ...scope, expires: PAST });
        expect(checkUnmarkedAllowance({ orgId: ORG, env: production }).unmarkedAllowed).toBe(false);
    });
});

describe('CLI production prompt', () => {
    it('skips the typed phrase only when the setting covers org, environment and tool', async () => {
        savePreapproval(scope, { ...scope, tools: ['deploy_jar'] });
        vi.spyOn(console, 'log').mockImplementation(() => undefined);

        expect(await confirmProductionWrite(production, ORG, 'deploy_jar')).toBe(true);
        expect(question).not.toHaveBeenCalled();

        question.mockImplementation((_prompt: string, answer: (value: string) => void) => answer('no'));
        expect(await confirmProductionWrite(production, ORG, 'update_app')).toBe(false);
        expect(await confirmProductionWrite(production, 'org-2', 'deploy_jar')).toBe(false);
        expect(question).toHaveBeenCalledTimes(2);
    });

    it('prompts when the entry has expired', async () => {
        savePreapproval(scope, { ...scope, tools: ['deploy_jar'], expires: PAST });
        question.mockImplementation((_prompt: string, answer: (value: string) => void) =>
            answer('deploy to production'),
        );
        expect(await confirmProductionWrite(production, ORG, 'deploy_jar')).toBe(true);
        expect(question).toHaveBeenCalledTimes(1);
    });
});

// ── MCP ───────────────────────────────────────────────

const SERVICE = 'mule.agent.application.properties.service';
const ref = { groupId: ORG, artifactId: 'orders-sapi', version: '1.0.0', packaging: 'jar' };
const detail = () => ({
    id: 'dep-1',
    name: 'orders-sapi',
    application: {
        desiredState: 'STARTED',
        ref: { ...ref },
        configuration: { [SERVICE]: { applicationName: 'orders-sapi', properties: {}, secureProperties: {} } },
    },
    target: {
        provider: 'MC',
        targetId: 'cloudhub-us-east-2',
        deploymentSettings: { runtime: { version: '4.9.0', java: '17' } },
        replicas: 1,
    },
    replicas: [{ id: 'r1', state: 'STARTED', currentDeploymentVersion: 'spec-1' }],
    desiredVersion: 'spec-1',
});
const marker = (deployable: boolean) => ({
    schemaVersion: 1,
    tool: 'mule-build',
    toolVersion: '3.2.0',
    stripped: !deployable,
    productionDeployable: deployable,
});
const jarBytes = (info?: object) =>
    Buffer.from(
        zipSync({
            'META-INF/MANIFEST.MF': strToU8('Manifest-Version: 1.0\n'),
            ...(info ? { 'META-INF/mule-build/build-info.json': strToU8(JSON.stringify(info)) } : {}),
        }),
    );
const exchangeJar = (buffer: Buffer) => ({
    buffer,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    md5Matches: true,
    fileName: 'orders-sapi.jar',
});

describe('MCP production writes', () => {
    const handlers = new Map<string, (input: any) => Promise<any>>();
    const server = {
        registerTool: vi.fn((name: string, _d: unknown, h: (input: any) => Promise<any>) => handlers.set(name, h)),
    };
    const client = {
        getDefaultOrgId: vi.fn(),
        whoami: vi.fn(),
        accessManagement: { resolveEnvironment: vi.fn() },
        runtimes: { getTarget: vi.fn() },
        exchange: { downloadAppJar: vi.fn() },
        cloudHub2: {
            findDetailByName: vi.fn(),
            patchDeployment: vi.fn(),
            setDesiredState: vi.fn(),
            getDeployment: vi.fn(),
            getDeploymentSpecs: vi.fn(),
            createDeployment: vi.fn(),
        },
    };
    const parse = (result: any) => JSON.parse(result.content[0].text);
    const args = { appName: 'orders-sapi', environment: 'Production', version: '1.1.0', wait: false };
    const writes = () =>
        client.cloudHub2.patchDeployment.mock.calls.length + client.cloudHub2.createDeployment.mock.calls.length;

    beforeEach(() => {
        handlers.clear();
        client.getDefaultOrgId.mockReset().mockResolvedValue(ORG);
        client.accessManagement.resolveEnvironment.mockReset().mockResolvedValue(production);
        client.runtimes.getTarget.mockReset().mockResolvedValue(null);
        client.exchange.downloadAppJar.mockReset().mockResolvedValue(exchangeJar(jarBytes(marker(true))));
        client.cloudHub2.findDetailByName.mockReset().mockResolvedValue(detail());
        client.cloudHub2.patchDeployment.mockReset().mockResolvedValue({ ...detail(), desiredVersion: 'spec-2' });
        client.cloudHub2.createDeployment.mockReset().mockResolvedValue({ id: 'dep-new' });
        client.cloudHub2.getDeploymentSpecs.mockReset().mockResolvedValue([
            { version: 'spec-1', application: { ref: { ...ref } } },
            { version: 'spec-0', application: { ref: { ...ref, version: '0.9.0' } } },
        ]);
        registerAppDeployTools(server as any, client as any);
        registerAppLifecycleTools(server as any, client as any);
        registerProfileTools(server as any, client as any);
        registerIdentityTools(server as any, client as any);
    });

    describe('pre-approval', () => {
        it('a covered org, environment and tool applies without confirmProduction, and says so', async () => {
            savePreapproval(scope, { ...scope, tools: ['update_app_artifact'] });
            const preview = parse(await handlers.get('update_app_artifact')!(args));
            expect(preview).toMatchObject({
                dryRun: true,
                production: true,
                productionPreapproved: true,
                requires: 'confirm: true',
            });
            expect(preview.preapprovalSource).toContain('production-approvals.json');

            const result = await handlers.get('update_app_artifact')!({ ...args, confirm: true });
            expect(result.isError).toBeUndefined();
            expect(client.cloudHub2.patchDeployment).toHaveBeenCalledTimes(1);
            expect(parse(result)).toMatchObject({ production: true, productionPreapproved: true });
        });

        it('still requires confirm', async () => {
            savePreapproval(scope, { ...scope, tools: 'all-mutating' });
            await handlers.get('update_app_artifact')!(args);
            expect(writes()).toBe(0);
        });

        it.each([
            ['an uncovered tool', { ...scope, tools: ['update_app'] }],
            ['another environment ID', { ...scope, environmentId: 'env-other', tools: ['update_app_artifact'] }],
            ['another organization', { ...scope, orgId: 'org-2', tools: ['update_app_artifact'] }],
            ['an expired entry', { ...scope, tools: ['update_app_artifact'], expires: PAST }],
        ])('%s still needs confirmProduction', async (_name, entry) => {
            savePreapproval(entry, entry as any);
            const refused = await handlers.get('update_app_artifact')!({ ...args, confirm: true });
            expect(refused.isError).toBe(true);
            expect(parse(refused)).toMatchObject({ refused: true, productionPreapproved: false });
            expect(writes()).toBe(0);
        });

        it('regression: a planted project file does not skip confirmProduction, and the preview says why', async () => {
            fs.writeFileSync(
                path.join(dir, '.anypoint-connect.json'),
                JSON.stringify({ productionPreapproval: { environments: ['Production'], tools: 'all-mutating' } }),
            );
            const refused = await handlers.get('update_app_artifact')!({ ...args, confirm: true });
            expect(refused.isError).toBe(true);
            expect(parse(refused).preapprovalWarning).toContain('is ignored');
            expect(writes()).toBe(0);
        });

        it('never waives the stripped-artifact refusal', async () => {
            savePreapproval(scope, { ...scope, tools: 'all-mutating' });
            client.exchange.downloadAppJar.mockResolvedValue(exchangeJar(jarBytes(marker(false))));
            const result = await handlers.get('update_app_artifact')!({
                ...args,
                confirm: true,
                confirmProduction: true,
            });
            expect(result.isError).toBe(true);
            expect(parse(result).blockers[0]).toContain('not production deployable');
            expect(writes()).toBe(0);
        });
    });

    describe('regression: artifacts selected from Exchange are verified for production', () => {
        it.each([
            ['update_app_artifact', args],
            ['update_app', args],
            ['deploy_app', { ...args, groupId: ORG, artifactId: 'orders-sapi' }],
            ['rollback_app', { appName: 'orders-sapi', environment: 'Production', wait: false }],
        ])('%s downloads the artifact and refuses a stripped build without jarPath', async (tool, input) => {
            client.exchange.downloadAppJar.mockResolvedValue(exchangeJar(jarBytes(marker(false))));
            const result = await handlers.get(tool)!({ ...input, confirm: true, confirmProduction: true });
            expect(result.isError).toBe(true);
            expect(JSON.stringify(parse(result))).toContain('not production deployable');
            expect(client.exchange.downloadAppJar).toHaveBeenCalled();
            expect(writes()).toBe(0);
        });

        it('deploy_app refuses a stripped build when creating a production app', async () => {
            client.cloudHub2.findDetailByName.mockResolvedValue(null);
            client.exchange.downloadAppJar.mockResolvedValue(exchangeJar(jarBytes(marker(false))));
            const result = await handlers.get('deploy_app')!({
                ...args,
                groupId: ORG,
                artifactId: 'orders-sapi',
                confirm: true,
                confirmProduction: true,
            });
            expect(result.isError).toBe(true);
            expect(parse(result).artifactVerification).toMatchObject({ checked: 'exchange' });
            expect(writes()).toBe(0);
        });

        it('refuses an unmarked artifact unless an allowance covers the org and environment', async () => {
            client.exchange.downloadAppJar.mockResolvedValue(exchangeJar(jarBytes()));
            const refused = parse(
                await handlers.get('rollback_app')!({ appName: 'orders-sapi', environment: 'Production' }),
            );
            expect(refused.blockers[0]).toContain('build provenance unknown');
            expect(refused.artifactVerification.provenancePolicy).toEqual({ unmarkedAllowed: false });

            saveUnmarkedAllowance(scope, scope);
            const preview = parse(
                await handlers.get('rollback_app')!({ appName: 'orders-sapi', environment: 'Production' }),
            );
            expect(preview.dryRun).toBe(true);
            expect(preview.artifactVerification.provenancePolicy).toMatchObject({ unmarkedAllowed: true });
        });

        it('refuses production when the artifact cannot be downloaded', async () => {
            client.exchange.downloadAppJar.mockRejectedValue(new Error('403 Forbidden'));
            const body = parse(await handlers.get('update_app_artifact')!(args));
            expect(body.refused).toBe(true);
            expect(body.blockers[0]).toContain('could not download');
        });

        it('binds jarPath to the deployed artifact by SHA-256, in any environment', async () => {
            const jarPath = path.join(dir, 'orders-sapi.jar');
            fs.writeFileSync(jarPath, jarBytes(marker(true)));
            client.accessManagement.resolveEnvironment.mockResolvedValue(sandbox);
            client.exchange.downloadAppJar.mockResolvedValue(
                exchangeJar(Buffer.concat([jarBytes(marker(true)), Buffer.from('x')])),
            );
            const mismatch = parse(
                await handlers.get('update_app_artifact')!({ ...args, environment: 'Sandbox', jarPath, confirm: true }),
            );
            expect(mismatch.blockers[0]).toContain('is not the artifact being deployed');
            expect(writes()).toBe(0);

            client.exchange.downloadAppJar.mockResolvedValue(exchangeJar(fs.readFileSync(jarPath)));
            const ok = await handlers.get('update_app_artifact')!({
                ...args,
                environment: 'Sandbox',
                jarPath,
                confirm: true,
            });
            expect(ok.isError).toBeUndefined();
            expect(client.cloudHub2.patchDeployment).toHaveBeenCalledTimes(1);
        });

        it('regression: with jarPath, a failed download or MD5 mismatch refuses the change outside production too', async () => {
            const jarPath = path.join(dir, 'orders-sapi.jar');
            fs.writeFileSync(jarPath, jarBytes(marker(true)));
            client.accessManagement.resolveEnvironment.mockResolvedValue(sandbox);
            const input = { ...args, environment: 'Sandbox', jarPath, confirm: true };

            client.exchange.downloadAppJar.mockRejectedValue(new Error('403 Forbidden'));
            const failed = parse(await handlers.get('update_app_artifact')!(input));
            expect(failed.refused).toBe(true);
            expect(failed.blockers[0]).toContain('could not download');

            client.exchange.downloadAppJar.mockResolvedValue({
                ...exchangeJar(fs.readFileSync(jarPath)),
                md5Matches: false,
            });
            const corrupt = parse(await handlers.get('update_app_artifact')!(input));
            expect(corrupt.refused).toBe(true);
            expect(corrupt.blockers[0]).toContain('MD5');
            expect(writes()).toBe(0);
        });

        it('does not download outside production without jarPath', async () => {
            client.accessManagement.resolveEnvironment.mockResolvedValue(sandbox);
            await handlers.get('update_app_artifact')!({ ...args, environment: 'Sandbox' });
            expect(client.exchange.downloadAppJar).not.toHaveBeenCalled();
        });
    });

    describe('policy tools', () => {
        it('set_production_preapproval previews, writes by ID on confirm, and clears', async () => {
            const input = { environment: 'Production', tools: ['update_app'], expires: FUTURE };
            const preview = parse(await handlers.get('set_production_preapproval')!(input));
            expect(preview).toMatchObject({
                dryRun: true,
                entry: { ...scope, environmentName: 'Production', tools: ['update_app'], expires: FUTURE },
            });
            expect(readApprovalState().productionPreapprovals).toEqual([]);

            const set = parse(await handlers.get('set_production_preapproval')!({ ...input, confirm: true }));
            expect(set.productionPolicy.productionPreapprovals[0]).toMatchObject({ ...scope, tools: ['update_app'] });
            expect(fs.existsSync(path.join(dir, '.anypoint-connect.json'))).toBe(false);

            const shown = parse(await handlers.get('get_project_profile')!({}));
            expect(shown.productionPolicy.productionPreapprovals).toHaveLength(1);
            client.whoami.mockResolvedValue({
                firstName: 'Sample',
                lastName: 'User',
                username: 'sample',
                email: 'sample@example.com',
                organization: { id: ORG, name: 'Sample Org' },
            });
            expect(parse(await handlers.get('whoami')!({})).productionPolicy.productionPreapprovals).toHaveLength(1);

            await handlers.get('set_production_preapproval')!({
                environment: 'Production',
                clear: true,
                confirm: true,
            });
            expect(readApprovalState().productionPreapprovals).toEqual([]);
        });

        it('refuses a non-production environment', async () => {
            client.accessManagement.resolveEnvironment.mockResolvedValue(sandbox);
            const result = await handlers.get('set_production_preapproval')!({
                environment: 'Sandbox',
                tools: 'all-mutating',
                confirm: true,
            });
            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain('not a production environment');
        });

        it('set_unmarked_artifact_allowance writes and clears an allowance', async () => {
            await handlers.get('set_unmarked_artifact_allowance')!({ environment: 'Production', confirm: true });
            expect(checkUnmarkedAllowance({ orgId: ORG, env: production }).unmarkedAllowed).toBe(true);
            await handlers.get('set_unmarked_artifact_allowance')!({
                environment: 'Production',
                clear: true,
                confirm: true,
            });
            expect(checkUnmarkedAllowance({ orgId: ORG, env: production }).unmarkedAllowed).toBe(false);
        });

        it('regression: set_project_profile updates the nearest project file instead of shadowing it', async () => {
            fs.writeFileSync(
                path.join(dir, '.anypoint-connect.json'),
                JSON.stringify({ profile: 'a', conventions: { assetVersion: '{pomVersion}' } }),
            );
            const child = path.join(dir, 'nested');
            fs.mkdirSync(child);
            vi.spyOn(process, 'cwd').mockReturnValue(child);
            await handlers.get('set_project_profile')!({ profile: 'b' });
            expect(fs.existsSync(path.join(child, '.anypoint-connect.json'))).toBe(false);
            expect(JSON.parse(fs.readFileSync(path.join(dir, '.anypoint-connect.json'), 'utf8'))).toEqual({
                profile: 'b',
                conventions: { assetVersion: '{pomVersion}' },
            });
        });
    });
});
