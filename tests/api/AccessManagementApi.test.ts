/**
 * Tests for AccessManagementApi
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AccessManagementApi } from '../../src/api/AccessManagementApi.js';
import { Cache } from '../../src/client/Cache.js';

const mockGet = vi.fn();
const mockHttpClient = { get: mockGet } as any;

describe('AccessManagementApi', () => {
    let api: AccessManagementApi;

    beforeEach(() => {
        vi.resetAllMocks();
        api = new AccessManagementApi(mockHttpClient, new Cache());
    });

    describe('getMe', () => {
        it('should call /accounts/api/me and return profile', async () => {
            const profile = {
                id: 'u1',
                username: 'jdoe',
                firstName: 'John',
                lastName: 'Doe',
                email: 'jdoe@example.com',
                organization: { id: 'org-1', name: 'My Org', domain: 'myorg' },
            };
            mockGet.mockResolvedValue(profile);

            const result = await api.getMe();
            expect(mockGet).toHaveBeenCalledWith('/accounts/api/me');
            expect(result.username).toBe('jdoe');
            expect(result.organization.name).toBe('My Org');
        });
    });

    describe('getEnvironments', () => {
        it('should fetch environments for an org', async () => {
            const envs = [
                { id: 'e1', name: 'Sandbox', organizationId: 'org-1', type: 'sandbox', isProduction: false },
                { id: 'e2', name: 'Production', organizationId: 'org-1', type: 'production', isProduction: true },
            ];
            mockGet.mockResolvedValue({ data: envs });

            const result = await api.getEnvironments('org-1');
            expect(mockGet).toHaveBeenCalledWith(
                expect.stringContaining('/org-1/environments')
            );
            expect(result).toHaveLength(2);
            expect(result[0].name).toBe('Sandbox');
            expect(result[1].isProduction).toBe(true);
        });
    });

    describe('resolveEnvironment', () => {
        it('should find environment by name (case-insensitive)', async () => {
            const envs = [
                { id: 'e1', name: 'Sandbox', organizationId: 'org-1', type: 'sandbox', isProduction: false },
                { id: 'e2', name: 'Production', organizationId: 'org-1', type: 'production', isProduction: true },
            ];
            mockGet.mockResolvedValue({ data: envs });

            const env = await api.resolveEnvironment('org-1', 'sandbox');
            expect(env.id).toBe('e1');
        });

        it('should throw for unknown environment', async () => {
            const envs = [
                { id: 'e1', name: 'Sandbox', organizationId: 'org-1', type: 'sandbox', isProduction: false },
            ];
            mockGet.mockResolvedValue({ data: envs });

            await expect(
                api.resolveEnvironment('org-1', 'staging')
            ).rejects.toThrow('not found');
        });

        it('should find environment by ID', async () => {
            const envs = [
                { id: 'e1', name: 'Sandbox', organizationId: 'org-1', type: 'sandbox', isProduction: false },
            ];
            mockGet.mockResolvedValue({ data: envs });

            const env = await api.resolveEnvironment('org-1', 'e1');
            expect(env.name).toBe('Sandbox');
        });
    });
});
