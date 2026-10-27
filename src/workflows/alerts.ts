/**
 * Alert workflows
 * Shared by the alert MCP tools and `anc alerts`: normalizing alerts for display (recipients masked by
 * default), turning human inputs (percent thresholds, minutes, explicit notifications) into the
 * platform's payload, resolving the target from CloudHub 2.0 or API Manager, duplicate detection,
 * and the get-merge-replace update the platform requires.
 */

import type { AnypointClient } from '../client/AnypointClient.js';
import type { Environment } from '../api/AccessManagementApi.js';
import {
    AlertPendingError,
    type AlertEntity,
    type AlertMetricId,
    type AlertNotification,
    type AlertOperator,
    type AlertWriteBody,
    type MonitoringAlert,
    type RuntimeManagerAlert,
} from '../api/AlertsApi.js';

export type MetricUnit = 'percent' | 'count' | 'ms';

export interface MetricInfo {
    unit: MetricUnit;
    entityType: 'application' | 'api';
    aggregation: 'AVG' | 'SUM';
    /** An API filter this metric needs. */
    requires?: 'RESPONSE_CODE' | 'POLICY';
}

/** Every metric an alert can watch, in one table. */
export const ALERT_METRICS: Record<AlertMetricId, MetricInfo> = {
    cpu_utilization: { unit: 'percent', entityType: 'application', aggregation: 'AVG' },
    memory_utilization: { unit: 'percent', entityType: 'application', aggregation: 'AVG' },
    thread_count: { unit: 'count', entityType: 'application', aggregation: 'AVG' },
    message_count: { unit: 'count', entityType: 'application', aggregation: 'SUM' },
    message_error_count: { unit: 'count', entityType: 'application', aggregation: 'SUM' },
    message_response_time: { unit: 'ms', entityType: 'application', aggregation: 'AVG' },
    api_request_count: { unit: 'count', entityType: 'api', aggregation: 'SUM' },
    api_response_time: { unit: 'ms', entityType: 'api', aggregation: 'AVG' },
    api_response_code_count: { unit: 'count', entityType: 'api', aggregation: 'SUM', requires: 'RESPONSE_CODE' },
    api_policy_violation_count: { unit: 'count', entityType: 'api', aggregation: 'SUM', requires: 'POLICY' },
};

export const MAX_DURATION_MINUTES = 60;

// ── Display ───────────────────────────────────────────

export interface RecipientSummary {
    recipientCount: number;
    /** Email domains only, never addresses. */
    recipientDomains: string[];
    slackChannels: number;
}

function domainOf(email: string): string {
    const at = email.lastIndexOf('@');
    return at >= 0 ? email.slice(at + 1).toLowerCase() : '(invalid address)';
}

export function summarizeRecipients(notifications: AlertNotification[] = []): RecipientSummary {
    const emails = notifications.filter((n) => n.type === 'EMAIL').flatMap((n) => n.recipients ?? []);
    return {
        recipientCount: emails.length + notifications.filter((n) => n.type === 'SLACK').length,
        recipientDomains: [...new Set(emails.map(domainOf))].sort(),
        slackChannels: notifications.filter((n) => n.type === 'SLACK').length,
    };
}

/**
 * Notifications as written back: the read side (`notificationTemplates`) under the write name, with
 * every field the platform returned kept, including ones this tool does not know.
 */
export function notificationsOf(alert: MonitoringAlert): AlertNotification[] {
    return (alert.notificationTemplates ?? alert.notifications ?? []).map((n) => ({
        ...n,
        ...(n.recipients ? { recipients: [...n.recipients] } : {}),
    }));
}

/** The fields a caller sets on a notification, in a fixed order, for comparison. */
function settableNotification(n: AlertNotification) {
    return {
        type: n.type,
        recipients: n.recipients ?? [],
        subject: n.subject ?? null,
        messageTemplate: n.messageTemplate ?? null,
        channelId: n.channelId ?? null,
        carrierId: n.carrierId ?? null,
    };
}

