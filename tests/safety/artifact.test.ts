import { createHash } from 'node:crypto';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { inspectArtifact, verifyArtifactDigest } from '../../src/safety/artifact.js';

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
