/**
 * Access Management API
 * User profile and environment management
 */

import type { HttpClient } from '../client/HttpClient.js';
import type { Cache } from '../client/Cache.js';

export interface UserProfile {
    id: string;
    username: string;
    firstName: string;
    lastName: string;
    email: string;
    organization: {
        id: string;
        name: string;
        domain: string;
    };
    memberOfOrganizations?: Array<{
        id: string;
        name: string;
    }>;
}

export interface Environment {
    id: string;
    name: string;
    organizationId: string;
    type: string;
    isProduction: boolean;
    clientId?: string;
}

export class AccessManagementApi {
    constructor(
        private readonly http: HttpClient,
        private readonly cache: Cache
    ) { }

    async getMe(): Promise<UserProfile> {
        return this.cache.getOrCompute('me', () =>
            this.http.get<UserProfile>('/accounts/api/me')
        );
    }

    async getEnvironments(orgId: string): Promise<Environment[]> {
        return this.cache.getOrCompute(`envs:${orgId}`, async () => {
            const response = await this.http.get<{ data: Environment[] }>(
                `/accounts/api/organizations/${orgId}/environments`
            );
            return response.data || [];
        });
    }

    /**
     * Resolve environment name to ID
     */
    async resolveEnvironment(orgId: string, nameOrId: string): Promise<Environment> {
        const envs = await this.getEnvironments(orgId);
        const env = envs.find(
            (e) =>
                e.id === nameOrId ||
                e.name.toLowerCase() === nameOrId.toLowerCase()
        );

        if (!env) {
            const available = envs.map((e) => e.name).join(', ');
            throw new Error(`Environment "${nameOrId}" not found. Available: ${available}`);
        }

        return env;
    }
}
