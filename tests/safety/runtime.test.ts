import { describe, expect, it } from 'vitest';
import type { RuntimeVersion } from '../../src/api/RuntimesApi.js';
import { compareVersions, parseRuntimeString, resolveRuntime, suggestRuntimes } from '../../src/safety/runtime.js';

const v = (version: string, releaseChannel: string | undefined, java: string[]): RuntimeVersion => ({
    version,
    ...(releaseChannel ? { releaseChannel } : {}),
    java,
});

const catalog: RuntimeVersion[] = [
    v('4.6.20', 'LTS', ['8', '17']),
    v('4.8.3', 'EDGE', ['17']),
    v('4.9.2', 'LTS', ['17']),
    v('4.9.10', 'LTS', ['17']),
    v('4.9.11', 'EDGE', ['17']),
    v('4.10.1', 'EDGE', ['17', '21']),
];

describe('parseRuntimeString', () => {
    it('splits the base version and reads the Java version from the tag', () => {
        expect(parseRuntimeString('4.8.5:4e-java8')).toEqual({ version: '4.8.5', java: '8' });
        expect(parseRuntimeString('4.9.0:12e-java17')).toEqual({ version: '4.9.0', java: '17' });
    });

    it('prefers an explicit Java version and omits java when unknown', () => {
        expect(parseRuntimeString('4.8.5:4e-java8', '17')).toEqual({ version: '4.8.5', java: '17' });
        expect(parseRuntimeString('4.9.0')).toEqual({ version: '4.9.0' });
    });
});

describe('compareVersions', () => {
    it('compares numerically, segment by segment', () => {
        expect(compareVersions('4.9.10', '4.9.2')).toBeGreaterThan(0);
        expect(compareVersions('4.9.2', '4.10.0')).toBeLessThan(0);
        expect(compareVersions('4.9.0', '4.9.0')).toBe(0);
    });

    it('treats missing segments as zero', () => {
        expect(compareVersions('4.9', '4.9.0')).toBe(0);
        expect(compareVersions('4.9', '4.9.1')).toBeLessThan(0);
    });
});

describe('resolveRuntime', () => {
    it('resolves an exact version', () => {
        expect(resolveRuntime(catalog, { version: '4.9.2' })?.version).toBe('4.9.2');
    });

    it('picks the newest patch for a minor prefix', () => {
        expect(resolveRuntime(catalog, { version: '4.9' })?.version).toBe('4.9.11');
    });

    it('does not let "4.1" match "4.10.x"', () => {
        expect(resolveRuntime(catalog, { version: '4.1' })).toBeUndefined();
    });

    it('filters by release channel, case-insensitively', () => {
        expect(resolveRuntime(catalog, { version: '4.9', releaseChannel: 'lts' })?.version).toBe('4.9.10');
        expect(resolveRuntime(catalog, { version: '4.8', releaseChannel: 'LTS' })).toBeUndefined();
    });

    it('filters by Java version', () => {
        expect(resolveRuntime(catalog, { version: '4.6', java: '8' })?.version).toBe('4.6.20');
        expect(resolveRuntime(catalog, { version: '4.9', java: '8' })).toBeUndefined();
        expect(resolveRuntime(catalog, { version: '4.10', java: '21' })?.version).toBe('4.10.1');
    });

    it('accepts any Java when the catalog entry lists none', () => {
        expect(resolveRuntime([v('4.9.0', 'LTS', [])], { version: '4.9', java: '8' })?.version).toBe('4.9.0');
    });

    it('returns undefined for a version the target does not offer', () => {
        expect(resolveRuntime(catalog, { version: '4.4.0' })).toBeUndefined();
    });
});

describe('suggestRuntimes', () => {
    it('orders same minor first, then the next LTS, then the newest', () => {
        expect(suggestRuntimes(catalog, { version: '4.9.0', java: '17' })).toEqual([
            '4.9.11 EDGE java17',
            '4.9.2 LTS java17',
            '4.10.1 EDGE java17',
        ]);
    });

    it('suggests the next LTS when the minor is gone', () => {
        expect(suggestRuntimes(catalog, { version: '4.7.0', java: '17' })).toEqual([
            '4.9.2 LTS java17',
            '4.10.1 EDGE java17',
        ]);
    });

    it('keeps Java 8 when the catalog still offers it', () => {
        expect(suggestRuntimes(catalog, { version: '4.6.3', java: '8' })).toEqual(['4.6.20 LTS java8']);
    });

    it('falls back to Java 17 when no Java 8 runtime is offered', () => {
        const java17Only = catalog.filter((entry) => entry.version !== '4.6.20');
        expect(suggestRuntimes(java17Only, { version: '4.8.5', java: '8' })).toEqual([
            '4.8.3 EDGE java17',
            '4.9.2 LTS java17',
            '4.10.1 EDGE java17',
        ]);
    });

    it('respects the limit and an empty catalog', () => {
        expect(suggestRuntimes(catalog, { version: '4.9.0', java: '17' }, 1)).toEqual(['4.9.11 EDGE java17']);
        expect(suggestRuntimes([], { version: '4.9.0' })).toEqual([]);
    });
});
