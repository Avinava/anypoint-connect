/**
 * Runtime catalog
 * Mule runtime versions a CloudHub 2.0 target (shared region or private space) accepts, read
 * from the Runtime Fabric targets API that Runtime Manager uses. The response shape varies by
 * target type, so versions are normalized defensively.
 */

import type { HttpClient } from '../client/HttpClient.js';
import type { Cache } from '../client/Cache.js';

export interface RuntimeVersion {
    /** Base version, e.g. "4.9.0". */
    version: string;
    tag?: string;
    releaseChannel?: string;
    /** Supported Java versions, e.g. ["8", "17"]. Empty when the target does not say. */
    java: string[];
}

export interface RuntimeTarget {
    id: string;
    name?: string;
    type?: string;
    runtimes: RuntimeVersion[];
}

interface RawVersion {
    baseVersion?: string;
    version?: string;
    tag?: string;
    releaseChannel?: string;
    channel?: string;
    java?: string | string[];
    javaVersion?: string;
    javaVersions?: string[];
    supportedJavaVersions?: string[];
}

interface RawTarget {
    id: string;
    name?: string;
    type?: string;
    runtimes?: Array<{ type?: string; versions?: RawVersion[] }>;
}

const BASE = '/runtimefabric/api';

function javaFrom(raw: RawVersion): string[] {
    const listed = raw.javaVersions ?? raw.supportedJavaVersions ?? raw.java ?? raw.javaVersion;
    if (Array.isArray(listed)) return listed.map(String);
    if (typeof listed === 'string') return [listed];
    const fromTag = /java(\d+)/i.exec(`${raw.tag ?? ''} ${raw.version ?? ''}`);
    return fromTag ? [fromTag[1]] : [];
}

/** Normalize one raw version entry; returns null when no version can be read. */
export function normalizeRuntimeVersion(raw: RawVersion): RuntimeVersion | null {
    const version = raw.baseVersion ?? raw.version?.split(':')[0];
    if (!version || !/^\d+\.\d+\.\d+/.test(version)) return null;
    return {
        version,
        ...(raw.tag ? { tag: raw.tag } : {}),
        ...((raw.releaseChannel ?? raw.channel) ? { releaseChannel: raw.releaseChannel ?? raw.channel } : {}),
        java: javaFrom(raw),
    };
}

export function normalizeTarget(raw: RawTarget): RuntimeTarget {
    const versions = (raw.runtimes ?? [])
        .filter((runtime) => !runtime.type || runtime.type.toLowerCase() === 'mule')
        .flatMap((runtime) => runtime.versions ?? [])
        .map(normalizeRuntimeVersion)
        .filter((v): v is RuntimeVersion => v !== null);
    return { id: raw.id, name: raw.name, type: raw.type, runtimes: versions };
}

export class RuntimesApi {
    constructor(
        private readonly http: HttpClient,
        private readonly cache: Cache,
    ) {}

    /** All deployment targets visible to the organization, with their runtime catalogs. */
    async getTargets(orgId: string): Promise<RuntimeTarget[]> {
        return this.cache.getOrCompute(`runtimes:${orgId}`, async () => {
            const response = await this.http.get<RawTarget[] | { items?: RawTarget[]; data?: RawTarget[] }>(
                `${BASE}/organizations/${orgId}/targets`,
            );
            const raw = Array.isArray(response) ? response : (response.items ?? response.data ?? []);
            return raw.map(normalizeTarget);
        });
    }

    /** The catalog for one target, or null when the organization cannot see it. */
    async getTarget(orgId: string, targetId: string): Promise<RuntimeTarget | null> {
        const targets = await this.getTargets(orgId);
        return targets.find((target) => target.id === targetId) ?? null;
    }
}
