/**
 * Alerts API
 * Anypoint Monitoring alerts (the observability family behind the Monitoring UI) and a read of
 * Runtime Manager event alerts.
 *
 * These endpoints are not publicly documented. Shapes follow observed responses and may change; a
 * family that answers 404 or 403 on list is reported as unsupported (AlertsUnsupportedError) rather
 * than as "no alerts".
 */

import { AxiosError } from 'axios';
import type { HttpClient } from '../client/HttpClient.js';
import { sanitizePlatformText } from '../safety/secrets.js';
import { errorMessage } from '../utils/errors.js';

export const ALERT_METRIC_IDS = [
    'cpu_utilization',
    'memory_utilization',
    'thread_count',
    'message_count',
    'message_error_count',
    'message_response_time',
    'api_request_count',
    'api_response_time',
    'api_response_code_count',
    'api_policy_violation_count',
] as const;
export type AlertMetricId = (typeof ALERT_METRIC_IDS)[number];

export const ALERT_OPERATORS = [
    'GREATER_THAN',
    'LESS_THAN',
    'GREATER_THAN_EQUAL_TO',
    'LESS_THAN_EQUAL_TO',
    'EQUALS',
] as const;
export type AlertOperator = (typeof ALERT_OPERATORS)[number];

export type AlertStatus = 'PENDING' | 'ACTIVE' | 'DELETED';
export type AlertDeploymentType = 'CLOUDHUB' | 'CLOUDHUB2' | 'RTF' | 'HYBRID';
export type AlertEntityType = 'application' | 'api' | 'server';

export interface AlertSettings {
    metricId: string;
    aggregationFunction: 'AVG' | 'SUM';
    evaluationOperator: AlertOperator;
    aggregationInterval: string;
    /** A fraction (0..1) for percent metrics. */
    threshold: number;
    evaluationInterval: string;
    numWindows?: number;
}

export interface AlertApiFilter {
    property: 'POLICY' | 'RESPONSE_CODE';
    operator: 'IN';
    values: string[];
}

export interface AlertEntity {
    entityType: AlertEntityType;
    subOrgId?: string;
    masterOrgId?: string;
    environmentId: string;
    environmentName?: string;
    appId?: string;
    clusterId?: string;
    deploymentType?: AlertDeploymentType;
    deploymentId?: string;
    flowId?: string;
    endpoint?: string;
    apiName?: string;
    apiInstanceId?: string;
    filters?: AlertApiFilter[];
    entityName?: string;
}

export interface AlertNotification {
    [field: string]: unknown;
    type: 'EMAIL' | 'SLACK';
    recipients?: string[];
    subject?: string;
    messageTemplate?: string;
    channelId?: string;
    carrierId?: string;
}

export interface MonitoringAlert {
    id: string;
    name: string;
    alertStatus?: AlertStatus;
    severity: number;
    enabled: boolean;
    alertOn?: string;
    settings: AlertSettings;
    entity: AlertEntity;
    tags?: Record<string, unknown>;
    state?: { currentState?: 'OK' | 'ALERTING' | string };
    /** The read side of `notifications`. */
    notificationTemplates?: AlertNotification[];
    notifications?: AlertNotification[];
    createdAt?: string;
    updatedAt?: string;
}

/** The body for create (no id) and update (full body with id); notifications are written as `notifications`. */
export interface AlertWriteBody {
    /** Writable fields of the existing alert this tool does not model (tags, alertOn, ...) are resent as is. */
    [field: string]: unknown;
    id?: string;
    name: string;
    severity: number;
    enabled: boolean;
    settings: AlertSettings;
    entity: AlertEntity;
    notifications: AlertNotification[];
}

/** A Runtime Manager event alert, as returned (best effort; the shape is not documented). */
export type RuntimeManagerAlert = Record<string, unknown> & { id?: string; name?: string };

export class AlertsUnsupportedError extends Error {
    constructor(
        readonly family: string,
        readonly status: number,
    ) {
        super(`${family} alerts are not available for this organization or token (HTTP ${status})`);
        this.name = 'AlertsUnsupportedError';
    }
}

export class AlertPendingError extends Error {
    constructor(id: string) {
        super(
            `Alert ${id} is still PENDING (being provisioned or deleted), and the platform refuses changes until it is ACTIVE. Retry in a minute or two.`,
        );
        this.name = 'AlertPendingError';
    }
}

