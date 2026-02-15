/**
 * Shared command utilities
 * Common helpers used across all CLI command modules
 */

import { getConfig } from '../utils/config.js';
import { AnypointClient } from '../client/AnypointClient.js';

/**
 * Creates an authenticated AnypointClient from the saved configuration.
 * Used by all CLI commands that need to interact with the Anypoint Platform.
 */
export function createClient(): AnypointClient {
    const config = getConfig();
    return new AnypointClient({
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        redirectUri: config.callbackUrl,
        baseUrl: config.baseUrl,
    });
}
