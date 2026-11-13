/**
 * Authentication modes: the one place the mode names live. `authorization_code` is the human browser
 * login; the other two are for unattended runs and never open a browser or write a token file.
 */

export const AUTH_MODES = ['authorization_code', 'client_credentials', 'bearer'] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

export const DEFAULT_AUTH_MODE: AuthMode = 'authorization_code';

/** Modes that run without a person, and so need an explicit organization. */
export function isServiceMode(mode: AuthMode): boolean {
    return mode !== 'authorization_code';
}

export function parseAuthMode(value: string | undefined, source: string): AuthMode {
    if (value === undefined || value === '') return DEFAULT_AUTH_MODE;
    if ((AUTH_MODES as readonly string[]).includes(value)) return value as AuthMode;
    throw new Error(`${source} must be one of ${AUTH_MODES.join(', ')} (got "${value}")`);
}
