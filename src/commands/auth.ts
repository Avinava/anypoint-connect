/**
 * Auth CLI Commands
 * anc auth login | logout | status
 */

import { Command } from 'commander';
import open from 'open';
import ora from 'ora';
import { getConfig } from '../utils/config.js';
import { log } from '../utils/logger.js';
import { AnypointClient } from '../client/AnypointClient.js';

export function createAuthCommand(): Command {
    const auth = new Command('auth').description('Manage Anypoint Platform authentication');

    auth.command('login')
        .description('Authenticate with Anypoint Platform via OAuth')
        .action(async () => {
            try {
                const config = getConfig();
                const client = new AnypointClient({
                    clientId: config.clientId,
                    clientSecret: config.clientSecret,
                    redirectUri: config.callbackUrl,
                    baseUrl: config.baseUrl,
                });

                const authUrl = client.getAuthorizeUrl();
                log.info('Opening browser for authentication...');
                log.dim(`  ${authUrl}`);

                // Start listening for callback before opening browser
                const authPromise = client.authenticate();

                // Open browser
                await open(authUrl);

                const spinner = ora('Waiting for authentication...').start();

                await authPromise;
                spinner.stop();

                // Verify by fetching user info
                const me = await client.whoami();
                log.success(`Authenticated as ${me.firstName} ${me.lastName} (${me.username})`);
                log.kv('Organization', me.organization.name);
            } catch (error) {
                log.error(`Authentication failed: ${error instanceof Error ? error.message : error}`);
                process.exit(1);
            }
        });

    auth.command('logout')
        .description('Clear stored credentials')
        .action(async () => {
            try {
                const config = getConfig();
                const client = new AnypointClient({
                    clientId: config.clientId,
                    clientSecret: config.clientSecret,
                    redirectUri: config.callbackUrl,
                    baseUrl: config.baseUrl,
                });

                await client.logout();
                log.success('Logged out successfully');
            } catch (error) {
                log.error(`Logout failed: ${error instanceof Error ? error.message : error}`);
                process.exit(1);
            }
        });

    auth.command('status')
        .description('Show current authentication status')
        .action(async () => {
            try {
                const config = getConfig();
                const client = new AnypointClient({
                    clientId: config.clientId,
                    clientSecret: config.clientSecret,
                    redirectUri: config.callbackUrl,
                    baseUrl: config.baseUrl,
                });

                const status = await client.getAuthStatus();

                if (!status.authenticated) {
                    log.warn('Not authenticated. Run: anc auth login');
                    return;
                }

                log.success('Authenticated');
                if (status.expiresAt) {
                    log.kv('Token Expires', status.expiresAt.toLocaleString());
                    log.kv('Expired', status.isExpired ? 'Yes' : 'No');
                    log.kv('Can Refresh', status.canRefresh ? 'Yes' : 'No');
                }

                // Show user info
                try {
                    const me = await client.whoami();
                    log.kv('User', `${me.firstName} ${me.lastName} (${me.username})`);
                    log.kv('Organization', me.organization.name);
                    log.kv('Org ID', me.organization.id);
                } catch {
                    log.dim('  Could not fetch user details (token may need refresh)');
                }
            } catch (error) {
                log.error(`Status check failed: ${error instanceof Error ? error.message : error}`);
                process.exit(1);
            }
        });

    return auth;
}
