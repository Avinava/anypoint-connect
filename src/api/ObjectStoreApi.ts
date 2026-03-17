/**
 * Object Store v2 API
 * Store, key, and value operations for CloudHub 2.0 applications
 */

import type { HttpClient } from '../client/HttpClient.js';
import type { Cache } from '../client/Cache.js';

export interface ObjectStore {
    storeId: string;
    isDefault: boolean;
    ttlSeconds?: number;
    isPersistent: boolean;
    created?: string;
}

export interface ObjectStoreKeysPage {
    keys: string[];
    nextPageToken?: string;
    total?: number;
}

export interface ObjectStoreValue {
    key: string;
    value: string;
    contentType?: string;
}

const BASE = '/object-store/api/v1';

export class ObjectStoreApi {
    constructor(
        private readonly http: HttpClient,
        private readonly cache: Cache,
    ) {}

    /**
     * List all Object Store v2 stores in an environment
     */
    async listStores(orgId: string, envId: string): Promise<ObjectStore[]> {
        const cacheKey = `os:stores:${orgId}:${envId}`;
        return this.cache.getOrCompute(cacheKey, async () => {
            const response = await this.http.get<{ values: ObjectStore[] }>(
                `${BASE}/organizations/${orgId}/environments/${envId}/stores`,
            );
            return response.values || [];
        });
    }

    /**
     * List keys in an Object Store
     */
    async listKeys(
        orgId: string,
        envId: string,
        storeId: string,
        options: { startKey?: string; limit?: number } = {},
    ): Promise<ObjectStoreKeysPage> {
        const params = new URLSearchParams();
        if (options.startKey) params.set('startKey', options.startKey);
        params.set('limit', String(options.limit || 25));

        return this.http.get<ObjectStoreKeysPage>(
            `${BASE}/organizations/${orgId}/environments/${envId}/stores/${encodeURIComponent(storeId)}/keys?${params.toString()}`,
        );
    }

    /**
     * Get a single value by key from an Object Store
     */
    async getValue(orgId: string, envId: string, storeId: string, key: string): Promise<ObjectStoreValue> {
        const response = await this.http.get<{ value: string; contentType?: string }>(
            `${BASE}/organizations/${orgId}/environments/${envId}/stores/${encodeURIComponent(storeId)}/keys/${encodeURIComponent(key)}`,
        );
        return {
            key,
            value: response.value,
            contentType: response.contentType,
        };
    }
}
