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

        it('should reject a mismatched state and continue waiting for the valid callback', async () => {
            const flow = new OAuthFlow(config);
            const port = 5456 + Math.floor(Math.random() * 1000);

            const callbackPromise = flow.waitForCallback(port, '/api/callback', 5000, {
                expectedState: 'expected-state',
            });

            const mismatchedResponsePromise = new Promise<Response>((resolve, reject) => {
                setTimeout(() => {
                    fetch(`http://localhost:${port}/api/callback?code=wrong-code&state=wrong-state`)
                        .then(resolve)
                        .catch(reject);
                }, 100);
            });

            const validResponsePromise = new Promise<Response>((resolve, reject) => {
                setTimeout(() => {
                    fetch(`http://localhost:${port}/api/callback?code=valid-code&state=expected-state`)
                        .then(resolve)
                        .catch(reject);
                }, 200);
            });

            const [result, mismatchedResponse, validResponse] = await Promise.all([
                callbackPromise,
                mismatchedResponsePromise,
                validResponsePromise,
            ]);

            expect(mismatchedResponse.status).toBe(400);
            expect(await mismatchedResponse.text()).toContain('could not be verified');
            expect(validResponse.status).toBe(200);
            expect(result).toEqual({ code: 'valid-code', state: 'expected-state' });
        });

        it('should return escaped HTML and security headers for provider errors', async () => {
            const flow = new OAuthFlow(config);
            const port = 6456 + Math.floor(Math.random() * 1000);
            const callbackPromise = flow.waitForCallback(port, '/api/callback', 5000);
            const responsePromise = new Promise<Response>((resolve, reject) => {
                setTimeout(() => {
                    fetch(
                        `http://localhost:${port}/api/callback?error=access_denied&error_description=${encodeURIComponent('<script>alert(1)</script>')}`,
                    )
                        .then(resolve)
                        .catch(reject);
                }, 100);
            });

            await expect(callbackPromise).rejects.toThrow('OAuth error');
            const response = await responsePromise;
            const body = await response.text();

            expect(response.status).toBe(400);
            expect(response.headers.get('cache-control')).toBe('no-store');
            expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
            expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
            expect(body).not.toContain('<script>alert(1)</script>');
        });

        it('should timeout after specified duration', async () => {
            const flow = new OAuthFlow(config);
            const port = 4456 + Math.floor(Math.random() * 1000);

            await expect(flow.waitForCallback(port, '/api/callback', 500)).rejects.toThrow('timed out');
        });
    });
});