/** Which aspects of the notifications differ, by name only, so a masked diff still says what changed. */
export function notificationDifferences(before: AlertNotification[], after: AlertNotification[]): string[] {
    const a = before.map(settableNotification);
    const b = after.map(settableNotification);
    const fields = new Set<string>();
    if (a.length !== b.length) fields.add('count');
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const x = a[i] as Record<string, unknown> | undefined;
        const y = b[i] as Record<string, unknown> | undefined;
        if (!x || !y) continue;
        for (const key of Object.keys(x)) {
            if (JSON.stringify(x[key]) !== JSON.stringify(y[key])) fields.add(key);
        }
    }
    return [...fields];
}

/**
 * A recipient summary for display. Domains can identify clients, so they are shown only with `reveal`;
 * otherwise only the counts.
 */
export function displayRecipients(notifications: AlertNotification[], reveal = false) {
    const { recipientDomains, ...counts } = summarizeRecipients(notifications);
    return reveal ? { ...counts, recipientDomains } : counts;
}

/** Notifications for display: masked to counts unless `reveal`. */
export function describeNotifications(notifications: AlertNotification[], reveal = false) {
    return notifications.map((n) =>
        reveal
            ? n
            : {
                  type: n.type,
                  ...(n.subject !== undefined ? { subject: n.subject } : {}),
                  ...displayRecipients([n]),
              },
    );
}

// ── Severity ──────────────────────────────────────────

/** The Monitoring UI's levels: the stored number is the index. */
export const SEVERITY_LABELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type SeverityLabel = (typeof SEVERITY_LABELS)[number];

/** Other alert families use words; map them onto the same labels. */
const SEVERITY_WORDS: Record<string, SeverityLabel> = {
    info: 'LOW',
    low: 'LOW',
    warning: 'MEDIUM',
    warn: 'MEDIUM',
    medium: 'MEDIUM',
    error: 'HIGH',
    high: 'HIGH',
    critical: 'CRITICAL',
};

/** A severity given as 0-3 or a label (LOW, MEDIUM, HIGH, CRITICAL), as the stored number. */
export function parseSeverity(input: number | string): number {
    if (typeof input === 'number' || /^\d+$/.test(String(input).trim())) {
        const n = Number(input);
        if (!Number.isInteger(n) || n < 0 || n > 3)
            throw new Error('severity must be 0-3 or LOW, MEDIUM, HIGH, CRITICAL');
        return n;
    }
    const index = SEVERITY_LABELS.indexOf(String(input).trim().toUpperCase() as SeverityLabel);
    if (index < 0) throw new Error('severity must be 0-3 or LOW, MEDIUM, HIGH, CRITICAL');
    return index;
}

/** One label for any family's severity: a Monitoring number, or a word such as INFO or warning. */
export function severityLabel(value: unknown): string | undefined {
    if (typeof value === 'number') return SEVERITY_LABELS[value] ?? String(value);
    if (typeof value === 'string' && value) return SEVERITY_WORDS[value.toLowerCase()] ?? value.toUpperCase();
    return undefined;
}

export function windowMinutes(interval: string | undefined): number | undefined {
    const match = /^(\d+)\s*([mh])$/i.exec(interval ?? '');
    if (!match) return undefined;
    return Number(match[1]) * (match[2].toLowerCase() === 'h' ? 60 : 1);
}

export function metricInfo(metric: string): MetricInfo | undefined {
    return ALERT_METRICS[metric as AlertMetricId];
}

/** A stored threshold in the unit people use: percent metrics are stored as fractions. */
export function displayThreshold(metric: string, stored: number): number {
    return metricInfo(metric)?.unit === 'percent' ? Math.round(stored * 100 * 1e6) / 1e6 : stored;
}

export type AlertSource = 'monitoring' | 'runtime-manager';

