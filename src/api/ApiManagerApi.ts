/**
 * API Manager API
 * Manages API instances, policies, SLA tiers, and alerts
 */

import type { HttpClient } from '../client/HttpClient.js';
import type { Cache } from '../client/Cache.js';

export interface ApiInstance {
    id: number;
    instanceLabel?: string;
    groupId: string;
    assetId: string;
    assetVersion: string;
    productVersion?: string;
    description?: string;
    tags?: string[];
    status: string;
    endpointUri?: string;
    /** Present on some proxy instances. */
    proxyUri?: string;
    technology?: string;
    deprecated?: boolean;
    isPublic?: boolean;
    stage?: string;
    activeContractsCount?: number;
    autodiscoveryInstanceName?: string;
}

export interface ApiAsset {
    id: number;
    name: string;
    exchangeAssetName: string;
    groupId: string;
    assetId: string;
    apis: ApiInstance[];
    totalApis: number;
}

export interface ApiPolicy {
    id?: number;
    policyTemplateId?: string;
    configurationData?: Record<string, unknown>;
    pointcutData?: Record<string, unknown>;
    order?: number;
    disabled?: boolean;
    template?: {
        groupId?: string;
        assetId?: string;
        assetVersion?: string;
    };
}

export interface SlaTier {
    id: number;
    name: string;
    description?: string;
    status: string;
    autoApprove: boolean;
    applicationCount: number;
    limits: Array<{
        maximumRequests: number;
        timePeriodInMilliseconds: number;
    }>;
}

export interface ApiContract {
    id: number;
    status: string;
    applicationId?: number;
    application?: { id: number; name: string; [key: string]: unknown };
    tier?: { id: number; name: string } | null;
    tierId?: number | null;
    requestedTierId?: number | null;
    approvedDate?: string;
    [key: string]: unknown;
}

/** A client application from the API Platform repository. Holds credentials; never return it raw. */
export interface ClientApplication {
    id: number;
    name: string;
    description?: string;
    clientId: string;
    clientSecret: string;
    url?: string;
    redirectUri?: string[];
    grantTypes?: string[];
    [key: string]: unknown;
}

/** An API instance resolved from a numeric ID or a name. `instance` is absent when an ID is not in the list. */
export interface ResolvedApiInstance {
    apiId: number;
    asset?: ApiAsset;
    instance?: ApiInstance;
}

const BASE = '/apimanager/api/v1';
const REPOSITORY = '/apiplatform/repository/v2';
const PAGE_SIZE = 100;
/** Hard stop for pagination, in case a response never reports a total. */
const MAX_PAGES = 100;

export class ApiManagerApi {
    constructor(
        private readonly http: HttpClient,
        private readonly cache: Cache,
    ) {}

    /**
     * Build the required Anypoint environment-scoped headers.
     */
    private envHeaders(orgId: string, envId: string) {
        return { 'X-ANYPNT-ORG-ID': orgId, 'X-ANYPNT-ENV-ID': envId };
    }

    /**
     * List all API assets/instances in an environment
     */
    async getApis(orgId: string, envId: string): Promise<ApiAsset[]> {
        const cacheKey = `apim:${orgId}:${envId}`;
        return this.cache.getOrCompute(cacheKey, async () => {
            const assets: ApiAsset[] = [];
            for (let page = 0; page < MAX_PAGES; page++) {
                const response = await this.http.get<{ total: number; assets: ApiAsset[] }>(
                    `${BASE}/organizations/${orgId}/environments/${envId}/apis?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`,
                    { headers: this.envHeaders(orgId, envId) },
                );
                const batch = response.assets || [];
                assets.push(...batch);
                if (batch.length < PAGE_SIZE || (response.total !== undefined && assets.length >= response.total))
                    break;
            }
            return assets;
        });
    }

    /**
     * Resolve a numeric API instance ID or an Exchange asset name (partial match) to an instance.
     * Throws when a name matches nothing.
     */
    async resolveApiInstance(
        orgId: string,
        env: { id: string; name: string },
        apiRef: string,
    ): Promise<ResolvedApiInstance> {
        const trimmed = apiRef.trim();
        if (/^\d+$/.test(trimmed)) {
            const apiId = Number(trimmed);
            const assets = await this.getApis(orgId, env.id);
            for (const asset of assets) {
                const instance = asset.apis.find((api) => api.id === apiId);
                if (instance) return { apiId, asset, instance };
            }
            return { apiId };
        }
        const found = await this.findByName(orgId, env.id, trimmed);
        if (!found) throw new Error(`API "${apiRef}" not found in ${env.name}`);
        return { apiId: found.instance.id, asset: found.asset, instance: found.instance };
    }

    /** List every contract (client application access grant) on an API instance. */
    async getContracts(orgId: string, envId: string, apiId: number): Promise<ApiContract[]> {
        const contracts: ApiContract[] = [];
        for (let page = 0; page < MAX_PAGES; page++) {
            const response = await this.http.get<{ total?: number; contracts?: ApiContract[] }>(
                `${BASE}/organizations/${orgId}/environments/${envId}/apis/${apiId}/contracts?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`,
                { headers: this.envHeaders(orgId, envId) },
            );
            const batch = response.contracts || [];
            contracts.push(...batch);
            if (batch.length < PAGE_SIZE || (response.total !== undefined && contracts.length >= response.total)) break;
        }
        return contracts;
    }

    /**
     * Get a client application, including its client ID and secret. Callers must mask the
     * secret before it reaches any output. Not cached, so a rotated secret is picked up.
     */
    async getClientApplication(orgId: string, appId: number | string): Promise<ClientApplication> {
        return this.http.get<ClientApplication>(
            `${REPOSITORY}/organizations/${orgId}/applications/${encodeURIComponent(String(appId))}`,
        );
    }

    /**
     * Get policies for an API instance
     */
    async getPolicies(orgId: string, envId: string, apiId: number): Promise<ApiPolicy[]> {
        const response = await this.http.get<{ policies: ApiPolicy[] }>(
            `${BASE}/organizations/${orgId}/environments/${envId}/apis/${apiId}/policies`,
            { headers: this.envHeaders(orgId, envId) },
        );
        return response.policies || [];
    }

    /**
     * Get SLA tiers for an API instance
     */
    async getSlaTiers(orgId: string, envId: string, apiId: number): Promise<SlaTier[]> {
        const response = await this.http.get<{ total: number; tiers: SlaTier[] }>(
            `${BASE}/organizations/${orgId}/environments/${envId}/apis/${apiId}/tiers`,
            { headers: this.envHeaders(orgId, envId) },
        );
        return response.tiers || [];
    }

    /**
     * Get alerts for an API instance
     */
    async getAlerts(orgId: string, envId: string, apiId: number): Promise<unknown[]> {
        return this.http.get<unknown[]>(`${BASE}/organizations/${orgId}/environments/${envId}/apis/${apiId}/alerts`, {
            headers: this.envHeaders(orgId, envId),
        });
    }

    /**
     * Find an API instance by name
     */
    async findByName(
        orgId: string,
        envId: string,
        name: string,
    ): Promise<{ asset: ApiAsset; instance: ApiInstance } | null> {
        const assets = await this.getApis(orgId, envId);
        const lower = name.toLowerCase();
        for (const asset of assets) {
            if (asset.exchangeAssetName.toLowerCase().includes(lower) || asset.assetId.toLowerCase().includes(lower)) {
                if (asset.apis.length > 0) {
                    return { asset, instance: asset.apis[0] };
                }
            }
        }
        return null;
    }
}
