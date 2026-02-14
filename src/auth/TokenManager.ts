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

    constructor(config: TokenManagerConfig) {
        this.config = config;
        this.oauthFlow = new OAuthFlow({
            clientId: config.clientId,
            clientSecret: config.clientSecret,
            redirectUri: config.redirectUri,
            baseUrl: config.baseUrl,
        });
        this.store = new FileStore();
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

            tokens = await this.oauthFlow.refreshToken(tokens.refreshToken);
            await this.store.save(tokens);
            this.cachedTokens = tokens;
        }

        return tokens.accessToken;
    }

    getAuthorizeUrl(): string {
        const state = this.generateState();
        return this.oauthFlow.getAuthorizeUrl(state);
    }

    /**
     * Perform full OAuth flow with browser
     */
    async authenticate(): Promise<AnypointTokens> {
        const redirectUrl = new URL(this.config.redirectUri);
        const port = parseInt(redirectUrl.port) || 3000;
        const callbackPath = redirectUrl.pathname;

        // Start callback server first
        const callbackPromise = this.oauthFlow.waitForCallback(port, callbackPath);

        // Wait for callback and exchange code
        const { code } = await callbackPromise;
        const tokens = await this.oauthFlow.exchangeCode(code);

        // Save tokens
        await this.store.save(tokens);
        this.cachedTokens = tokens;

        return tokens;
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
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let result = '';
        for (let i = 0; i < 32; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return result;
    }
}