export function normalizeAlert(alert: MonitoringAlert, options: { reveal?: boolean } = {}) {
    const notifications = notificationsOf(alert);
    const entity = alert.entity ?? ({} as AlertEntity);
    const metric = alert.settings?.metricId;
    return {
        id: alert.id,
        source: 'monitoring' as AlertSource,
        name: alert.name,
        enabled: alert.enabled,
        severity: severityLabel(alert.severity),
        severityLevel: alert.severity,
        status: alert.alertStatus,
        state: alert.state?.currentState,
        entity: {
            type: entity.entityType,
            name: entity.appId ?? entity.apiName ?? entity.entityName ?? entity.endpoint,
            ...(entity.apiInstanceId ? { apiInstanceId: entity.apiInstanceId } : {}),
            deploymentType: entity.deploymentType,
            environment: entity.environmentName ?? entity.environmentId,
            environmentId: entity.environmentId,
        },
        condition: {
            metric,
            operator: alert.settings?.evaluationOperator,
            threshold: metric !== undefined ? displayThreshold(metric, alert.settings.threshold) : undefined,
            unit: metric !== undefined ? metricInfo(metric)?.unit : undefined,
            windowMinutes: windowMinutes(alert.settings?.evaluationInterval),
        },
        ...displayRecipients(notifications, options.reveal),
        ...(options.reveal ? { notifications } : {}),
    };
}

const RM_RESOURCE_TYPES: Record<string, string> = { 'mc-application': 'application' };

/** Whether a Runtime Manager alert targets an app: membership in its resources, case-insensitive. */
export function targetsApp(resources: readonly string[] | undefined, app: string): boolean {
    return (resources ?? []).some((r) => r.toLowerCase() === app.toLowerCase());
}

/**
 * View of a Runtime Manager event alert (deployment failed and similar). Observed shape:
 * condition{type, resourceType, resources[]}, actions[]{type, userIds[], emails[], subject, content},
 * plus conditionType, isSystem and productName.
 */
export function normalizeRuntimeManagerAlert(alert: RuntimeManagerAlert, options: { reveal?: boolean } = {}) {
    const text = (value: unknown) => (typeof value === 'string' || typeof value === 'number' ? value : undefined);
    const condition = (alert.condition ?? {}) as Record<string, unknown>;
    const actions = (Array.isArray(alert.actions) ? alert.actions : []) as Array<Record<string, unknown>>;
    const strings = (value: unknown) =>
        Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
    const emails = actions.flatMap((a) => strings(a.emails));
    const userIds = actions.flatMap((a) => strings(a.userIds));
    const resources = strings(condition.resources);
    const resourceType = text(condition.resourceType);
    return {
        id: text(alert.id),
        source: 'runtime-manager' as AlertSource,
        name: text(alert.name),
        enabled: typeof alert.enabled === 'boolean' ? alert.enabled : undefined,
        severity: severityLabel(alert.severity),
        status: text(alert.status),
        state: text(alert.state),
        entity: {
            type: (resourceType && RM_RESOURCE_TYPES[String(resourceType)]) ?? resourceType,
            name: resources.length ? resources.join(', ') : undefined,
            /** Every target, for filtering by membership. */
            resources,
        },
        condition: { event: text(condition.type) },
        ...(text(alert.conditionType) !== undefined ? { conditionType: text(alert.conditionType) } : {}),
        ...(typeof alert.isSystem === 'boolean' ? { isSystem: alert.isSystem } : {}),
        ...(text(alert.productName) !== undefined ? { productName: text(alert.productName) } : {}),
        recipientCount: emails.length + userIds.length,
        ...(options.reveal
            ? {
                  recipientDomains: [...new Set(emails.map(domainOf))].sort(),
                  actions: actions.map((a) => ({
                      type: a.type,
                      emails: strings(a.emails),
                      userIds: strings(a.userIds),
                  })),
              }
            : {}),
    };
}

// ── Inputs ────────────────────────────────────────────

export type NotificationInput =
    | { type: 'EMAIL'; recipients: string[]; subject: string; message: string }
    | { type: 'SLACK'; channelId: string; carrierId?: string; message: string };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Turn explicit notification inputs into the platform shape. At least one is required; there are no defaults. */
