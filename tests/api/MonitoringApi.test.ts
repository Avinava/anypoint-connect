/**
 * Tests for MonitoringApi
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MonitoringApi } from '../../src/api/MonitoringApi.js';
import { Cache } from '../../src/client/Cache.js';

const mockPost = vi.fn();
const mockHttpClient = {
    get: vi.fn(),
    post: mockPost,
    patch: vi.fn(),
    delete: vi.fn(),
} as any;

describe('MonitoringApi', () => {
    let api: MonitoringApi;

    beforeEach(() => {
        vi.resetAllMocks();
        api = new MonitoringApi(mockHttpClient, new Cache());
    });

    describe('search', () => {
        it('should POST the AMQL query to the metrics endpoint', async () => {
            mockPost.mockResolvedValue({ data: [{ 'app.name': 'test-app', request_count: 100 }] });

            const result = await api.search('SELECT COUNT(requests) FROM "mulesoft.app.inbound"');
            expect(mockPost).toHaveBeenCalledWith(expect.stringContaining('/metrics:search?limit=200&offset=0'), {
                query: 'SELECT COUNT(requests) FROM "mulesoft.app.inbound"',
            });
            expect(result).toHaveLength(1);
        });

        it('should return empty array on error', async () => {
            mockPost.mockRejectedValue(new Error('Network error'));
            const result = await api.search('bad query');
            expect(result).toEqual([]);
        });

        it('should pass custom limit', async () => {
            mockPost.mockResolvedValue({ data: [] });
            await api.search('query', 500);
            expect(mockPost).toHaveBeenCalledWith(expect.stringContaining('limit=500'), expect.anything());
        });
    });

    describe('getInboundMetrics', () => {
        it('should NOT include COUNT(errors) in the AMQL query', async () => {
            mockPost.mockResolvedValue({ data: [] });

            await api.getInboundMetrics('org-1', 'env-1', 1000, 2000);

            const query = mockPost.mock.calls[0][1].query;
            expect(query).not.toContain('COUNT(errors)');
            expect(query).not.toContain('error_count');
            expect(query).toContain('COUNT(requests)');
            expect(query).toContain('AVG(response_time)');
        });

        it('should return mapped results without errorCount', async () => {
            mockPost.mockResolvedValue({
                data: [{ 'app.name': 'my-app', request_count: 500, avg_response_time: 120.5 }],
            });

            const result = await api.getInboundMetrics('org-1', 'env-1', 1000, 2000);
            expect(result).toEqual([{ appName: 'my-app', requestCount: 500, avgResponseTime: 120.5 }]);
            expect((result[0] as any).errorCount).toBeUndefined();
        });

        it('should include org, env, and timestamp filters', async () => {
            mockPost.mockResolvedValue({ data: [] });
            await api.getInboundMetrics('org-1', 'env-1', 1000, 2000);

            const query = mockPost.mock.calls[0][1].query;
            expect(query).toContain(`"sub_org.id" = 'org-1'`);
            expect(query).toContain(`"env.id" = 'env-1'`);
            expect(query).toContain('timestamp BETWEEN 1000 AND 2000');
        });
    });

    describe('getOutboundMetrics', () => {
        it('should query mulesoft.app.outbound dataset', async () => {
            mockPost.mockResolvedValue({ data: [] });
            await api.getOutboundMetrics('org-1', 'env-1', 1000, 2000);

            const query = mockPost.mock.calls[0][1].query;
            expect(query).toContain('"mulesoft.app.outbound"');
        });
    });

    describe('getAppMetrics', () => {
        it('should combine inbound and outbound metrics', async () => {
            mockPost
                .mockResolvedValueOnce({
                    data: [{ 'app.name': 'app-1', request_count: 100, avg_response_time: 200 }],
                })
                .mockResolvedValueOnce({
                    data: [{ 'app.name': 'app-1', request_count: 50, avg_response_time: 80 }],
                });

            const result = await api.getAppMetrics('org-1', 'env-1', 1000, 2000);
            expect(result).toHaveLength(1);
            expect(result[0]).toEqual({
                appName: 'app-1',
                requestCount: 100,
                avgResponseTime: 200,
                outboundCount: 50,
                outboundAvgResponseTime: 80,
            });
            expect((result[0] as any).errorCount).toBeUndefined();
            expect((result[0] as any).errorRate).toBeUndefined();
        });

        it('should include outbound-only apps', async () => {
            mockPost.mockResolvedValueOnce({ data: [] }).mockResolvedValueOnce({
                data: [{ 'app.name': 'outbound-only', request_count: 30, avg_response_time: 50 }],
            });

            const result = await api.getAppMetrics('org-1', 'env-1', 1000, 2000);
            expect(result).toHaveLength(1);
            expect(result[0].appName).toBe('outbound-only');
            expect(result[0].requestCount).toBe(0);
            expect(result[0].outboundCount).toBe(30);
        });

        it('should filter by appName case-insensitively', async () => {
            mockPost
                .mockResolvedValueOnce({
                    data: [
                        { 'app.name': 'App-A', request_count: 10, avg_response_time: 100 },
                        { 'app.name': 'App-B', request_count: 20, avg_response_time: 200 },
                    ],
                })
                .mockResolvedValueOnce({ data: [] });

            const result = await api.getAppMetrics('org-1', 'env-1', 1000, 2000, 'app-a');
            expect(result).toHaveLength(1);
            expect(result[0].appName).toBe('App-A');
        });
    });

    describe('getPerformanceMetrics', () => {
        it('should query percentiles p50, p95, p99 and min/max', async () => {
            mockPost.mockResolvedValue({ data: [] });
            await api.getPerformanceMetrics('org-1', 'env-1', 1000, 2000);

            const query = mockPost.mock.calls[0][1].query;
            expect(query).toContain('PERCENTILE(response_time, 0.5) AS "p50"');
            expect(query).toContain('PERCENTILE(response_time, 0.95) AS "p95"');
            expect(query).toContain('PERCENTILE(response_time, 0.99) AS "p99"');
            expect(query).toContain('MAX(response_time)');
            expect(query).toContain('MIN(response_time)');
        });

        it('should return mapped PerformanceMetrics', async () => {
            mockPost.mockResolvedValue({
                data: [
                    {
                        'app.name': 'perf-app',
                        request_count: 1000,
                        avg_response_time: 250,
                        max_response_time: 5000,
                        min_response_time: 2,
                        p50: 180,
                        p95: 1200,
                        p99: 3500,
                    },
                ],
            });

            const result = await api.getPerformanceMetrics('org-1', 'env-1', 1000, 2000);
            expect(result).toEqual([
                {
                    appName: 'perf-app',
                    requestCount: 1000,
                    avgResponseTime: 250,
                    maxResponseTime: 5000,
                    minResponseTime: 2,
                    p50: 180,
                    p95: 1200,
                    p99: 3500,
                },
            ]);
        });

        it('should add app.name filter when appName is provided', async () => {
            mockPost.mockResolvedValue({ data: [] });
            await api.getPerformanceMetrics('org-1', 'env-1', 1000, 2000, 'my-app');

            const query = mockPost.mock.calls[0][1].query;
            expect(query).toContain(`"app.name" = 'my-app'`);
        });
    });

    describe('getTimeSeries', () => {
        it('should include TIMESERIES clause with granularity', async () => {
            mockPost.mockResolvedValue({ data: [] });
            await api.getTimeSeries('org-1', 'env-1', 1000, 2000, 'PT5M');

            const query = mockPost.mock.calls[0][1].query;
            expect(query).toContain('TIMESERIES PT5M');
            expect(query).toContain('timestamp');
        });

        it('should default to PT1H granularity', async () => {
            mockPost.mockResolvedValue({ data: [] });
            await api.getTimeSeries('org-1', 'env-1', 1000, 2000);

            const query = mockPost.mock.calls[0][1].query;
            expect(query).toContain('TIMESERIES PT1H');
        });

        it('should return mapped TimeSeriesDataPoint', async () => {
            mockPost.mockResolvedValue({
                data: [
                    {
                        timestamp: 1700000000000,
                        'app.name': 'ts-app',
                        request_count: 42,
                        avg_response_time: 300,
                        p95: 900,
                    },
                ],
            });

            const result = await api.getTimeSeries('org-1', 'env-1', 1000, 2000);
            expect(result).toEqual([
                {
                    timestamp: 1700000000000,
                    appName: 'ts-app',
                    requestCount: 42,
                    avgResponseTime: 300,
                    p95: 900,
                },
            ]);
        });

        it('should use higher limit (1000) for time-series queries', async () => {
            mockPost.mockResolvedValue({ data: [] });
            await api.getTimeSeries('org-1', 'env-1', 1000, 2000);

            expect(mockPost).toHaveBeenCalledWith(expect.stringContaining('limit=1000'), expect.anything());
        });

        it('should add app.name filter when appName is provided', async () => {
            mockPost.mockResolvedValue({ data: [] });
            await api.getTimeSeries('org-1', 'env-1', 1000, 2000, 'PT1H', 'filtered-app');

            const query = mockPost.mock.calls[0][1].query;
            expect(query).toContain(`"app.name" = 'filtered-app'`);
        });
    });

    describe('getWorkerMetrics', () => {
        it('should GROUP BY app.name and worker.id', async () => {
            mockPost.mockResolvedValue({ data: [] });
            await api.getWorkerMetrics('org-1', 'env-1', 1000, 2000);

            const query = mockPost.mock.calls[0][1].query;
            expect(query).toContain('"worker.id"');
            expect(query).toContain('GROUP BY "app.name", "worker.id"');
        });

        it('should return mapped WorkerMetrics', async () => {
            mockPost.mockResolvedValue({
                data: [
                    {
                        'app.name': 'worker-app',
                        'worker.id': 'replica-0',
                        request_count: 200,
                        avg_response_time: 150,
                        max_response_time: 3000,
                        p95: 800,
                    },
                ],
            });

            const result = await api.getWorkerMetrics('org-1', 'env-1', 1000, 2000);
            expect(result).toEqual([
                {
                    appName: 'worker-app',
                    workerId: 'replica-0',
                    requestCount: 200,
                    avgResponseTime: 150,
                    maxResponseTime: 3000,
                    p95: 800,
                },
            ]);
        });
    });

    describe('getCrossEnvMetrics', () => {
        it('should NOT include env.id filter (cross-env)', async () => {
            mockPost.mockResolvedValue({ data: [] });
            await api.getCrossEnvMetrics('org-1', 1000, 2000);

            const query = mockPost.mock.calls[0][1].query;
            expect(query).not.toContain('"env.id"');
            expect(query).toContain(`"sub_org.id" = 'org-1'`);
        });

        it('should GROUP BY app.name and env.name', async () => {
            mockPost.mockResolvedValue({ data: [] });
            await api.getCrossEnvMetrics('org-1', 1000, 2000);

            const query = mockPost.mock.calls[0][1].query;
            expect(query).toContain('GROUP BY "app.name", "env.name"');
        });

        it('should return mapped CrossEnvMetrics', async () => {
            mockPost.mockResolvedValue({
                data: [
                    {
                        'app.name': 'cross-app',
                        'env.name': 'Production',
                        request_count: 5000,
                        avg_response_time: 100,
                        p95: 500,
                        p99: 1200,
                    },
                ],
            });

            const result = await api.getCrossEnvMetrics('org-1', 1000, 2000);
            expect(result).toEqual([
                {
                    appName: 'cross-app',
                    envName: 'Production',
                    requestCount: 5000,
                    avgResponseTime: 100,
                    p95: 500,
                    p99: 1200,
                },
            ]);
        });
    });

    describe('exportMetrics', () => {
        it('should not include error fields in export summary', async () => {
            mockPost
                .mockResolvedValueOnce({
                    data: [{ 'app.name': 'export-app', request_count: 100, avg_response_time: 200 }],
                })
                .mockResolvedValueOnce({ data: [] });

            const result = await api.exportMetrics('org-1', 'env-1', 'Dev', 1000, 2000);
            expect(result.summary).toEqual({
                totalRequests: 100,
                avgResponseTime: 200,
            });
            expect((result.summary as any).totalErrors).toBeUndefined();
            expect((result.summary as any).errorRate).toBeUndefined();
        });
    });

    describe('isAvailable', () => {
        it('should return true when search succeeds', async () => {
            mockPost.mockResolvedValue({ data: [] });
            expect(await api.isAvailable()).toBe(true);
        });

        it('should return true even when POST fails (search swallows errors)', async () => {
            mockPost.mockRejectedValue(new Error('Unauthorized'));
            // search() catches errors and returns [], so isAvailable never sees the throw
            expect(await api.isAvailable()).toBe(true);
        });
    });
});
