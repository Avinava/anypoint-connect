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
                }),
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
                }),
            );
            expect(result.id).toBe('dep-1');
        });
    });

    describe('getDetailedDeployments', () => {
        it('hydrates thin list records sequentially', async () => {
            mockGet
                .mockResolvedValueOnce({
                    items: [
                        { id: 'dep-1', name: 'sample-app-1', status: 'APPLIED' },
                        { id: 'dep-2', name: 'sample-app-2', status: 'APPLIED' },
                    ],
                })
                .mockResolvedValueOnce({ id: 'dep-1', name: 'sample-app-1', application: { ref: {} } })
                .mockResolvedValueOnce({ id: 'dep-2', name: 'sample-app-2', application: { ref: {} } });

            const result = await api.getDetailedDeployments('org-1', 'env-1');

            expect(result.map((deployment) => deployment.id)).toEqual(['dep-1', 'dep-2']);
            expect(mockGet.mock.calls[1][0]).toContain('/deployments/dep-1');
            expect(mockGet.mock.calls[2][0]).toContain('/deployments/dep-2');
        });
    });

    describe('getDeploymentSpecs', () => {
        it('fetches deployment history from the specs endpoint', async () => {
            mockGet.mockResolvedValue([{ version: 'spec-1' }]);
            const result = await api.getDeploymentSpecs('org-1', 'env-1', 'dep-1');
            expect(mockGet).toHaveBeenCalledWith(
                expect.stringContaining('/deployments/dep-1/specs'),
                expect.any(Object),
            );
            expect(result).toEqual([{ version: 'spec-1' }]);
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
                }),
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
                }),
            );
        });

        it('verifies absence using a fresh deployment list', async () => {
            mockGet.mockResolvedValueOnce({
                items: [{ id: 'dep-1', name: 'sample-app', status: 'APPLIED' }],
            });
            await api.getDeployments('org-1', 'env-1');

            mockGet.mockResolvedValueOnce({ items: [] });
            const result = await api.waitForDeploymentDeletion('org-1', 'env-1', 'sample-app', 'dep-1', 0, 0);

            expect(result).toEqual({ verifiedAbsent: true });
            expect(mockGet).toHaveBeenCalledTimes(2);
        });

        it('reports a replacement deployment with the same name', async () => {
            mockGet.mockResolvedValue({
                items: [{ id: 'dep-2', name: 'sample-app', status: 'APPLIED' }],
            });

            const result = await api.waitForDeploymentDeletion('org-1', 'env-1', 'sample-app', 'dep-1', 0, 0);

            expect(result).toEqual({ verifiedAbsent: false, replacementDeploymentId: 'dep-2' });
        });

        it('reports an unverified deletion when the original deployment remains at timeout', async () => {
            mockGet.mockResolvedValue({
                items: [{ id: 'dep-1', name: 'sample-app', status: 'DELETING' }],
            });

            const result = await api.waitForDeploymentDeletion('org-1', 'env-1', 'sample-app', 'dep-1', 0, 0);

            expect(result).toEqual({ verifiedAbsent: false, currentDeploymentId: 'dep-1' });
        });

        it('reports a platform-confirmed deletion tombstone separately from an unknown timeout', async () => {
            mockGet
                .mockResolvedValueOnce({
                    items: [{ id: 'dep-1', name: 'sample-app', status: 'FAILED' }],
                })
                .mockResolvedValueOnce({
                    id: 'dep-1',
                    name: 'sample-app',
                    status: 'FAILED',
                    application: { desiredState: 'DELETED' },
                });

            const result = await api.waitForDeploymentDeletion('org-1', 'env-1', 'sample-app', 'dep-1', 0, 0);

            expect(result).toEqual({
                verifiedAbsent: false,
                deletionState: 'DELETED',
                currentDeploymentId: 'dep-1',
            });
        });
    });

    describe('updateArtifactRef', () => {
        it('PATCHes a body containing ONLY the artifact ref (no runtime/target/replicas)', async () => {
            mockPatch.mockResolvedValue({ id: 'dep-1', status: 'APPLYING' });
            const ref = { groupId: 'org-1', artifactId: 'my-api', version: '2.0.0', packaging: 'jar' };

            await api.updateArtifactRef('org-1', 'env-1', 'dep-1', ref);

            expect(mockPatch).toHaveBeenCalledWith(
                expect.stringContaining('/org-1/environments/env-1/deployments/dep-1'),
                { application: { ref } },
                expect.objectContaining({
                    headers: expect.objectContaining({ 'X-ANYPNT-ORG-ID': 'org-1', 'X-ANYPNT-ENV-ID': 'env-1' }),
                }),
            );
            // Guard the invariant: the PATCH body must not carry infra that could clobber prod.
            const body = mockPatch.mock.calls[0][1];
            expect(Object.keys(body)).toEqual(['application']);
            expect(Object.keys(body.application)).toEqual(['ref']);
        });
    });

    describe('updateApplicationConfiguration', () => {
        it('PATCHes only the application properties configuration', async () => {
            mockPatch.mockResolvedValue({ id: 'dep-1', status: 'APPLYING' });
            const service = {
                applicationName: 'sample-app',
                properties: { environment: 'test' },
                secureProperties: { credential: '******' },
            };

            await api.updateApplicationConfiguration('org-1', 'env-1', 'dep-1', service);

            const body = mockPatch.mock.calls[0][1];
            expect(body).toEqual({
                application: {
                    configuration: {
                        'mule.agent.application.properties.service': service,
                    },
                },
            });
            expect(JSON.stringify(body)).not.toMatch(/target|runtime|replicas|desiredState|ref/);
        });
    });

    describe('setDesiredState', () => {
        it('PATCHes only the requested desired state', async () => {
            mockPatch.mockResolvedValue({ id: 'dep-1', status: 'APPLYING' });
            await api.setDesiredState('org-1', 'env-1', 'dep-1', 'STOPPED');
            expect(mockPatch).toHaveBeenCalledWith(
                expect.any(String),
                { application: { desiredState: 'STOPPED' } },
                expect.any(Object),
            );
        });
    });

    describe('rollbackToRef', () => {
        it('delegates to a ref-only PATCH', async () => {
            mockPatch.mockResolvedValue({ id: 'dep-1', status: 'APPLYING' });
            const ref = { groupId: 'org-1', artifactId: 'my-api', version: '1.0.0', packaging: 'jar' };
            await api.rollbackToRef('org-1', 'env-1', 'dep-1', ref);
            expect(mockPatch).toHaveBeenCalledWith(expect.any(String), { application: { ref } }, expect.any(Object));
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

        it('hydrates full detail when requested by name', async () => {
            mockGet
                .mockResolvedValueOnce({ items: [{ id: 'dep-1', name: 'sample-app', status: 'APPLIED' }] })
                .mockResolvedValueOnce({
                    id: 'dep-1',
                    name: 'sample-app',
                    application: { ref: { version: '2.0.0' } },
                });

            const result = await api.findDetailByName('org-1', 'env-1', 'SAMPLE-APP');
            expect(result?.application.ref.version).toBe('2.0.0');
            expect(mockGet).toHaveBeenCalledTimes(2);
        });
    });
});