export function buildNotifications(inputs: NotificationInput[] | undefined): AlertNotification[] {
    if (!inputs?.length) throw new Error('At least one notification is required (EMAIL recipients or a SLACK channel)');
    return inputs.map((n, i) => {
        if (n.type === 'EMAIL') {
            if (!n.recipients?.length) throw new Error(`notifications[${i}]: EMAIL needs at least one recipient`);
            const bad = n.recipients.filter((r) => !EMAIL.test(r));
            if (bad.length) throw new Error(`notifications[${i}]: ${bad.length} recipient(s) are not email addresses`);
            if (!n.subject?.trim()) throw new Error(`notifications[${i}]: EMAIL needs a subject`);
            if (!n.message?.trim()) throw new Error(`notifications[${i}]: EMAIL needs a message`);
            return { type: 'EMAIL', recipients: [...n.recipients], subject: n.subject, messageTemplate: n.message };
        }
        if (!n.channelId?.trim()) throw new Error(`notifications[${i}]: SLACK needs a channelId`);
        if (!n.message?.trim()) throw new Error(`notifications[${i}]: SLACK needs a message`);
        return {
            type: 'SLACK',
            channelId: n.channelId,
            ...(n.carrierId ? { carrierId: n.carrierId } : {}),
            messageTemplate: n.message,
        };
    });
}

/** Convert and validate a threshold given in the metric's unit (percent for % metrics). */
export function storedThreshold(metric: AlertMetricId, value: number): number {
    const info = ALERT_METRICS[metric];
    if (!Number.isFinite(value)) throw new Error('threshold must be a number');
    if (info.unit === 'percent') {
        if (value <= 0 || value > 100) {
            throw new Error(`threshold for ${metric} is a percentage: more than 0 and at most 100 (got ${value})`);
        }
        return Math.round((value / 100) * 1e6) / 1e6;
    }
    if (value < 0) throw new Error(`threshold for ${metric} must not be negative`);
    if (info.unit === 'count' && !Number.isInteger(value)) {
        throw new Error(`threshold for ${metric} is a count and must be a whole number`);
    }
    return value;
}

export function evaluationInterval(durationMinutes: number): string {
    if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > MAX_DURATION_MINUTES) {
        throw new Error(`durationMinutes must be a whole number from 1 to ${MAX_DURATION_MINUTES}`);
    }
    return `${durationMinutes}m`;
}

export const checkSeverity = parseSeverity;

export interface ApiFilterInput {
    responseCodes?: string[];
    policies?: string[];
}

export type AlertTarget = { app: string } | { apiInstanceId: string };

export interface CreateAlertInput {
    environment: string;
    name: string;
    target: AlertTarget;
    metric: AlertMetricId;
    operator: AlertOperator;
    /** In the metric's unit: percent (0-100] for cpu and memory, a count, or milliseconds. */
    threshold: number;
    durationMinutes: number;
    /** 0-3, or LOW, MEDIUM, HIGH, CRITICAL. */
    severity: number | string;
    enabled?: boolean;
    notifications: NotificationInput[];
    apiFilters?: ApiFilterInput;
    allowDuplicate?: boolean;
}

