/**
 * Tests for MonitoringApi
 */
import { AxiosError, AxiosHeaders } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MonitoringApi, amqlString } from '../../src/api/MonitoringApi.js';
import { Cache } from '../../src/client/Cache.js';
import { AmqlQueryError } from '../../src/utils/errors.js';

const ORG = '00000000-0000-4000-8000-000000000001';
const ENV = '00000000-0000-4000-8000-000000000002';

const mockPost = vi.fn();
const mockHttpClient = { get: vi.fn(), post: mockPost, patch: vi.fn(), delete: vi.fn() } as any;

/** Route mocked responses by the datasource and a distinguishing fragment of the query. */
function respond(routes: Array<[RegExp, Array<Record<string, unknown>>]>) {
    mockPost.mockImplementation(async (_url: string, body: { query: string }) => {
        const match = routes.find(([pattern]) => pattern.test(body.query));
        return { data: match ? match[1] : [] };
    });
}

function queries(): string[] {
    return mockPost.mock.calls.map((call) => call[1].query as string);
}

function platformError(status: number, message: string): AxiosError {
    const headers = new AxiosHeaders();
    return new AxiosError('Request failed', 'ERR_BAD_REQUEST', { headers } as any, undefined, {
        status,
        statusText: 'Bad Request',
        headers,
        config: { headers } as any,
        data: { message, 'X-ANYPNT-TRX-ID': 'trx-1' },
    });
}

