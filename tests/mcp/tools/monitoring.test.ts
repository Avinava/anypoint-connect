import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerMonitoringTools } from '../../../src/mcp/tools/monitoring.js';
import { AmqlQueryError } from '../../../src/utils/errors.js';

describe('monitoring MCP tools', () => {
    const handlers = new Map<string, (input: any) => Promise<any>>();
    const server = {
        registerTool: vi.fn((name: string, _definition: unknown, handler: (input: any) => Promise<any>) => {
            handlers.set(name, handler);
        }),
    };
    const client = {
        getDefaultOrgId: vi.fn(),
        accessManagement: { resolveEnvironment: vi.fn() },
        monitoring: {
            getMetrics: vi.fn(),
            getRouteMetrics: vi.fn(),
            getRuntimeMetrics: vi.fn(),
            getTimeSeries: vi.fn(),
            search: vi.fn(),
        },
    };
    const parse = (result: any) => JSON.parse(result.content[0].text);

    beforeEach(() => {
        handlers.clear();
        vi.clearAllMocks();
        client.getDefaultOrgId.mockResolvedValue('org-1');
        client.accessManagement.resolveEnvironment.mockResolvedValue({ id: 'env-1', name: 'Sandbox' });
        client.monitoring.getMetrics.mockResolvedValue([{ appName: 'orders' }]);
        client.monitoring.getRouteMetrics.mockResolvedValue([{ route: '/v1' }]);
        client.monitoring.getRuntimeMetrics.mockResolvedValue([{ workerId: 'w-1' }]);
        client.monitoring.getTimeSeries.mockResolvedValue([{ timestamp: 0 }]);
        registerMonitoringTools(server as any, client as any);
    });

    it('registers exactly the consolidated monitoring tools', () => {
        expect([...handlers.keys()].sort()).toEqual([
            'get_metrics',
            'get_metrics_timeseries',
            'get_runtime_metrics',
            'raw_amql_query',
        ]);
    });

    it('get_metrics compares every environment when none is given', async () => {
        const body = parse(await handlers.get('get_metrics')!({ groupBy: 'worker' }));
        expect(client.accessManagement.resolveEnvironment).not.toHaveBeenCalled();
        expect(client.monitoring.getMetrics).toHaveBeenCalledWith(
            expect.objectContaining({ orgId: 'org-1', envId: undefined }),
            'worker',
        );
        expect(body).toMatchObject({ environment: 'all', groupBy: 'worker', rows: [{ appName: 'orders' }] });
    });

    it('get_metrics routes groupBy "route" to the route breakdown', async () => {
        const body = parse(await handlers.get('get_metrics')!({ environment: 'Sandbox', groupBy: 'route' }));
        expect(client.monitoring.getRouteMetrics).toHaveBeenCalledWith(expect.objectContaining({ envId: 'env-1' }));
        expect(body.routes).toEqual([{ route: '/v1' }]);
    });

    it('get_runtime_metrics and get_metrics_timeseries scope to the resolved environment', async () => {
        await handlers.get('get_runtime_metrics')!({ environment: 'Sandbox', appName: 'orders', hoursBack: 2 });
        const runtimeScope = client.monitoring.getRuntimeMetrics.mock.calls[0][0];
        expect(runtimeScope).toMatchObject({ orgId: 'org-1', envId: 'env-1', appName: 'orders' });
        expect(runtimeScope.to - runtimeScope.from).toBe(2 * 60 * 60 * 1000);

        const body = parse(
            await handlers.get('get_metrics_timeseries')!({ environment: 'Sandbox', signal: 'gc', granularity: '5m' }),
        );
        expect(client.monitoring.getTimeSeries).toHaveBeenCalledWith(expect.anything(), 'gc', '5m');
        expect(body).toMatchObject({ signal: 'gc', granularity: '5m', points: [{ timestamp: 0 }] });
    });

    it('raw_amql_query surfaces platform errors as tool errors', async () => {
        client.monitoring.search.mockRejectedValue(
            new AmqlQueryError("AMQL query failed (HTTP 400): 'SELECT *' is not supported", 'SELECT *', 400),
        );
        const result = await handlers.get('raw_amql_query')!({ query: 'SELECT *' });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("'SELECT *' is not supported");
    });
});
