/**
 * Artifact verification for changes that select an artifact already in Exchange
 *
 * deploy_app, update_app, update_app_artifact and rollback_app point an app at Exchange coordinates,
 * so a check of a local jar alone proves nothing about what will run. For a production target the
 * artifact is downloaded from Exchange and its own build marker is checked. When a local jar is given,
 * its SHA-256 must equal the Exchange artifact's, in any environment, so the reviewed file is the one
 * deployed.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { AnypointClient } from '../client/AnypointClient.js';
import type { ArtifactRef } from '../api/CloudHub2Api.js';
import type { Environment } from '../api/AccessManagementApi.js';
import { checkBuildProvenance, readBuildProvenance, type ProvenanceCheck } from '../safety/artifact.js';
import { isProductionEnv, validateJarFile } from '../safety/guards.js';
import { checkUnmarkedAllowance } from '../safety/preapproval.js';
import { errorMessage } from '../utils/errors.js';

/** Read a local jar after the basic file checks. */
export async function readJarBytes(jarPath: string): Promise<Buffer> {
    const check = validateJarFile(jarPath);
    if (!check.valid) throw new Error(check.error);
    return readFile(jarPath);
}

export interface ArtifactVerification {
    /** Where the checked bytes came from. */
    checked: 'exchange' | 'local' | 'none';
    ref: Pick<ArtifactRef, 'groupId' | 'artifactId' | 'version'>;
    /** SHA-256 of the Exchange artifact, when downloaded. */
    exchangeSha256?: string;
    /** SHA-256 of the local jar, when given. */
    localSha256?: string;
    provenance?: ProvenanceCheck;
    warnings: string[];
    blockers: string[];
}

export interface VerifyArtifactRequest {
    orgId: string;
    env: Pick<Environment, 'id' | 'name' | 'isProduction'>;
    ref: Pick<ArtifactRef, 'groupId' | 'artifactId' | 'version'>;
    /** Local jar the artifact was published from. */
    jarPath?: string;
}

const coordinates = (ref: VerifyArtifactRequest['ref']) => `${ref.groupId}:${ref.artifactId}:${ref.version}`;

/**
 * Verify the artifact a change selects. Returns `checked: "none"` outside production when no local
 * jar is given; nothing is downloaded then.
 */
export async function verifySelectedArtifact(
    client: AnypointClient,
    request: VerifyArtifactRequest,
): Promise<ArtifactVerification> {
    const production = isProductionEnv(request.env.name, request.env.isProduction);
    const result: ArtifactVerification = { checked: 'none', ref: request.ref, warnings: [], blockers: [] };

    let local: { bytes: Buffer; sha256: string } | undefined;
    if (request.jarPath) {
        const bytes = await readJarBytes(request.jarPath);
        local = { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
        result.localSha256 = local.sha256;
    }
    if (!production && !local) return result;

    let exchange: { buffer: Buffer; sha256: string; md5Matches: boolean } | undefined;
    try {
        exchange = await client.exchange.downloadAppJar(
            request.orgId,
            request.ref.groupId,
            request.ref.artifactId,
            request.ref.version,
        );
    } catch (error) {
        const message = `Could not download ${coordinates(request.ref)} from Exchange to verify it: ${errorMessage(error)}`;
        if (production) result.blockers.push(`Refused: ${message}`);
        else result.warnings.push(message);
    }

    if (exchange) {
        result.checked = 'exchange';
        result.exchangeSha256 = exchange.sha256;
        if (!exchange.md5Matches) {
            const message = `The jar downloaded for ${coordinates(request.ref)} does not match its Exchange MD5`;
            if (production) result.blockers.push(`Refused: ${message}`);
            else result.warnings.push(message);
        }
        if (local && local.sha256 !== exchange.sha256) {
            result.blockers.push(
                `Refused: ${path.basename(request.jarPath!)} (SHA-256 ${local.sha256}) is not the artifact being deployed, ${coordinates(request.ref)} (SHA-256 ${exchange.sha256}). Pass the jar that was published, or omit jarPath.`,
            );
        }
    } else if (local && !production) {
        result.checked = 'local';
    }

    const bytes = exchange?.buffer ?? (result.checked === 'local' ? local?.bytes : undefined);
    if (bytes) {
        const unmarked = production
            ? checkUnmarkedAllowance({ orgId: request.orgId, env: request.env })
            : { unmarkedAllowed: false };
        result.provenance = checkBuildProvenance(readBuildProvenance(bytes), production, unmarked);
        result.warnings.push(...result.provenance.warnings);
        if (result.provenance.blocker) result.blockers.push(result.provenance.blocker);
    }
    return result;
}

/** The serializable part of a verification, for previews. */
export function describeVerification(verification: ArtifactVerification) {
    return {
        checked: verification.checked,
        ref: verification.ref,
        ...(verification.exchangeSha256 ? { exchangeSha256: verification.exchangeSha256 } : {}),
        ...(verification.localSha256 ? { localSha256: verification.localSha256 } : {}),
        ...(verification.provenance ? { buildProvenance: verification.provenance.buildProvenance } : {}),
        ...(verification.provenance?.provenancePolicy
            ? { provenancePolicy: verification.provenance.provenancePolicy }
            : {}),
    };
}
