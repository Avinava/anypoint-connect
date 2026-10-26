/**
 * Asset naming conventions
 * Choose Exchange coordinates for a published application JAR. Explicit values win, then the
 * project's convention (.anypoint-connect.json), then the JAR's own Maven identity. The pattern of
 * the app's deployed asset is detected and reported so it can be adopted as a convention; it is
 * applied only when a caller asks for it.
 */

import { execFileSync } from 'node:child_process';
import type { ArtifactRef } from '../api/CloudHub2Api.js';
import type { ArtifactCoordinates } from '../safety/artifact.js';

export interface AssetConvention {
    /** Template for the asset ID, e.g. "{app}-{pomVersion}-{timestamp}". */
    assetId?: string;
    /** Template or fixed value for the asset version, e.g. "1.0.0" or "{pomVersion}". */
    assetVersion?: string;
    groupId?: string;
}

export type NamingRule = 'explicit' | 'convention' | 'inferred' | 'jar';

export interface AssetSuggestion {
    groupId: string;
    assetId: string;
    version: string;
    rules: { groupId: NamingRule | 'organization'; assetId: NamingRule; version: NamingRule };
    /** The convention that produced the result, when one applied. */
    convention?: AssetConvention;
    /** The pattern of the deployed asset, reported but not applied. Adopt it as a project convention to use it. */
    deployedPattern?: AssetConvention;
}

export interface NamingVariables {
    app: string;
    artifactId?: string;
    pomVersion?: string;
    timestamp: string;
    gitShort?: string;
}

const TOKEN = /\{(app|artifactId|pomVersion|timestamp|gitShort)\}/g;
const VALID_ID = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

/** UTC timestamp as yyyyMMddHHmmss. */
export function namingTimestamp(date: Date = new Date()): string {
    return date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

/** The short commit hash of the project, when it is a git checkout. */
export function gitShortHash(cwd: string = process.cwd()): string | undefined {
    try {
        return (
            execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
                cwd,
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore'],
            }).trim() || undefined
        );
    } catch {
        return undefined;
    }
}

/** Fill a template. Throws when a token has no value or the result is not a valid Maven identifier. */
export function renderTemplate(template: string, vars: NamingVariables): string {
    const value = template.replace(TOKEN, (_, token: keyof NamingVariables) => {
        const replacement = vars[token];
        if (!replacement) throw new Error(`Naming template "${template}" uses {${token}}, which has no value here`);
        return replacement;
    });
    if (!VALID_ID.test(value))
        throw new Error(`Naming template "${template}" produced an invalid identifier "${value}"`);
    return value;
}

const SEMVER = /\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?/;
const STAMP = /(?<!\d)\d{14}(?!\d)/;

/**
 * Infer a convention from the asset the app currently runs. For example an app "orders-sapi"
 * running "orders-sapi-1.4.0-20260101120000" at version 1.0.0 implies
 * "{app}-{pomVersion}-{timestamp}" at a fixed "1.0.0".
 */
export function inferConvention(app: string, ref: ArtifactRef): AssetConvention | undefined {
    const id = ref.artifactId;
    if (!id.toLowerCase().startsWith(app.toLowerCase())) return undefined;
    let rest = id.slice(app.length);
    const hasStamp = STAMP.test(rest);
    rest = rest.replace(STAMP, '{timestamp}');
    const hasVersion = SEMVER.test(rest);
    rest = rest.replace(SEMVER, '{pomVersion}');
    if (!hasStamp && !hasVersion) return rest === '' ? { assetId: '{app}', assetVersion: '{pomVersion}' } : undefined;
    if (/\d/.test(rest.replace(/\{\w+\}/g, ''))) return undefined;
    return {
        assetId: `{app}${rest}`,
        // A timestamped asset ID usually pairs with a fixed version; otherwise the version follows the pom.
        assetVersion: hasStamp ? ref.version : '{pomVersion}',
    };
}

export interface SuggestInput {
    app: string;
    orgId: string;
    jar?: ArtifactCoordinates;
    existingRef?: ArtifactRef;
    convention?: AssetConvention;
    explicit?: { assetId?: string; assetVersion?: string; groupId?: string };
    now?: Date;
    gitShort?: string;
    /**
     * Apply the pattern inferred from the deployed asset. Off by default: publication never picks
     * coordinates the caller did not ask for, so the inferred pattern is only reported.
     */
    applyInferred?: boolean;
}

/** Pick the Exchange coordinates and report which rule chose each one. */
export function suggestAssetCoordinates(input: SuggestInput): AssetSuggestion {
    const vars: NamingVariables = {
        app: input.app,
        artifactId: input.jar?.artifactId,
        pomVersion: input.jar?.version,
        timestamp: namingTimestamp(input.now),
        gitShort: input.gitShort,
    };
    const detected = input.existingRef ? inferConvention(input.app, input.existingRef) : undefined;
    const inferred = input.applyInferred ? detected : undefined;
    const render = (value: string) => (value.includes('{') ? renderTemplate(value, vars) : value);

    const pick = (
        explicit: string | undefined,
        convention: string | undefined,
        inferredValue: string | undefined,
        jarValue: string | undefined,
        field: string,
    ): { value: string; rule: NamingRule } => {
        if (explicit) return { value: explicit, rule: 'explicit' };
        if (convention) return { value: render(convention), rule: 'convention' };
        if (inferredValue) {
            try {
                return { value: render(inferredValue), rule: 'inferred' };
            } catch {
                // The inferred pattern needs a value this JAR lacks; fall through to the JAR identity.
            }
        }
        if (jarValue) return { value: jarValue, rule: 'jar' };
        throw new Error(`Cannot determine the asset ${field}; pass it explicitly or set a naming convention`);
    };

    const assetId = pick(
        input.explicit?.assetId,
        input.convention?.assetId,
        inferred?.assetId,
        input.jar?.artifactId,
        'ID',
    );
    const version = pick(
        input.explicit?.assetVersion,
        input.convention?.assetVersion,
        inferred?.assetVersion,
        input.jar?.version,
        'version',
    );
    const groupId = input.explicit?.groupId
        ? { value: input.explicit.groupId, rule: 'explicit' as const }
        : input.convention?.groupId
          ? { value: input.convention.groupId, rule: 'convention' as const }
          : { value: input.orgId, rule: 'organization' as const };

    const usedConvention =
        assetId.rule === 'convention' || version.rule === 'convention'
            ? input.convention
            : assetId.rule === 'inferred' || version.rule === 'inferred'
              ? inferred
              : undefined;

    return {
        groupId: groupId.value,
        assetId: assetId.value,
        version: version.value,
        rules: { groupId: groupId.rule, assetId: assetId.rule, version: version.rule },
        ...(usedConvention ? { convention: usedConvention } : {}),
        ...(detected && !input.applyInferred ? { deployedPattern: detected } : {}),
    };
}
