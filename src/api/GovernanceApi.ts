import type { HttpClient } from '../client/HttpClient.js';

const BASE = '/api/v1';

export interface GovernanceAssetCoordinates {
    groupId: string;
    assetId: string;
    version: string;
}

export interface GovernanceConformanceRequest {
    orgId: string;
    groupId: string;
    assetId: string;
    minorVersion: string;
    versions: string[];
}

export class GovernanceApi {
    constructor(private readonly http: HttpClient) {}

    private headers(orgId: string, ownerId: string) {
        return { 'x-organization-id': orgId, 'x-owner-id': ownerId };
    }

    async explainPublished(orgId: string, ownerId: string, coordinates: GovernanceAssetCoordinates): Promise<unknown> {
        const { groupId, assetId, version } = coordinates;
        return this.http.post(
            `${BASE}/plan/explain/${encodeURIComponent(groupId)}/${encodeURIComponent(assetId)}/${encodeURIComponent(version)}`,
            {},
            { headers: this.headers(orgId, ownerId) },
        );
    }

    async explainPlanned(
        orgId: string,
        ownerId: string,
        input: { groupId: string; assetId: string; filter?: string },
    ): Promise<unknown> {
        const query = new URLSearchParams({
            organization: orgId,
            groupId: input.groupId,
            assetId: input.assetId,
            filter: input.filter || '',
        });
        return this.http.post(
            `${BASE}/plan/explain/?${query.toString()}`,
            {},
            { headers: this.headers(orgId, ownerId) },
        );
    }

    async conformanceStatus(orgId: string, ownerId: string, request: GovernanceConformanceRequest): Promise<unknown> {
        return this.http.post(`${BASE}/conformance/status/`, request, { headers: this.headers(orgId, ownerId) });
    }
}
