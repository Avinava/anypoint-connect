/**
 * MCP Tool Registrar — Alert tools
 * list_alerts, get_alert, create_alert, update_alert, set_alert_enabled, delete_alert
 *
 * Anypoint Monitoring alerts through the undocumented observability API used by the Monitoring UI.
 * Writes preview by default, need confirm: true, and in production confirmProduction or a user-level
 * pre-approval, judged by the alert's own environment. Recipients are masked unless asked for.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AnypointClient } from '../../client/AnypointClient.js';
import {
    ALERT_METRIC_IDS,
    ALERT_OPERATORS,
    AlertPendingError,
    AlertsUnsupportedError,
    type MonitoringAlert,
} from '../../api/AlertsApi.js';
import {
    MAX_DURATION_MINUTES,
    alertEnvironment,
    describeNotifications,
    executeDeleteAlert,
    normalizeAlert,
    normalizeRuntimeManagerAlert,
    planCreateAlert,
    planUpdateAlert,
    summarizeRecipients,
    type AlertPatch,
} from '../../workflows/alerts.js';
import { errorMessage } from '../../utils/errors.js';
import { dryRunPreview, guardWrite, mcpError, mcpText, productionFields, writeInputs } from './shared.js';

const notificationSchema = z.discriminatedUnion('type', [
    z.object({
        type: z.literal('EMAIL'),
        recipients: z.array(z.string()).min(1).describe('Email addresses'),
        subject: z.string().describe('Email subject'),
        message: z.string().describe('Message template'),
    }),
    z.object({
        type: z.literal('SLACK'),
        channelId: z.string().describe('Slack channel ID'),
        carrierId: z.string().optional().describe('Slack connection (carrier) ID'),
        message: z.string().describe('Message template'),
    }),
]);

const conditionInputs = {
    operator: z.enum(ALERT_OPERATORS).describe('Comparison with the threshold'),
    threshold: z
        .number()
        .describe(
            'Threshold in the metric unit: a percentage (more than 0, at most 100) for cpu_utilization and memory_utilization, a whole number for counts, milliseconds for response times',
        ),
    durationMinutes: z
        .number()
        .int()
        .min(1)
        .max(MAX_DURATION_MINUTES)
        .describe('How many minutes the condition must hold (evaluation window)'),
    severity: z.number().int().min(0).max(2).describe('Severity 0, 1 or 2, as the platform stores it'),
};

function unsupported(error: AlertsUnsupportedError) {
    return { supported: false, family: error.family, status: error.status, message: error.message };
}

function failure(error: unknown) {
    if (error instanceof AlertsUnsupportedError) return { ...mcpText(unsupported(error)), isError: true as const };
    if (error instanceof AlertPendingError) {
        return { ...mcpText({ refused: true, retryLater: true, message: error.message }), isError: true as const };
    }
    return mcpError(error);
}

/** The write body for a preview: exact, with existing recipients masked unless the caller supplied them. */
function previewBody(body: { notifications: MonitoringAlert['notifications'] } & object, revealNotifications: boolean) {
    return revealNotifications
        ? body
        : { ...body, notifications: describeNotifications(body.notifications ?? [], false) };
}