/** Resolve the alert entity from CloudHub 2.0 (an app) or API Manager (an API instance). */
export async function resolveAlertEntity(
    client: AnypointClient,
    orgId: string,
    env: Pick<Environment, 'id' | 'name'>,
    target: AlertTarget,
    metric: AlertMetricId,
    filters?: ApiFilterInput,
): Promise<AlertEntity> {
    const info = ALERT_METRICS[metric];
    if ('app' in target) {
        if (info.entityType !== 'application') throw new Error(`${metric} applies to an API instance, not an app`);
        const deployment = await client.cloudHub2.findDetailByName(orgId, env.id, target.app);
        if (!deployment) {
            throw new Error(
                `Application "${target.app}" not found in CloudHub 2.0 in ${env.name}; alerts can be created for CloudHub 2.0 apps and API instances`,
            );
        }
        return {
            entityType: 'application',
            subOrgId: orgId,
            environmentId: env.id,
            environmentName: env.name,
            appId: deployment.name,
            clusterId: deployment.target?.targetId,
            deploymentType: 'CLOUDHUB2',
            deploymentId: deployment.id,
        };
    }
    if (info.entityType !== 'api') throw new Error(`${metric} applies to an app, not an API instance`);
    const resolved = await client.apiManager.resolveApiInstance(orgId, env, String(target.apiInstanceId));
    if (!resolved.instance) throw new Error(`API instance ${target.apiInstanceId} not found in ${env.name}`);
    const apiFilters = [
        ...(filters?.responseCodes?.length
            ? [{ property: 'RESPONSE_CODE' as const, operator: 'IN' as const, values: filters.responseCodes }]
            : []),
        ...(filters?.policies?.length
            ? [{ property: 'POLICY' as const, operator: 'IN' as const, values: filters.policies }]
            : []),
    ];
    if (info.requires && !apiFilters.some((f) => f.property === info.requires)) {
        throw new Error(
            `${metric} needs apiFilters.${info.requires === 'RESPONSE_CODE' ? 'responseCodes' : 'policies'}`,
        );
    }
    return {
        entityType: 'api',
        subOrgId: orgId,
        environmentId: env.id,
        environmentName: env.name,
        apiName: resolved.asset?.exchangeAssetName ?? resolved.instance.assetId,
        apiInstanceId: String(resolved.apiId),
        ...(resolved.instance.endpointUri ? { endpoint: resolved.instance.endpointUri } : {}),
        ...(apiFilters.length ? { filters: apiFilters } : {}),
    };
}

export function sameEntity(a: AlertEntity | undefined, b: AlertEntity): boolean {
    if (!a || a.entityType !== b.entityType || a.environmentId !== b.environmentId) return false;
    return b.entityType === 'api' ? String(a.apiInstanceId) === String(b.apiInstanceId) : a.appId === b.appId;
}

/** Recipients outside the user's own email domain, as domains. The user's address is never returned. */
export function outsideDomains(notifications: AlertNotification[], userEmail: string | undefined): string[] {
    if (!userEmail || !userEmail.includes('@')) return [];
    const own = domainOf(userEmail);
    return summarizeRecipients(notifications).recipientDomains.filter((d) => d !== own);
}

export interface CreateAlertPlan {
    orgId: string;
    env: Environment;
    body: AlertWriteBody;
    warnings: string[];
    /** An existing alert with the same name on the same entity. */
    duplicate?: { id: string; name: string; status?: string };
}

/**
 * The create payload for a preview. For an API target only the instance ID the caller passed is shown;
 * the API name and endpoint resolved from API Manager are sent but not printed.
 */
export function previewPayload(body: AlertWriteBody): AlertWriteBody {
    if (body.entity.entityType !== 'api') return body;
    const { apiName: _apiName, endpoint: _endpoint, ...entity } = body.entity;
    return { ...body, entity: { ...entity, apiName: '(resolved from API Manager)' } };
}

