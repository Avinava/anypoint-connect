import { describe, expect, it } from 'vitest';
import type { CH2Deployment } from '../../src/api/CloudHub2Api.js';
import {
    assertDeploymentUnchanged,
    canonicalJson,
    checkReviewedPlan,
    digestOf,
} from '../../src/safety/plan-binding.js';

const deployment = (overrides: Record<string, unknown> = {}) =>
    ({
        id: 'dep-1',
        name: 'orders-sapi',
        application: { desiredState: 'STARTED', ref: { groupId: 'g', artifactId: 'a', version: '1.0.0' } },
        target: { replicas: 1, deploymentSettings: { runtime: { version: '4.9.0' }, updateStrategy: 'rolling' } },
        desiredVersion: 'spec-1',
        lastModifiedDate: 1000,
        ...overrides,
    }) as unknown as CH2Deployment;

describe('digestOf', () => {
    it('is the same for the same data in any key order, and differs when a value differs', () => {
        expect(digestOf({ a: 1, b: { c: [1, 2], d: 'x' } })).toBe(digestOf({ b: { d: 'x', c: [1, 2] }, a: 1 }));
        expect(digestOf({ a: 1 })).not.toBe(digestOf({ a: 2 }));
        expect(digestOf({ a: [1, 2] })).not.toBe(digestOf({ a: [2, 1] }));
        expect(digestOf({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
    });

    it('ignores undefined fields, as JSON does', () => {
        expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
    });
});

describe('checkReviewedPlan', () => {
    it('requires the digest from the preview', () => {
        expect(checkReviewedPlan(undefined, 'abc')).toMatch(/planDigest is required/);
        expect(checkReviewedPlan('', 'abc')).toMatch(/planDigest is required/);
    });
    it('refuses a digest from a different plan', () => {
        expect(checkReviewedPlan('old', 'new')).toMatch(/differs from the one you reviewed/);
    });
    it('accepts the matching digest', () => {
        expect(checkReviewedPlan('abc', 'abc')).toBeNull();
    });
});

describe('assertDeploymentUnchanged', () => {
    it('accepts an identical deployment', () => {
        expect(() => assertDeploymentUnchanged(deployment(), deployment())).not.toThrow();
    });

    it('refuses a recreated deployment (new id)', () => {
        expect(() => assertDeploymentUnchanged(deployment(), deployment({ id: 'dep-2' }))).toThrow(
            /changed after review/,
        );
    });

    it('refuses a changed revision or modified time', () => {
        expect(() => assertDeploymentUnchanged(deployment(), deployment({ desiredVersion: 'spec-2' }))).toThrow(
            /changed after review/,
        );
        expect(() => assertDeploymentUnchanged(deployment(), deployment({ lastModifiedDate: 2000 }))).toThrow(
            /changed after review/,
        );
    });

    it('compares the state itself when revision fields are missing, and does not trust silence', () => {
        const bare = (overrides: Record<string, unknown> = {}) =>
            deployment({ desiredVersion: undefined, lastModifiedDate: undefined, ...overrides });
        expect(() => assertDeploymentUnchanged(bare(), bare())).not.toThrow();
        expect(() =>
            assertDeploymentUnchanged(
                bare(),
                bare({ target: { replicas: 2, deploymentSettings: { runtime: { version: '4.9.0' } } } }),
            ),
        ).toThrow(/changed after review/);
        expect(() =>
            assertDeploymentUnchanged(
                bare(),
                bare({
                    application: { desiredState: 'STOPPED', ref: { groupId: 'g', artifactId: 'a', version: '1.0.0' } },
                }),
            ),
        ).toThrow(/changed after review/);
    });
});
