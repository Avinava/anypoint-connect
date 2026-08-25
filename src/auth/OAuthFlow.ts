/**
 * OAuth Flow
 * Browser-based OAuth2 authorization code flow for Anypoint Platform
 */

import * as http from 'http';
import type { AnypointTokens } from './TokenStore.js';
import { OAUTH_CALLBACK_HEADERS, renderOAuthCallbackPage } from './OAuthCallbackPage.js';

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

export interface OAuthCallbackOptions {
    /** OAuth state generated with the authorization URL. */
    expectedState?: string;
    /** Loopback host to bind. Defaults to localhost for compatibility. */
    hostname?: string;
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
        timeoutMs: number = 120000,
        options: OAuthCallbackOptions = {},
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
                        res.writeHead(400, OAUTH_CALLBACK_HEADERS);
                        res.end(
                            renderOAuthCallbackPage({
                                status: 'error',
                                title: 'Authentication was not completed',
                                message: 'Anypoint Platform did not authorize this local session.',
                                detail: error_description || error,
                            }),
                        );
                        server.close();
                        reject(new Error(`OAuth error: ${error_description || error}`));
                        return;
                    }

                    if (!code || !state) {
                        res.writeHead(400, OAUTH_CALLBACK_HEADERS);
                        res.end(
                            renderOAuthCallbackPage({
                                status: 'error',
                                title: 'The callback was incomplete',
                                message: 'The authorization response did not contain both a code and state value.',
                                detail: 'Return to the terminal and start the login again if it does not continue.',
                            }),
                        );
                        return;
                    }

                    if (options.expectedState && state !== options.expectedState) {
                        res.writeHead(400, OAUTH_CALLBACK_HEADERS);
                        res.end(
                            renderOAuthCallbackPage({
                                status: 'error',
                                title: 'The callback could not be verified',
                                message: 'This response did not match the login request started by the CLI.',
                                detail: 'For your safety, no authorization code was accepted.',
                            }),
                        );
                        return;
                    }

                    res.writeHead(200, OAUTH_CALLBACK_HEADERS);
                    res.end(
                        renderOAuthCallbackPage({
                            status: 'success',
                            title: 'Authentication successful',
                            message: 'Anypoint Platform returned control to Anypoint Connect securely.',
                        }),
                    );
                    server.close();
                    resolve({ code, state });
                } else {
                    res.writeHead(404, OAUTH_CALLBACK_HEADERS);
                    res.end(
                        renderOAuthCallbackPage({
                            status: 'error',
                            title: 'Callback page not found',
                            message: 'This local server only accepts the configured OAuth callback path.',
                        }),
                    );
                }
            });

            server.listen(port, options.hostname || 'localhost', () => {
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

        const data = (await response.json()) as TokenResponse;

        return this.mapTokenResponse(data);
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

        const data = (await response.json()) as TokenResponse;

        return this.mapTokenResponse(data, refreshToken);
    }

    /**
     * Convert a raw OAuth token response to our internal AnypointTokens shape.
     * Falls back to the provided refreshToken when the response omits one (common on refresh).
     */
    private mapTokenResponse(data: TokenResponse, fallbackRefreshToken?: string): AnypointTokens {
        return {
            accessToken: data.access_token,
            refreshToken: data.refresh_token || fallbackRefreshToken,
            tokenType: data.token_type || 'Bearer',
            expiresIn: data.expires_in || 3600,
            expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
            scope: data.scope,
        };
    }
}
