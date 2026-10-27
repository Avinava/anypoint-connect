import { createHash } from 'node:crypto';
import { unzipSync, strFromU8 } from 'fflate';

export interface ArtifactCoordinates {
    groupId: string;
    artifactId: string;
    version: string;
}

/** Read embedded Maven identity without extracting files or trusting the JAR filename. */
export function inspectArtifact(
    bytes: Uint8Array,
    expectedArtifactId?: string,
    allowAmbiguous = false,
): {
    sha256: string;
    coordinates?: ArtifactCoordinates;
} {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const metadataPaths = new Set<string>();
    let metadataSize = 0;
    const entries = unzipSync(bytes, {
        filter(entry) {
            if (!/^META-INF\/maven\/[^/]+\/[^/]+\/pom\.properties$/.test(entry.name)) return false;
            if (metadataPaths.has(entry.name)) throw new Error('Artifact has duplicate Maven metadata');
            metadataPaths.add(entry.name);
            metadataSize += entry.originalSize;
            if (entry.originalSize > 65536 || metadataSize > 1048576)
                throw new Error('Artifact metadata exceeds the supported size');
            return true;
        },
    });
    const candidates: ArtifactCoordinates[] = [];
    for (const [name, content] of Object.entries(entries)) {
        const properties = Object.fromEntries(
            strFromU8(content)
                .split(/\r?\n/)
                .flatMap((line) => {
                    const match = /^\s*(groupId|artifactId|version)\s*[=:]\s*([^\s]+)\s*$/.exec(line);
                    return match ? [[match[1], match[2]]] : [];
                }),
        );
        const { groupId, artifactId, version } = properties;
        if (
            !groupId ||
            !artifactId ||
            !version ||
            [groupId, artifactId, version].some((value) => !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value))
        ) {
            throw new Error('Artifact has missing, unresolved, or invalid Maven coordinates');
        }
        if (name !== `META-INF/maven/${groupId}/${artifactId}/pom.properties`) {
            throw new Error('Artifact metadata path does not match its Maven coordinates');
        }
        if (!expectedArtifactId || artifactId === expectedArtifactId) candidates.push({ groupId, artifactId, version });
    }
    if (candidates.length > 1) {
        if (allowAmbiguous) return { sha256 };
        throw new Error('Artifact has ambiguous Maven coordinates');
    }
    return { sha256, coordinates: candidates[0] };
}

/** Where mule-build (3.2.0 and later) records how a jar was built. */
export const BUILD_INFO_PATH = 'META-INF/mule-build/build-info.json';

const BUILD_INFO_MAX_BYTES = 65536;

/** What a jar says about its own build, read from {@link BUILD_INFO_PATH}. */
export type BuildProvenance =
    | { status: 'unknown' }
    | { status: 'invalid'; reason: string }
    | {
          status: 'recorded';
          schemaVersion: number;
          tool: string;
          toolVersion: string;
          stripped: boolean;
          productionDeployable: boolean;
      };

/** Read the build-info marker without extracting anything else. A jar without one has unknown provenance. */
export function readBuildProvenance(bytes: Uint8Array): BuildProvenance {
    let seen = 0;
    let oversized = false;
    const entries = unzipSync(bytes, {
        filter(entry) {
            if (entry.name !== BUILD_INFO_PATH) return false;
            seen++;
            if (entry.originalSize > BUILD_INFO_MAX_BYTES) {
                oversized = true;
                return false;
            }
            return true;
        },
    });
    if (seen === 0) return { status: 'unknown' };
    if (seen > 1) return { status: 'invalid', reason: `the jar has ${seen} ${BUILD_INFO_PATH} entries` };
    if (oversized) return { status: 'invalid', reason: `${BUILD_INFO_PATH} exceeds ${BUILD_INFO_MAX_BYTES} bytes` };

    let info: Record<string, unknown>;
    try {
        const parsed: unknown = JSON.parse(strFromU8(entries[BUILD_INFO_PATH]));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
        info = parsed as Record<string, unknown>;
    } catch {
        return { status: 'invalid', reason: `${BUILD_INFO_PATH} is not a JSON object` };
    }
    const { schemaVersion, tool, toolVersion, stripped, productionDeployable } = info;
    if (
        typeof schemaVersion !== 'number' ||
        !Number.isInteger(schemaVersion) ||
        schemaVersion < 1 ||
        typeof tool !== 'string' ||
        typeof toolVersion !== 'string' ||
        typeof stripped !== 'boolean' ||
        typeof productionDeployable !== 'boolean'
    ) {
        return {
            status: 'invalid',
            reason: `${BUILD_INFO_PATH} lacks schemaVersion, tool, toolVersion, stripped or productionDeployable`,
        };
    }
    return { status: 'recorded', schemaVersion, tool, toolVersion, stripped, productionDeployable };
}

/** The outcome of checking a jar's build provenance against where it is going. */
export interface ProvenanceCheck {
    /** Serializable summary for previews. */
    buildProvenance: BuildProvenance & { note?: string };
    warnings: string[];
    /** Set when the jar must not go to the target. There is no override. */
    blocker?: string;
}

/**
 * Decide whether a jar may go to an environment. A jar whose build marks it not production
 * deployable (for example, built with secure properties stripped) is refused for production and
 * flagged elsewhere. A jar without a marker is allowed (older builds) and noted. A marker that
 * cannot be read is treated like a non-deployable one, since it cannot vouch for the build.
 * `production` is undefined when the target is not known yet (publishing only).
 */
export function checkBuildProvenance(provenance: BuildProvenance, production: boolean | undefined): ProvenanceCheck {
    if (provenance.status === 'unknown') {
        return {
            buildProvenance: {
                ...provenance,
                note: `build provenance unknown: the jar has no ${BUILD_INFO_PATH} (built before mule-build 3.2.0 or by another tool)`,
            },
            warnings: [],
        };
    }
    if (provenance.status === 'recorded' && provenance.productionDeployable) {
        return { buildProvenance: provenance, warnings: [] };
    }

    const problem =
        provenance.status === 'invalid'
            ? `its build marker is unreadable (${provenance.reason})`
            : `its build marks it not production deployable (${provenance.tool} ${provenance.toolVersion}, stripped: ${provenance.stripped})`;
    if (production) {
        return {
            buildProvenance: provenance,
            warnings: [],
            blocker: `Refused: this jar cannot go to a production environment because ${problem}. Build a production-deployable jar (secure properties not stripped) and preview again.`,
        };
    }
    return {
        buildProvenance: provenance,
        warnings: [
            `This jar is not production deployable: ${problem}. Deploying it to a production environment is refused.`,
        ],
    };
}

/** Compare the exact bytes that will be uploaded with the reviewed build or preview digest. */
export function verifyArtifactDigest(bytes: Uint8Array, expectedSha256?: string): string {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (
        expectedSha256 !== undefined &&
        (!/^[a-fA-F0-9]{64}$/.test(expectedSha256) || sha256 !== expectedSha256.toLowerCase())
    ) {
        throw new Error('Artifact digest changed or is invalid; build or preview the artifact again');
    }
    return sha256;
}
