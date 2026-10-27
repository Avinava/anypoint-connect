/** Synthetic Anypoint Monitoring alert fixtures. No real organization, environment, app or user values. */
import { AxiosError } from 'axios';
import type { AlertDeploymentType, MonitoringAlert } from '../../src/api/AlertsApi.js';

export function httpError(status: number, data: unknown = {}) {
    return new AxiosError('request failed', 'ERR_BAD_REQUEST', undefined, undefined, {
        status,
        statusText: '',
        headers: {},
        config: {} as never,
        data,
    });
}

export const ORG = 'org-sample';
export const SANDBOX = { id: 'env-sbx', name: 'Sandbox', isProduction: false, organizationId: ORG, type: 'sandbox' };
export const PRODUCTION = {
    id: 'env-prd',
    name: 'Production',
    isProduction: true,
    organizationId: ORG,
    type: 'production',
};

export function appAlert(overrides: Partial<MonitoringAlert> = {}, deploymentType: AlertDeploymentType = 'CLOUDHUB2') {
    return {
        id: 'alert-1',
        name: 'orders memory',
        alertStatus: 'ACTIVE',
        severity: 1,
        enabled: true,
        alertOn: 'METRICS',
        settings: {
            metricId: 'memory_utilization',
            aggregationFunction: 'AVG',
            evaluationOperator: 'GREATER_THAN',
            aggregationInterval: '1m',
            threshold: 0.85,
            evaluationInterval: '5m',
        },
        entity: {
            entityType: 'application',
            subOrgId: ORG,
            environmentId: SANDBOX.id,
            environmentName: SANDBOX.name,
            appId: 'orders-sapi',
            clusterId: 'target-1',
            deploymentType,
            deploymentId: 'dep-1',
        },
        state: { currentState: 'OK' },
        notificationTemplates: [
            {
                type: 'EMAIL',
                recipients: ['ops@example.com', 'pager@example.org'],
                subject: 'Memory high',
                messageTemplate: 'Memory is high',
            },
        ],
        ...overrides,
    } as MonitoringAlert;
}

export function apiAlert(overrides: Partial<MonitoringAlert> = {}) {
    return appAlert({
        id: 'alert-api',
        name: 'orders api 5xx',
        settings: {
            metricId: 'api_response_code_count',
            aggregationFunction: 'SUM',
            evaluationOperator: 'GREATER_THAN',
            aggregationInterval: '1m',
            threshold: 10,
            evaluationInterval: '10m',
        },
        entity: {
            entityType: 'api',
            subOrgId: ORG,
            environmentId: SANDBOX.id,
            environmentName: SANDBOX.name,
            apiName: 'orders-api',
            apiInstanceId: '1001',
            filters: [{ property: 'RESPONSE_CODE', operator: 'IN', values: ['500', '503'] }],
        },
        notificationTemplates: [{ type: 'SLACK', channelId: 'C0SAMPLE', messageTemplate: 'API errors' }],
        ...overrides,
    });
}

export const deployment = {
    id: 'dep-1',
    name: 'orders-sapi',
    application: { ref: { groupId: ORG, artifactId: 'orders-sapi', version: '1.0.0', packaging: 'jar' } },
    target: { provider: 'MC', targetId: 'target-1', replicas: 1 },
};

export const apiInstance = {
    apiId: 1001,
    asset: { exchangeAssetName: 'orders-api', assetId: 'orders-api', apis: [] },
    instance: { id: 1001, assetId: 'orders-api', endpointUri: 'https://orders.example.com/api' },
};
