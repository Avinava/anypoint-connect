import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AnypointClient } from '../../../src/client/AnypointClient.js';
import { registerAlertTools } from '../../../src/mcp/tools/alerts.js';
import { registerAppReadTools } from '../../../src/mcp/tools/apps-read.js';
import { registerMonitoringTools } from '../../../src/mcp/tools/monitoring.js';
import { appAlert } from '../../fixtures/alerts.js';

const ORG = 'org-sample';
const ENV = { id: 'env-1', name: 'Sandbox', isProduction: false };
const deployment = {
    id: 'dep-1',
    name: 'orders-sapi',
    status: 'APPLIED',
    application: {
        desiredState: 'STARTED',
        ref: { groupId: ORG, artifactId: 'orders-sapi', version: '1.0.0' },
        vCores: 0.1,
    },
    target: { replicas: 1, deploymentSettings: { runtime: { version: '4.9.0' } } },
    replicas: [{ id: 'r1', state: 'STARTED', currentDeploymentVersion: 's1' }],
    desiredVersion: 's1',
    lastModifiedDate: Date.now() - 600_000,
};

function fakeClient() {
    return {
        getDefaultOrgId: vi.fn().mockResolvedValue(ORG),
        accessManagement: { resolveEnvironment: vi.fn().mockResolvedValue(ENV) },
        cloudHub2: {
            getDetailedDeployments: vi.fn().mockResolvedValue([deployment]),
            findDetailByName: vi.fn(async (_o: string, _e: string, name: string) =>
                name === 'orders-sapi' ? deployment : null,
            ),
        },
        monitoring: {
            getMetrics: vi.fn().mockResolvedValue([{ appName: 'orders-sapi', requestCount: 3 }]),
            getRouteMetrics: vi.fn().mockResolvedValue([]),
        },
        alerts: {
            get: vi.fn(async (_o: string, id: string) => (id === 'alert-1' ? appAlert() : null)),
            listAll: vi.fn().mockResolvedValue({ alerts: [appAlert()], complete: true }),
            list: vi.fn().mockResolvedValue([appAlert()]),
        },
    } as unknown as AnypointClient;
}

/** A real MCP server and client over an in-memory pipe, so the SDK itself validates structured output. */
async function connect() {
    const server = new McpServer({ name: 'test', version: '0' });
    const client = fakeClient();
    registerAppReadTools(server, client);
    registerMonitoringTools(server, client);
    registerAlertTools(server, client);
    const mcp = new Client({ name: 'test-client', version: '0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), mcp.connect(b)]);
    return mcp;
}

describe('structured MCP output, validated by the SDK', () => {
    it('list_apps returns structuredContent and keeps the bare array as text', async () => {
        const mcp = await connect();
        const result = await mcp.callTool({ name: 'list_apps', arguments: { environment: 'Sandbox' } });
        expect(result.structuredContent).toMatchObject({
            apps: [{ id: 'dep-1', name: 'orders-sapi', version: '1.0.0' }],
        });
        const text = (result.content as Array<{ text: string }>)[0].text;
        expect(Array.isArray(JSON.parse(text))).toBe(true);
    });

    it('get_app_status returns phase and settled; a missing app is an error, not a status', async () => {
        const mcp = await connect();
        const ok = await mcp.callTool({
            name: 'get_app_status',
            arguments: { appName: 'orders-sapi', environment: 'Sandbox' },
        });
        expect(ok.isError).toBeFalsy();
        expect(ok.structuredContent).toMatchObject({ name: 'orders-sapi', phase: 'RUNNING', settled: true });

        const missing = await mcp.callTool({
            name: 'get_app_status',
            arguments: { appName: 'nope', environment: 'Sandbox' },
        });
        expect(missing.isError).toBe(true);
        expect(missing.structuredContent).toBeUndefined();
    });

    it('get_metrics and the alert reads validate against their schemas', async () => {
        const mcp = await connect();
        const metrics = await mcp.callTool({ name: 'get_metrics', arguments: { environment: 'Sandbox' } });
        expect(metrics.structuredContent).toMatchObject({ environment: 'Sandbox', groupBy: 'app' });

        const list = await mcp.callTool({
            name: 'list_alerts',
            arguments: { environment: 'Sandbox', source: 'monitoring' },
        });
        expect(list.isError).toBeFalsy();
        expect(list.structuredContent).toMatchObject({ total: 1, alerts: [{ id: 'alert-1', name: 'orders memory' }] });

        const one = await mcp.callTool({ name: 'get_alert', arguments: { id: 'alert-1' } });
        expect(one.structuredContent).toMatchObject({ id: 'alert-1', severity: 'MEDIUM' });
        // Recipients stay masked in structured form exactly as in text.
        expect(JSON.stringify(one.structuredContent)).not.toContain('ops@example.com');
    });
});
