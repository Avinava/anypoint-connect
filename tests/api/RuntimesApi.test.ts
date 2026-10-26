import { describe, expect, it, vi } from 'vitest';
import { Cache } from '../../src/client/Cache.js';
import { RuntimesApi, normalizeRuntimeVersion, normalizeTarget } from '../../src/api/RuntimesApi.js';

describe('RuntimesApi', () => {
    it('normalizes the version shapes targets return', () => {
        expect(
            normalizeRuntimeVersion({ baseVersion: '4.9.0', tag: 'v1', releaseChannel: 'LTS', javaVersions: ['17'] }),
        ).toEqual({
            version: '4.9.0',
            tag: 'v1',
            releaseChannel: 'LTS',
            java: ['17'],
        });
        expect(normalizeRuntimeVersion({ version: '4.8.5:4e-java8' })).toEqual({ version: '4.8.5', java: ['8'] });
        expect(normalizeRuntimeVersion({ version: 'latest' })).toBeNull();
    });

    it('keeps only Mule runtimes of a target', () => {
        const target = normalizeTarget({
            id: 'cloudhub-us-east-2',
            runtimes: [
                { type: 'mule', versions: [{ baseVersion: '4.9.0' }] },
                { type: 'other', versions: [{ baseVersion: '9.9.9' }] },
            ],
        });
        expect(target.runtimes.map((v) => v.version)).toEqual(['4.9.0']);
    });

    it('reads the organization targets once and finds one by ID', async () => {
        const http = {
            get: vi.fn().mockResolvedValue({
                items: [
                    { id: 'cloudhub-us-east-2', runtimes: [{ type: 'mule', versions: [{ baseVersion: '4.9.0' }] }] },
                ],
            }),
        };
        const api = new RuntimesApi(http as any, new Cache());
        expect((await api.getTarget('org-1', 'cloudhub-us-east-2'))?.runtimes).toHaveLength(1);
        expect(await api.getTarget('org-1', 'missing')).toBeNull();
        expect(http.get).toHaveBeenCalledTimes(1);
        expect(http.get).toHaveBeenCalledWith('/runtimefabric/api/organizations/org-1/targets');
    });
});
