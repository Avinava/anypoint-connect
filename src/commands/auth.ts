/**
 * Auth CLI Commands
 * anc auth login | logout | status
 */

import { Command } from 'commander';
import open from 'open';
import ora from 'ora';
import { log } from '../utils/logger.js';
import { errorMessage } from '../utils/errors.js';
import { resolveProfile } from '../utils/config.js';
import { createClient } from './shared.js';

export function createAuthCommand(): Command {
    const auth = new Command('auth').description('Manage Anypoint Platform authentication');

    auth.command('login')
        .description('Authenticate with Anypoint Platform via OAuth')
        .option('-p, --profile <name>', 'Profile to authenticate')
        .action(async (options: { profile?: string }) => {
            try {
                const { name: profileName } = resolveProfile(options.profile);
                const client = createClient(profileName);
                const authUrl = client.getAuthorizeUrl();
                log.info(`Opening browser for authentication (profile: ${profileName})...`);
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
                log.kv('Profile', profileName);
            } catch (error) {
                log.error(`Authentication failed: ${errorMessage(error)}`);
                process.exit(1);
            }
        });

    auth.command('logout')
        .description('Clear stored credentials')
        .option('-p, --profile <name>', 'Profile to log out')
        .action(async (options: { profile?: string }) => {
            try {
                const { name: profileName } = resolveProfile(options.profile);
                const client = createClient(profileName);
                await client.logout();
                log.success(`Logged out successfully (profile: ${profileName})`);
            } catch (error) {
                log.error(`Logout failed: ${errorMessage(error)}`);
                process.exit(1);
            }
        });

    auth.command('status')
        .description('Show current authentication status')
        .option('-p, --profile <name>', 'Profile to check status for')
        .action(async (options: { profile?: string }) => {
            try {
                const { name: profileName, source } = resolveProfile(options.profile);
                const client = createClient(profileName);
                const status = await client.getAuthStatus();

                log.kv('Profile', `${profileName} (resolved via ${source})`);

                if (!status.authenticated) {
                    log.warn(`Not authenticated. Run: anc auth login${profileName !== 'default' ? ` --profile ${profileName}` : ''}`);
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
                log.error(`Status check failed: ${errorMessage(error)}`);
                process.exit(1);
            }
        });

    return auth;
}
