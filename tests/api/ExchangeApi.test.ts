/**
 * Tests for ExchangeApi
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import { createHash } from 'node:crypto';
import * as os from 'os';
import * as path from 'path';
import { ExchangeApi } from '../../src/api/ExchangeApi.js';
import { Cache } from '../../src/client/Cache.js';

const mockGet = vi.fn();
const mockPostMultipart = vi.fn();
const mockDownload = vi.fn();
const mockHttp = { get: mockGet, postMultipart: mockPostMultipart, download: mockDownload } as any;

describe('ExchangeApi.publishAppAsset', () => {
    let api: ExchangeApi;
    let jarPath: string;

    beforeEach(() => {
        vi.resetAllMocks();
        api = new ExchangeApi(mockHttp, new Cache());
        jarPath = path.join(os.tmpdir(), `anc-test-${process.pid}.jar`);
        fs.writeFileSync(jarPath, Buffer.from('PK fake jar bytes'));
    });

    afterEach(() => {
        if (fs.existsSync(jarPath)) fs.unlinkSync(jarPath);
    });

    it('POSTs multipart to the v2 publication endpoint with the sync header and a timeout', async () => {
        mockPostMultipart.mockResolvedValue({});

        const result = await api.publishAppAsset('org-1', 'grp-1', 'my-app', '1.0.0', jarPath);

        expect(mockPostMultipart).toHaveBeenCalledWith(
            '/exchange/api/v2/organizations/org-1/assets/grp-1/my-app/1.0.0',
            expect.any(FormData),
            expect.objectContaining({
                headers: expect.objectContaining({ 'x-sync-publication': 'true' }),
                timeout: expect.any(Number),
            }),
        );
        expect(result).toEqual({
            groupId: 'grp-1',
            assetId: 'my-app',
            version: '1.0.0',
            classifier: 'mule-application',
            fileName: path.basename(jarPath),
        });
    });

    it('rejects changed upload bytes before creating a multipart request', async () => {
        await expect(
            api.publishAppAsset('sample-org', 'sample-group', 'sample', '1.0.0', jarPath, '0'.repeat(64)),
        ).rejects.toThrow('digest changed');
        expect(mockPostMultipart).not.toHaveBeenCalled();
    });

    it('uploads precisely the buffer covered by the reviewed SHA-256', async () => {
        const bytes = fs.readFileSync(jarPath);
        const digest = createHash('sha256').update(bytes).digest('hex');
        await api.publishAppAsset('sample-org', 'sample-group', 'sample', '1.0.0', jarPath, digest);
        const form: FormData = mockPostMultipart.mock.calls[0][1];
        const uploaded = form.get('files.mule-application.jar') as Blob;
        expect(Buffer.from(await uploaded.arrayBuffer())).toEqual(bytes);
    });

    it('builds a multipart body with name, classifier, and the jar file part', async () => {
        mockPostMultipart.mockResolvedValue({});
        await api.publishAppAsset('org-1', 'grp-1', 'my-app', '1.0.0', jarPath);

        const form: FormData = mockPostMultipart.mock.calls[0][1];
        expect(form.get('name')).toBe('my-app');
        expect(form.get('classifier')).toBe('mule-application');
        expect(form.get('files.mule-application.jar')).toBeInstanceOf(Blob);
    });
});

describe('ExchangeApi.downloadAppJar', () => {
    let api: ExchangeApi;
    const jar = Buffer.from('PK jar bytes');
    const asset = (files: unknown[]) => ({ groupId: 'org-1', assetId: 'orders-sapi', version: '1.0.0', files });

    beforeEach(() => {
        vi.resetAllMocks();
        api = new ExchangeApi(mockHttp, new Cache());
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('reads the asset metadata and downloads the mule-application jar with a size bound', async () => {
        mockGet.mockResolvedValue(
            asset([
                { classifier: 'raml', packaging: 'zip', externalLink: '/spec' },
                {
                    classifier: 'mule-application',
                    packaging: 'jar',
                    externalLink: '/exchange/api/v2/assets/org-1/orders-sapi/1.0.0/files/jar',
                    md5: createHash('md5').update(jar).digest('hex'),
                },
            ]),
        );
        mockDownload.mockResolvedValue(jar);

        const result = await api.downloadAppJar('org-1', 'org-1', 'orders-sapi', '1.0.0', { maxBytes: 1024 });

        expect(mockGet).toHaveBeenCalledWith('/exchange/api/v2/assets/org-1/orders-sapi/1.0.0');
        expect(mockDownload).toHaveBeenCalledWith(
            '/exchange/api/v2/assets/org-1/orders-sapi/1.0.0/files/jar',
            expect.objectContaining({ maxContentLength: 1024 }),
        );
        expect(result).toMatchObject({
            sha256: createHash('sha256').update(jar).digest('hex'),
            md5Matches: true,
            fileName: 'orders-sapi-1.0.0-mule-application.jar',
        });
    });

    it('fetches a link on another host without the platform token', async () => {
        const axios = (await import('axios')).default;
        const plainGet = vi.spyOn(axios, 'get').mockResolvedValue({ data: jar });
        mockGet.mockResolvedValue(
            asset([
                { classifier: 'mule-application', packaging: 'jar', downloadURL: 'https://storage.example.com/x.jar' },
            ]),
        );

        await api.downloadAppJar('org-1', 'org-1', 'orders-sapi', '1.0.0');

        expect(plainGet).toHaveBeenCalledWith(
            'https://storage.example.com/x.jar',
            expect.objectContaining({ responseType: 'arraybuffer' }),
        );
        expect(mockDownload).not.toHaveBeenCalled();
    });

    it('refuses a jar over the size bound and reports missing jars', async () => {
        mockGet.mockResolvedValue(asset([{ classifier: 'mule-application', packaging: 'jar', externalLink: '/f' }]));
        mockDownload.mockResolvedValue(Buffer.alloc(2048));
        await expect(api.downloadAppJar('org-1', 'org-1', 'orders-sapi', '1.0.0', { maxBytes: 1024 })).rejects.toThrow(
            'exceeds 1024 bytes',
        );

        const other = new ExchangeApi(mockHttp, new Cache());
        mockGet.mockResolvedValue(asset([{ classifier: 'raml', packaging: 'zip' }]));
        await expect(other.downloadAppJar('org-1', 'org-1', 'orders-sapi', '1.0.0')).rejects.toThrow(
            'No mule-application jar',
        );
    });
});
