import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AlertPendingError, AlertsApi, AlertsUnsupportedError } from '../../src/api/AlertsApi.js';
import { ORG, appAlert, httpError } from '../fixtures/alerts.js';

const BASE = `/observability/api/v1/organizations/${ORG}/alerts`;

describe('AlertsApi', () => {
    const http = { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() };
    let api: AlertsApi;
    beforeEach(() => {
        vi.resetAllMocks();
        api = new AlertsApi(http as any);
    });

    it('follows pagination until a short page or no next link', async () => {
        const page = (n: number, start: number) =>
            Array.from({ length: n }, (_, i) => appAlert({ id: `alert-${start + i}` }));
        http.get
            .mockResolvedValueOnce({ data: page(100, 0), metadata: { pagination: { next: 'p2' } } })
            .mockResolvedValueOnce({ data: page(3, 100), metadata: { pagination: {} } });
        const alerts = await api.list(ORG, { environmentId: 'env-sbx', name: 'orders memory' });
        expect(alerts).toHaveLength(103);
        expect(http.get.mock.calls[0][0]).toBe(`${BASE}?limit=100&offset=0&environmentId=env-sbx&name=orders+memory`);
        expect(http.get.mock.calls[1][0]).toContain('offset=100');
    });

    it('stops when a full page has no next link', async () => {
        http.get.mockResolvedValueOnce({
            data: Array.from({ length: 100 }, () => appAlert()),
            metadata: { pagination: {} },
        });
        await api.list(ORG);
        expect(http.get).toHaveBeenCalledTimes(1);
    });

    it.each([404, 403])('reports the family as unsupported on %s', async (status) => {
        http.get.mockRejectedValue(httpError(status));
        await expect(api.list(ORG)).rejects.toBeInstanceOf(AlertsUnsupportedError);
    });

    it('returns null for a missing alert', async () => {
        http.get.mockRejectedValue(httpError(404));
        expect(await api.get(ORG, 'alert-x')).toBeNull();
    });

    it('creates with POST and unwraps data', async () => {
        http.post.mockResolvedValue({ data: { id: 'alert-new', alertStatus: 'PENDING' } });
        const body = { ...appAlert(), notifications: [] } as any;
        expect(await api.create(ORG, body)).toEqual({ id: 'alert-new', alertStatus: 'PENDING' });
        expect(http.post).toHaveBeenCalledWith(BASE, body);
    });

    it('replaces with a full PATCH that carries the id', async () => {
        const body = {
            name: 'n',
            severity: 0,
            enabled: false,
            settings: {} as any,
            entity: {} as any,
            notifications: [],
        };
        await api.update(ORG, 'alert-1', body);
        expect(http.patch).toHaveBeenCalledWith(`${BASE}/alert-1`, { ...body, id: 'alert-1' });
    });

    it('maps a 400 "not present or Deleted" to a PENDING refusal', async () => {
        http.patch.mockRejectedValue(httpError(400, { message: 'Alert is not present or Deleted' }));
        await expect(api.update(ORG, 'alert-1', {} as any)).rejects.toBeInstanceOf(AlertPendingError);
    });

    it('maps other 400s and 404s to clear messages', async () => {
        http.patch.mockRejectedValueOnce(httpError(400, { message: 'threshold invalid' }));
        await expect(api.update(ORG, 'alert-1', {} as any)).rejects.toThrow('rejected (HTTP 400): threshold invalid');
        http.delete.mockRejectedValueOnce(httpError(404));
        await expect(api.delete(ORG, 'alert-1')).rejects.toThrow('Alert alert-1 not found');
    });

    it('reads Runtime Manager alerts with org and environment headers', async () => {
        http.get.mockResolvedValue({ data: [{ id: 'rm-1', name: 'deploy failed' }] });
        expect(await api.listRuntimeManager(ORG, 'env-sbx')).toEqual([{ id: 'rm-1', name: 'deploy failed' }]);
        expect(http.get).toHaveBeenCalledWith('/armui/api/v1/alerts', {
            headers: { 'X-ANYPNT-ORG-ID': ORG, 'X-ANYPNT-ENV-ID': 'env-sbx' },
        });
    });
});
