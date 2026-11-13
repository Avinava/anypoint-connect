import type { TokenProvider } from './TokenProvider.js';

const DEFAULT_BASE_URL = 'https://anypoint.mulesoft.com';
/** Used when the platform omits `expires_in`: a short lifetime, so a missing field never over-trusts a token. */
const FALLBACK_LIFETIME_SECONDS = 600;
const RENEW_BEFORE_EXPIRY_MS = 60_000;
const TOKEN_REQUEST_TIMEOUT_MS = 30_000;

export interface ClientCredentialsConfig {
    clientId: string;
    clientSecret: string;
    baseUrl?: string;
}

interface ServiceTokenResponse {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
}

/**
 * Service authentication: a Connected App's client credentials exchanged for a token. The token lives
 * in memory only (never the human token file), concurrent callers share one exchange, and it is
 * renewed shortly before it expires. It uses its own request, not the authenticated client, so token
 * acquisition cannot call itself.
 */
export class ClientCredentialsProvider implements TokenProvider {
    readonly unauthorizedMessage =
        'The service token was rejected. Check that the Connected App is still valid and has access to this organization.';
    private readonly config: ClientCredentialsConfig;
    private cached: { token: string; expiresAt: number } | null = null;
    private pending: Promise<string> | null = null;

    constructor(config: ClientCredentialsConfig) {
        if (!config.clientId || !config.clientSecret) {
            throw new Error('client_credentials authentication needs a client ID and secret.');
        }
        this.config = config;
    }

    invalidate(): void {
        this.cached = null;
    }

    async getAccessToken(): Promise<string> {
        if (this.cached && this.cached.expiresAt - Date.now() > RENEW_BEFORE_EXPIRY_MS) return this.cached.token;
        this.pending ??= this.acquire().finally(() => {
            this.pending = null;
        });
        return this.pending;
    }

    private async acquire(): Promise<string> {
        const url = `${this.config.baseUrl || DEFAULT_BASE_URL}/accounts/api/v2/oauth2/token`;
        const response = await fetch(url, {
            method: 'POST',
            signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS), // a hung endpoint must not block every request
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'client_credentials',
                client_id: this.config.clientId,
                client_secret: this.config.clientSecret,
            }).toString(),
        });
        const data = (await response.json().catch(() => ({}))) as ServiceTokenResponse;
        if (!response.ok || !data.access_token) {
            // Only the platform's own error fields: never the request, which carries the secret.
            const detail = [data.error, data.error_description].filter(Boolean).join(': ');
            throw new Error(`Service token request failed (HTTP ${response.status})${detail ? `: ${detail}` : ''}`);
        }
        const seconds =
            Number.isFinite(data.expires_in) && (data.expires_in as number) > 0
                ? (data.expires_in as number)
                : FALLBACK_LIFETIME_SECONDS;
        this.cached = { token: data.access_token, expiresAt: Date.now() + seconds * 1000 };
        return data.access_token;
    }
}
