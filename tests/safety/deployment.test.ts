/**
 * Tests for shared deployment payload logic
 */
import { describe, it, expect } from 'vitest';
import {
    buildCreatePayload,
    mergeForArtifactUpdate,
    planSettingsChange,
    resolveRollbackTarget,
    diffDeployment,
    parseVcores,
    regionToSubdomain,
    DEFAULT_RUNTIME,
    DEFAULT_REGION,
    type DeploymentInput,
} from '../../src/safety/deployment.js';
import type { CH2Deployment } from '../../src/api/CloudHub2Api.js';

const baseInput: DeploymentInput = {
    appName: 'example-api',
    groupId: 'org-123',
    artifactId: 'example-api',
    version: '1.0.0',
};

function makeExisting(overrides: Partial<CH2Deployment> = {}): CH2Deployment {
    return {
        id: 'dep-1',
        name: 'example-api',
        status: 'RUNNING',
        application: {
            ref: { groupId: 'org-123', artifactId: 'example-api', version: '1.4.11', packaging: 'jar' },
            desiredState: 'STARTED',
            vCores: 0.5,
        },
        target: {
            provider: 'MC',
            targetId: 'private-space-abc',
            deploymentSettings: {
                runtime: { version: '4.9.18' },
                updateStrategy: 'rolling',
                clustered: true,
            },
            replicas: 2,
        },
        replicas: [
            { id: 'r1', state: 'STARTED' },
            { id: 'r2', state: 'STARTED' },
        ],
        ...overrides,
    };
}

describe('parseVcores', () => {
    it('returns undefined for undefined input', () => {
        expect(parseVcores(undefined)).toBeUndefined();
    });

    it('parses a valid size to a number', () => {
        expect(parseVcores('0.5')).toBe(0.5);
        expect(parseVcores('2')).toBe(2);
    });

    it('throws on an invalid size', () => {
        expect(() => parseVcores('0.3')).toThrow(/Invalid vCore size/);
    });
});

describe('regionToSubdomain', () => {
    it('maps a known region', () => {
        expect(regionToSubdomain('cloudhub-us-east-2')).toBe('us-e2');
    });

    it('falls back for an unknown region', () => {
        expect(regionToSubdomain('cloudhub-mars-1')).toBe('mars1');
    });
});

describe('buildCreatePayload', () => {
    it('applies defaults for runtime, region, and replicas', () => {
        const p = buildCreatePayload(baseInput);
        expect(p.target.deploymentSettings.runtime.version).toBe(DEFAULT_RUNTIME);
        expect(p.target.targetId).toBe(DEFAULT_REGION);
        expect(p.replicas ?? p.target.replicas).toBe(1);
        expect(p.application.ref.packaging).toBe('jar');
    });

    it('writes vcores into application.vCores (regression: was a silent no-op)', () => {
        const p = buildCreatePayload({ ...baseInput, vcores: '2' });
        expect(p.application.vCores).toBe(2);
    });

    it('computes the public URL from the region subdomain', () => {
        const p = buildCreatePayload({ ...baseInput, region: 'cloudhub-eu-west-1' });
        expect(p.target.deploymentSettings.http?.inbound?.publicUrl).toBe('example-api.eu-w1.cloudhub.io');
    });

    it('nests properties under the mule agent config key', () => {
        const p = buildCreatePayload({ ...baseInput, properties: { DB_URL: 'x' } });
        expect(p.application.configuration?.['mule.agent.application.properties.service']?.properties).toEqual({
            DB_URL: 'x',
        });
    });

    it('always sends the properties service, empty when there are no properties', () => {
        const p = buildCreatePayload(baseInput);
        expect(p.application.configuration?.['mule.agent.application.properties.service']).toEqual({
            applicationName: baseInput.appName,
            properties: {},
            secureProperties: {},
        });
    });
});

