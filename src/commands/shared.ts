/**
 * Shared command utilities
 * Common helpers used across all CLI command modules
 */

import { getConfig, resolveProfile } from '../utils/config.js';
import { AnypointClient } from '../client/AnypointClient.js';

/**
 * Creates an authenticated AnypointClient from the saved configuration.
 * If no profile is specified, auto-resolves from env / project config / default.
 */
export function createClient(profile?: string): AnypointClient {
    const resolved = resolveProfile(profile);
    const config = getConfig({ profile: resolved.name });
    return new AnypointClient({
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        redirectUri: config.callbackUrl,
        baseUrl: config.baseUrl,
        profileName: config.profile,
    });
}
