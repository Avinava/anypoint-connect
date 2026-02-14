/**
 * Tests for OAuthFlow
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { OAuthFlow } from '../../src/auth/OAuthFlow.js';

describe('OAuthFlow', () => {
    const config = {
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        redirectUri: 'http://localhost:3000/api/callback',
    };

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('getAuthorizeUrl', () => {
        it('should generate correct authorization URL', () => {
            const flow = new OAuthFlow(config);
            const url = flow.getAuthorizeUrl('random-state');

            expect(url).toContain('https://anypoint.mulesoft.com/accounts/api/v2/oauth2/authorize');
            expect(url).toContain('client_id=test-client-id');
            expect(url).toContain('redirect_uri=');
            expect(url).toContain('response_type=code');
            expect(url).toContain('scope=full+offline_access');
            expect(url).toContain('state=random-state');
        });

        it('should use custom base URL when provided', () => {
            const flow = new OAuthFlow({
                ...config,
                baseUrl: 'https://eu1.anypoint.mulesoft.com',
            });
            const url = flow.getAuthorizeUrl('state');

            expect(url).toContain('https://eu1.anypoint.mulesoft.com');
        });

        it('should encode redirect URI', () => {
            const flow = new OAuthFlow(config);
            const url = flow.getAuthorizeUrl('state');

            expect(url).toContain('redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fapi%2Fcallback');
        });
    });

    describe('waitForCallback', () => {
        it('should start a server on the specified port', async () => {
            const flow = new OAuthFlow(config);
            const port = 3456 + Math.floor(Math.random() * 1000);

            const callbackPromise = flow.waitForCallback(port, '/api/callback', 5000);

            // Simulate a callback
            setTimeout(async () => {
                try {
                    await fetch(`http://localhost:${port}/api/callback?code=test-code&state=test-state`);
                } catch {
                    // fetch may fail after server closes, that's ok
                }
            }, 100);

            const result = await callbackPromise;
            expect(result.code).toBe('test-code');
            expect(result.state).toBe('test-state');
        });

        it('should timeout after specified duration', async () => {
            const flow = new OAuthFlow(config);
            const port = 4456 + Math.floor(Math.random() * 1000);

            await expect(
                flow.waitForCallback(port, '/api/callback', 500)
            ).rejects.toThrow('timed out');
        });
    });
});
