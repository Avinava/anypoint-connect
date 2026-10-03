import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenManager } from '../../src/auth/TokenManager.js';

describe('TokenManager authentication initialization', () => {
    let home: string;
    beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), 'auth-test-home-'));
        vi.stubEnv('HOME', home);
    });
    afterEach(() => {
        vi.unstubAllEnvs();
        rmSync(home, { recursive: true, force: true });
    });
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
