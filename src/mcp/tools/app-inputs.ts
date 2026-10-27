/**
 * Shared input fragments for application change tools
 * Settings, runtime and wait inputs used by update_app, update_app_settings, update_app_artifact,
 * restart_app and the deploy tools, so every tool describes them the same way.
 */

import { z } from 'zod';
import type { AnypointClient } from '../../client/AnypointClient.js';
import { secretSourceSchema } from '../../safety/secret-sources.js';
import { redactText } from '../../safety/secrets.js';
import {
    describeAppChange,
    executeAppChange,
    planAppChange,
    resolveSettingsInput,
    type AppChangeRequest,
    type SettingsChangeInput,
} from '../../workflows/app-change.js';
import type { RuntimeSpec } from '../../safety/runtime.js';
import { errorMessage } from '../../utils/errors.js';
import { guardWrite, mcpText, productionFields, resolveEnvironment } from './shared.js';

export const settingsInputs = {
    properties: z
        .record(z.string(), z.string())
        .optional()
        .describe('Plain properties to add or change. Do not put secrets here; use securePropertiesFrom'),
    secureProperties: z
        .record(z.string(), z.string())
        .optional()
        .describe(
            'Secure properties to add or change inline. Prefer securePropertiesFrom so values stay out of the conversation',
        ),
    propertiesFrom: z
        .array(secretSourceSchema)
        .optional()
        .describe('Plain properties read on the server from a project file or environment variables'),
    securePropertiesFrom: z
        .array(secretSourceSchema)
        .optional()
        .describe(
            'Secure properties read on the server: {file, format?, keys?, rename?, prefix?} for a .env/.properties/JSON file inside the project, or {env: {propertyName: ENV_VAR}}. Values never appear in the conversation',
        ),
    removeProperties: z.array(z.string()).optional().describe('Plain property names to delete'),
    removeSecureProperties: z.array(z.string()).optional().describe('Secure property names to delete'),
    moveToSecure: z
        .array(z.string())
        .optional()
        .describe('Plain property names whose current value moves to secure properties on the server'),
};

export const runtimeInputs = {
    runtime: z
        .string()
        .optional()
        .describe(
            'Mule runtime version to move to, e.g. "4.9.0" or "4.9" for the newest 4.9 patch. Checked against the target first',
        ),
    javaVersion: z
        .string()
        .optional()
        .describe('Java version for the runtime, e.g. "17". Default: keep the current one if offered'),
    releaseChannel: z.string().optional().describe('Release channel, e.g. "LTS" or "EDGE"'),
};

export const waitInputs = {
    wait: z.boolean().optional().describe('Wait until every replica runs the new spec, or the change fails'),
    waitTimeoutSeconds: z.number().min(10).max(1800).optional().describe('Wait limit in seconds (default 300)'),
};

export const provenanceJarInput = z
    .string()
    .optional()
    .describe(
        'Local .jar the new version was built and published from. In any environment the Exchange artifact is then downloaded and its SHA-256 must match this jar; a mismatch, a failed download or an MD5 mismatch refuses the change. Production changes always download the Exchange artifact and check its build marker, with or without jarPath',
    );

export const modeInput = z
    .enum(['inPlace', 'stopStart'])
    .optional()
    .describe(
        'inPlace (default): one update with the platform update strategy. stopStart: stop, apply, start, so old and new replicas never run together. Use stopStart for apps with streaming, subscription or polling listeners',
    );

export const updateStrategyInput = z
    .enum(['rolling', 'recreate'])
    .optional()
    .describe('Persistently set the update strategy. recreate stops old replicas before new ones start');

type SettingsArgs = {
    [K in keyof typeof settingsInputs]?: z.infer<(typeof settingsInputs)[K]>;
};

export function settingsFromArgs(args: SettingsArgs): SettingsChangeInput {
    return {
        properties: args.properties,
        secureProperties: args.secureProperties,
        propertiesFrom: args.propertiesFrom,
        securePropertiesFrom: args.securePropertiesFrom,
        removeProperties: args.removeProperties,
        removeSecureProperties: args.removeSecureProperties,
        moveToSecure: args.moveToSecure,
    };
}

export function runtimeFromArgs(args: {
    runtime?: string;
    javaVersion?: string;
    releaseChannel?: string;
}): RuntimeSpec | undefined {
    if (!args.runtime) return undefined;
    return {
        version: args.runtime,
        ...(args.javaVersion ? { java: args.javaVersion } : {}),
        ...(args.releaseChannel ? { releaseChannel: args.releaseChannel } : {}),
    };
}

export interface AppChangeToolArgs {
    appName: string;
    environment: string;
    confirm?: boolean;
    confirmProduction?: boolean;
    wait?: boolean;
    waitTimeoutSeconds?: number;
}

/**
 * Plan, guard and apply an application change for an MCP tool. Previews by default, refuses
 * production without confirmProduction, and scrubs secret values from every response.
 */
export async function runAppChangeTool(
    client: AnypointClient,
    args: AppChangeToolArgs,
    change: Omit<
        AppChangeRequest,
        'orgId' | 'env' | 'appName' | 'secretValues' | 'settings' | 'artifactVerifiedLocally'
    > & {
        settings?: SettingsChangeInput;
    },
    labels: { done: string; /** MCP tool name, for production pre-approval. */ tool: string },
) {
    let secretValues: string[] = [];
    try {
        const { orgId, env } = await resolveEnvironment(client, args.environment);
        const resolved = resolveSettingsInput(change.settings);
        secretValues = resolved.secretValues;
        const plan = await planAppChange(client, {
            ...change,
            orgId,
            env,
            appName: args.appName,
            settings: resolved.change,
            secretValues,
        });
        const preview = describeAppChange(plan);

        if (plan.noop) return mcpText({ noop: true, message: 'Nothing to change.', ...preview });
        if (plan.blockers.length) {
            return {
                ...mcpText({ refused: true, message: 'The change cannot be applied.', ...preview }),
                isError: true as const,
            };
        }
        const gate = guardWrite({
            orgId,
            env,
            tool: labels.tool,
            confirm: args.confirm,
            confirmProduction: args.confirmProduction,
            preview,
        });
        if (gate) return gate;

        const result = await executeAppChange(client, plan, {
            wait: args.wait,
            timeoutMs: args.waitTimeoutSeconds ? args.waitTimeoutSeconds * 1000 : undefined,
        });
        const response = {
            message: `${labels.done} "${plan.existing.name}" in ${env.name}`,
            deploymentId: result.deployment.id,
            ...productionFields(orgId, env, labels.tool),
            performed: result.performed,
            changes: plan.changes,
            ...(plan.settings ? { settings: plan.settings.diff } : {}),
            ...(result.snapshot
                ? {
                      phase: result.snapshot.phase,
                      settled: result.snapshot.settled,
                      ...(result.snapshot.reason ? { reason: result.snapshot.reason } : {}),
                      ...(result.timedOut ? { timedOut: true } : {}),
                  }
                : { tip: 'Pass wait: true, or call get_app_status with wait: true, to follow the rollout.' }),
            ...(plan.warnings.length ? { warnings: plan.warnings } : {}),
        };
        const failed = result.snapshot && result.snapshot.terminal && !result.snapshot.settled;
        return {
            ...mcpText(JSON.parse(redactText(JSON.stringify(response), secretValues))),
            ...(failed ? { isError: true as const } : {}),
        };
    } catch (error) {
        return {
            content: [{ type: 'text' as const, text: `Error: ${redactText(errorMessage(error), secretValues)}` }],
            isError: true as const,
        };
    }
}
