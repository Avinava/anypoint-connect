import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const question = vi.hoisted(() => vi.fn());
vi.mock('readline', () => ({
    createInterface: () => ({ question, close: vi.fn() }),
}));

import { checkPreapproval, readPreapproval, validatePreapproval } from '../../src/safety/preapproval.js';
import { confirmProductionWrite } from '../../src/safety/guards.js';
import { registerAppDeployTools } from '../../src/mcp/tools/apps-deploy.js';
import { registerAppLifecycleTools } from '../../src/mcp/tools/apps-lifecycle.js';
import { registerProfileTools } from '../../src/mcp/tools/profile.js';

const production = { id: 'env-prod', name: 'Production', isProduction: true };
const FUTURE = '2999-01-01T00:00:00Z';
const PAST = '2000-01-01T00:00:00Z';

let dir: string;
function writeConfig(content: Record<string, unknown>) {
    fs.writeFileSync(path.join(dir, '.anypoint-connect.json'), JSON.stringify(content));
}

beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'anc-preapproval-')));
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    question.mockReset();
});
afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('productionPreapproval rules', () => {
    it('validates names, tools and expiry', () => {
        expect(validatePreapproval({ environments: ['Production'], tools: 'all-mutating' })).toEqual({
            environments: ['Production'],
            tools: 'all-mutating',
        });
        expect(() => validatePreapproval({ environments: ['Prod*'], tools: ['update_app'] })).toThrow('wildcards');
        expect(() => validatePreapproval({ environments: ['Production'], tools: ['list_apps'] })).toThrow(
            'not a pre-approvable tool',
        );
        expect(() => validatePreapproval({ environments: [], tools: ['update_app'] })).toThrow('environments');
        expect(() =>
            validatePreapproval({ environments: ['Production'], tools: ['update_app'], expires: 'soon' }),
        ).toThrow('expires');
        expect(() => validatePreapproval({ environments: ['Production'], tools: ['update_app'], extra: 1 })).toThrow(
            'unknown fields',
        );
    });

    it('covers only the named environment and tool', () => {
        writeConfig({
            productionPreapproval: { environments: ['production'], tools: ['update_app'], expires: FUTURE },
        });
        expect(checkPreapproval(production, 'update_app')).toMatchObject({
            productionPreapproved: true,
            preapprovalExpires: FUTURE,
        });
        expect(checkPreapproval(production, 'update_app').preapprovalSource).toContain('.anypoint-connect.json');
        expect(checkPreapproval(production, 'deploy_jar').productionPreapproved).toBe(false);
        expect(checkPreapproval({ name: 'Production EU' }, 'update_app').productionPreapproved).toBe(false);
    });

    it('ignores expired entries and invalid entries', () => {
        writeConfig({
            productionPreapproval: [
                { environments: ['Production'], tools: 'all-mutating', expires: PAST },
                { environments: ['Production*'], tools: 'all-mutating' },
            ],
        });
        const state = readPreapproval();
        expect(state.entries).toHaveLength(1);
        expect(state.entries[0].expired).toBe(true);
        expect(state.invalid).toHaveLength(1);
        expect(checkPreapproval(production, 'update_app').productionPreapproved).toBe(false);
    });

    it('all-mutating does not cover delete_app unless it is named', () => {
        writeConfig({ productionPreapproval: { environments: ['Production'], tools: 'all-mutating' } });
        expect(checkPreapproval(production, 'restart_app').productionPreapproved).toBe(true);
        expect(checkPreapproval(production, 'delete_app').productionPreapproved).toBe(false);
        writeConfig({ productionPreapproval: { environments: ['Production'], tools: ['delete_app'] } });
        expect(checkPreapproval(production, 'delete_app').productionPreapproved).toBe(true);
    });
});

describe('CLI production prompt', () => {
    it('skips the typed phrase only when the setting covers the tool and environment', async () => {
        writeConfig({ productionPreapproval: { environments: ['Production'], tools: ['deploy_jar'] } });
        vi.spyOn(console, 'log').mockImplementation(() => undefined);

        expect(await confirmProductionWrite(production, 'deploy_jar')).toBe(true);
        expect(question).not.toHaveBeenCalled();

        question.mockImplementation((_prompt: string, answer: (value: string) => void) => answer('no'));
        expect(await confirmProductionWrite(production, 'update_app')).toBe(false);
        expect(question).toHaveBeenCalledTimes(1);
    });

    it('prompts when the entry has expired', async () => {
        writeConfig({ productionPreapproval: { environments: ['Production'], tools: ['deploy_jar'], expires: PAST } });
        question.mockImplementation((_prompt: string, answer: (value: string) => void) =>
            answer('deploy to production'),
        );
        expect(await confirmProductionWrite(production, 'deploy_jar')).toBe(true);
        expect(question).toHaveBeenCalledTimes(1);
    });
});

