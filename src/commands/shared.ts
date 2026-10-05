/**
 * Shared command utilities
 * Common helpers used across all CLI command modules
 */

import * as readline from 'node:readline/promises';
import { getConfig, resolveProfile } from '../config/profiles.js';
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

/** Ask a yes/no question on the terminal; anything but "y" or "yes" declines. */
export async function confirmAction(question: string): Promise<boolean> {
    if (!process.stdin.isTTY) {
        throw new Error('Confirmation required but the terminal is not interactive; pass --yes to proceed.');
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
        const answer = await rl.question(`  ${question} [y/N] `);
        return ['y', 'yes'].includes(answer.trim().toLowerCase());
    } finally {
        rl.close();
    }
}
