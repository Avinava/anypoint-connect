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

const BASE = '/apimanager/api/v1';

export class ApiManagerApi {
    constructor(
        private readonly http: HttpClient,
        private readonly cache: Cache
    ) { }

    /**
     * List all API assets/instances in an environment
     */
    async getApis(orgId: string, envId: string): Promise<ApiAsset[]> {
        const cacheKey = `apim:${orgId}:${envId}`;
        return this.cache.getOrCompute(cacheKey, async () => {
            const response = await this.http.get<{ total: number; assets: ApiAsset[] }>(
                `${BASE}/organizations/${orgId}/environments/${envId}/apis?limit=100`,
                {
                    headers: {
                        'X-ANYPNT-ORG-ID': orgId,
                        'X-ANYPNT-ENV-ID': envId,
                    },
                }
            );
            return response.assets || [];
        });
    }

    /**
     * Get policies for an API instance
     */
    async getPolicies(orgId: string, envId: string, apiId: number): Promise<ApiPolicy[]> {
        const response = await this.http.get<{ policies: ApiPolicy[] }>(
            `${BASE}/organizations/${orgId}/environments/${envId}/apis/${apiId}/policies`,
            {
                headers: {
                    'X-ANYPNT-ORG-ID': orgId,
                    'X-ANYPNT-ENV-ID': envId,
                },
            }
        );
        return response.policies || [];
    }

    /**
     * Get SLA tiers for an API instance
     */
    async getSlaTiers(orgId: string, envId: string, apiId: number): Promise<SlaTier[]> {
        const response = await this.http.get<{ total: number; tiers: SlaTier[] }>(
            `${BASE}/organizations/${orgId}/environments/${envId}/apis/${apiId}/tiers`,
            {
                headers: {
                    'X-ANYPNT-ORG-ID': orgId,
                    'X-ANYPNT-ENV-ID': envId,
                },
            }
        );
        return response.tiers || [];
    }

    /**
     * Get alerts for an API instance
     */
    async getAlerts(orgId: string, envId: string, apiId: number): Promise<unknown[]> {
        return this.http.get<unknown[]>(
            `${BASE}/organizations/${orgId}/environments/${envId}/apis/${apiId}/alerts`,
            {
                headers: {
                    'X-ANYPNT-ORG-ID': orgId,
                    'X-ANYPNT-ENV-ID': envId,
                },
            }
        );
    }

    /**
     * Find an API instance by name
     */
    async findByName(orgId: string, envId: string, name: string): Promise<{ asset: ApiAsset; instance: ApiInstance } | null> {
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