describe('MonitoringApi', () => {
    let api: MonitoringApi;
    const scope = { orgId: ORG, envId: ENV, from: 1000, to: 2000 };

    beforeEach(() => {
        vi.resetAllMocks();
        api = new MonitoringApi(mockHttpClient, new Cache());
    });

    describe('search', () => {
        it('POSTs the query with a clamped page size and a long timeout', async () => {
            mockPost.mockResolvedValue({ data: [{ n: 1 }] });
            const rows = await api.search('SELECT 1', { limit: 50000, offset: 10 });

            expect(rows).toEqual([{ n: 1 }]);
            expect(mockPost).toHaveBeenCalledWith(
                '/observability/api/v1/metrics:search?limit=2000&offset=10',
                { query: 'SELECT 1' },
                { timeout: 90000 },
            );
        });

        it('raises the platform message instead of returning no rows', async () => {
            mockPost.mockRejectedValue(platformError(400, "'not_a_field' is not a supported attribute"));

            const failure = await api.search('SELECT AVG(not_a_field)').catch((e) => e);
            expect(failure).toBeInstanceOf(AmqlQueryError);
            expect(failure.message).toBe("AMQL query failed (HTTP 400): 'not_a_field' is not a supported attribute");
            expect(failure.status).toBe(400);
            expect(failure.transactionId).toBe('trx-1');
            expect(failure.query).toBe('SELECT AVG(not_a_field)');
        });

        it('follows pagination in searchAll', async () => {
            mockPost
                .mockResolvedValueOnce({ data: [{ n: 1 }, { n: 2 }], metadata: { pagination: { next: 'more' } } })
                .mockResolvedValueOnce({ data: [{ n: 3 }], metadata: { pagination: { next: null } } });

            expect(await api.searchAll('SELECT 1')).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
            expect(mockPost.mock.calls[1][0]).toContain('offset=2');
        });
    });

    describe('scope filters', () => {
        it('escapes app names and rejects non-UUID identifiers', async () => {
            respond([]);
            await api.getMetrics({ ...scope, appName: "o'brien" });
            expect(queries()[0]).toContain(`"app.name" = 'o''brien'`);
            expect(amqlString("a'b")).toBe("'a''b'");

            await expect(api.getMetrics({ ...scope, envId: "x' OR '1'='1" })).rejects.toThrow('Invalid environment ID');
        });

        it('compares environments by grouping on env.name when no environment is given', async () => {
            respond([]);
            await api.getMetrics({ orgId: ORG, from: 1000, to: 2000 });
            for (const query of queries()) {
                expect(query).not.toContain('"env.id"');
                expect(query).toContain('GROUP BY "app.name", "env.name"');
            }
        });
    });

    describe('getMetrics', () => {
        it('merges inbound, failures, outbound and message volume per app', async () => {
            respond([
                [/"failed_count".*mulesoft\.app\.inbound/, [{ 'app.name': 'orders', failed_count: 5 }]],
                [/"failed_count".*mulesoft\.app\.outbound/, [{ 'app.name': 'orders', failed_count: 2 }]],
                [
                    /mulesoft\.app\.inbound/,
                    [{ 'app.name': 'orders', request_count: 100, avg_response_time: 50, p75: 60, p90: 80, p99: 200 }],
                ],
                [
                    /mulesoft\.app\.outbound/,
                    [
                        { 'app.name': 'orders', request_count: 40, avg_response_time: 30 },
                        { 'app.name': 'scheduler', request_count: 7, avg_response_time: 10 },
                    ],
                ],
                [/mulesoft\.message/, [{ 'app.name': 'orders', message_count: 300, message_error_count: 4 }]],
            ]);

            const rows = await api.getMetrics(scope);
            const orders = rows.find((r) => r.appName === 'orders')!;
            expect(orders).toMatchObject({
                requestCount: 100,
                failedCount: 5,
                failureRate: 0.05,
                p75: 60,
                p90: 80,
                outboundCount: 40,
                outboundFailedCount: 2,
                messageCount: 300,
                messageErrorCount: 4,
            });
            // Outbound-only apps (schedulers, batch jobs) are still reported.
            expect(rows.find((r) => r.appName === 'scheduler')).toMatchObject({ requestCount: 0, outboundCount: 7 });
            expect(queries().every((q) => !q.includes('mulesoft.jvm"'))).toBe(true);
        });

        it('groups by worker when asked', async () => {
            respond([
                [
                    /COUNT\(requests\) AS "request_count", AVG.*mulesoft\.app\.inbound/,
                    [
                        { 'app.name': 'orders', 'worker.id': 'w-1', request_count: 10 },
                        { 'app.name': 'orders', 'worker.id': 'w-2', request_count: 30 },
                    ],
                ],
            ]);
            const rows = await api.getMetrics(scope, 'worker');
            expect(rows.map((r) => [r.workerId, r.requestCount])).toEqual([
                ['w-2', 30],
                ['w-1', 10],
            ]);
            expect(queries()[0]).toContain('GROUP BY "app.name", "worker.id"');
        });
    });

    describe('getRouteMetrics', () => {
        it('reports inbound and outbound routes and keeps unlabelled routes as null', async () => {
            respond([
                [
                    /"failed_count".*mulesoft\.app\.outbound/,
                    [{ 'app.name': 'orders', 'http.route': '/v1/stock', failed_count: 3 }],
                ],
                [/mulesoft\.app\.outbound/, [{ 'app.name': 'orders', 'http.route': '/v1/stock', request_count: 9 }]],
                [/"request_count".*mulesoft\.app\.inbound/, [{ 'app.name': 'orders', request_count: 12 }]],
            ]);

            const routes = await api.getRouteMetrics(scope);
            expect(routes[0]).toMatchObject({
                direction: 'outbound',
                route: '/v1/stock',
                requestCount: 9,
                failedCount: 3,
            });
            expect(routes[1]).toMatchObject({ direction: 'inbound', route: null, requestCount: 12, failedCount: 0 });
        });
    });

    describe('getRuntimeMetrics', () => {
        beforeEach(() => {
            const worker = { 'app.name': 'orders', 'worker.id': 'w-1' };
            respond([
                [
                    /mulesoft\.app\.jvm\.memory/,
                    [
                        {
                            ...worker,
                            type: 'heap',
                            pool: 'total-heap',
                            used_avg: 600,
                            used_peak: 900,
                            committed_avg: 950,
                            limit_max: -1,
                        },
                        {
                            ...worker,
                            type: 'heap',
                            pool: 'tenured_gen',
                            used_avg: 360,
                            used_peak: 480,
                            committed_avg: 500,
                            limit_max: 512,
                        },
                        {
                            ...worker,
                            type: 'heap',
                            pool: 'eden_space',
                            used_avg: 200,
                            used_peak: 400,
                            committed_avg: 400,
                            limit_max: 430,
                        },
                        {
                            ...worker,
                            type: 'off-heap',
                            pool: 'metaspace',
                            used_avg: 280,
                            used_peak: 281,
                            committed_avg: 285,
                            limit_max: -1,
                        },
                        { ...worker },
                    ],
                ],
                [
                    /mulesoft\.app\.jvm\.gc/,
                    [
                        {
                            ...worker,
                            name: 'MarkSweepCompact',
                            count_max: 13,
                            count_min: 11,
                            duration_max: 7360,
                            duration_min: 5871,
                        },
                        { ...worker, name: 'copy' },
                    ],
                ],
                [/mulesoft\.app\.jvm\.cpu/, [{ ...worker, available_processors: 1, total_physical_memory: 2048 }]],
                [
                    /mulesoft\.app\.memory/,
                    [
                        {
                            ...worker,
                            system_cpu_avg: 0.02,
                            system_cpu_max: 0.2,
                            process_cpu_avg: 0.01,
                            process_cpu_max: 0.21,
                            free_memory_avg: 300,
                        },
                    ],
                ],
            ]);
        });

        it('derives heap, old-generation pressure and GC deltas per worker', async () => {
            const [worker] = await api.getRuntimeMetrics(scope);
            expect(worker).toMatchObject({
                appName: 'orders',
                workerId: 'w-1',
                heapUsedAvg: 600,
                heapUsedPeak: 900,
                oldGenPool: 'tenured_gen',
                oldGenLimit: 512,
                oldGenPeakRatio: 480 / 512,
                metaspaceUsedAvg: 280,
                oldGenGcCount: 2,
                oldGenGcTimeMs: 1489,
                availableProcessors: 1,
                totalPhysicalMemory: 2048,
                systemCpuLoadMax: 0.2,
                freePhysicalMemoryAvg: 300,
            });
            // Collectors that never reported are dropped; unbounded pools have no limit.
            expect(worker.gcCollectors).toEqual([
                { collector: 'MarkSweepCompact', oldGeneration: true, collections: 2, timeMs: 1489 },
            ]);
            expect(worker.pools.find((p) => p.pool === 'metaspace')!.limit).toBeNull();
        });

        it('never aggregates cumulative GC counters with SUM or memory sizes with MIN/MAX', async () => {
            await api.getRuntimeMetrics(scope);
            const gc = queries().find((q) => q.includes('mulesoft.app.jvm.gc'))!;
            expect(gc).not.toMatch(/SUM\(/);
            const host = queries().find((q) => q.includes('"mulesoft.app.memory"'))!;
            expect(host).not.toMatch(/(MIN|MAX)\(free_physical_memory_size\)/);
            const pools = queries().find((q) => q.includes('mulesoft.app.jvm.memory'))!;
            expect(pools).toContain('MAX("limit")');
        });
    });

    describe('getTimeSeries', () => {
        it('maps the granularity and merges traffic with failures', async () => {
            respond([
                [/"failed_count"/, [{ timestamp: 60000, 'app.name': 'orders', failed_count: 1 }]],
                [
                    /"request_count"/,
                    [
                        { timestamp: 0, 'app.name': 'orders', request_count: 4, avg_response_time: 10, p95: 20 },
                        { timestamp: 60000, 'app.name': 'orders', request_count: 6, avg_response_time: 12, p95: 25 },
                    ],
                ],
            ]);
            const points = await api.getTimeSeries(scope, 'traffic', '1m');
            expect(queries()[0]).toContain('TIMESERIES PT1M');
            expect(points).toEqual([
                { timestamp: 0, appName: 'orders', requestCount: 4, failedCount: 0, avgResponseTime: 10, p95: 20 },
                { timestamp: 60000, appName: 'orders', requestCount: 6, failedCount: 1, avgResponseTime: 12, p95: 25 },
            ]);
        });

        it('turns cumulative GC counters into per-bucket deltas and survives restarts', async () => {
            const row = (timestamp: number, countMin: number, countMax: number, durMin: number, durMax: number) => ({
                timestamp,
                'app.name': 'orders',
                'worker.id': 'w-1',
                name: 'G1 Old Generation',
                count_min: countMin,
                count_max: countMax,
                duration_min: durMin,
                duration_max: durMax,
            });
            respond([
                [/mulesoft\.app\.jvm\.gc/, [row(0, 10, 11, 100, 150), row(1, 11, 13, 150, 260), row(2, 0, 1, 0, 40)]],
            ]);

            const points = await api.getTimeSeries(scope, 'gc', '1h');
            expect(points.map((p) => [p.oldGenGcCount, p.oldGenGcTimeMs])).toEqual([
                [1, 50],
                [2, 110],
                [1, 40],
            ]);
        });

        it('splits memory pools into heap, old generation and metaspace per worker', async () => {
            const base = { timestamp: 0, 'app.name': 'orders', 'worker.id': 'w-1' };
            respond([
                [
                    /mulesoft\.app\.jvm\.memory/,
                    [
                        { ...base, pool: 'total-heap', used: 600 },
                        { ...base, pool: 'G1 Old Gen', used: 300 },
                        { ...base, pool: 'metaspace', used: 100 },
                        { ...base, pool: 'eden_space', used: 50 },
                    ],
                ],
            ]);
            expect(await api.getTimeSeries(scope, 'memory')).toEqual([
                {
                    ...{ timestamp: 0, appName: 'orders', workerId: 'w-1' },
                    heapUsed: 600,
                    oldGenUsed: 300,
                    metaspaceUsed: 100,
                },
            ]);
        });
    });

    describe('exportMetrics', () => {
        it('summarizes requests, failures and the request-weighted average', async () => {
            respond([
                [/"failed_count".*mulesoft\.app\.inbound/, [{ 'app.name': 'a', failed_count: 1 }]],
                [
                    /mulesoft\.app\.inbound/,
                    [
                        { 'app.name': 'a', request_count: 10, avg_response_time: 100 },
                        { 'app.name': 'b', request_count: 30, avg_response_time: 200 },
                    ],
                ],
            ]);
            const exported = await api.exportMetrics(ORG, ENV, 'Sandbox', 0, 1000);
            expect(exported.summary).toEqual({ totalRequests: 40, totalFailed: 1, avgResponseTime: 175 });
            expect(exported.environment).toBe('Sandbox');
        });
    });
});
