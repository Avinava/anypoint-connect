/**
 * Tests for shared deployment payload logic
 */
import { describe, it, expect } from 'vitest';
import {
    buildCreatePayload,
    mergeForArtifactUpdate,
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
            replicas: [
                { id: 'r1', state: 'STARTED' },
                { id: 'r2', state: 'STARTED' },
            ],
        },
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
        expect(
            p.application.configuration?.['mule.agent.application.properties.service']?.properties,
        ).toEqual({ DB_URL: 'x' });
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
        const next = buildCreatePayload({ ...baseInput, version: '1.4.12', runtime: '4.9.18', region: 'private-space-abc' });
        const changes = diffDeployment(existing, next).map((c) => c.field);
        expect(changes).not.toContain('runtime');
        expect(changes).not.toContain('targetId');
        expect(changes).toContain('version');
    });
});