describe('mergeForArtifactUpdate', () => {
    it('returns ONLY application.ref — no runtime, target, or replicas (core regression)', () => {
        const existing = makeExisting();
        const payload = mergeForArtifactUpdate(existing, { version: '1.4.12' });

        // The whole point: the update body must not carry infra that would clobber prod.
        expect(Object.keys(payload)).toEqual(['application']);
        expect(Object.keys(payload.application)).toEqual(['ref']);
        const serialized = JSON.stringify(payload);
        expect(serialized).not.toContain('runtime');
        expect(serialized).not.toContain('targetId');
        expect(serialized).not.toContain('replicas');
    });

    it('fills omitted ref fields from the existing deployment', () => {
        const existing = makeExisting();
        const payload = mergeForArtifactUpdate(existing, { version: '1.4.12' });
        expect(payload.application.ref).toEqual({
            groupId: 'org-123',
            artifactId: 'example-api',
            version: '1.4.12',
            packaging: 'jar',
        });
    });

    it('lets the caller override any ref field', () => {
        const existing = makeExisting();
        const payload = mergeForArtifactUpdate(existing, { groupId: 'org-999', version: '2.0.0' });
        expect(payload.application.ref.groupId).toBe('org-999');
        expect(payload.application.ref.artifactId).toBe('example-api');
    });
});

describe('resolveRollbackTarget', () => {
    const spec = (id: string, artifactId: string, version: string) => ({
        version: id,
        application: {
            ref: { groupId: 'org-123', artifactId, version, packaging: 'jar' },
            desiredState: 'STARTED',
        },
        target: {
            provider: 'MC',
            targetId: 'private-space-abc',
            deploymentSettings: { runtime: { version: '4.9.18' } },
            replicas: 2,
        },
    });

    it('uses the last successful spec ref after a failed desired spec', () => {
        const existing = makeExisting({ desiredVersion: 'spec-new', lastSuccessfulVersion: 'spec-good' });
        const target = resolveRollbackTarget(existing, [
            spec('spec-new', 'example-api', '1.4.11'),
            spec('spec-good', 'example-api', '1.4.10'),
        ]);
        expect(target).toEqual({
            ref: { groupId: 'org-123', artifactId: 'example-api', version: '1.4.10', packaging: 'jar' },
            sourceSpecId: 'spec-good',
        });
    });

    it('skips lifecycle-only specs and selects the newest distinct artifact ref', () => {
        const existing = makeExisting({ desiredVersion: 'spec-current', lastSuccessfulVersion: 'spec-current' });
        const target = resolveRollbackTarget(existing, [
            spec('spec-current', 'example-api', '1.4.11'),
            spec('spec-stop', 'example-api', '1.4.11'),
            spec('spec-previous', 'example-api-build-2', '1.0.0'),
        ]);
        expect(target?.ref.artifactId).toBe('example-api-build-2');
        expect(target?.sourceSpecId).toBe('spec-previous');
    });

    it('resolves an explicit artifact version from history', () => {
        const existing = makeExisting({ desiredVersion: 'spec-current' });
        const target = resolveRollbackTarget(
            existing,
            [spec('spec-current', 'example-api', '1.4.11'), spec('spec-match', 'example-api-build-1', '1.2.0')],
            '1.2.0',
        );
        expect(target?.ref.artifactId).toBe('example-api-build-1');
    });

    it('returns null when history contains no distinct target', () => {
        const existing = makeExisting({ desiredVersion: 'spec-current' });
        expect(resolveRollbackTarget(existing, [spec('spec-current', 'example-api', '1.4.11')])).toBeNull();
    });
});