export async function planCreateAlert(
    client: AnypointClient,
    input: CreateAlertInput,
    options: { enableHint?: string } = {},
): Promise<CreateAlertPlan> {
    const orgId = await client.getDefaultOrgId();
    const env = await client.accessManagement.resolveEnvironment(orgId, input.environment);
    if (!input.name?.trim()) throw new Error('name is required');
    const info = ALERT_METRICS[input.metric];
    if (!info) throw new Error(`Unknown metric "${input.metric}"`);
    const notifications = buildNotifications(input.notifications);
    const settings = {
        metricId: input.metric,
        aggregationFunction: info.aggregation,
        evaluationOperator: input.operator,
        aggregationInterval: '1m',
        threshold: storedThreshold(input.metric, input.threshold),
        evaluationInterval: evaluationInterval(input.durationMinutes),
    };
    const entity = await resolveAlertEntity(client, orgId, env, input.target, input.metric, input.apiFilters);
    const body: AlertWriteBody = {
        name: input.name.trim(),
        severity: checkSeverity(input.severity),
        enabled: input.enabled ?? false,
        settings,
        entity,
        notifications,
    };

    const warnings: string[] = [];
    let userEmail: string | undefined;
    try {
        userEmail = (await client.whoami()).email;
    } catch {
        // Without the user's address the domain check is skipped.
    }
    const outside = outsideDomains(notifications, userEmail);
    if (outside.length) warnings.push(`Recipients outside your email domain: ${outside.join(', ')}`);
    if (!body.enabled) {
        warnings.push(
            `The alert is created disabled; enable it with ${options.enableHint ?? 'set_alert_enabled'} once reviewed.`,
        );
    }

    const existing = await client.alerts.list(orgId, { environmentId: env.id, name: body.name });
    const match = existing.find(
        (a) => a.name === body.name && a.alertStatus !== 'DELETED' && sameEntity(a.entity, entity),
    );
    return {
        orgId,
        env,
        body,
        warnings,
        ...(match ? { duplicate: { id: match.id, name: match.name, status: match.alertStatus } } : {}),
    };
}

// ── Update ────────────────────────────────────────────

export interface AlertPatch {
    name?: string;
    /** 0-3, or LOW, MEDIUM, HIGH, CRITICAL. */
    severity?: number | string;
    enabled?: boolean;
    operator?: AlertOperator;
    /** In the metric's unit, as for create. */
    threshold?: number;
    durationMinutes?: number;
    /** Replaces every notification. */
    notifications?: NotificationInput[];
}

export interface AlertChange {
    field: string;
    from: unknown;
    to: unknown;
    /** For notifications: which parts differ (recipients, subject, messageTemplate, channelId, ...). */
    differs?: string[];
}

/** Fields the platform returns but does not take back; everything else on the alert is resent. */
const READ_ONLY_ALERT_FIELDS = [
    'alertStatus',
    'state',
    'notificationTemplates',
    'createdAt',
    'updatedAt',
    'createdDate',
    'updatedDate',
    'lastModifiedDate',
] as const;

export interface UpdateAlertPlan {
    orgId: string;
    env: Environment;
    existing: MonitoringAlert;
    body: AlertWriteBody;
    changes: AlertChange[];
    noop: boolean;
}

export async function loadAlert(client: AnypointClient, orgId: string, id: string): Promise<MonitoringAlert> {
    const alert = await client.alerts.get(orgId, id);
    if (!alert || alert.alertStatus === 'DELETED') throw new Error(`Alert ${id} not found (it may have been deleted)`);
    return alert;
}

/** The environment an alert belongs to, for production checks. */
export async function alertEnvironment(client: AnypointClient, orgId: string, alert: MonitoringAlert) {
    return client.accessManagement.resolveEnvironment(orgId, alert.entity.environmentId);
}

