/**
 * Anypoint Client
 * Main facade providing unified access to all Anypoint APIs
 */

import { TokenManager, type AuthStatus, type TokenProvider } from '../auth/index.js';
import { BearerProvider } from '../auth/BearerProvider.js';
import { ClientCredentialsProvider } from '../auth/ClientCredentialsProvider.js';
import { HttpClient } from './HttpClient.js';
import { Cache } from './Cache.js';
import { AccessManagementApi, type UserProfile } from '../api/AccessManagementApi.js';
import { CloudHub2Api } from '../api/CloudHub2Api.js';
import { LogsApi } from '../api/LogsApi.js';
import { MonitoringApi } from '../api/MonitoringApi.js';
import { ExchangeApi } from '../api/ExchangeApi.js';
import { ApiManagerApi } from '../api/ApiManagerApi.js';
import { DesignCenterApi } from '../api/DesignCenterApi.js';
import { DesignCenterWorkflow } from '../workflows/design-center.js';
import { GovernanceApi } from '../api/GovernanceApi.js';
import { AuditLogApi } from '../api/AuditLogApi.js';
import { AnypointMQApi } from '../api/AnypointMQApi.js';
import { ObjectStoreApi } from '../api/ObjectStoreApi.js';
import { RuntimesApi } from '../api/RuntimesApi.js';
import { AlertsApi } from '../api/AlertsApi.js';
import { DEFAULT_CALLBACK_URL, type Config } from '../config/profiles.js';
import { DEFAULT_AUTH_MODE, isServiceMode, type AuthMode } from '../config/auth-modes.js';

export interface AnypointClientConfig {
    clientId: string;
    clientSecret: string;
    redirectUri?: string;
    baseUrl?: string;
    cacheTtlMinutes?: number;
    profileName?: string;
    /** How to authenticate. The browser login when unset, so existing callers are unchanged. */
    authMode?: AuthMode;
    /** The organization to operate in. Required for `client_credentials` and `bearer`. */
    orgId?: string;
    /** The token for `bearer` mode. */
    accessToken?: string;
}

export class AnypointClient {
    /** Only the browser login has a token manager; service modes hold their token in memory. */
    private readonly tokenManager: TokenManager | null;
    private readonly authMode: AuthMode;
    private readonly configuredOrgId: string | undefined;
    private readonly provider: TokenProvider;
    private userOrgId: string | undefined;
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
    public readonly designCenterWorkflow: DesignCenterWorkflow;
    public readonly governance: GovernanceApi;
    public readonly auditLog: AuditLogApi;
    public readonly anypointMQ: AnypointMQApi;
    public readonly objectStore: ObjectStoreApi;
    public readonly runtimes: RuntimesApi;
    public readonly alerts: AlertsApi;

    /** A client for a resolved profile configuration. */
    static fromConfig(config: Config): AnypointClient {
        return new AnypointClient({
            clientId: config.clientId,
            clientSecret: config.clientSecret,
            redirectUri: config.callbackUrl,
            baseUrl: config.baseUrl,
            profileName: config.profile,
            authMode: config.authMode,
            orgId: config.orgId,
            accessToken: config.accessToken,
        });
    }

    constructor(config: AnypointClientConfig) {
        this.authMode = config.authMode ?? DEFAULT_AUTH_MODE;
        this.configuredOrgId = config.orgId || undefined;
        if (isServiceMode(this.authMode) && !this.configuredOrgId) {
            throw new Error(`The ${this.authMode} mode needs an explicit organization (orgId).`);
        }

        if (this.authMode === 'client_credentials') {
            this.tokenManager = null;
            this.provider = new ClientCredentialsProvider({
                clientId: config.clientId,
                clientSecret: config.clientSecret,
                baseUrl: config.baseUrl,
            });
        } else if (this.authMode === 'bearer') {
            this.tokenManager = null;
            this.provider = new BearerProvider(config.accessToken);
        } else {
            this.tokenManager = new TokenManager({
                clientId: config.clientId,
                clientSecret: config.clientSecret,
                redirectUri: config.redirectUri || DEFAULT_CALLBACK_URL,
                baseUrl: config.baseUrl,
                profileName: config.profileName,
            });
            this.provider = this.tokenManager;
        }

        this.cache = new Cache(config.cacheTtlMinutes || 5);

        this.httpClient = new HttpClient({
            baseUrl: config.baseUrl || 'https://anypoint.mulesoft.com',
            tokenProvider: this.provider,
        });

        this.accessManagement = new AccessManagementApi(this.httpClient, this.cache);
        this.cloudHub2 = new CloudHub2Api(this.httpClient, this.cache);
        this.logs = new LogsApi(this.httpClient, this.cloudHub2);
        this.monitoring = new MonitoringApi(this.httpClient, this.cache);
        this.exchange = new ExchangeApi(this.httpClient, this.cache);
        this.apiManager = new ApiManagerApi(this.httpClient, this.cache);
        this.designCenter = new DesignCenterApi(this.httpClient, this.cache);
        this.designCenterWorkflow = new DesignCenterWorkflow(this.designCenter, this.exchange);
        this.governance = new GovernanceApi(this.httpClient);
        this.auditLog = new AuditLogApi(this.httpClient);
        this.anypointMQ = new AnypointMQApi(this.httpClient, this.cache);
        this.objectStore = new ObjectStoreApi(this.httpClient, this.cache);
        this.runtimes = new RuntimesApi(this.httpClient, this.cache);
        this.alerts = new AlertsApi(this.httpClient);
    }

    // ── Auth ──────────────────────────────────────────

    getAuthMode(): AuthMode {
        return this.authMode;
    }

    /** The browser login's token manager; service modes have none, and say so. */
    private browserLogin(action: string): TokenManager {
        if (!this.tokenManager) {
            throw new Error(
                `${action} is not available with ${this.authMode} authentication; there is no browser login.`,
            );
        }
        return this.tokenManager;
    }

    async getAuthStatus(): Promise<AuthStatus> {
        if (this.tokenManager) return this.tokenManager.getStatus();
        // Service modes: authenticated when a token can be obtained now.
        try {
            await this.provider.getAccessToken();
            return { authenticated: true };
        } catch {
            return { authenticated: false };
        }
    }

    getAuthorizeUrl(): string {
        return this.browserLogin('Login').getAuthorizeUrl();
    }

    async authenticate(): Promise<void> {
        await this.browserLogin('Login').authenticate();
    }

    async refreshToken(): Promise<void> {
        await this.browserLogin('Token refresh').refresh();
    }

    async logout(): Promise<void> {
        await this.browserLogin('Logout').logout();
        this.cache.clear();
    }

    // ── Convenience ───────────────────────────────────

    /** The signed-in person. Service identities are not people, so this is for the browser login only. */
    async whoami(): Promise<UserProfile> {
        if (isServiceMode(this.authMode)) {
            throw new Error(
                `whoami is not available with ${this.authMode} authentication; the organization comes from configuration.`,
            );
        }
        return this.accessManagement.getMe();
    }

    /** The configured organization, else the signed-in user's own (looked up once). */
    async getDefaultOrgId(): Promise<string> {
        if (this.configuredOrgId) return this.configuredOrgId;
        this.userOrgId ??= (await this.whoami()).organization.id;
        return this.userOrgId;
    }

    clearCache(): void {
        this.cache.clear();
    }

    /** Expose cache instance for diagnostics (read-only stats) */
    getCache(): Cache {
        return this.cache;
    }
}
