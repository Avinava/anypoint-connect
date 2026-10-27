import * as fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AlertsApi } from '../../../src/api/AlertsApi.js';
import { registerAlertTools } from '../../../src/mcp/tools/alerts.js';
import { registerApiManagerTools } from '../../../src/mcp/tools/api-manager.js';
import { approvalsFile, savePreapproval } from '../../../src/safety/preapproval.js';
import {
    ORG,
    PRODUCTION,
    SANDBOX,
    apiAlert,
    apiInstance,
    appAlert,
    deployment,
    httpError,
    runtimeManagerAlert,
} from '../../fixtures/alerts.js';

const BASE = `/observability/api/v1/organizations/${ORG}/alerts`;
const USER_EMAIL = 'someone@example.com';

describe('alert MCP tools', () => {
    const handlers = new Map<string, (input: any) => Promise<any>>();
    const server = {
        registerTool: vi.fn((name: string, _d: unknown, h: (input: any) => Promise<any>) => handlers.set(name, h)),
    };
    const http = { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() };
    const client = {
        getDefaultOrgId: vi.fn(),
        whoami: vi.fn(),
        accessManagement: { resolveEnvironment: vi.fn() },
        cloudHub2: { findDetailByName: vi.fn() },
        apiManager: { resolveApiInstance: vi.fn(), getAlerts: vi.fn() },
        alerts: new AlertsApi(http as any),
    };
    const parse = (result: any) => JSON.parse(result.content[0].text);
    let stored: Record<string, any>;

    /** A tiny in-memory alert service behind the mocked HttpClient. */
    function serve(alerts: Array<Record<string, any>>) {
        stored = Object.fromEntries(alerts.map((a) => [a.id, a]));
        http.get.mockImplementation(async (url: string) => {
            if (url.startsWith(`${BASE}?`)) {
                const params = new URL(`https://x${url}`).searchParams;
                const env = params.get('environmentId');
                const name = params.get('name');
                const data = Object.values(stored).filter(
                    (a) => (!env || a.entity.environmentId === env) && (!name || a.name === name),
                );
                return { data, metadata: { pagination: {} } };
            }
            const id = decodeURIComponent(url.slice(BASE.length + 1));
            if (!stored[id]) throw httpError(404);
            return { data: stored[id] };
        });
    }

    const createArgs = {
        environment: 'Sandbox',
        name: 'orders cpu',
        target: { app: 'orders-sapi' },
        metric: 'cpu_utilization',
        operator: 'GREATER_THAN',
        threshold: 90,
        durationMinutes: 10,
        severity: 2,
        notifications: [
            {
                type: 'EMAIL',
                recipients: ['ops@example.com', 'pager@example.org'],
                subject: 'CPU high',
                message: 'CPU is high',
            },
        ],
    };

    beforeEach(() => {
        handlers.clear();
        vi.resetAllMocks();
        fs.rmSync(approvalsFile(), { force: true });
        client.getDefaultOrgId.mockResolvedValue(ORG);
        client.whoami.mockResolvedValue({ email: USER_EMAIL });
        client.accessManagement.resolveEnvironment.mockImplementation(async (_org: string, ref: string) =>
            ref === PRODUCTION.id || ref === 'Production' ? PRODUCTION : SANDBOX,
        );
        client.cloudHub2.findDetailByName.mockResolvedValue(deployment);
        client.apiManager.resolveApiInstance.mockResolvedValue(apiInstance);
        client.apiManager.getAlerts.mockResolvedValue([]);
        http.post.mockResolvedValue({ data: { id: 'alert-new', alertStatus: 'PENDING' } });
        http.patch.mockResolvedValue(undefined);
        http.delete.mockResolvedValue(undefined);
        serve([appAlert(), apiAlert()]);
        registerAlertTools(server as any, client as any);
        registerApiManagerTools(server as any, client as any);
    });
    afterEach(() => fs.rmSync(approvalsFile(), { force: true }));

    describe('list_alerts and get_alert', () => {
        it('normalizes, filters and masks recipients by default', async () => {
            const body = parse(await handlers.get('list_alerts')!({ entityType: 'application', source: 'monitoring' }));
            expect(body.alerts).toHaveLength(1);
            expect(body.alerts[0]).toMatchObject({ id: 'alert-1', recipientCount: 2, severity: 'MEDIUM' });
            // Domains can identify clients: hidden unless revealRecipients
            expect(body.alerts[0].recipientDomains).toBeUndefined();
            expect(JSON.stringify(body)).not.toContain('example.org');
            const revealed = parse(await handlers.get('get_alert')!({ id: 'alert-1', revealRecipients: true }));
            expect(revealed.notifications[0].recipients).toContain('ops@example.com');
            expect(revealed.recipientDomains).toEqual(['example.com', 'example.org']);
        });

        it('regression: a Runtime Manager alert on several apps matches app by membership', async () => {
            const listMonitoring = http.get.getMockImplementation()!;
            http.get.mockImplementation(async (url: string) =>
                url === '/armui/api/v1/alerts'
                    ? {
                          data: [
                              runtimeManagerAlert({
                                  condition: {
                                      type: 'deployment-failed',
                                      resourceType: 'mc-application',
                                      resources: ['billing-sapi', 'orders-sapi'],
                                  },
                              }),
                          ],
                      }
                    : listMonitoring(url),
            );
            const body = parse(
                await handlers.get('list_alerts')!({
                    environment: 'Sandbox',
                    source: 'runtime-manager',
                    app: 'orders-sapi',
                }),
            );
            expect(body.alerts).toHaveLength(1);
            expect(body.alerts[0].entity.resources).toEqual(['billing-sapi', 'orders-sapi']);
        });

        it('reports an unsupported family cleanly', async () => {
            http.get.mockRejectedValue(httpError(403));
            const body = parse(await handlers.get('list_alerts')!({ environment: 'Sandbox' }));
            expect(body.sources.monitoring).toMatchObject({ supported: false, status: 403 });
            expect(body.sources['runtime-manager']).toMatchObject({ supported: false });
        });

        it('get_api_alerts adds the Monitoring alerts on that API instance', async () => {
            const body = parse(await handlers.get('get_api_alerts')!({ apiName: '1001', environment: 'Sandbox' }));
            expect(body.monitoringAlerts.supported).toBe(true);
            expect(body.monitoringAlerts.alerts.map((a: any) => a.id)).toEqual(['alert-api']);
        });
    });

    describe('create_alert', () => {
        it('previews the exact CloudHub 2.0 payload with the percent threshold as a fraction', async () => {
            const body = parse(await handlers.get('create_alert')!(createArgs));
            expect(body.dryRun).toBe(true);
            expect(body.payload).toEqual({
                name: 'orders cpu',
                severity: 2,
                enabled: false,
                settings: {
                    metricId: 'cpu_utilization',
                    aggregationFunction: 'AVG',
                    evaluationOperator: 'GREATER_THAN',
                    aggregationInterval: '1m',
                    threshold: 0.9,
                    evaluationInterval: '10m',
                },
                entity: {
                    entityType: 'application',
                    subOrgId: ORG,
                    environmentId: SANDBOX.id,
                    environmentName: SANDBOX.name,
                    appId: 'orders-sapi',
                    clusterId: 'target-1',
                    deploymentType: 'CLOUDHUB2',
                    deploymentId: 'dep-1',
                },
                notifications: [
                    {
                        type: 'EMAIL',
                        recipients: ['ops@example.com', 'pager@example.org'],
                        subject: 'CPU high',
                        messageTemplate: 'CPU is high',
                    },
                ],
            });
            expect(body.warnings[0]).toBe('Recipients outside your email domain: example.org');
            expect(JSON.stringify(body)).not.toContain(USER_EMAIL);
            expect(http.post).not.toHaveBeenCalled();
        });

        it('builds an API entity with filters and SUM aggregation', async () => {
            const body = parse(
                await handlers.get('create_alert')!({
                    ...createArgs,
                    name: 'orders api errors',
                    target: { apiInstanceId: '1001' },
                    metric: 'api_response_code_count',
                    threshold: 5,
                    apiFilters: { responseCodes: ['500'] },
                }),
            );
            expect(body.payload.settings).toMatchObject({ aggregationFunction: 'SUM', threshold: 5 });
            // The preview names only what the caller passed: the instance ID, not the resolved API name or endpoint.
            expect(body.payload.entity).toEqual({
                entityType: 'api',
                subOrgId: ORG,
                environmentId: SANDBOX.id,
                environmentName: SANDBOX.name,
                apiName: '(resolved from API Manager)',
                apiInstanceId: '1001',
                filters: [{ property: 'RESPONSE_CODE', operator: 'IN', values: ['500'] }],
            });
            expect(JSON.stringify(body)).not.toContain('orders-api');
            expect(JSON.stringify(body)).not.toContain('orders.example.com');

            // The platform still receives the resolved entity.
            await handlers.get('create_alert')!({
                ...createArgs,
                name: 'orders api errors',
                target: { apiInstanceId: '1001' },
                metric: 'api_response_code_count',
                threshold: 5,
                apiFilters: { responseCodes: ['500'] },
                confirm: true,
            });
            expect(http.post.mock.calls[0][1].entity).toMatchObject({
                apiName: 'orders-api',
                endpoint: 'https://orders.example.com/api',
            });
        });

        it('takes severity by number 0-3 or by label', async () => {
            expect(
                parse(await handlers.get('create_alert')!({ ...createArgs, severity: 'CRITICAL' })).payload.severity,
            ).toBe(3);
            expect(parse(await handlers.get('create_alert')!({ ...createArgs, severity: 0 })).payload.severity).toBe(0);
        });

        it('refuses a mismatched metric and target, and an API metric that needs a filter', async () => {
            const wrong = await handlers.get('create_alert')!({ ...createArgs, metric: 'api_request_count' });
            expect(wrong.isError).toBe(true);
            expect(wrong.content[0].text).toContain('applies to an API instance');
            const missing = await handlers.get('create_alert')!({
                ...createArgs,
                target: { apiInstanceId: '1001' },
                metric: 'api_response_code_count',
                threshold: 5,
            });
            expect(missing.content[0].text).toContain('apiFilters.responseCodes');
        });

        it('sends notifications on POST after confirm', async () => {
            const result = parse(await handlers.get('create_alert')!({ ...createArgs, confirm: true }));
            expect(result).toMatchObject({ id: 'alert-new', status: 'PENDING' });
            expect(http.post.mock.calls[0][1].notifications[0].messageTemplate).toBe('CPU is high');
            expect(http.post.mock.calls[0][1].notificationTemplates).toBeUndefined();
        });

        it('refuses a duplicate name on the same target unless allowDuplicate', async () => {
            const args = {
                ...createArgs,
                name: 'orders memory',
                metric: 'memory_utilization',
                threshold: 85,
                confirm: true,
            };
            const refused = await handlers.get('create_alert')!(args);
            expect(refused.isError).toBe(true);
            expect(parse(refused).existingId).toBe('alert-1');
            expect(http.post).not.toHaveBeenCalled();
            await handlers.get('create_alert')!({ ...args, allowDuplicate: true });
            expect(http.post).toHaveBeenCalledTimes(1);
        });

        it('needs confirmProduction in production, or a pre-approval for create_alert', async () => {
            const args = { ...createArgs, environment: 'Production', confirm: true };
            const refused = await handlers.get('create_alert')!(args);
            expect(parse(refused)).toMatchObject({ refused: true, productionPreapproved: false });
            expect(http.post).not.toHaveBeenCalled();

            const scope = { orgId: ORG, environmentId: PRODUCTION.id };
            savePreapproval(scope, { ...scope, tools: 'all-mutating' });
            const applied = parse(await handlers.get('create_alert')!(args));
            expect(applied).toMatchObject({ id: 'alert-new', production: true, productionPreapproved: true });
        });
    });

    describe('update_alert and set_alert_enabled', () => {
        it('reads, merges and sends the full body with notifications', async () => {
            const result = parse(
                await handlers.get('update_alert')!({
                    id: 'alert-1',
                    patch: { threshold: 90, durationMinutes: 15 },
                    confirm: true,
                }),
            );
            expect(result.changes).toEqual([
                { field: 'threshold', from: 85, to: 90 },
                { field: 'windowMinutes', from: 5, to: 15 },
            ]);
            const [url, body] = http.patch.mock.calls[0];
            expect(url).toBe(`${BASE}/alert-1`);
            expect(body).toEqual({
                id: 'alert-1',
                alertOn: 'METRICS',
                name: 'orders memory',
                severity: 1,
                enabled: true,
                settings: { ...appAlert().settings, threshold: 0.9, evaluationInterval: '15m' },
                entity: appAlert().entity,
                notifications: [
                    {
                        type: 'EMAIL',
                        recipients: ['ops@example.com', 'pager@example.org'],
                        subject: 'Memory high',
                        messageTemplate: 'Memory is high',
                    },
                ],
            });
        });

        describe('regression: an update is reported as accepted until verified', () => {
            it('says updated only when the listed alert is ACTIVE with the new values', async () => {
                http.patch.mockImplementation(async (_url: string, body: any) => {
                    stored['alert-1'] = { ...stored['alert-1'], enabled: body.enabled, alertStatus: 'ACTIVE' };
                });
                const result = parse(
                    await handlers.get('set_alert_enabled')!({ id: 'alert-1', enabled: false, confirm: true }),
                );
                expect(result).toMatchObject({ accepted: true, verified: true, status: 'ACTIVE' });
                expect(result.message).toMatch(/^Updated/);
            });

            it('reports PENDING with a retry hint, not "Updated"', async () => {
                http.patch.mockImplementation(async () => {
                    stored['alert-1'] = { ...stored['alert-1'], alertStatus: 'PENDING' };
                });
                const result = parse(
                    await handlers.get('set_alert_enabled')!({ id: 'alert-1', enabled: false, confirm: true }),
                );
                expect(result).toMatchObject({ accepted: true, verified: false, status: 'PENDING' });
                expect(result.message).not.toMatch(/^Updated/);
                expect(result.message).toContain('check again');
            });

            it('does not claim the update when the listed values are still the old ones', async () => {
                const result = parse(
                    await handlers.get('set_alert_enabled')!({ id: 'alert-1', enabled: false, confirm: true }),
                );
                expect(result).toMatchObject({ accepted: true, verified: false, status: 'ACTIVE' });
                expect(result.message).not.toMatch(/^Updated/);
            });
        });

        it('masks existing recipients in the preview', async () => {
            const preview = parse(await handlers.get('set_alert_enabled')!({ id: 'alert-1', enabled: false }));
            expect(preview).toMatchObject({ dryRun: true, action: 'disable alert' });
            expect(JSON.stringify(preview)).not.toContain('ops@example.com');
        });

        it('refuses a PENDING alert with a retry-later message', async () => {
            serve([appAlert({ alertStatus: 'PENDING' })]);
            const result = await handlers.get('update_alert')!({
                id: 'alert-1',
                patch: { severity: 0 },
                confirm: true,
            });
            expect(result.isError).toBe(true);
            expect(parse(result)).toMatchObject({ refused: true, retryLater: true });
            expect(http.patch).not.toHaveBeenCalled();
        });

        it('maps a platform PENDING refusal on PATCH the same way', async () => {
            http.patch.mockRejectedValue(httpError(400, { message: 'Alert not present or Deleted' }));
            const result = await handlers.get('set_alert_enabled')!({ id: 'alert-1', enabled: false, confirm: true });
            expect(parse(result).retryLater).toBe(true);
        });

        it('reports a missing alert', async () => {
            const result = await handlers.get('update_alert')!({ id: 'alert-x', patch: { severity: 0 } });
            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain('not found');
        });

        describe('regression: notification changes with the same counts and domains', () => {
            const same = { subject: 'Memory high', message: 'Memory is high' };
            it.each([
                ['a swapped recipient', { recipients: ['oncall@example.com', 'pager@example.org'], ...same }],
                [
                    'an edited subject',
                    { recipients: ['ops@example.com', 'pager@example.org'], ...same, subject: 'RAM' },
                ],
                ['an edited message', { recipients: ['ops@example.com', 'pager@example.org'], ...same, message: 'x' }],
            ])('%s is a change, shown masked', async (_name, email) => {
                const notifications = [{ type: 'EMAIL', ...email }];
                const result = parse(await handlers.get('update_alert')!({ id: 'alert-1', patch: { notifications } }));
                expect(result.noop).toBeUndefined();
                expect(result.changes.map((c: any) => c.field)).toEqual(['notifications']);
                expect(JSON.stringify(result.changes)).not.toContain('@example');
            });

            it('a switched Slack channel is a change', async () => {
                serve([apiAlert()]);
                const result = parse(
                    await handlers.get('update_alert')!({
                        id: 'alert-api',
                        patch: { notifications: [{ type: 'SLACK', channelId: 'C0OTHER', message: 'API errors' }] },
                    }),
                );
                expect(result.changes.map((c: any) => c.field)).toEqual(['notifications']);
            });

            it('identical notifications are still a noop', async () => {
                const notifications = [
                    { type: 'EMAIL', recipients: ['ops@example.com', 'pager@example.org'], ...same },
                ];
                expect(
                    parse(await handlers.get('update_alert')!({ id: 'alert-1', patch: { notifications } })).noop,
                ).toBe(true);
            });
        });

        it('regression: keeps every writable field of the existing alert in the full PATCH', async () => {
            serve([
                appAlert({
                    tags: { product: 'sample', strategy: 'sample' },
                    alertOn: 'METRICS',
                    createdAt: '2026-01-01T00:00:00Z',
                    updatedAt: '2026-01-02T00:00:00Z',
                    notificationTemplates: [
                        {
                            type: 'EMAIL',
                            recipients: ['ops@example.com'],
                            subject: 'S',
                            messageTemplate: 'M',
                            locale: 'en',
                        } as any,
                    ],
                    customField: 'kept',
                } as any),
            ]);
            await handlers.get('set_alert_enabled')!({ id: 'alert-1', enabled: false, confirm: true });
            const body = http.patch.mock.calls[0][1];
            expect(body).toMatchObject({
                id: 'alert-1',
                enabled: false,
                tags: { product: 'sample', strategy: 'sample' },
                alertOn: 'METRICS',
                customField: 'kept',
            });
            expect(body.notifications[0].locale).toBe('en');
            for (const readOnly of ['alertStatus', 'state', 'createdAt', 'updatedAt', 'notificationTemplates']) {
                expect(body).not.toHaveProperty(readOnly);
            }
        });

        it('regression: platform error text is sanitized before it reaches the caller', async () => {
            const token = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJzYW1wbGUifQ', 'c2lnbmF0dXJl'].join('.');
            http.patch.mockRejectedValue(
                httpError(400, { message: `invalid recipient secret.person@example.net with token ${token}` }),
            );
            const result = await handlers.get('set_alert_enabled')!({ id: 'alert-1', enabled: false, confirm: true });
            expect(result.isError).toBe(true);
            expect(result.content[0].text).not.toContain('secret.person@example.net');
            expect(result.content[0].text).not.toContain(token);
            expect(result.content[0].text).toContain('example.net');
        });
    });

    describe('delete_alert, regression from live sandbox runs', () => {
        const confirmed = { id: 'alert-1', confirm: true, expectedName: 'orders memory' };

        it('refuses a PENDING alert even when GET answers 404, and the dry run warns', async () => {
            serve([appAlert({ alertStatus: 'PENDING' })]);
            const listOnly = http.get.getMockImplementation()!;
            http.get.mockImplementation(async (url: string) => {
                if (url.startsWith(`${BASE}?`)) return listOnly(url);
                throw httpError(404, { message: 'Alert not found' });
            });
            const preview = parse(await handlers.get('delete_alert')!({ id: 'alert-1' }));
            expect(preview.dryRun).toBe(true);
            expect(preview.warnings[0]).toContain('in progress');
            const refused = parse(await handlers.get('delete_alert')!(confirmed));
            expect(refused).toMatchObject({ refused: true, retryLater: true, status: 'PENDING' });
            expect(http.delete).not.toHaveBeenCalled();
        });

        it('verifies from the list when GET keeps answering ACTIVE after the delete', async () => {
            const original = appAlert();
            http.delete.mockImplementation(async () => {
                delete stored['alert-1'];
            });
            const listOnly = http.get.getMockImplementation()!;
            http.get.mockImplementation(async (url: string) =>
                url.startsWith(`${BASE}?`) ? listOnly(url) : { data: original },
            );
            const result = parse(await handlers.get('delete_alert')!(confirmed));
            expect(result).toMatchObject({ accepted: true, status: 'GONE', verifiedAbsent: true });
        });

        it('regression: never infers absence from a truncated list', async () => {
            const original = appAlert();
            http.delete.mockResolvedValue(undefined);
            http.get.mockImplementation(async (url: string) => {
                if (!url.startsWith(`${BASE}?`)) return { data: original };
                const params = new URL(`https://x${url}`).searchParams;
                // The name-filtered listing still shows the alert before deletion; afterwards every page is full.
                if (http.delete.mock.calls.length === 0) return { data: [original], metadata: { pagination: {} } };
                return {
                    data: Array.from({ length: 100 }, (_, i) => appAlert({ id: `other-${params.get('offset')}-${i}` })),
                    metadata: { pagination: { next: 'more' } },
                };
            });
            const result = parse(await handlers.get('delete_alert')!(confirmed));
            expect(result).toMatchObject({ accepted: true, status: 'UNVERIFIED', verifiedAbsent: false });
            expect(result.message).toContain('could not be verified');
        });

        it('treats a 404 on DELETE with the alert absent from the list as gone', async () => {
            const original = appAlert();
            const listOnly = http.get.getMockImplementation()!;
            http.get.mockImplementation(async (url: string) =>
                url.startsWith(`${BASE}?`) ? listOnly(url) : { data: original },
            );
            http.delete.mockImplementation(async () => {
                delete stored['alert-1'];
                throw httpError(404, { message: 'Alert not found' });
            });
            const result = parse(await handlers.get('delete_alert')!(confirmed));
            expect(result).toMatchObject({ accepted: false, status: 'GONE', verifiedAbsent: true });
            expect(result.message).toContain('Already gone');
        });
    });

    describe('delete_alert', () => {
        it('is bound to the alert name and never claims deleted while PENDING', async () => {
            const preview = parse(await handlers.get('delete_alert')!({ id: 'alert-1' }));
            expect(preview.confirmation).toEqual({ confirm: true, expectedName: 'orders memory' });

            const refused = await handlers.get('delete_alert')!({
                id: 'alert-1',
                confirm: true,
                expectedName: 'other',
            });
            expect(refused.isError).toBe(true);
            expect(http.delete).not.toHaveBeenCalled();

            http.delete.mockImplementation(async () => {
                stored['alert-1'] = { ...stored['alert-1'], alertStatus: 'PENDING' };
            });
            const pending = parse(
                await handlers.get('delete_alert')!({ id: 'alert-1', confirm: true, expectedName: 'orders memory' }),
            );
            expect(pending).toMatchObject({ accepted: true, status: 'PENDING', verifiedAbsent: false });
            expect(pending.message).not.toMatch(/^Deleted/);
        });

        it('reports a verified deletion when the alert is gone', async () => {
            http.delete.mockImplementation(async () => {
                delete stored['alert-1'];
            });
            const done = parse(
                await handlers.get('delete_alert')!({ id: 'alert-1', confirm: true, expectedName: 'orders memory' }),
            );
            expect(done).toMatchObject({ accepted: true, status: 'GONE', verifiedAbsent: true });
        });

        it('in production needs a pre-approval that names delete_alert', async () => {
            serve([appAlert({ entity: { ...appAlert().entity, environmentId: PRODUCTION.id } })]);
            const scope = { orgId: ORG, environmentId: PRODUCTION.id };
            const args = { id: 'alert-1', confirm: true, expectedName: 'orders memory' };

            savePreapproval(scope, { ...scope, tools: 'all-mutating' });
            expect(parse(await handlers.get('delete_alert')!(args)).refused).toBe(true);
            expect(http.delete).not.toHaveBeenCalled();

            savePreapproval(scope, { ...scope, tools: ['delete_alert'] });
            expect(parse(await handlers.get('delete_alert')!(args)).accepted).toBe(true);
        });
    });
});
