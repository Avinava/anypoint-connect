/**
 * Token Storage Interface
 */

export interface AnypointTokens {
    accessToken: string;
    refreshToken?: string;
    tokenType: string;
    expiresIn: number;
    expiresAt: number; // Unix timestamp ms
    scope?: string;
}

export interface TokenStore {
    save(tokens: AnypointTokens): Promise<void>;
    load(): Promise<AnypointTokens | null>;
    clear(): Promise<void>;
    exists(): Promise<boolean>;
}
