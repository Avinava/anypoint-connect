import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BearerProvider } from '../../src/auth/BearerProvider.js';
import { ClientCredentialsProvider } from '../../src/auth/ClientCredentialsProvider.js';

/** A real local token endpoint, so the provider's actual HTTP request is exercised. */
function tokenServer(respond: (call: number, body: URLSearchParams) => { status: number; json: unknown }) {
    const bodies: URLSearchParams[] = [];
    const server: Server = createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', () => {
            const body = new URLSearchParams(raw);
            bodies.push(body);
            const { status, json } = respond(bodies.length, body);
            // Slow enough that concurrent callers overlap.
            setTimeout(() => {
                res.writeHead(status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(json));
            }, 20);
        });
    });
    return new Promise<{ baseUrl: string; bodies: URLSearchParams[]; close: () => void }>((resolve) =>
        server.listen(0, '127.0.0.1', () =>
            resolve({
                baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
                bodies,
                close: () => server.close(),
            }),
        ),
    );
}

describe('ClientCredentialsProvider', () => {
    let home: string;
    beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), 'cc-home-'));
        vi.stubEnv('HOME', home);
    });
    afterEach(() => {
        vi.unstubAllEnvs();
        rmSync(home, { recursive: true, force: true });
    });

    it('exchanges client credentials once for concurrent callers and writes nothing to disk', async () => {
        const server = await tokenServer(() => ({ status: 200, json: { access_token: 'tok-1', expires_in: 3600 } }));
        const provider = new ClientCredentialsProvider({
            clientId: 'id',
            clientSecret: 's3cret',
            baseUrl: server.baseUrl,
        });
        const tokens = await Promise.all([
            provider.getAccessToken(),
            provider.getAccessToken(),
            provider.getAccessToken(),
        ]);
        expect(tokens).toEqual(['tok-1', 'tok-1', 'tok-1']);
        expect(server.bodies).toHaveLength(1);
        expect(server.bodies[0].get('grant_type')).toBe('client_credentials');
        expect(server.bodies[0].get('client_id')).toBe('id');
        await provider.getAccessToken();
        expect(server.bodies).toHaveLength(1); // cached
        expect(readdirSync(home)).toEqual([]);
        server.close();
    });

    it('renews a token that is about to expire', async () => {
        const server = await tokenServer((call) => ({
            status: 200,
            json: { access_token: `tok-${call}`, expires_in: 30 }, // inside the renewal window
        }));
        const provider = new ClientCredentialsProvider({ clientId: 'id', clientSecret: 's', baseUrl: server.baseUrl });
        expect(await provider.getAccessToken()).toBe('tok-1');
        expect(await provider.getAccessToken()).toBe('tok-2');
        server.close();
    });

    it('treats a missing expires_in as a short lifetime, not an hour', async () => {
        const server = await tokenServer((call) => ({ status: 200, json: { access_token: `tok-${call}` } }));
        const provider = new ClientCredentialsProvider({ clientId: 'id', clientSecret: 's', baseUrl: server.baseUrl });
        await provider.getAccessToken();
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(Date.now() + 560_000); // 600s lifetime, 60s renewal window
        expect(await provider.getAccessToken()).toBe('tok-2');
        vi.useRealTimers();
        server.close();
    });

    it('fails with the HTTP status and platform error, never the secret, and retries on the next call', async () => {
        const server = await tokenServer((call) =>
            call === 1
                ? { status: 401, json: { error: 'invalid_client', error_description: 'bad credentials' } }
                : { status: 200, json: { access_token: 'tok-ok', expires_in: 3600 } },
        );
        const provider = new ClientCredentialsProvider({
            clientId: 'id',
            clientSecret: 'TOPSECRET',
            baseUrl: server.baseUrl,
        });
        const error = await provider.getAccessToken().catch((e: Error) => e);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('HTTP 401');
        expect((error as Error).message).toContain('invalid_client');
        expect((error as Error).message).not.toContain('TOPSECRET');
        expect(await provider.getAccessToken()).toBe('tok-ok');
        server.close();
    });

    it('requires a client ID and secret', () => {
        expect(() => new ClientCredentialsProvider({ clientId: '', clientSecret: '' })).toThrow('client ID and secret');
    });
});

describe('BearerProvider', () => {
    it('returns the supplied token and rejects a missing one', async () => {
        expect(await new BearerProvider(' abc ').getAccessToken()).toBe('abc');
        expect(() => new BearerProvider(undefined)).toThrow('ANYPOINT_ACCESS_TOKEN');
        expect(() => new BearerProvider('  ')).toThrow('ANYPOINT_ACCESS_TOKEN');
    });
});