const BASE = '/observability/api/v1';
const PAGE_SIZE = 100;
/** Hard stop for pagination: 2,000 alerts. */
const MAX_PAGES = 20;

function status(error: unknown): number | undefined {
    return error instanceof AxiosError ? error.response?.status : undefined;
}

/**
 * Map platform errors to messages that say what happened. Platform text is sanitized first: an alert
 * error can echo recipients or tokens, and it ends up in MCP responses and CLI output.
 */
export function alertError(error: unknown, id?: string): Error {
    const code = status(error);
    const detail = sanitizePlatformText(errorMessage(error));
    if (code === 404) return new Error(`${id ? `Alert ${id}` : 'Alert'} not found (it may have been deleted)`);
    if (code === 400 && /not present or deleted/i.test(detail) && id) return new AlertPendingError(id);
    if (code === 400) return new Error(`The alert was rejected (HTTP 400): ${detail}`);
    return new Error(code ? `Alert request failed (HTTP ${code}): ${detail}` : detail);
}

export class AlertsApi {
    constructor(private readonly http: HttpClient) {}

    private url(orgId: string, id?: string): string {
        return `${BASE}/organizations/${orgId}/alerts${id ? `/${encodeURIComponent(id)}` : ''}`;
    }

    /** Every Monitoring alert of the organization, optionally narrowed by environment ID and exact name. */
    async list(orgId: string, filter: { environmentId?: string; name?: string } = {}): Promise<MonitoringAlert[]> {
        const alerts: MonitoringAlert[] = [];
        for (let page = 0; page < MAX_PAGES; page++) {
            const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) });
            if (filter.environmentId) params.set('environmentId', filter.environmentId);
            if (filter.name) params.set('name', filter.name);
            let response: { data?: MonitoringAlert[]; metadata?: { pagination?: { next?: unknown } } };
            try {
                response = await this.http.get(`${this.url(orgId)}?${params}`);
            } catch (error) {
                const code = status(error);
                if (code === 404 || code === 403) throw new AlertsUnsupportedError('Monitoring', code);
                throw alertError(error);
            }
            const batch = response.data ?? [];
            alerts.push(...batch);
            if (batch.length < PAGE_SIZE || !response.metadata?.pagination?.next) break;
        }
        return alerts;
    }

    /** One alert, or null when it does not exist (any more). */
    async get(orgId: string, id: string): Promise<MonitoringAlert | null> {
        try {
            const response = await this.http.get<{ data?: MonitoringAlert }>(this.url(orgId, id));
            return response.data ?? null;
        } catch (error) {
            if (status(error) === 404) return null;
            throw alertError(error, id);
        }
    }

    async create(orgId: string, body: AlertWriteBody): Promise<MonitoringAlert | undefined> {
        try {
            const response = await this.http.post<{ data?: MonitoringAlert } | MonitoringAlert>(this.url(orgId), body);
            return response && 'data' in response ? response.data : (response as MonitoringAlert | undefined);
        } catch (error) {
            throw alertError(error);
        }
    }

    /** Replace an alert. The platform needs the full body; a partial one is rejected. */
    async update(orgId: string, id: string, body: AlertWriteBody): Promise<void> {
        try {
            await this.http.patch(this.url(orgId, id), { ...body, id });
        } catch (error) {
            throw alertError(error, id);
        }
    }

    /** Request deletion. It is asynchronous: the alert can stay PENDING for a while before it is gone. */
    async delete(orgId: string, id: string): Promise<'accepted' | 'not-found'> {
        try {
            await this.http.delete(this.url(orgId, id));
            return 'accepted';
        } catch (error) {
            // The platform also answers 404 while a change is still PENDING; callers check the list.
            if (status(error) === 404) return 'not-found';
            throw alertError(error, id);
        }
    }

    /** Runtime Manager event alerts (deployment failed and similar) for one environment. Read only. */
    async listRuntimeManager(orgId: string, envId: string): Promise<RuntimeManagerAlert[]> {
        try {
            const response = await this.http.get<{ data?: RuntimeManagerAlert[] } | RuntimeManagerAlert[]>(
                '/armui/api/v1/alerts',
                { headers: { 'X-ANYPNT-ORG-ID': orgId, 'X-ANYPNT-ENV-ID': envId } },
            );
            return Array.isArray(response) ? response : (response.data ?? []);
        } catch (error) {
            const code = status(error);
            if (code === 404 || code === 403) throw new AlertsUnsupportedError('Runtime Manager', code);
            throw alertError(error);
        }
    }
}
