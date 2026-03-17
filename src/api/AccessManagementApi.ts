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

/** Raw response shape from /accounts/api/me */
interface MeApiResponse {
    user: UserProfile & {
        organization?: { id: string; name: string; domain: string };
        memberOfOrganizations?: Array<{ id: string; name: string }>;
    };
    organization?: { id: string; name: string; domain: string };
}

export interface Environment {
    id: string;
    name: string;
    organizationId: string;
    type: string;
    isProduction: boolean;
    clientId?: string;
}

export interface OrgEntitlements {
    vCoresProduction: { assigned: number; reassigned: number };
    vCoresSandbox: { assigned: number; reassigned: number };
    vCoresDesign: { assigned: number; reassigned: number };
    staticIps: { assigned: number; reassigned: number };
    vpcs: { assigned: number; reassigned: number };
    mqMessages: { base: number; addOn: number };
    mqRequests: { base: number; addOn: number };
    mqAdvancedFeatures: { enabled: boolean };
    objectStoreRequestUnits: { base: number; addOn: number };
    objectStoreKeys: { base: number; addOn: number };
    designCenter: { api: boolean; [key: string]: unknown };
    autoscaling: boolean;
    armAlerts: boolean;
    apis: { enabled: boolean };
    apiMonitoring: { schedules: number };
    monitoringCenter: { productSKU: number };
    loadBalancer: { assigned: number; reassigned: number };
    runtimeFabric: { enabled?: boolean; [key: string]: unknown };
    runtimeFabricCloud: { enabled?: boolean; [key: string]: unknown };
    appViz: { enabled?: boolean; [key: string]: unknown };
    globalDeployment: boolean;
    createSubOrgs: boolean;
    createEnvironments: boolean;
    [key: string]: unknown;
}

export interface OrgSubscription {
    category: string;
    type: string;
    expiration: string;
}

export interface OrgDetails {
    name: string;
    id: string;
    entitlements: OrgEntitlements;
    subscription: OrgSubscription;
}

export class AccessManagementApi {
    constructor(
        private readonly http: HttpClient,
        private readonly cache: Cache,
    ) {}

    async getMe(): Promise<UserProfile> {
        return this.cache.getOrCompute('me', async () => {
            const raw = await this.http.get<MeApiResponse>('/accounts/api/me');

            // /accounts/api/me returns { user: {...}, organization: {...} }
            const user = raw.user ?? (raw as unknown as UserProfile);
            const org = raw.organization ?? user.organization;

            return {
                id: user.id,
                username: user.username,
                firstName: user.firstName,
                lastName: user.lastName,
                email: user.email,
                organization: org ?? { id: '', name: 'Unknown', domain: '' },
                memberOfOrganizations: user.memberOfOrganizations,
            };
        });
    }

    async getEnvironments(orgId: string): Promise<Environment[]> {
        return this.cache.getOrCompute(`envs:${orgId}`, async () => {
            const response = await this.http.get<{ data: Environment[] }>(
                `/accounts/api/organizations/${orgId}/environments`,
            );
            return response.data || [];
        });
    }

    /**
     * Get organization details including entitlements and subscription
     */
    async getOrgDetails(orgId: string): Promise<OrgDetails> {
        return this.cache.getOrCompute(`org:${orgId}`, async () => {
            return this.http.get<OrgDetails>(`/accounts/api/organizations/${orgId}`);
        });
    }

    /**
     * Resolve environment name to ID
     */
    async resolveEnvironment(orgId: string, nameOrId: string): Promise<Environment> {
        const envs = await this.getEnvironments(orgId);
        const env = envs.find((e) => e.id === nameOrId || e.name.toLowerCase() === nameOrId.toLowerCase());

        if (!env) {
            const available = envs.map((e) => e.name).join(', ');
            throw new Error(`Environment "${nameOrId}" not found. Available: ${available}`);
        }

        return env;
    }
}
