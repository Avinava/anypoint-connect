import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignCenterApi } from '../../src/api/DesignCenterApi.js';
import { Cache } from '../../src/client/Cache.js';

const get = vi.fn();
const post = vi.fn();
const http = { get, post } as any;

describe('DesignCenterApi', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        get.mockImplementation(async (url: string) => {
            if (url === '/accounts/api/me') return { user: { id: 'owner-1' } };
            if (url === '/designcenter/api-designer/projects') {
                return [
                    { id: 'p-1', name: 'orders-api', type: 'raml', organizationId: 'org-1' },
                    { id: 'p-2', name: 'orders-api-v2', type: 'raml', organizationId: 'org-1' },
                ];
            }
            throw new Error(`Unexpected GET ${url}`);
        });
    });

    it('resolves only exact project names or IDs', async () => {
        const api = new DesignCenterApi(http, new Cache());
        await expect(api.findByNameOrThrow('org-1', 'orders')).rejects.toThrow(/not found/);
        await expect(api.findByNameOrThrow('org-1', 'orders-api')).resolves.toMatchObject({ id: 'p-1' });
        await expect(api.findByNameOrThrow('org-1', 'p-2')).resolves.toMatchObject({ name: 'orders-api-v2' });
    });

    it('sends one uppercase FILE batch payload', async () => {
        post.mockResolvedValue(undefined);
        const api = new DesignCenterApi(http, new Cache());
        await api.saveFiles(
            'org-1',
            'p-1',
            [
                { path: 'api.raml', content: 'one' },
                { path: 'types/item.raml', content: 'two' },
            ],
            'master',
            'test update',
        );
        expect(post).toHaveBeenCalledWith(
            '/designcenter/api-designer/projects/p-1/branches/master/save',
            [
                { path: 'api.raml', content: 'one', type: 'FILE' },
                { path: 'types/item.raml', content: 'two', type: 'FILE' },
            ],
            expect.objectContaining({ headers: expect.objectContaining({ 'x-commit-message': 'test update' }) }),
        );
    });

    it('preserves the write failure when lock release also fails', async () => {
        const api = new DesignCenterApi(http, new Cache());
        vi.spyOn(api, 'acquireLock').mockResolvedValue();
        vi.spyOn(api, 'releaseLock').mockRejectedValue(new Error('release failed'));
        await expect(
            api.withLock('org-1', 'p-1', 'master', async () => {
                throw new Error('write failed');
            }),
        ).rejects.toThrow('write failed');
    });
});