export function registerAlertTools(server: McpServer, client: AnypointClient) {
    server.registerTool(
        'list_alerts',
        {
            title: 'List Alerts',
            description:
                'Lists alerts across Anypoint Monitoring (metric alerts on apps and API instances) and, with an environment, Runtime Manager event alerts. Each alert is normalized to {id, source, name, enabled, severity, status, state, entity{type, name, deploymentType, environment}, condition{metric, operator, threshold, unit, windowMinutes}, recipientCount, recipientDomains}. Recipients are masked (count and domains) unless revealRecipients is true. Deleted alerts are hidden unless status is DELETED. ' +
                'Uses an undocumented API; a family the organization or token cannot reach is reported as unsupported.',
            inputSchema: {
                environment: z
                    .string()
                    .optional()
                    .describe('Environment name or ID. Required for Runtime Manager alerts'),
                entityType: z
                    .enum(['application', 'api', 'server'])
                    .optional()
                    .describe('Only alerts on this kind of target'),
                app: z.string().optional().describe('Only alerts on this application name'),
                apiInstanceId: z.string().optional().describe('Only alerts on this API instance ID'),
                name: z.string().optional().describe('Only alerts whose name contains this text (case-insensitive)'),
                status: z.enum(['PENDING', 'ACTIVE', 'DELETED']).optional().describe('Only alerts with this status'),
                source: z
                    .enum(['monitoring', 'runtime-manager', 'all'])
                    .optional()
                    .describe('Alert family (default all)'),
                revealRecipients: z.boolean().optional().describe('Include full notification recipients'),
            },
            annotations: { readOnlyHint: true },
        },
        async (input) => {
            try {
                const orgId = await client.getDefaultOrgId();
                const env = input.environment
                    ? await client.accessManagement.resolveEnvironment(orgId, input.environment)
                    : undefined;
                const source = input.source ?? 'all';
                const sources: Record<string, unknown> = {};
                const alerts: Array<Record<string, unknown>> = [];
                const needle = input.name?.toLowerCase();

                if (source !== 'runtime-manager') {
                    try {
                        const found = (await client.alerts.list(orgId, { environmentId: env?.id }))
                            .filter((a) =>
                                input.status ? a.alertStatus === input.status : a.alertStatus !== 'DELETED',
                            )
                            .filter((a) => !input.entityType || a.entity?.entityType === input.entityType)
                            .filter((a) => !input.app || a.entity?.appId?.toLowerCase() === input.app.toLowerCase())
                            .filter(
                                (a) => !input.apiInstanceId || String(a.entity?.apiInstanceId) === input.apiInstanceId,
                            )
                            .filter((a) => !needle || a.name?.toLowerCase().includes(needle));
                        alerts.push(...found.map((a) => normalizeAlert(a, { reveal: input.revealRecipients })));
                        sources.monitoring = { supported: true, count: found.length };
                    } catch (error) {
                        if (!(error instanceof AlertsUnsupportedError)) throw error;
                        sources.monitoring = unsupported(error);
                    }
                }
                if (source !== 'monitoring') {
                    if (!env) {
                        sources['runtime-manager'] = { skipped: 'pass environment to read Runtime Manager alerts' };
                    } else {
                        try {
                            const found = (await client.alerts.listRuntimeManager(orgId, env.id))
                                .map(normalizeRuntimeManagerAlert)
                                .filter(
                                    (a) =>
                                        !needle ||
                                        String(a.name ?? '')
                                            .toLowerCase()
                                            .includes(needle),
                                )
                                .filter(
                                    (a) =>
                                        !input.app ||
                                        String(a.entity.name ?? '').toLowerCase() === input.app.toLowerCase(),
                                );
                            alerts.push(...found);
                            sources['runtime-manager'] = { supported: true, count: found.length, readOnly: true };
                        } catch (error) {
                            if (!(error instanceof AlertsUnsupportedError)) throw error;
                            sources['runtime-manager'] = unsupported(error);
                        }
                    }
                }
                return mcpText({
                    ...(env ? { environment: env.name } : {}),
                    total: alerts.length,
                    sources,
                    alerts,
                });
            } catch (error) {
                return failure(error);
            }
        },
    );

    server.registerTool(
        'get_alert',
        {
            title: 'Get Alert',
            description:
                'Returns one Anypoint Monitoring alert, normalized as in list_alerts, plus its raw settings and entity. Recipients are masked unless revealRecipients is true.',
            inputSchema: {
                id: z.string().describe('Alert ID from list_alerts'),
                revealRecipients: z.boolean().optional().describe('Include full notification recipients'),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ id, revealRecipients }) => {
            try {
                const orgId = await client.getDefaultOrgId();
                const alert = await client.alerts.get(orgId, id);
                if (!alert)
                    return { ...mcpText({ found: false, message: `Alert ${id} not found` }), isError: true as const };
                return mcpText({
                    ...normalizeAlert(alert, { reveal: revealRecipients }),
                    settings: alert.settings,
                    entityDetail: alert.entity,
                });
            } catch (error) {
                return failure(error);
            }
        },
    );

    server.registerTool(
        'create_alert',
        {
            title: 'Create Alert',
            description:
                'Creates an Anypoint Monitoring metric alert on a CloudHub 2.0 app (target {app}) or an API instance (target {apiInstanceId}); the target is resolved from CloudHub 2.0 or API Manager. Notifications are explicit, at least one, with no defaults. The alert is created disabled unless enabled is true. ' +
                'An alert with the same name on the same target is refused (its id is returned) unless allowDuplicate is true. The preview shows the exact payload and recipients and warns about recipients outside your email domain. ' +
                'Previews by default; pass confirm: true to create (production also needs confirmProduction or a pre-approval). Uses an undocumented API.',
            inputSchema: {
                environment: z.string().describe('Environment name or ID of the target'),
                name: z.string().describe('Alert name (names are not unique on the platform)'),
                target: z
                    .union([
                        z.object({ app: z.string().describe('CloudHub 2.0 application name') }),
                        z.object({ apiInstanceId: z.string().describe('API instance ID from list_api_instances') }),
                    ])
                    .describe('{app} or {apiInstanceId}'),
                metric: z
                    .enum(ALERT_METRIC_IDS)
                    .describe('Metric to watch; app metrics for apps, api_* metrics for API instances'),
                ...conditionInputs,
                enabled: z.boolean().optional().describe('Enable on creation (default false)'),
                notifications: z
                    .array(notificationSchema)
                    .min(1)
                    .describe('EMAIL and SLACK notifications; at least one'),
                apiFilters: z
                    .object({
                        responseCodes: z.array(z.string()).optional(),
                        policies: z.array(z.string()).optional(),
                    })
                    .optional()
                    .describe('For api_response_code_count (responseCodes) and api_policy_violation_count (policies)'),
                allowDuplicate: z
                    .boolean()
                    .optional()
                    .describe('Create even if the target has an alert with this name'),
                ...writeInputs,
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
        },
        async (args) => {
            try {
                const plan = await planCreateAlert(client, args);
                const preview = {
                    action: 'create alert',
                    environment: plan.env.name,
                    payload: plan.body,
                    recipients: summarizeRecipients(plan.body.notifications),
                    ...(plan.warnings.length ? { warnings: plan.warnings } : {}),
                };
                if (plan.duplicate && !args.allowDuplicate) {
                    return {
                        ...mcpText({
                            refused: true,
                            message: `An alert named "${plan.duplicate.name}" already exists on this target (id ${plan.duplicate.id}). Pass allowDuplicate: true to create another.`,
                            existingId: plan.duplicate.id,
                            ...preview,
                        }),
                        isError: true as const,
                    };
                }
                const gate = guardWrite({
                    orgId: plan.orgId,
                    env: plan.env,
                    tool: 'create_alert',
                    confirm: args.confirm,
                    confirmProduction: args.confirmProduction,
                    preview,
                });
                if (gate) return gate;
                const created = await client.alerts.create(plan.orgId, plan.body);
                return mcpText({
                    message: `Created alert "${plan.body.name}" in ${plan.env.name}`,
                    ...(created?.id ? { id: created.id } : {}),
                    status: created?.alertStatus ?? 'PENDING',
                    enabled: plan.body.enabled,
                    ...productionFields(plan.orgId, plan.env, 'create_alert'),
                    tip: 'A new alert is PENDING until the platform provisions it; it cannot be changed until it is ACTIVE.',
                });
            } catch (error) {
                return failure(error);
            }
        },
    );

    async function runUpdate(
        tool: 'update_alert' | 'set_alert_enabled',
        id: string,
        patch: AlertPatch,
        args: { confirm?: boolean; confirmProduction?: boolean },
    ) {
        const plan = await planUpdateAlert(client, id, patch);
        const preview = {
            action: tool === 'set_alert_enabled' ? (patch.enabled ? 'enable alert' : 'disable alert') : 'update alert',
            id,
            name: plan.existing.name,
            environment: plan.env.name,
            changes: plan.changes,
            payload: previewBody(plan.body, Boolean(patch.notifications)),
        };
        if (plan.noop) return mcpText({ noop: true, message: 'Nothing to change.', ...preview });
        const gate = guardWrite({
            orgId: plan.orgId,
            env: plan.env,
            tool,
            confirm: args.confirm,
            confirmProduction: args.confirmProduction,
            preview,
        });
        if (gate) return gate;
        await client.alerts.update(plan.orgId, id, plan.body);
        return mcpText({
            message: `Updated alert "${plan.body.name}"`,
            id,
            changes: plan.changes,
            ...productionFields(plan.orgId, plan.env, tool),
        });
    }

    server.registerTool(
        'update_alert',
        {
            title: 'Update Alert',
            description:
                'Changes an Anypoint Monitoring alert: name, severity, enabled, operator, threshold (in the metric unit, percent for cpu and memory), durationMinutes, or notifications (replaces them all). The platform needs the full alert, so the tool reads it, merges the patch and sends it whole; metric and target cannot change. A PENDING alert cannot be changed yet; the tool says to retry later. Previews by default; pass confirm: true to apply.',
            inputSchema: {
                id: z.string().describe('Alert ID'),
                patch: z
                    .object({
                        name: z.string().optional(),
                        severity: conditionInputs.severity.optional(),
                        enabled: z.boolean().optional(),
                        operator: conditionInputs.operator.optional(),
                        threshold: conditionInputs.threshold.optional(),
                        durationMinutes: conditionInputs.durationMinutes.optional(),
                        notifications: z.array(notificationSchema).min(1).optional(),
                    })
                    .describe('Fields to change'),
                ...writeInputs,
            },
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
        },
        async ({ id, patch, confirm, confirmProduction }) => {
            try {
                return await runUpdate('update_alert', id, patch, { confirm, confirmProduction });
            } catch (error) {
                return failure(error);
            }
        },
    );

    server.registerTool(
        'set_alert_enabled',
        {
            title: 'Enable or Disable Alert',
            description:
                'Enables or disables an Anypoint Monitoring alert, keeping everything else. Previews by default; pass confirm: true to apply.',
            inputSchema: {
                id: z.string().describe('Alert ID'),
                enabled: z.boolean().describe('true to enable, false to disable'),
                ...writeInputs,
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
        },
        async ({ id, enabled, confirm, confirmProduction }) => {
            try {
                return await runUpdate('set_alert_enabled', id, { enabled }, { confirm, confirmProduction });
            } catch (error) {
                return failure(error);
            }
        },
    );

    server.registerTool(
        'delete_alert',
        {
            title: 'Delete Alert',
            description:
                'Deletes an Anypoint Monitoring alert. Bound like delete_app: call without confirm for a preview, then with confirm: true and expectedName exactly as the preview shows. Production also needs confirmProduction, unless a pre-approval names delete_alert ("all-mutating" does not cover it). Deletion is asynchronous: the result reports accepted and the status, and never claims the alert is deleted while it is PENDING.',
            inputSchema: {
                id: z.string().describe('Alert ID'),
                expectedName: z.string().optional().describe('The alert name from the preview; binds the delete to it'),
                ...writeInputs,
            },
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
        },
        async ({ id, expectedName, confirm, confirmProduction }) => {
            try {
                const orgId = await client.getDefaultOrgId();
                const alert = await client.alerts.get(orgId, id);
                if (!alert || alert.alertStatus === 'DELETED') {
                    return mcpText({
                        accepted: false,
                        status: alert ? 'DELETED' : 'GONE',
                        message: `Alert ${id} does not exist (any more)`,
                    });
                }
                const env = await alertEnvironment(client, orgId, alert);
                const preview = { action: 'delete alert', alert: normalizeAlert(alert) };
                if (!confirm) {
                    return dryRunPreview({
                        ...preview,
                        ...productionFields(orgId, env, 'delete_alert'),
                        confirmation: { confirm: true, expectedName: alert.name },
                    });
                }
                if (expectedName !== alert.name) {
                    return {
                        ...mcpText({
                            refused: true,
                            message: 'Deletion refused: expectedName is missing or does not match the alert.',
                            id,
                        }),
                        isError: true as const,
                    };
                }
                const gate = guardWrite({ orgId, env, tool: 'delete_alert', confirm, confirmProduction, preview });
                if (gate) return gate;
                const result = await executeDeleteAlert(client, orgId, id);
                return mcpText({ id, ...result, ...productionFields(orgId, env, 'delete_alert') });
            } catch (error) {
                return failure(error);
            }
        },
    );
}

/** Monitoring alerts on one API instance, for get_api_alerts. Never throws for an unsupported family. */
export async function monitoringAlertsForApi(
    client: AnypointClient,
    orgId: string,
    envId: string,
    apiInstanceId: number | string,
) {
    try {
        const alerts = await client.alerts.list(orgId, { environmentId: envId });
        return {
            supported: true as const,
            alerts: alerts
                .filter(
                    (a) =>
                        a.alertStatus !== 'DELETED' &&
                        a.entity?.entityType === 'api' &&
                        String(a.entity.apiInstanceId) === String(apiInstanceId),
                )
                .map((a) => normalizeAlert(a)),
        };
    } catch (error) {
        if (error instanceof AlertsUnsupportedError) return unsupported(error);
        return { supported: false as const, message: errorMessage(error) };
    }
}
