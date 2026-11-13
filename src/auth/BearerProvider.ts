import type { TokenProvider } from './TokenProvider.js';

/**
 * A caller-supplied bearer token, kept in memory only. Its lifetime is unknown, so it is never
 * refreshed or stored; when the platform rejects it the caller must supply a new one.
 */
export class BearerProvider implements TokenProvider {
    readonly unauthorizedMessage =
        'The bearer token was rejected (expired or invalid). Supply a new ANYPOINT_ACCESS_TOKEN.';
    private readonly token: string;

    constructor(token: string | undefined) {
        const trimmed = token?.trim();
        if (!trimmed) throw new Error('Bearer authentication needs a token: set ANYPOINT_ACCESS_TOKEN.');
        this.token = trimmed;
    }

    async getAccessToken(): Promise<string> {
        return this.token;
    }
}