/** Read the alert, merge the patch, and build the full replacement body the platform needs. */
export async function planUpdateAlert(client: AnypointClient, id: string, patch: AlertPatch): Promise<UpdateAlertPlan> {
    const orgId = await client.getDefaultOrgId();
    const existing = await loadAlert(client, orgId, id);
    if (existing.alertStatus === 'PENDING') throw new AlertPendingError(id);
    const env = await alertEnvironment(client, orgId, existing);
    const metric = existing.settings.metricId as AlertMetricId;

    const settings = { ...existing.settings };
    if (patch.operator !== undefined) settings.evaluationOperator = patch.operator;
    if (patch.threshold !== undefined) {
        if (!metricInfo(metric)) throw new Error(`Unknown metric "${metric}"; threshold cannot be converted`);
        settings.threshold = storedThreshold(metric, patch.threshold);
    }
    if (patch.durationMinutes !== undefined) settings.evaluationInterval = evaluationInterval(patch.durationMinutes);

    const writable: Record<string, unknown> = { ...existing };
    for (const field of READ_ONLY_ALERT_FIELDS) delete writable[field];
    const body: AlertWriteBody = {
        ...writable,
        id: existing.id,
        name: patch.name?.trim() || existing.name,
        severity: patch.severity !== undefined ? checkSeverity(patch.severity) : existing.severity,
        enabled: patch.enabled ?? existing.enabled,
        settings,
        entity: existing.entity,
        notifications: patch.notifications ? buildNotifications(patch.notifications) : notificationsOf(existing),
    };

    const changes: AlertChange[] = [];
    const push = (field: string, from: unknown, to: unknown) => {
        if (JSON.stringify(from) !== JSON.stringify(to)) changes.push({ field, from, to });
    };
    push('name', existing.name, body.name);
    push('severity', severityLabel(existing.severity), severityLabel(body.severity));
    push('enabled', existing.enabled, body.enabled);
    push('operator', existing.settings.evaluationOperator, settings.evaluationOperator);
    push(
        'threshold',
        displayThreshold(metric, existing.settings.threshold),
        displayThreshold(metric, settings.threshold),
    );
    push(
        'windowMinutes',
        windowMinutes(existing.settings.evaluationInterval),
        windowMinutes(settings.evaluationInterval),
    );
    if (patch.notifications) {
        // Compare the full bodies; show only the masked summary and which parts differ.
        const differs = notificationDifferences(notificationsOf(existing), body.notifications);
        if (differs.length) {
            changes.push({
                field: 'notifications',
                from: describeNotifications(notificationsOf(existing)),
                to: describeNotifications(body.notifications),
                differs,
            });
        }
    }
    return { orgId, env, existing, body, changes, noop: changes.length === 0 };
}

// ── Delete ────────────────────────────────────────────

/**
 * Find an alert in the list, narrowed by environment and name so the listing stays small. `complete`
 * is false when the listing hit its page cap; absence from an incomplete listing proves nothing.
 */
export async function findListedAlert(
    client: AnypointClient,
    orgId: string,
    alert: { id: string; name?: string; environmentId?: string },
): Promise<{ alert?: MonitoringAlert; complete: boolean }> {
    const { alerts, complete } = await client.alerts.listAll(orgId, {
        ...(alert.environmentId ? { environmentId: alert.environmentId } : {}),
        ...(alert.name ? { name: alert.name } : {}),
    });
    return { alert: alerts.find((a) => a.id === alert.id && a.alertStatus !== 'DELETED'), complete };
}

// ── Update result ─────────────────────────────────────

export interface UpdateAlertResult {
    accepted: true;
    /** True only when the listed alert is ACTIVE and carries the new values. */
    verified: boolean;
    status: 'ACTIVE' | 'PENDING' | 'UNVERIFIED';
    message: string;
}

function applied(listed: MonitoringAlert, body: AlertWriteBody): boolean {
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    return (
        listed.name === body.name &&
        listed.enabled === body.enabled &&
        listed.severity === body.severity &&
        same(listed.settings?.threshold, body.settings.threshold) &&
        same(listed.settings?.evaluationOperator, body.settings.evaluationOperator) &&
        same(listed.settings?.evaluationInterval, body.settings.evaluationInterval)
    );
}

/**
 * Send the full replacement, then re-read the alert from the list once. The platform answers 202 and
 * applies the change asynchronously, so "updated" is claimed only when the list shows it applied.
 */
