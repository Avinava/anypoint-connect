/**
 * Token Manager
 * Manages token lifecycle: storage, refresh, validation
 */

import type { TokenStore, AnypointTokens } from './TokenStore.js';
import { OAuthFlow } from './OAuthFlow.js';
import { FileStore } from './FileStore.js';

export interface TokenManagerConfig {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    baseUrl?: string;
    profileName?: string;
}

export interface AuthStatus {
    authenticated: boolean;
    expiresAt?: Date;
    isExpired?: boolean;
    canRefresh?: boolean;
}

export class TokenManager {
    private readonly config: TokenManagerConfig;
    private readonly oauthFlow: OAuthFlow;
    private store: TokenStore;
    private cachedTokens: AnypointTokens | null = null;
    private pendingState: string | null = null;

    constructor(config: TokenManagerConfig) {
        this.config = config;
        this.oauthFlow = new OAuthFlow({
            clientId: config.clientId,
            clientSecret: config.clientSecret,
            redirectUri: config.redirectUri,
            baseUrl: config.baseUrl,
        });
        this.store = new FileStore(config.profileName);
    }

    async getStatus(): Promise<AuthStatus> {
        const tokens = await this.getTokens();

        if (!tokens) {
            return { authenticated: false };
        }

        const now = Date.now();
        const isExpired = tokens.expiresAt < now;
        const canRefresh = !!tokens.refreshToken;

        return {
            authenticated: !isExpired || canRefresh,
            expiresAt: new Date(tokens.expiresAt),
            isExpired,
            canRefresh,
        };
    }

    /**
     * Get valid access token (refreshes if needed)
     */
    async getAccessToken(): Promise<string> {
        let tokens = await this.getTokens();

        if (!tokens) {
            throw new Error('Not authenticated. Run: anc auth login');
        }

        // Check if token is expired (with 5 minute buffer)
        const now = Date.now();
        const bufferMs = 5 * 60 * 1000;

        if (tokens.expiresAt < now + bufferMs) {
            if (!tokens.refreshToken) {
                throw new Error('Token expired and no refresh token. Run: anc auth login');
            }

            try {
                tokens = await this.oauthFlow.refreshToken(tokens.refreshToken);
            } catch {
                // Refresh failed — another process (e.g. CLI) may have already
                // rotated the refresh token. Reload from disk and retry once.
                this.cachedTokens = null;
                const reloaded = await this.store.load();
                if (reloaded?.refreshToken && reloaded.refreshToken !== tokens.refreshToken) {
                    // File has newer tokens; if the access token is still valid, use it
                    if (reloaded.expiresAt >= now + bufferMs) {
                        this.cachedTokens = reloaded;
                        return reloaded.accessToken;
                    }
                    // Access token also expired — try refreshing with the newer refresh token
                    tokens = await this.oauthFlow.refreshToken(reloaded.refreshToken);
                } else {
                    throw new Error('Token refresh failed. Run: anc auth login');
                }
            }
            await this.store.save(tokens);
            this.cachedTokens = tokens;
        }

        return tokens.accessToken;
    }

    getAuthorizeUrl(): string {
        const state = this.generateState();
        this.pendingState = state;
        return this.oauthFlow.getAuthorizeUrl(state);
    }

    /**
     * Perform full OAuth flow with browser
     */
    async authenticate(): Promise<AnypointTokens> {
        if (!this.pendingState) {
            throw new Error('Authentication was not initialized. Generate the authorization URL first.');
        }

        const redirectUrl = new URL(this.config.redirectUri);
        const hostname = this.getLoopbackHostname(redirectUrl);
        const port = parseInt(redirectUrl.port) || 3000;
        const callbackPath = redirectUrl.pathname;
        const expectedState = this.pendingState;

        try {
            // Start callback server first
            const callbackPromise = this.oauthFlow.waitForCallback(port, callbackPath, 120000, {
                expectedState,
                hostname,
            });

            // Wait for callback and exchange code
            const { code } = await callbackPromise;
            const tokens = await this.oauthFlow.exchangeCode(code);

            // Save tokens
            await this.store.save(tokens);
            this.cachedTokens = tokens;

            return tokens;
        } finally {
            this.pendingState = null;
        }
    }

    async refresh(): Promise<AnypointTokens> {
        const tokens = await this.getTokens();

        if (!tokens?.refreshToken) {
            throw new Error('No refresh token available');
        }

        const newTokens = await this.oauthFlow.refreshToken(tokens.refreshToken);
        await this.store.save(newTokens);
        this.cachedTokens = newTokens;

        return newTokens;
    }

    async logout(): Promise<void> {
        await this.store.clear();
        this.cachedTokens = null;
    }

    async setAccessToken(accessToken: string, expiresInSeconds: number = 3600): Promise<void> {
        const tokens: AnypointTokens = {
            accessToken,
            expiresAt: Date.now() + expiresInSeconds * 1000,
            expiresIn: expiresInSeconds,
            tokenType: 'Bearer',
        };
        await this.store.save(tokens);
        this.cachedTokens = tokens;
    }

    private async getTokens(): Promise<AnypointTokens | null> {
        if (this.cachedTokens) {
            return this.cachedTokens;
        }

        this.cachedTokens = await this.store.load();
        return this.cachedTokens;
    }

    private generateState(): string {
        return crypto.randomUUID();
    }

    private getLoopbackHostname(redirectUrl: URL): string {
        if (redirectUrl.protocol !== 'http:') {
            throw new Error('OAuth callback URL must use HTTP on a loopback host.');
        }

        const hostname = redirectUrl.hostname.replace(/^\[|\]$/g, '');
        if (!['localhost', '127.0.0.1', '::1'].includes(hostname)) {
            throw new Error('OAuth callback URL must use localhost, 127.0.0.1, or ::1.');
        }

        return hostname;
    }
}
