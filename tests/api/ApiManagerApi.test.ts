/**
 * Tests for ApiManagerApi
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiManagerApi } from '../../src/api/ApiManagerApi.js';
import { Cache } from '../../src/client/Cache.js';

const mockGet = vi.fn();
const mockHttp = { get: mockGet } as any;
const headers = { headers: { 'X-ANYPNT-ORG-ID': 'org-1', 'X-ANYPNT-ENV-ID': 'env-1' } };

function asset(id: number, name: string) {
    return { id, name, exchangeAssetName: name, groupId: 'org-1', assetId: name, apis: [{ id, status: 'active' }] };
}

describe('ApiManagerApi', () => {
    let api: ApiManagerApi;

    beforeEach(() => {
        vi.resetAllMocks();
        api = new ApiManagerApi(mockHttp, new Cache());
    });

    it('pages through getApis past the first 100 assets', async () => {
        const first = Array.from({ length: 100 }, (_, i) => asset(i + 1, `api-${i + 1}`));
        mockGet
            .mockResolvedValueOnce({ total: 101, assets: first })
            .mockResolvedValueOnce({ total: 101, assets: [asset(101, 'orders-sapi')] });

        const assets = await api.getApis('org-1', 'env-1');

        expect(assets).toHaveLength(101);
        expect(mockGet).toHaveBeenNthCalledWith(
            1,
            '/apimanager/api/v1/organizations/org-1/environments/env-1/apis?limit=100&offset=0',
            headers,
        );
        expect(mockGet).toHaveBeenNthCalledWith(
            2,
            '/apimanager/api/v1/organizations/org-1/environments/env-1/apis?limit=100&offset=100',
            headers,
        );
    });

    it('pages through contracts', async () => {
        const page = Array.from({ length: 100 }, (_, i) => ({ id: i, status: 'APPROVED' }));
        mockGet
            .mockResolvedValueOnce({ total: 102, contracts: page })
            .mockResolvedValueOnce({ total: 102, contracts: [{ id: 100 }, { id: 101 }] });

        const contracts = await api.getContracts('org-1', 'env-1', 42);

        expect(contracts).toHaveLength(102);
        expect(mockGet).toHaveBeenNthCalledWith(
            2,
            '/apimanager/api/v1/organizations/org-1/environments/env-1/apis/42/contracts?limit=100&offset=100',
            headers,
        );
    });

    it('gets a client application from the API Platform repository', async () => {
        mockGet.mockResolvedValue({ id: 7, name: 'orders-client', clientId: 'id', clientSecret: 'secret' });
        await api.getClientApplication('org-1', 7);
        expect(mockGet).toHaveBeenCalledWith('/apiplatform/repository/v2/organizations/org-1/applications/7');
    });

    describe('resolveApiInstance', () => {
        const env = { id: 'env-1', name: 'Sandbox' };

        beforeEach(() => {
            mockGet.mockResolvedValue({ total: 2, assets: [asset(11, 'customers-sapi'), asset(42, 'orders-sapi')] });
        });

        it('resolves a numeric ID with its instance', async () => {
            const resolved = await api.resolveApiInstance('org-1', env, '42');
            expect(resolved.apiId).toBe(42);
            expect(resolved.asset?.exchangeAssetName).toBe('orders-sapi');
        });

        it('keeps a numeric ID that is not in the list', async () => {
            expect(await api.resolveApiInstance('org-1', env, '999')).toEqual({ apiId: 999 });
        });

        it('resolves a partial name', async () => {
            expect((await api.resolveApiInstance('org-1', env, 'orders')).apiId).toBe(42);
        });

        it('throws for an unknown name', async () => {
            await expect(api.resolveApiInstance('org-1', env, 'billing')).rejects.toThrow(
                'API "billing" not found in Sandbox',
            );
        });
    });
});
