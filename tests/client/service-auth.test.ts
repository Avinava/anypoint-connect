import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnypointClient } from '../../src/client/AnypointClient.js';

interface Seen {
    method?: string;
    url?: string;
    authorization?: string;
}

/** A local platform: token endpoint, environments, and a /me that must never be called in service modes. */
function platform(options: { rejectApi?: boolean } = {}) {
    const seen: Seen[] = [];
    const server: Server = createServer((req, res) => {
        seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/accounts/api/v2/oauth2/token') {
            res.end(JSON.stringify({ access_token: 'svc-token', expires_in: 3600 }));
        } else if (options.rejectApi) {
            res.writeHead(401).end(JSON.stringify({ message: 'nope' }));
        } else if (req.url === '/accounts/api/organizations/org-1/environments') {
            res.end(JSON.stringify({ data: [{ id: 'env-1', name: 'Sandbox', isProduction: false }] }));
        } else {
            res.writeHead(404).end('{}');
        }
    });
    return new Promise<{ baseUrl: string; seen: Seen[]; close: () => void }>((resolve) =>
        server.listen(0, '127.0.0.1', () =>
            resolve({
                baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
                seen,
                close: () => server.close(),
            }),
        ),
    );
}

describe('service authentication end to end', () => {
    let home: string;
    beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), 'svc-home-'));
        vi.stubEnv('HOME', home);
    });
    afterEach(() => {
        vi.unstubAllEnvs();
        rmSync(home, { recursive: true, force: true });
    });

    it('lists environments with client credentials, never calls /me, and writes no token file', async () => {
        const server = await platform();
        const client = new AnypointClient({
            clientId: 'id',
            clientSecret: 's',
            baseUrl: server.baseUrl,
            authMode: 'client_credentials',
            orgId: 'org-1',
        });
        const orgId = await client.getDefaultOrgId();
        const envs = await client.accessManagement.getEnvironments(orgId);
        expect(envs.map((e) => e.name)).toEqual(['Sandbox']);
        expect(server.seen.map((s) => s.url)).toEqual([
            '/accounts/api/v2/oauth2/token',
            '/accounts/api/organizations/org-1/environments',
        ]);
        expect(server.seen[1].authorization).toBe('Bearer svc-token');
        expect(readdirSync(home)).toEqual([]);
        server.close();
    });

    it('uses a supplied bearer token as is, with no token exchange', async () => {
        const server = await platform();
        const client = new AnypointClient({
            clientId: '',
            clientSecret: '',
            baseUrl: server.baseUrl,
            authMode: 'bearer',
            accessToken: 'given-token',
            orgId: 'org-1',
        });
        await client.accessManagement.getEnvironments(await client.getDefaultOrgId());
        expect(server.seen).toHaveLength(1);
        expect(server.seen[0].authorization).toBe('Bearer given-token');
        server.close();
    });

    it('explains a rejected bearer token instead of a bare 401', async () => {
        const server = await platform({ rejectApi: true });
        const client = new AnypointClient({
            clientId: '',
            clientSecret: '',
            baseUrl: server.baseUrl,
            authMode: 'bearer',
            accessToken: 'stale',
            orgId: 'org-1',
        });
        await expect(client.accessManagement.getEnvironments('org-1')).rejects.toThrow('bearer token was rejected');
        server.close();
    });

    it('refuses without an organization, before any request', () => {
        expect(() => new AnypointClient({ clientId: 'id', clientSecret: 's', authMode: 'client_credentials' })).toThrow(
            'explicit organization',
        );
    });

    it('has no browser login or user profile in service modes', async () => {
        const client = new AnypointClient({
            clientId: 'id',
            clientSecret: 's',
            authMode: 'client_credentials',
            orgId: 'org-1',
        });
        expect(() => client.getAuthorizeUrl()).toThrow('no browser login');
        await expect(client.whoami()).rejects.toThrow('not available with client_credentials');
        await expect(client.logout()).rejects.toThrow('no browser login');
    });

    it('keeps the human login unchanged: the configured org wins, else whoami once', async () => {
        const human = new AnypointClient({ clientId: 'id', clientSecret: 's' });
        const whoami = vi
            .spyOn(human.accessManagement, 'getMe')
            .mockResolvedValue({ organization: { id: 'org-user' } } as never);
        expect(await human.getDefaultOrgId()).toBe('org-user');
        expect(await human.getDefaultOrgId()).toBe('org-user');
        expect(whoami).toHaveBeenCalledTimes(1);
        const explicit = new AnypointClient({ clientId: 'id', clientSecret: 's', orgId: 'org-chosen' });
        expect(await explicit.getDefaultOrgId()).toBe('org-chosen');
    });
});
