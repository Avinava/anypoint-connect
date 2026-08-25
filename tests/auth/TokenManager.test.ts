import { describe, expect, it } from 'vitest';
import { TokenManager } from '../../src/auth/TokenManager.js';

describe('TokenManager authentication initialization', () => {
    const baseConfig = {
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        redirectUri: 'http://localhost:3000/api/callback',
    };

    it('requires an authorization URL before waiting for a callback', async () => {
        const manager = new TokenManager(baseConfig);

        await expect(manager.authenticate()).rejects.toThrow('Generate the authorization URL first');
    });

    it('rejects non-loopback callback URLs before opening a server', async () => {
        const manager = new TokenManager({
            ...baseConfig,
            redirectUri: 'https://example.invalid/api/callback',
        });
        manager.getAuthorizeUrl();

        await expect(manager.authenticate()).rejects.toThrow('must use HTTP on a loopback host');
    });
});
