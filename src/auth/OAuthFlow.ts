/**
 * OAuth Flow
 * Browser-based OAuth2 authorization code flow for Anypoint Platform
 */

import * as http from 'http';
import type { AnypointTokens } from './TokenStore.js';

interface TokenResponse {
    access_token: string;
    refresh_token?: string;
    token_type?: string;
    expires_in?: number;
    scope?: string;
}

const DEFAULT_BASE_URL = 'https://anypoint.mulesoft.com';

export interface OAuthConfig {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    baseUrl?: string;
}

export class OAuthFlow {
    private readonly config: OAuthConfig;
    private readonly baseUrl: string;

    constructor(config: OAuthConfig) {
        this.config = config;
        this.baseUrl = config.baseUrl || DEFAULT_BASE_URL;
    }

    /**
     * Get the authorization URL to open in browser
     */
    getAuthorizeUrl(state: string): string {
        const params = new URLSearchParams({
            client_id: this.config.clientId,
            redirect_uri: this.config.redirectUri,
            response_type: 'code',
            scope: 'full offline_access',
            state,
        });

        return `${this.baseUrl}/accounts/api/v2/oauth2/authorize?${params.toString()}`;
    }

    /**
     * Start local callback server and wait for authorization code
     */
    async waitForCallback(
        port: number = 3000,
        callbackPath: string = '/api/callback',
        timeoutMs: number = 120000
    ): Promise<{ code: string; state: string }> {
        return new Promise((resolve, reject) => {
            const server = http.createServer((req, res) => {
                const parsedUrl = new URL(req.url || '', `http://localhost`);

                if (parsedUrl.pathname === callbackPath) {
                    const code = parsedUrl.searchParams.get('code');
                    const state = parsedUrl.searchParams.get('state');
                    const error = parsedUrl.searchParams.get('error');
                    const error_description = parsedUrl.searchParams.get('error_description');

                    if (error) {
                        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                        res.end(`
              <html>
                <head><meta charset="utf-8"></head>
                <body style="font-family: system-ui; padding: 40px; text-align: center; background: #1a1a2e; color: #e0e0e0;">
                  <h1 style="color: #ff6b6b;">❌ Authentication Failed</h1>
                  <p>${error_description || error}</p>
                  <p style="color: #888;">You can close this window.</p>
                </body>
              </html>
            `);
                        server.close();
                        reject(new Error(`OAuth error: ${error_description || error}`));
                        return;
                    }

                    if (code && state) {
                        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                        res.end(`
              <html>
                <head><meta charset="utf-8"></head>
                <body style="font-family: system-ui; padding: 40px; text-align: center; background: #1a1a2e; color: #e0e0e0;">
                  <h1 style="color: #4ecdc4;">✅ Authentication Successful!</h1>
                  <p>You can close this window and return to the terminal.</p>
                  <script>setTimeout(() => window.close(), 2000);</script>
                </body>
              </html>
            `);
                        server.close();
                        resolve({ code: code as string, state: state as string });
                    } else {
                        res.writeHead(400, { 'Content-Type': 'text/plain' });
                        res.end('Missing code or state');
                    }
                } else {
                    res.writeHead(404, { 'Content-Type': 'text/plain' });
                    res.end('Not found');
                }
            });

            server.listen(port, () => {
                // Server started, waiting for callback
            });

            const timeout = setTimeout(() => {
                server.close();
                reject(new Error('Authentication timed out (2 minutes)'));
            }, timeoutMs);

            server.on('close', () => clearTimeout(timeout));
            server.on('error', (err) => {
                clearTimeout(timeout);
                reject(err);
            });
        });
    }

    /**
     * Exchange authorization code for tokens
     */
    async exchangeCode(code: string): Promise<AnypointTokens> {
        const tokenUrl = `${this.baseUrl}/accounts/api/v2/oauth2/token`;

        const body = new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: this.config.clientId,
            client_secret: this.config.clientSecret,
            redirect_uri: this.config.redirectUri,
            code,
        });

        const response = await fetch(tokenUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString(),
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Token exchange failed: ${error}`);
        }

        const data = await response.json() as TokenResponse;

        return {
            accessToken: data.access_token,
            refreshToken: data.refresh_token,
            tokenType: data.token_type || 'Bearer',
            expiresIn: data.expires_in || 3600,
            expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
            scope: data.scope,
        };
    }

    /**
     * Refresh an expired access token
     */
    async refreshToken(refreshToken: string): Promise<AnypointTokens> {
        const tokenUrl = `${this.baseUrl}/accounts/api/v2/oauth2/token`;

        const body = new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: this.config.clientId,
            client_secret: this.config.clientSecret,
            refresh_token: refreshToken,
        });

        const response = await fetch(tokenUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString(),
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Token refresh failed: ${error}`);
        }

        const data = await response.json() as TokenResponse;

        return {
            accessToken: data.access_token,
            refreshToken: data.refresh_token || refreshToken,
            tokenType: data.token_type || 'Bearer',
            expiresIn: data.expires_in || 3600,
            expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
            scope: data.scope,
        };
    }
}
