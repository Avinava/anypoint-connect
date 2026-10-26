import { describe, expect, it } from 'vitest';
import type { ArtifactRef } from '../../src/api/CloudHub2Api.js';
import {
    inferConvention,
    namingTimestamp,
    renderTemplate,
    suggestAssetCoordinates,
} from '../../src/workflows/asset-naming.js';

const NOW = new Date(Date.UTC(2026, 0, 2, 3, 4, 5));
const ref = (artifactId: string, version = '1.0.0'): ArtifactRef => ({
    groupId: 'org-1',
    artifactId,
    version,
    packaging: 'jar',
});
const jar = { groupId: 'com.example', artifactId: 'orders-sapi', version: '1.5.0' };

describe('namingTimestamp', () => {
    it('formats UTC time as 14 digits', () => {
        expect(namingTimestamp(NOW)).toBe('20260102030405');
        expect(namingTimestamp()).toMatch(/^\d{14}$/);
    });
});

describe('renderTemplate', () => {
    const vars = { app: 'orders-sapi', pomVersion: '1.5.0', timestamp: '20260102030405' };

    it('fills every token', () => {
        expect(renderTemplate('{app}-{pomVersion}-{timestamp}', vars)).toBe('orders-sapi-1.5.0-20260102030405');
    });

    it('throws when a token has no value', () => {
        expect(() => renderTemplate('{app}-{gitShort}', vars)).toThrow(
            'Naming template "{app}-{gitShort}" uses {gitShort}, which has no value here',
        );
    });

    it('throws when the result is not a valid identifier', () => {
        expect(() => renderTemplate('{app} {pomVersion}', vars)).toThrow(
            'produced an invalid identifier "orders-sapi 1.5.0"',
        );
        expect(() => renderTemplate('-{app}', vars)).toThrow('invalid identifier');
    });
});

describe('inferConvention', () => {
    it('infers {app}-{pomVersion}-{timestamp} at a fixed version', () => {
        expect(inferConvention('orders-sapi', ref('orders-sapi-1.4.0-20260101120000', '1.0.0'))).toEqual({
            assetId: '{app}-{pomVersion}-{timestamp}',
            assetVersion: '1.0.0',
        });
    });

    it('infers {app} following the pom version for an app-name-only ID', () => {
        expect(inferConvention('orders-sapi', ref('orders-sapi', '1.4.0'))).toEqual({
            assetId: '{app}',
            assetVersion: '{pomVersion}',
        });
    });

    it('infers a version-suffixed ID without a timestamp', () => {
        expect(inferConvention('orders-sapi', ref('orders-sapi-1.4.0', '1.4.0'))).toEqual({
            assetId: '{app}-{pomVersion}',
            assetVersion: '{pomVersion}',
        });
    });

    it('returns undefined for an unrelated ID', () => {
        expect(inferConvention('orders-sapi', ref('billing-papi'))).toBeUndefined();
        expect(inferConvention('orders-sapi', ref('orders-sapi-v2'))).toBeUndefined();
    });
});

describe('suggestAssetCoordinates', () => {
    const existingRef = ref('orders-sapi-1.4.0-20260101120000', '1.0.0');
    const base = { app: 'orders-sapi', orgId: 'org-1', jar, existingRef, now: NOW };

    it('prefers explicit values over everything else', () => {
        const result = suggestAssetCoordinates({
            ...base,
            convention: { assetId: '{app}-{timestamp}', assetVersion: '2.0.0', groupId: 'conv-group' },
            explicit: { assetId: 'orders-sapi-custom', assetVersion: '9.9.9', groupId: 'explicit-group' },
            applyInferred: true,
        });
        expect(result).toMatchObject({
            groupId: 'explicit-group',
            assetId: 'orders-sapi-custom',
            version: '9.9.9',
            rules: { groupId: 'explicit', assetId: 'explicit', version: 'explicit' },
        });
        expect(result.convention).toBeUndefined();
    });

    it('uses the project convention before the deployed pattern', () => {
        const convention = { assetId: '{app}-{timestamp}', assetVersion: '{pomVersion}', groupId: 'conv-group' };
        const result = suggestAssetCoordinates({ ...base, convention, applyInferred: true });
        expect(result).toMatchObject({
            groupId: 'conv-group',
            assetId: 'orders-sapi-20260102030405',
            version: '1.5.0',
            rules: { groupId: 'convention', assetId: 'convention', version: 'convention' },
            convention,
        });
    });

    it('applies the inferred pattern only when applyInferred is true', () => {
        const applied = suggestAssetCoordinates({ ...base, applyInferred: true });
        expect(applied).toMatchObject({
            assetId: 'orders-sapi-1.5.0-20260102030405',
            version: '1.0.0',
            rules: { assetId: 'inferred', version: 'inferred' },
            convention: { assetId: '{app}-{pomVersion}-{timestamp}', assetVersion: '1.0.0' },
        });
        expect(applied.deployedPattern).toBeUndefined();
    });

    it('falls back to the JAR and reports the deployed pattern when not applying it', () => {
        const result = suggestAssetCoordinates(base);
        expect(result).toMatchObject({
            assetId: 'orders-sapi',
            version: '1.5.0',
            rules: { assetId: 'jar', version: 'jar' },
            deployedPattern: { assetId: '{app}-{pomVersion}-{timestamp}', assetVersion: '1.0.0' },
        });
        expect(result.convention).toBeUndefined();
    });

    it('defaults the groupId to the organization', () => {
        const result = suggestAssetCoordinates({ app: 'orders-sapi', orgId: 'org-1', jar, now: NOW });
        expect(result.groupId).toBe('org-1');
        expect(result.rules.groupId).toBe('organization');
        expect(result.deployedPattern).toBeUndefined();
    });

    it('falls through to the JAR when the inferred pattern needs a missing value', () => {
        const result = suggestAssetCoordinates({
            app: 'orders-sapi',
            orgId: 'org-1',
            jar: { ...jar, version: '' },
            existingRef,
            explicit: { assetVersion: '1.0.0' },
            applyInferred: true,
            now: NOW,
        });
        expect(result.rules.assetId).toBe('jar');
        expect(result.assetId).toBe('orders-sapi');
    });

    it('throws when nothing determines a value', () => {
        expect(() => suggestAssetCoordinates({ app: 'orders-sapi', orgId: 'org-1', now: NOW })).toThrow(
            'Cannot determine the asset ID',
        );
    });
});