export async function executeUpdateAlert(
    client: AnypointClient,
    plan: Pick<UpdateAlertPlan, 'orgId' | 'existing' | 'body'>,
): Promise<UpdateAlertResult> {
    const id = plan.existing.id;
    await client.alerts.update(plan.orgId, id, plan.body);
    const { alert: listed } = await findListedAlert(client, plan.orgId, {
        id,
        name: plan.body.name,
        environmentId: plan.existing.entity.environmentId,
    });
    const retry = 'The platform applies changes asynchronously; check again with get_alert or list_alerts in a minute.';
    if (!listed) {
        return {
            accepted: true,
            verified: false,
            status: 'UNVERIFIED',
            message: `Change accepted; the alert was not found in the list yet. ${retry}`,
        };
    }
    if (listed.alertStatus === 'PENDING') {
        return {
            accepted: true,
            verified: false,
            status: 'PENDING',
            message: `Change accepted; the alert is PENDING while the platform applies it. ${retry}`,
        };
    }
    if (!applied(listed, plan.body)) {
        return {
            accepted: true,
            verified: false,
            status: 'ACTIVE',
            message: `Change accepted, but the list still shows the previous values. ${retry}`,
        };
    }
    return { accepted: true, verified: true, status: 'ACTIVE', message: `Updated alert "${plan.body.name}".` };
}

// ── Delete ────────────────────────────────────────────

export interface DeleteAlertResult {
    accepted: boolean;
    /** PENDING while the platform deletes it; GONE once the complete list no longer shows it. */
    status: 'PENDING' | 'ACTIVE' | 'DELETED' | 'GONE' | 'UNVERIFIED';
    verifiedAbsent: boolean;
    message: string;
}

export const CHANGE_IN_PROGRESS =
    'A change to this alert is in progress (PENDING); the platform refuses changes and deletion until it finishes. Retry later.';

/**
 * Read an alert for deletion. The list is fresher than GET right after a change (GET can keep
 * answering ACTIVE, or 404 while the list still shows PENDING), so the listed entry wins.
 */
export async function readAlertForDelete(
    client: AnypointClient,
    orgId: string,
    id: string,
): Promise<MonitoringAlert | null> {
    const got = await client.alerts.get(orgId, id);
    const { alert: listed } = await findListedAlert(client, orgId, {
        id,
        ...(got ? { name: got.name, environmentId: got.entity.environmentId } : {}),
    });
    if (listed) return listed;
    return got && got.alertStatus !== 'DELETED' ? got : null;
}

/**
 * Request deletion, then verify it from the list. Never claims deleted while the list still shows the
 * alert, or when the listing was cut off. A 404 on DELETE with the alert absent from a complete
 * listing means it is already gone.
 */
export async function executeDeleteAlert(
    client: AnypointClient,
    orgId: string,
    alert: Pick<MonitoringAlert, 'id' | 'name' | 'entity'>,
): Promise<DeleteAlertResult> {
    const outcome = await client.alerts.delete(orgId, alert.id);
    const { alert: still, complete } = await findListedAlert(client, orgId, {
        id: alert.id,
        name: alert.name,
        environmentId: alert.entity.environmentId,
    });
    if (!still && !complete) {
        return {
            accepted: outcome === 'accepted',
            status: 'UNVERIFIED',
            verifiedAbsent: false,
            message:
                'Deletion accepted, but it could not be verified: the alert list is longer than this tool reads. Check again with get_alert or list_alerts.',
        };
    }
    if (!still) {
        return {
            accepted: outcome === 'accepted',
            status: 'GONE',
            verifiedAbsent: true,
            message:
                outcome === 'accepted'
                    ? 'Deleted; the alert no longer appears in the list.'
                    : 'Already gone: the platform no longer has the alert and it is not in the list.',
        };
    }
    if (outcome === 'not-found') {
        return {
            accepted: false,
            status: still.alertStatus === 'ACTIVE' ? 'ACTIVE' : 'PENDING',
            verifiedAbsent: false,
            message: `The platform answered not found but still lists the alert (${still.alertStatus}). ${CHANGE_IN_PROGRESS}`,
        };
    }
    return {
        accepted: true,
        status: still.alertStatus === 'ACTIVE' ? 'ACTIVE' : 'PENDING',
        verifiedAbsent: false,
        message:
            'Deletion accepted but not finished: the alert still appears in the list. Deletion is asynchronous and can take a while; check again with list_alerts.',
    };
}
