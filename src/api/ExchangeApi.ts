/**
 * Exchange API
 * Asset discovery, search, and spec download via Anypoint Exchange v2
 */

import type { HttpClient } from '../client/HttpClient.js';
import type { Cache } from '../client/Cache.js';

export interface ExchangeAsset {
    groupId: string;
    assetId: string;
    version: string;
    name: string;
    type: string;
    description?: string;
    status?: string;
    rating?: number;
    numberOfRates?: number;
    createdAt?: string;
    modifiedAt?: string;
    labels?: string[];
    categories?: Array<{ key: string; value: string }>;
    files?: Array<{
        classifier: string;
        packaging: string;
        externalLink?: string;
        downloadURL?: string;
        mainFile?: string;
        md5?: string;
    }>;
    organization?: {
        id: string;
        name: string;
    };
}

export interface ExchangeAssetDetail extends ExchangeAsset {
    contactName?: string;
    contactEmail?: string;
    dependencies?: Array<{ groupId: string; assetId: string; version: string }>;
    versions?: Array<{ version: string; status: string }>;
    instances?: Array<{
        id: string;
        name: string;
        environmentId?: string;
        endpointUri?: string;
    }>;
}

export interface ExchangeSearchOptions {
    search?: string;
    type?: string;       // 'rest-api' | 'soap-api' | 'http-api' | 'app' | 'connector' | 'template' | 'example' | 'policy'
    limit?: number;
    offset?: number;
    organizationId?: string;
}

const BASE = '/exchange/api/v2';

export class ExchangeApi {
    constructor(
        private readonly http: HttpClient,
        private readonly cache: Cache
    ) { }

    /**
     * Search assets in Exchange
     */
    async searchAssets(
        orgId: string,
        options: ExchangeSearchOptions = {}
    ): Promise<ExchangeAsset[]> {
        const params = new URLSearchParams();
        params.set('organizationId', orgId);
        if (options.search) params.set('search', options.search);
        if (options.type) params.set('type', options.type);
        params.set('limit', String(options.limit || 20));
        if (options.offset) params.set('offset', String(options.offset));

        return this.http.get<ExchangeAsset[]>(
            `${BASE}/assets?${params.toString()}`
        );
    }

    /**
     * Get detailed asset info
     */
    async getAsset(
        groupId: string,
        assetId: string,
        version?: string
    ): Promise<ExchangeAssetDetail> {
        const cacheKey = `exchange:${groupId}:${assetId}:${version || 'latest'}`;
        return this.cache.getOrCompute(cacheKey, async () => {
            const path = version
                ? `${BASE}/assets/${groupId}/${assetId}/${version}`
                : `${BASE}/assets/${groupId}/${assetId}`;
            return this.http.get<ExchangeAssetDetail>(path);
        });
    }

    /**
     * Get all versions of an asset
     */
    async getAssetVersions(
        groupId: string,
        assetId: string
    ): Promise<Array<{ version: string; status: string }>> {
        const detail = await this.getAsset(groupId, assetId);
        return detail.versions || [];
    }

    /**
     * Download an API spec file (RAML / OAS) for an asset version.
     * Returns the spec content as a string.
     */
    async downloadSpec(
        groupId: string,
        assetId: string,
        version?: string
    ): Promise<{ content: string; classifier: string; fileName: string }> {
        const detail = await this.getAsset(groupId, assetId, version);

        // Find the spec file
        const specFile = detail.files?.find(
            (f) =>
                f.classifier === 'raml' ||
                f.classifier === 'oas' ||
                f.classifier === 'oas3' ||
                f.classifier === 'fat-raml' ||
                f.classifier === 'fat-oas' ||
                f.classifier === 'wsdl'
        );

        if (!specFile) {
            throw new Error(
                `No API spec found for ${groupId}/${assetId}. Asset type: ${detail.type}. ` +
                `Available files: ${(detail.files || []).map((f) => f.classifier).join(', ') || 'none'}`
            );
        }

        const downloadUrl =
            specFile.downloadURL ||
            `${BASE}/assets/${groupId}/${assetId}/${version || detail.version}/files/${specFile.classifier}`;

        const buffer = await this.http.download(downloadUrl);
        return {
            content: buffer.toString('utf-8'),
            classifier: specFile.classifier,
            fileName: specFile.mainFile || `${assetId}.${specFile.classifier}`,
        };
    }
}