describe('planSettingsChange', () => {
    const withSettings = (properties: Record<string, string>, secureProperties: Record<string, string>) =>
        makeExisting({
            application: {
                ref: { groupId: 'org-123', artifactId: 'example-api', version: '1.4.11', packaging: 'jar' },
                desiredState: 'STARTED',
                configuration: {
                    'mule.agent.application.properties.service': {
                        applicationName: 'example-api',
                        properties,
                        secureProperties,
                    },
                    'mule.agent.logging.service': { scopeLoggingConfigurations: [] },
                },
            },
        });

    it('keeps untouched plain and masked secure values while overlaying changes', () => {
        const existing = withSettings(
            { environment: 'test', unchanged: 'yes' },
            { credential: '******', token: '******' },
        );
        const plan = planSettingsChange(existing, {
            properties: { environment: 'staging' },
            secureProperties: { credential: 'replacement' },
        });
        expect(plan.service).toEqual({
            applicationName: 'example-api',
            properties: { environment: 'staging', unchanged: 'yes' },
            secureProperties: { credential: 'replacement', token: '******' },
        });
        expect(plan.diff.changed).toEqual([{ key: 'environment', from: 'test', to: 'staging' }]);
        expect(plan.diff.secureChanged).toEqual(['credential']);
        expect(plan.changed).toBe(true);
    });

    it('adds one secret without touching the others', () => {
        const existing = withSettings({}, { first: '******', second: '******' });
        const plan = planSettingsChange(existing, { secureProperties: { third: 'value-3' } });
        expect(plan.service.secureProperties).toEqual({ first: '******', second: '******', third: 'value-3' });
        expect(plan.diff.secureAdded).toEqual(['third']);
    });

    it('removes plain and secure keys by sending the full maps without them', () => {
        const existing = withSettings({ keep: '1', drop: '2' }, { gone: '******', stays: '******' });
        const plan = planSettingsChange(existing, { removeProperties: ['drop'], removeSecureProperties: ['gone'] });
        expect(plan.service.properties).toEqual({ keep: '1' });
        expect(plan.service.secureProperties).toEqual({ stays: '******' });
        expect(plan.diff.removed).toEqual(['drop']);
        expect(plan.diff.secureRemoved).toEqual(['gone']);
    });

    it('moves a plain value to secure on the server without echoing it', () => {
        const existing = withSettings({ 'db.password': 'plain-secret-value' }, {});
        const plan = planSettingsChange(existing, { moveToSecure: ['db.password'] });
        expect(plan.service.properties).toEqual({});
        expect(plan.service.secureProperties).toEqual({ 'db.password': 'plain-secret-value' });
        expect(JSON.stringify(plan.diff)).not.toContain('plain-secret-value');
        expect(plan.diff.movedToSecure).toEqual(['db.password']);
    });

    it('masks secret-looking plain values in the diff and warns', () => {
        const existing = withSettings({}, {});
        const plan = planSettingsChange(existing, { properties: { 'api.token': 'abcdefghijkl' } });
        expect(plan.diff.added).toEqual([{ key: 'api.token', to: '******…kl' }]);
        expect(plan.warnings.join(' ')).toContain('looks like a secret');
    });

    it('rejects contradictory or unsafe changes', () => {
        const existing = withSettings({ plain: 'x' }, { stored: '******' });
        expect(() => planSettingsChange(existing, { secureProperties: { missing: '******' } })).toThrow(
            /no secure property/,
        );
        expect(() => planSettingsChange(existing, { properties: { a: '1' }, secureProperties: { a: '2' } })).toThrow(
            /both/,
        );
        expect(() => planSettingsChange(existing, { secureProperties: { plain: 'y' } })).toThrow(/moveToSecure/);
        expect(() => planSettingsChange(existing, { moveToSecure: ['absent'] })).toThrow(/no plain property/);
        expect(() => planSettingsChange(existing, { properties: { plain: 'y' }, removeProperties: ['plain'] })).toThrow(
            /set and removed/,
        );
    });

    it('treats resending a masked value and removing an absent key as no change', () => {
        const existing = withSettings({}, { stored: '******' });
        const plan = planSettingsChange(existing, {
            secureProperties: { stored: '******' },
            removeProperties: ['absent'],
        });
        expect(plan.changed).toBe(false);
        expect(plan.warnings).toEqual(['"absent" is not a plain property; nothing to remove']);
    });
});

describe('diffDeployment', () => {
    it('flags a runtime downgrade that a create-style payload would cause', () => {
        const existing = makeExisting();
        const next = buildCreatePayload(baseInput); // defaults runtime to 4.8.0, region to us-east-2
        const changes = diffDeployment(existing, next);
        const fields = changes.map((c) => c.field);
        expect(fields).toContain('runtime'); // 4.9.18 -> 4.8.0
        expect(fields).toContain('targetId'); // private-space-abc -> cloudhub-us-east-2
    });

    it('reports no infra changes for a ref-only update mapped onto the same infra', () => {
        const existing = makeExisting();
        // Simulate the server-preserving update: runtime/target unchanged, only version differs.
        const next = buildCreatePayload({
            ...baseInput,
            version: '1.4.12',
            runtime: '4.9.18',
            region: 'private-space-abc',
        });
        const changes = diffDeployment(existing, next).map((c) => c.field);
        expect(changes).not.toContain('runtime');
        expect(changes).not.toContain('targetId');
        expect(changes).toContain('version');
    });
});
