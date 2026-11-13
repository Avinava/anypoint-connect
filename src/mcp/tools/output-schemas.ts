/**
 * Output schemas for the read tools that return structured results. Each describes the same JSON the
 * tool already prints as text, so a program can rely on the fields without parsing prose. They name the
 * fields a caller can depend on; anything else the tool adds is still sent.
 */

import { z } from 'zod';

const loose = z.record(z.string(), z.unknown());

export const listAppsOutput = {
    apps: z.array(
        z.object({
            id: z.string(),
            name: z.string(),
            status: z.string().nullish(),
            version: z.string().nullish(),
            runtime: z.string().nullish(),
            vCores: z.number().nullish(),
            replicas: z.number().nullish(),
        }),
    ),
};

export const appStatusOutput = {
    name: z.string(),
    phase: z.string().describe('RUNNING, STARTING, UPDATING, DEGRADED, FAILED, STOPPING or STOPPED'),
    settled: z.boolean().describe('True when the phase is final; a wait that ended early leaves this false'),
    reason: z.string().optional(),
    timedOut: z.boolean().optional().describe('Present when a requested wait ended at its limit'),
    desiredState: z.string().nullish(),
    status: z.string().nullish().describe('The raw platform status'),
    version: z.string().nullish(),
    groupId: z.string().nullish(),
    artifactId: z.string().nullish(),
    runtime: z.string().nullish(),
    resources: loose.optional(),
    autoscaling: z.unknown().optional(),
    jvm: z.unknown().optional(),
    clustered: z.unknown().optional(),
    updateStrategy: z.unknown().optional(),
    replicas: z
        .array(
            z.object({
                id: z.string().nullish(),
                state: z.string().nullish(),
                location: z.string().nullish(),
                onCurrentSpec: z.boolean(),
                reason: z.string().optional(),
            }),
        )
        .optional(),
    publicUrl: z.string().nullish(),
    updatedAt: z.string().optional(),
};

const period = z.object({ from: z.string(), to: z.string() });

export const metricsOutput = {
    environment: z.string(),
    period,
    groupBy: z.enum(['app', 'worker', 'route']).optional(),
    rows: z.array(loose).optional().describe('Per app or worker rows'),
    routes: z.array(loose).optional().describe('Per route rows, when groupBy is route'),
};

export const alertListOutput = {
    environment: z.string().optional(),
    total: z.number(),
    sources: loose.describe('Per alert family: supported, count, or why it is unsupported'),
    alerts: z.array(
        z.object({
            // A Runtime Manager alert can carry a numeric id or no name; one such alert must not fail the list.
            id: z.union([z.string(), z.number()]),
            source: z.string(),
            name: z.string().nullish(),
            enabled: z.boolean().nullish(),
        }),
    ),
};

export const alertOutput = {
    id: z.string(),
    source: z.string(),
    name: z.string(),
    enabled: z.boolean().nullish(),
    severity: z.string().nullish(),
    status: z.string().nullish(),
    entity: loose.optional(),
    condition: loose.optional(),
    recipientCount: z.number().optional(),
    settings: z.unknown().optional(),
    entityDetail: z.unknown().optional(),
};
