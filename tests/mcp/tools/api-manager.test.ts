import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { registerApiManagerTools } from '../../../src/mcp/tools/api-manager.js';
import { PROJECT_ROOT_ENV } from '../../../src/safety/paths.js';
import { inferCredentialStyle } from '../../../src/client/smoke-test.js';

const CLIENT_ID = 'c1d2e3f4a5b6c7d8e9f0';
const CLIENT_SECRET = 'S3cr3tValue-9f8e7d6c5b4a';

describe('API Manager MCP tools', () => {
    const handlers = new Map<string, (input: any) => Promise<any>>();
    const server = {
        registerTool: vi.fn((name: string, _definition: unknown, handler: (input: any) => Promise<any>) => {
            handlers.set(name, handler);
        }),
    };
    const client = {
        getDefaultOrgId: vi.fn(),
        accessManagement: { resolveEnvironment: vi.fn() },
        apiManager: {
            getApis: vi.fn(),
            resolveApiInstance: vi.fn(),
            getPolicies: vi.fn(),
            getSlaTiers: vi.fn(),
            getAlerts: vi.fn(),
            getContracts: vi.fn(),
            getClientApplication: vi.fn(),
        },
    };
    const text = (result: any): string => result.content.map((c: any) => c.text).join('\n');
    const parse = (result: any) => JSON.parse(result.content[0].text);
    const expectNoSecret = (result: any) => {
        expect(text(result)).not.toContain(CLIENT_SECRET);
        expect(text(result)).not.toContain(Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'));
    };

    let root: string;
    let api: http.Server;
    let baseUrl: string;
    let requests: http.IncomingMessage[];

    beforeAll(async () => {
        // Echoes the request headers back in the body and in a response header, so any
        // credential that is not scrubbed would show up in the tool output.
        api = http.createServer((req, res) => {
            requests.push(req);
            if (req.url?.includes('/slow')) return;
            res.setHeader('content-type', 'application/json');
            res.setHeader('x-request-id', String(req.headers.client_secret ?? 'none'));
            res.setHeader('set-cookie', 'session=abc');
            res.statusCode = req.url?.includes('/missing') ? 404 : 200;
            res.end(JSON.stringify({ echo: req.headers, padding: 'x'.repeat(req.url?.includes('/big') ? 10000 : 0) }));
        });
        await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
        baseUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
        api.closeAllConnections();
        await new Promise((resolve) => api.close(resolve));
    });

    beforeEach(() => {
        handlers.clear();
        vi.clearAllMocks();
        requests = [];
        root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'anc-apim-')));
        process.env[PROJECT_ROOT_ENV] = root;
        client.getDefaultOrgId.mockResolvedValue('org-1');
        client.accessManagement.resolveEnvironment.mockResolvedValue({
            id: 'env-1',
            name: 'Sandbox',
            isProduction: false,
        });
        client.apiManager.resolveApiInstance.mockResolvedValue({
            apiId: 42,
            asset: { exchangeAssetName: 'orders-sapi' },
            instance: { id: 42, endpointUri: `${baseUrl}/api` },
        });
        client.apiManager.getPolicies.mockResolvedValue([
            { template: { assetId: 'client-id-enforcement' }, configurationData: {} },
        ]);
        client.apiManager.getContracts.mockResolvedValue([
            {
                id: 5,
                status: 'APPROVED',
                application: { id: 7, name: 'orders-client', clientId: CLIENT_ID },
                tier: { id: 1, name: 'Gold' },
            },
            { id: 6, status: 'REVOKED', applicationId: 8, application: { id: 8, name: 'old-client' }, tier: null },
        ]);
        client.apiManager.getClientApplication.mockResolvedValue({
            id: 7,
            name: 'orders-client',
            clientId: CLIENT_ID,
            clientSecret: CLIENT_SECRET,
            grantTypes: [],
        });
        registerApiManagerTools(server as any, client as any);
    });

    afterEach(() => {
        delete process.env[PROJECT_ROOT_ENV];
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('registers the new tools', () => {
        expect([...handlers.keys()]).toEqual(
            expect.arrayContaining(['list_api_contracts', 'get_client_application', 'smoke_test_api']),
        );
    });

    it('resolves names through the shared resolver and reports not-found as a tool error', async () => {
        client.apiManager.resolveApiInstance.mockRejectedValue(new Error('API "billing" not found in Sandbox'));
        const result = await handlers.get('get_api_policies')!({ apiName: 'billing', environment: 'Sandbox' });
        expect(result.isError).toBe(true);
        expect(text(result)).toBe('Error: API "billing" not found in Sandbox');
    });

    describe('list_api_contracts', () => {
        it('lists contract, app, tier and status without credentials', async () => {
            const result = await handlers.get('list_api_contracts')!({ environment: 'Sandbox', api: 'orders' });
            expect(parse(result)).toEqual({
                environment: 'Sandbox',
                apiId: 42,
                apiName: 'orders-sapi',
                total: 2,
                contracts: [
                    { contractId: 5, clientAppId: 7, clientAppName: 'orders-client', tier: 'Gold', status: 'APPROVED' },
                    { contractId: 6, clientAppId: 8, clientAppName: 'old-client', tier: null, status: 'REVOKED' },
                ],
            });
            expect(text(result)).not.toContain(CLIENT_ID);
        });
    });

    describe('get_client_application', () => {
        it('masks the secret to its last four characters', async () => {
            const result = await handlers.get('get_client_application')!({ appId: 7 });
            const body = parse(result);
            expect(body.clientId).toBe(CLIENT_ID);
            expect(body.clientSecret).toBe(`******…${CLIENT_SECRET.slice(-4)}`);
            expectNoSecret(result);
        });

        it('writes a 0600 .env file inside the project root and returns only the path', async () => {
            const result = await handlers.get('get_client_application')!({
                appId: 7,
                writeCredentialsTo: 'client.env',
            });
            const file = path.join(root, 'client.env');
            expect(parse(result).credentialsWrittenTo).toBe(file);
            expectNoSecret(result);
            expect(fs.statSync(file).mode & 0o777).toBe(0o600);
            expect(fs.readFileSync(file, 'utf8')).toBe(`CLIENT_ID=${CLIENT_ID}\nCLIENT_SECRET=${CLIENT_SECRET}\n`);
        });

        it('refuses to overwrite unless asked, and resets the mode when it does', async () => {
            const file = path.join(root, 'client.env');
            fs.writeFileSync(file, 'OLD=1\n', { mode: 0o644 });

            const refused = await handlers.get('get_client_application')!({
                appId: 7,
                writeCredentialsTo: 'client.env',
            });
            expect(refused.isError).toBe(true);
            expect(text(refused)).toContain('File exists');
            expectNoSecret(refused);
            expect(fs.readFileSync(file, 'utf8')).toBe('OLD=1\n');

            await handlers.get('get_client_application')!({
                appId: 7,
                writeCredentialsTo: 'client.env',
                overwrite: true,
            });
            expect(fs.statSync(file).mode & 0o777).toBe(0o600);
            expect(fs.readFileSync(file, 'utf8')).toContain('CLIENT_SECRET=');
        });

        it('refuses a path outside the project root', async () => {
            const result = await handlers.get('get_client_application')!({
                appId: 7,
                writeCredentialsTo: '../escape.env',
            });
            expect(result.isError).toBe(true);
            expect(text(result)).toContain('inside the project root');
            expect(fs.existsSync(path.join(path.dirname(root), 'escape.env'))).toBe(false);
        });

        it('scrubs the secret from error text that happens to contain it', async () => {
            const result = await handlers.get('get_client_application')!({
                appId: 7,
                writeCredentialsTo: `${CLIENT_SECRET}/client.env`,
            });
            expect(result.isError).toBe(true);
            expect(text(result)).toContain('Directory not found');
            expectNoSecret(result);
        });

        it('does not leak anything when the lookup fails', async () => {
            client.apiManager.getClientApplication.mockRejectedValue(new Error('HTTP 404'));
            const result = await handlers.get('get_client_application')!({ appId: 99 });
            expect(result.isError).toBe(true);
            expectNoSecret(result);
        });
    });

    describe('smoke_test_api', () => {
        it('sends client_id/client_secret headers from the only approved contract and scrubs them', async () => {
            const result = await handlers.get('smoke_test_api')!({
                environment: 'Sandbox',
                api: 'orders',
                path: '/orders?limit=1',
            });
            expect(result.isError).toBeUndefined();
            const body = parse(result);

            expect(requests).toHaveLength(1);
            expect(requests[0].url).toBe('/api/orders?limit=1');
            expect(requests[0].headers.client_id).toBe(CLIENT_ID);
            expect(requests[0].headers.client_secret).toBe(CLIENT_SECRET);

            expect(body).toMatchObject({
                status: 200,
                passed: true,
                request: { method: 'GET', credentials: 'headers client_id/client_secret', clientApp: { id: 7 } },
            });
            expect(body.latencyMs).toEqual(expect.any(Number));
            expect(body.headers['x-request-id']).toBe('******');
            expect(body.headers['set-cookie']).toBeUndefined();
            expect(body.body.excerpt).toContain('"client_secret":"******"');
            expect(text(result)).not.toContain(CLIENT_ID);
            expectNoSecret(result);
        });

        it('uses basic auth when the client-id policy reads the basic auth header', async () => {
            client.apiManager.getPolicies.mockResolvedValue([
                {
                    template: { assetId: 'client-id-enforcement' },
                    configurationData: {
                        credentialsOriginHasHttpBasicAuthenticationHeader: 'httpBasicAuthenticationHeader',
                    },
                },
            ]);
            const result = await handlers.get('smoke_test_api')!({ environment: 'Sandbox', api: 'orders', path: '/' });
            const expected = `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`;
            expect(requests[0].headers.authorization).toBe(expected);
            expect(requests[0].headers.client_secret).toBeUndefined();
            expect(parse(result).request.credentials).toBe('HTTP basic auth');
            expectNoSecret(result);
        });

        it('limits the body excerpt to 4 KB and honours expectStatus', async () => {
            const big = parse(
                await handlers.get('smoke_test_api')!({ environment: 'Sandbox', api: 'orders', path: '/big' }),
            );
            expect(big.body.excerpt.length).toBeLessThanOrEqual(4096);
            expect(big.body.truncated).toBe(true);

            const missing = parse(
                await handlers.get('smoke_test_api')!({
                    environment: 'Sandbox',
                    api: 'orders',
                    path: '/missing',
                    expectStatus: 404,
                }),
            );
            expect(missing).toMatchObject({ status: 404, passed: true });
        });

        it('scrubs credentials from errors', async () => {
            const result = await handlers.get('smoke_test_api')!({
                environment: 'Sandbox',
                api: 'orders',
                path: '/slow',
                timeoutMs: 200,
            });
            expect(result.isError).toBe(true);
            expect(text(result)).toContain('Smoke test failed');
            expectNoSecret(result);
        });

        it('asks for clientAppId when several contracts are approved', async () => {
            client.apiManager.getContracts.mockResolvedValue([
                { id: 1, status: 'APPROVED', application: { id: 7, name: 'orders-client' } },
                { id: 2, status: 'APPROVED', application: { id: 9, name: 'reports-client' } },
            ]);
            const result = await handlers.get('smoke_test_api')!({ environment: 'Sandbox', api: 'orders' });
            expect(result.isError).toBe(true);
            expect(text(result)).toContain('pass clientAppId');
            expect(text(result)).toContain('reports-client (9)');
            expect(requests).toHaveLength(0);
        });

        it('refuses to send credentials over plain HTTP to another host', async () => {
            const result = await handlers.get('smoke_test_api')!({
                environment: 'Sandbox',
                api: 'orders',
                url: 'http://other.example.com/x',
            });
            expect(result.isError).toBe(true);
            expect(text(result)).toContain('plain HTTP');
            expect(client.apiManager.getClientApplication).not.toHaveBeenCalled();
        });

        it('puts non-GET methods behind the write guard', async () => {
            const preview = await handlers.get('smoke_test_api')!({
                environment: 'Sandbox',
                api: 'orders',
                path: '/orders',
                method: 'post',
                body: { sku: 'A-1' },
            });
            expect(parse(preview)).toMatchObject({ dryRun: true, method: 'POST', url: `${baseUrl}/api/orders` });
            expect(requests).toHaveLength(0);
            expect(client.apiManager.getClientApplication).not.toHaveBeenCalled();

            const sent = await handlers.get('smoke_test_api')!({
                environment: 'Sandbox',
                api: 'orders',
                path: '/orders',
                method: 'POST',
                body: { sku: 'A-1' },
                confirm: true,
            });
            expect(parse(sent).status).toBe(200);
            expect(requests).toHaveLength(1);
            expect(requests[0].method).toBe('POST');
            expectNoSecret(sent);
        });

        it('requires confirmProduction for non-GET methods in production', async () => {
            client.accessManagement.resolveEnvironment.mockResolvedValue({
                id: 'env-1',
                name: 'Production',
                isProduction: true,
            });
            const refused = await handlers.get('smoke_test_api')!({
                environment: 'Production',
                api: 'orders',
                method: 'DELETE',
                path: '/orders/1',
                confirm: true,
            });
            expect(refused.isError).toBe(true);
            expect(parse(refused).refused).toBe(true);
            expect(requests).toHaveLength(0);

            await handlers.get('smoke_test_api')!({
                environment: 'Production',
                api: 'orders',
                method: 'GET',
                path: '/orders/1',
            });
            expect(requests).toHaveLength(1);
        });
    });
});

describe('inferCredentialStyle', () => {
    it('reads header names from the policy expressions and ignores disabled policies', () => {
        expect(inferCredentialStyle([])).toEqual({ mode: 'none' });
        expect(inferCredentialStyle([{ template: { assetId: 'client-id-enforcement' }, disabled: true }])).toEqual({
            mode: 'none',
        });
        expect(
            inferCredentialStyle([
                {
                    template: { assetId: 'client-id-enforcement' },
                    configurationData: {
                        clientIdExpression: "#[attributes.headers['x-client-id']]",
                        clientSecretExpression: '#[attributes.headers.x-client-secret]',
                    },
                },
            ]),
        ).toEqual({ mode: 'headers', idHeader: 'x-client-id', secretHeader: 'x-client-secret' });
    });
});
