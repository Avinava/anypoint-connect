/**
 * What the HTTP client needs from authentication: a valid access token for the next request.
 * `TokenManager` (human login), `ClientCredentialsProvider` and `BearerProvider` all satisfy it.
 */
export interface TokenProvider {
    getAccessToken(): Promise<string>;
    /** Shown instead of a bare 401 when the platform rejects the token and nothing can renew it. */
    readonly unauthorizedMessage?: string;
    /** Drop a cached token the platform rejected, so the next request gets a fresh one. */
    invalidate?(): void;
}
