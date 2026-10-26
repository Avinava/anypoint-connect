/**
 * Runtime version checks
 * Validate a requested Mule runtime against what the deployment target accepts, and suggest the
 * nearest supported version when the current one has been retired. Pure functions.
 */

import type { RuntimeVersion } from '../api/RuntimesApi.js';

export interface RuntimeSpec {
    /** Base version ("4.9.0") or a version prefix ("4.9"). */
    version: string;
    java?: string;
    releaseChannel?: string;
}

/** Split a deployment's runtime string ("4.8.5:4e-java8") into its base version and Java version. */
export function parseRuntimeString(value: string, java?: string): RuntimeSpec {
    const [base, tag = ''] = value.split(':');
    const fromTag = /java(\d+)/i.exec(tag)?.[1];
    return { version: base, ...((java ?? fromTag) ? { java: java ?? fromTag } : {}) };
}

export function compareVersions(a: string, b: string): number {
    const pa = a.split('.').map((part) => parseInt(part, 10) || 0);
    const pb = b.split('.').map((part) => parseInt(part, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

const minorOf = (version: string) => version.split('.').slice(0, 2).join('.');
const supportsJava = (candidate: RuntimeVersion, java?: string) =>
    !java || candidate.java.length === 0 || candidate.java.includes(java);

/** The newest catalog entry matching the spec, or undefined when the target does not offer it. */
export function resolveRuntime(catalog: RuntimeVersion[], spec: RuntimeSpec): RuntimeVersion | undefined {
    return catalog
        .filter((v) => v.version === spec.version || v.version.startsWith(`${spec.version}.`))
        .filter((v) => !spec.releaseChannel || v.releaseChannel?.toUpperCase() === spec.releaseChannel.toUpperCase())
        .filter((v) => supportsJava(v, spec.java))
        .sort((a, b) => compareVersions(b.version, a.version))[0];
}

function label(v: RuntimeVersion, java?: string): string {
    const javaPart = java && v.java.includes(java) ? java : v.java.includes('17') ? '17' : v.java[v.java.length - 1];
    return [v.version, v.releaseChannel, javaPart ? `java${javaPart}` : undefined].filter(Boolean).join(' ');
}

/**
 * Nearest supported versions for an unsupported runtime, best first: the newest patch of the same
 * minor, then the oldest newer LTS, then the newest version overall. Java 17 is preferred when the
 * original Java version is no longer offered.
 */
export function suggestRuntimes(catalog: RuntimeVersion[], current: RuntimeSpec, limit = 3): string[] {
    const javaOffered = !current.java || catalog.some((v) => v.java.includes(current.java as string));
    const java = javaOffered ? current.java : '17';
    const usable = catalog.filter((v) => supportsJava(v, java));
    const pool = usable.length > 0 ? usable : catalog;
    const byNewest = [...pool].sort((a, b) => compareVersions(b.version, a.version));

    const picks: RuntimeVersion[] = [];
    const add = (v: RuntimeVersion | undefined) => {
        if (v && !picks.some((p) => p.version === v.version && p.releaseChannel === v.releaseChannel)) picks.push(v);
    };
    add(byNewest.find((v) => minorOf(v.version) === minorOf(current.version)));
    add(
        [...pool]
            .filter((v) => v.releaseChannel?.toUpperCase() === 'LTS' && compareVersions(v.version, current.version) > 0)
            .sort((a, b) => compareVersions(a.version, b.version))[0],
    );
    add(byNewest[0]);
    return picks.slice(0, limit).map((v) => label(v, java));
}
