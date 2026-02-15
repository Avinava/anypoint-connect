/**
 * Anypoint Client
 * Main facade providing unified access to all Anypoint APIs
 */

import { TokenManager, type AuthStatus } from '../auth/index.js';
import { HttpClient } from './HttpClient.js';
import { Cache } from './Cache.js';
import { AccessManagementApi, type UserProfile } from '../api/AccessManagementApi.js';
import { CloudHub2Api } from '../api/CloudHub2Api.js';
import { LogsApi } from '../api/LogsApi.js';
import { MonitoringApi } from '../api/MonitoringApi.js';
import { ExchangeApi } from '../api/ExchangeApi.js';
import { ApiManagerApi } from '../api/ApiManagerApi.js';
import { DesignCenterApi } from '../api/DesignCenterApi.js';
import { DEFAULT_CALLBACK_URL } from '../utils/config.js';

export interface AnypointClientConfig {
    clientId: string;
    clientSecret: string;
    redirectUri?: string;
    baseUrl?: string;
    cacheTtlMinutes?: number;
}

export class AnypointClient {
    private readonly tokenManager: TokenManager;
    private readonly httpClient: HttpClient;
    private readonly cache: Cache;

    // API clients
    public readonly accessManagement: AccessManagementApi;
    public readonly cloudHub2: CloudHub2Api;
    public readonly logs: LogsApi;
    public readonly monitoring: MonitoringApi;
    public readonly exchange: ExchangeApi;
    public readonly apiManager: ApiManagerApi;
    public readonly designCenter: DesignCenterApi;

    constructor(config: AnypointClientConfig) {
        this.tokenManager = new TokenManager({
            clientId: config.clientId,
            clientSecret: config.clientSecret,
            redirectUri: config.redirectUri || DEFAULT_CALLBACK_URL,
            baseUrl: config.baseUrl,
        });

        this.cache = new Cache(config.cacheTtlMinutes || 5);

        this.httpClient = new HttpClient({
            baseUrl: config.baseUrl || 'https://anypoint.mulesoft.com',
            tokenManager: this.tokenManager,
        });

        this.accessManagement = new AccessManagementApi(this.httpClient, this.cache);
        this.cloudHub2 = new CloudHub2Api(this.httpClient, this.cache);
        this.logs = new LogsApi(this.httpClient, this.cloudHub2);
        this.monitoring = new MonitoringApi(this.httpClient, this.cache);
        this.exchange = new ExchangeApi(this.httpClient, this.cache);
        this.apiManager = new ApiManagerApi(this.httpClient, this.cache);
        this.designCenter = new DesignCenterApi(this.httpClient, this.cache);
    }

    // ── Auth ──────────────────────────────────────────

    async getAuthStatus(): Promise<AuthStatus> {
        return this.tokenManager.getStatus();
    }

    getAuthorizeUrl(): string {
        return this.tokenManager.getAuthorizeUrl();
    }

    async authenticate(): Promise<void> {
        await this.tokenManager.authenticate();
    }

    async refreshToken(): Promise<void> {
        await this.tokenManager.refresh();
    }

    async logout(): Promise<void> {
        await this.tokenManager.logout();
        this.cache.clear();
    }

    // ── Convenience ───────────────────────────────────

    async whoami(): Promise<UserProfile> {
        return this.accessManagement.getMe();
    }

    async getDefaultOrgId(): Promise<string> {
        const me = await this.whoami();
        return me.organization.id;
    }

    clearCache(): void {
        this.cache.clear();
    }
}