describe('MCP production writes with pre-approval', () => {
    const SERVICE = 'mule.agent.application.properties.service';
    const ref = { groupId: 'org-1', artifactId: 'orders-sapi', version: '1.0.0', packaging: 'jar' };
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
    const handlers = new Map<string, (input: any) => Promise<any>>();
    const server = {
        registerTool: vi.fn((name: string, _d: unknown, h: (input: any) => Promise<any>) => handlers.set(name, h)),
    };
    const client = {
        getDefaultOrgId: vi.fn(),
        accessManagement: { resolveEnvironment: vi.fn() },
        runtimes: { getTarget: vi.fn() },
        cloudHub2: {
            findDetailByName: vi.fn(),
            patchDeployment: vi.fn(),
            setDesiredState: vi.fn(),
            getDeployment: vi.fn(),
        },
    };
    const parse = (result: any) => JSON.parse(result.content[0].text);
    const args = { appName: 'orders-sapi', environment: 'Production', version: '1.1.0', wait: false };

    beforeEach(() => {
        handlers.clear();
        client.getDefaultOrgId.mockResolvedValue('org-1');
        client.accessManagement.resolveEnvironment.mockResolvedValue(production);
        client.runtimes.getTarget.mockResolvedValue(null);
        client.cloudHub2.findDetailByName.mockResolvedValue(detail());
        client.cloudHub2.patchDeployment.mockReset().mockResolvedValue({ ...detail(), desiredVersion: 'spec-2' });
        registerAppDeployTools(server as any, client as any);
        registerAppLifecycleTools(server as any, client as any);
        registerProfileTools(server as any);
    });

    it('a covered env and tool applies without confirmProduction, and says so', async () => {
        writeConfig({ productionPreapproval: { environments: ['Production'], tools: ['update_app_artifact'] } });
        const preview = parse(await handlers.get('update_app_artifact')!(args));
        expect(preview).toMatchObject({
            dryRun: true,
            production: true,
            productionPreapproved: true,
            requires: 'confirm: true',
        });
        expect(preview.preapprovalSource).toContain('.anypoint-connect.json');

        const result = await handlers.get('update_app_artifact')!({ ...args, confirm: true });
        expect(result.isError).toBeUndefined();
        expect(client.cloudHub2.patchDeployment).toHaveBeenCalledTimes(1);
        expect(parse(result)).toMatchObject({ production: true, productionPreapproved: true });
    });

    it('still requires confirm', async () => {
        writeConfig({ productionPreapproval: { environments: ['Production'], tools: 'all-mutating' } });
        await handlers.get('update_app_artifact')!(args);
        expect(client.cloudHub2.patchDeployment).not.toHaveBeenCalled();
    });

    it.each([
        ['an uncovered tool', { environments: ['Production'], tools: ['update_app'] }],
        ['an uncovered environment', { environments: ['Production EU'], tools: ['update_app_artifact'] }],
        ['an expired entry', { environments: ['Production'], tools: ['update_app_artifact'], expires: PAST }],
    ])('%s still needs confirmProduction', async (_name, entry) => {
        writeConfig({ productionPreapproval: entry });
        const refused = await handlers.get('update_app_artifact')!({ ...args, confirm: true });
        expect(refused.isError).toBe(true);
        expect(parse(refused)).toMatchObject({ refused: true, productionPreapproved: false });
        expect(client.cloudHub2.patchDeployment).not.toHaveBeenCalled();
    });

    it('never waives the stripped-artifact refusal', async () => {
        writeConfig({ productionPreapproval: { environments: ['Production'], tools: 'all-mutating' } });
        const jarPath = path.join(dir, 'sample.jar');
        fs.writeFileSync(
            jarPath,
            zipSync({
                'META-INF/mule-build/build-info.json': strToU8(
                    JSON.stringify({
                        schemaVersion: 1,
                        tool: 'mule-build',
                        toolVersion: '3.2.0',
                        stripped: true,
                        productionDeployable: false,
                    }),
                ),
            }),
        );
        for (const tool of ['update_app_artifact', 'update_app']) {
            const result = await handlers.get(tool)!({ ...args, jarPath, confirm: true, confirmProduction: true });
            expect(result.isError).toBe(true);
            expect(parse(result).blockers[0]).toContain('cannot go to a production environment');
        }
        expect(client.cloudHub2.patchDeployment).not.toHaveBeenCalled();
    });

    it('set_project_profile previews, then writes and clears the pre-approval on confirm', async () => {
        writeConfig({ profile: 'sample', conventions: { assetVersion: '{pomVersion}' } });
        const entry = { environments: ['Production'], tools: ['update_app'], expires: FUTURE };
        const preview = parse(await handlers.get('set_project_profile')!({ productionPreapproval: entry }));
        expect(preview).toMatchObject({ dryRun: true, action: 'set production pre-approval', next: [entry] });
        expect(readPreapproval().entries).toHaveLength(0);

        const set = parse(await handlers.get('set_project_profile')!({ productionPreapproval: entry, confirm: true }));
        expect(set.productionPreapproval.active).toEqual([entry]);
        const file = JSON.parse(fs.readFileSync(path.join(dir, '.anypoint-connect.json'), 'utf8'));
        expect(file).toMatchObject({ profile: 'sample', conventions: { assetVersion: '{pomVersion}' } });

        const shown = parse(await handlers.get('get_project_profile')!({}));
        expect(shown.productionPreapproval.active).toEqual([entry]);

        await handlers.get('set_project_profile')!({ clearProductionPreapproval: true, confirm: true });
        expect(
            JSON.parse(fs.readFileSync(path.join(dir, '.anypoint-connect.json'), 'utf8')).productionPreapproval,
        ).toBeUndefined();
    });

    it('set_project_profile rejects a wildcard environment', async () => {
        const result = await handlers.get('set_project_profile')!({
            productionPreapproval: { environments: ['Prod*'], tools: ['update_app'] },
            confirm: true,
        });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('wildcards');
    });
});
