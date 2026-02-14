/**
 * Tests for CloudHub2Api
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CloudHub2Api } from '../../src/api/CloudHub2Api.js';
import { Cache } from '../../src/client/Cache.js';

// Mock HttpClient
const mockGet = vi.fn();
const mockPost = vi.fn();
const mockPatch = vi.fn();
const mockDelete = vi.fn();

const mockHttpClient = {
    get: mockGet,
    post: mockPost,
    patch: mockPatch,
    delete: mockDelete,
} as any;

describe('CloudHub2Api', () => {
    let api: CloudHub2Api;

    beforeEach(() => {
        vi.resetAllMocks();
        api = new CloudHub2Api(mockHttpClient, new Cache());
    });

    describe('getDeployments', () => {
        it('should call correct endpoint and return items', async () => {
            const items = [
                { id: '1', name: 'app1', status: 'APPLIED' },
                { id: '2', name: 'app2', status: 'STARTED' },
            ];
            mockGet.mockResolvedValue({ items });

            const result = await api.getDeployments('org-1', 'env-1');
            expect(mockGet).toHaveBeenCalledWith(
                expect.stringContaining('/org-1/environments/env-1/deployments'),
                expect.objectContaining({
                    headers: expect.objectContaining({
                        'X-ANYPNT-ORG-ID': 'org-1',
                        'X-ANYPNT-ENV-ID': 'env-1',
                    }),
                })
            );
            expect(result).toEqual(items);
        });
    });

    describe('getDeployment', () => {
        it('should fetch a single deployment by ID', async () => {
            const deployment = { id: 'dep-1', name: 'my-app', status: 'APPLIED' };
            mockGet.mockResolvedValue(deployment);

            const result = await api.getDeployment('org-1', 'env-1', 'dep-1');
            expect(mockGet).toHaveBeenCalledWith(
                expect.stringContaining('/dep-1'),
                expect.objectContaining({
                    headers: expect.objectContaining({
                        'X-ANYPNT-ORG-ID': 'org-1',
                    }),
                })
            );
            expect(result.id).toBe('dep-1');
        });
    });

    describe('createDeployment', () => {
        it('should POST to the deployments endpoint', async () => {
            const spec = { name: 'new-app' };
            mockPost.mockResolvedValue({ id: 'new-dep', status: 'DEPLOYING' });

            const result = await api.createDeployment('org-1', 'env-1', spec as any);

            expect(mockPost).toHaveBeenCalledWith(
                expect.stringContaining('/org-1/environments/env-1/deployments'),
                spec,
                expect.objectContaining({
                    headers: expect.objectContaining({
                        'X-ANYPNT-ORG-ID': 'org-1',
                    }),
                })
            );
            expect(result.id).toBe('new-dep');
        });
    });

    describe('deleteDeployment', () => {
        it('should DELETE the correct deployment', async () => {
            mockDelete.mockResolvedValue(undefined);
            await api.deleteDeployment('org-1', 'env-1', 'dep-1');
            expect(mockDelete).toHaveBeenCalledWith(
                expect.stringContaining('/dep-1'),
                expect.objectContaining({
                    headers: expect.objectContaining({
                        'X-ANYPNT-ENV-ID': 'env-1',
                    }),
                })
            );
        });
    });

    describe('findByName', () => {
        it('should find a deployment by app name (case-insensitive)', async () => {
            const items = [
                { id: '1', name: 'my-api', status: 'APPLIED' },
                { id: '2', name: 'other-api', status: 'APPLIED' },
            ];
            mockGet.mockResolvedValue({ items });

            const result = await api.findByName('org-1', 'env-1', 'My-API');
            expect(result).not.toBeNull();
            expect(result!.name).toBe('my-api');
        });

        it('should return null when not found', async () => {
            mockGet.mockResolvedValue({ items: [] });
            const result = await api.findByName('org-1', 'env-1', 'nonexistent');
            expect(result).toBeNull();
        });
    });
});
