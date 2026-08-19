import { describe, expect, it, vi } from 'vitest';
import { GovernanceApi } from '../../src/api/GovernanceApi.js';

describe('GovernanceApi', () => {
    it('uses documented read-oriented explain and conformance POSTs', async () => {
        const post = vi.fn().mockResolvedValue({ ok: true });
        const api = new GovernanceApi({ post } as any);
        await api.explainPublished('org-1', 'owner-1', { groupId: 'group-1', assetId: 'asset-1', version: '1.0.0' });
        await api.conformanceStatus('org-1', 'owner-1', {
            orgId: 'org-1',
            groupId: 'group-1',
            assetId: 'asset-1',
            minorVersion: '1.0',
            versions: ['1.0.0'],
        });
        expect(post.mock.calls[0][0]).toBe('/api/v1/plan/explain/group-1/asset-1/1.0.0');
        expect(post.mock.calls[1][0]).toBe('/api/v1/conformance/status/');
        expect(post.mock.calls[1][2].headers).toEqual({
            'x-organization-id': 'org-1',
            'x-owner-id': 'owner-1',
        });
    });
});
