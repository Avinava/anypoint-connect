import { createHash } from 'node:crypto';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
    BUILD_INFO_PATH,
    checkBuildProvenance,
    inspectArtifact,
    readBuildProvenance,
    verifyArtifactDigest,
} from '../../src/safety/artifact.js';

function markedJar(info: unknown): Uint8Array {
    return zipSync({
        'META-INF/MANIFEST.MF': strToU8('Manifest-Version: 1.0\n'),
        [BUILD_INFO_PATH]: strToU8(typeof info === 'string' ? info : JSON.stringify(info)),
    });
}

const STRIPPED = {
    schemaVersion: 1,
    tool: 'mule-build',
    toolVersion: '3.2.0',
    stripped: true,
    productionDeployable: false,
};
const RELEASE = { ...STRIPPED, stripped: false, productionDeployable: true };

describe('build provenance marker', () => {
    it('reads a recorded marker', () => {
        expect(readBuildProvenance(markedJar(STRIPPED))).toEqual({ status: 'recorded', ...STRIPPED });
    });

    it('reports unknown provenance for a jar without a marker', () => {
        expect(readBuildProvenance(zipSync({ 'META-INF/MANIFEST.MF': strToU8('x') }))).toEqual({ status: 'unknown' });
    });

    it.each([
        ['not JSON', 'not json'],
        ['an array', '[]'],
        [
            'missing productionDeployable',
            { schemaVersion: 1, tool: 'mule-build', toolVersion: '3.2.0', stripped: true },
        ],
        ['a string flag', { ...RELEASE, productionDeployable: 'true' }],
        ['an unknown schema version', { ...RELEASE, schemaVersion: 2 }],
        ['another build tool', { ...RELEASE, tool: 'other-builder' }],
        ['stripped yet production deployable', { ...RELEASE, stripped: true, productionDeployable: true }],
        ['not stripped yet not production deployable', { ...RELEASE, stripped: false, productionDeployable: false }],
    ])('marks %s as invalid, and refuses it for production', (_name, info) => {
        const provenance = readBuildProvenance(markedJar(info));
        expect(provenance.status).toBe('invalid');
        expect(checkBuildProvenance(provenance, true, { unmarkedAllowed: true }).blocker).toContain(
            'marker is not valid',
        );
    });

    it('marks an oversized marker as invalid without reading it', () => {
        const result = readBuildProvenance(markedJar(' '.repeat(70000)));
        expect(result).toMatchObject({ status: 'invalid' });
    });

    it('refuses a non-deployable jar for production, with no override', () => {
        const check = checkBuildProvenance(readBuildProvenance(markedJar(STRIPPED)), true);
        expect(check.blocker).toContain('cannot go to a production environment');
        expect(check.blocker).toContain('stripped: true');
    });

    it('warns for a non-deployable jar outside production, and when the target is unknown', () => {
        for (const production of [false, undefined]) {
            const check = checkBuildProvenance(readBuildProvenance(markedJar(STRIPPED)), production);
            expect(check.blocker).toBeUndefined();
            expect(check.warnings[0]).toContain('not production deployable');
        }
    });

    it('refuses a jar without a marker for production by default', () => {
        const check = checkBuildProvenance({ status: 'unknown' }, true);
        expect(check.blocker).toContain('build provenance unknown');
        expect(check.provenancePolicy).toEqual({ unmarkedAllowed: false });
    });

    it('allows a jar without a marker for production with an allowance, and shows it', () => {
        const allowance = { unmarkedAllowed: true, source: 'sample-store', expires: '2999-01-01T00:00:00Z' };
        const check = checkBuildProvenance({ status: 'unknown' }, true, allowance);
        expect(check.blocker).toBeUndefined();
        expect(check.provenancePolicy).toEqual(allowance);
        expect(check.buildProvenance.note).toContain('build provenance unknown');
    });

    it('never lets an allowance admit a stripped jar', () => {
        const check = checkBuildProvenance(readBuildProvenance(markedJar(STRIPPED)), true, { unmarkedAllowed: true });
        expect(check.blocker).toContain('not production deployable');
    });

    it('only notes a jar without a marker outside production', () => {
        const check = checkBuildProvenance({ status: 'unknown' }, false);
        expect(check).toMatchObject({ warnings: [] });
        expect(check.blocker).toBeUndefined();
        expect(check.provenancePolicy).toBeUndefined();
    });

    it('passes a production-deployable jar silently', () => {
        expect(checkBuildProvenance(readBuildProvenance(markedJar(RELEASE)), true)).toEqual({
            buildProvenance: { status: 'recorded', ...RELEASE },
            provenancePolicy: { unmarkedAllowed: false },
            warnings: [],
        });
    });
});

function jar(version = '2.4.1'): Uint8Array {
    return zipSync({
        'META-INF/maven/dev.sample/sample/pom.properties': strToU8(
            `groupId=dev.sample\nartifactId=sample\nversion=${version}\n`,
        ),
    });
}

describe('artifact metadata and exact byte identity', () => {
    it('returns embedded coordinates and the exact-byte SHA-256', () => {
        const bytes = jar();
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        expect(inspectArtifact(bytes)).toEqual({
            coordinates: { groupId: 'dev.sample', artifactId: 'sample', version: '2.4.1' },
            sha256,
        });
        expect(verifyArtifactDigest(bytes, sha256.toUpperCase())).toBe(sha256);
        expect(() => verifyArtifactDigest(bytes, 'invalid')).toThrow('digest changed or is invalid');
    });

    it.each(['../other', '1.0.0?query=true', '1.0.0#fragment', '${revision}', '1.0.0%2fother'])(
        'rejects unsafe or unresolved embedded versions: %s',
        (version) => {
            expect(() => inspectArtifact(jar(version))).toThrow('invalid Maven coordinates');
        },
    );

    it('rejects oversized metadata, including the combined size of many descriptors', () => {
        expect(() =>
            inspectArtifact(zipSync({ 'META-INF/maven/dev.sample/sample/pom.properties': strToU8('x'.repeat(65537)) })),
        ).toThrow('size');
        const entries = Object.fromEntries(
            Array.from({ length: 17 }, (_, index) => [
                `META-INF/maven/dev.sample/sample${index}/pom.properties`,
                strToU8('x'.repeat(65536)),
            ]),
        );
        expect(() => inspectArtifact(zipSync(entries))).toThrow('size');
    });

    it('rejects inconsistent metadata paths', () => {
        expect(() =>
            inspectArtifact(
                zipSync({
                    'META-INF/maven/dev.sample/other/pom.properties': strToU8(
                        'groupId=dev.sample\nartifactId=sample\nversion=1.0.0',
                    ),
                }),
            ),
        ).toThrow('does not match');
    });

    it('rejects duplicate metadata paths before a ZIP reader can overwrite them', () => {
        const bytes = Buffer.from(
            zipSync({
                'META-INF/maven/dev.sample/sample/pom.properties': strToU8(
                    'groupId=dev.sample\nartifactId=sample\nversion=1.0.0',
                ),
                'META-INF/maven/dev.sample/second/pom.properties': strToU8(
                    'groupId=dev.sample\nartifactId=second\nversion=1.0.0',
                ),
            }),
        );
        const duplicated = Buffer.from(bytes.toString('latin1').replaceAll('/second/', '/sample/'), 'latin1');
        expect(() => inspectArtifact(duplicated)).toThrow('duplicate Maven metadata');
    });
});
