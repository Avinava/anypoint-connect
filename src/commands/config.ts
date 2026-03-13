/**
 * Config CLI Commands
 * anc config init | show | set <key> <value> | path | profiles | use <profile>
 */

import { Command } from 'commander';
import * as readline from 'readline';
import chalk from 'chalk';
import { log } from '../utils/logger.js';
import { errorMessage } from '../utils/errors.js';
import {
    readSavedConfig,
    writeSavedConfig,
    updateSavedConfig,
    hasSavedConfig,
    getConfigDir,
    getProfileDir,
    listProfiles,
    resolveProfile,
    writeProjectConfig,
    DEFAULT_CALLBACK_URL,
    type SavedConfig,
} from '../utils/config.js';

function ask(rl: readline.Interface, prompt: string, defaultValue?: string): Promise<string> {
    const display = defaultValue ? `${prompt} ${chalk.dim(`(${defaultValue})`)} ` : `${prompt} `;
    return new Promise((resolve) => {
        rl.question(display, (answer) => {
            resolve(answer.trim() || defaultValue || '');
        });
    });
}

export function createConfigCommand(): Command {
    const config = new Command('config').description('Manage Anypoint Connect configuration');

    // ── config init ──────────────────────────────────
    config
        .command('init')
        .description('Interactive setup — saves credentials to a profile')
        .option('-p, --profile <name>', 'Profile name to configure')
        .action(async (options: { profile?: string }) => {
            const { name: profileName } = resolveProfile(options.profile);
            const existing = readSavedConfig(profileName);

            if (existing && hasSavedConfig(profileName)) {
                log.info(`Existing configuration found for profile "${profileName}". Values will be used as defaults.`);
                log.dim(`  Config file: ${getProfileDir(profileName)}/config.json`);
                console.log();
            }

            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout,
            });

            try {
                log.header(`Anypoint Connect Setup — Profile: ${chalk.cyan(profileName)}`);
                log.dim(`  Credentials saved to: ~/.anypoint-connect/profiles/${profileName}/config.json`);
                log.dim(`  Tokens saved to: ~/.anypoint-connect/profiles/${profileName}/tokens.enc (AES-256-GCM)`);
                console.log();

                const clientId = await ask(rl, '  Client ID:', existing?.clientId);

                const clientSecret = await ask(
                    rl,
                    '  Client Secret:',
                    existing?.clientSecret ? '••••••' + existing.clientSecret.slice(-4) : undefined,
                );

                const callbackUrl = await ask(rl, '  Callback URL:', existing?.callbackUrl || DEFAULT_CALLBACK_URL);

                const baseUrl = await ask(rl, '  Base URL:', existing?.baseUrl || 'https://anypoint.mulesoft.com');

                const defaultEnv = await ask(rl, '  Default Environment (optional):', existing?.defaultEnv);

                rl.close();

                // If user entered the masked secret, keep the original
                const resolvedSecret =
                    clientSecret.startsWith('••••••') && existing?.clientSecret ? existing.clientSecret : clientSecret;

                if (!clientId || !resolvedSecret) {
                    log.error('Client ID and Client Secret are required');
                    process.exit(1);
                }

                const saved: SavedConfig = {
                    clientId,
                    clientSecret: resolvedSecret,
                    callbackUrl,
                    baseUrl,
                    ...(defaultEnv ? { defaultEnv } : {}),
                };

                writeSavedConfig(saved, profileName);

                console.log();
                log.success(`Configuration saved for profile "${profileName}"!`);
                log.kv('Location', `${getProfileDir(profileName)}/config.json`);
                console.log();
                log.info('Next step: authenticate with Anypoint Platform');
                log.dim(`  anc auth login${profileName !== 'default' ? ` --profile ${profileName}` : ''}`);
            } catch (error) {
                rl.close();
                log.error(`Setup failed: ${errorMessage(error)}`);
                process.exit(1);
            }
        });

    // ── config show ──────────────────────────────────
    config
        .command('show')
        .description('Display current configuration (secrets masked)')
        .option('-p, --profile <name>', 'Profile to show')
        .action((options: { profile?: string }) => {
            const { name: profileName, source } = resolveProfile(options.profile);
            const saved = readSavedConfig(profileName);

            if (!saved) {
                log.warn(
                    `No configuration found for profile "${profileName}". Run: anc config init --profile ${profileName}`,
                );
                return;
            }

            log.header(`Anypoint Connect Configuration — Profile: ${chalk.cyan(profileName)}`);
            log.kv('Profile', `${profileName} (resolved via ${source})`);
            log.kv('Config File', `${getProfileDir(profileName)}/config.json`);
            console.log();
            log.kv('Client ID', saved.clientId);
            log.kv('Client Secret', '••••••' + (saved.clientSecret?.slice(-4) || ''));
            log.kv('Callback URL', saved.callbackUrl);
            log.kv('Base URL', saved.baseUrl);
            if (saved.defaultEnv) {
                log.kv('Default Env', saved.defaultEnv);
            }
        });

    // ── config set ───────────────────────────────────
    config
        .command('set')
        .description('Set a single config value')
        .argument('<key>', 'Config key: clientId, clientSecret, callbackUrl, baseUrl, defaultEnv')
        .argument('<value>', 'Value to set')
        .option('-p, --profile <name>', 'Profile to update')
        .action((key: string, value: string, options: { profile?: string }) => {
            const { name: profileName } = resolveProfile(options.profile);

            const validKeys: (keyof SavedConfig)[] = [
                'clientId',
                'clientSecret',
                'callbackUrl',
                'baseUrl',
                'defaultEnv',
            ];

            if (!validKeys.includes(key as keyof SavedConfig)) {
                log.error(`Invalid key "${key}". Valid keys: ${validKeys.join(', ')}`);
                process.exit(1);
            }

            updateSavedConfig({ [key]: value }, profileName);
            const display = key === 'clientSecret' ? '••••••' + value.slice(-4) : value;
            log.success(`[${profileName}] Set ${key} = ${display}`);
        });

    // ── config path ──────────────────────────────────
    config
        .command('path')
        .description('Print the config directory path')
        .option('-p, --profile <name>', 'Profile to show path for')
        .action((options: { profile?: string }) => {
            if (options.profile) {
                console.log(getProfileDir(options.profile));
            } else {
                console.log(getConfigDir());
            }
        });

    // ── config profiles ──────────────────────────────
    config
        .command('profiles')
        .description('List all configured profiles')
        .action(() => {
            const profiles = listProfiles();
            const { name: activeProfile, source } = resolveProfile();

            if (profiles.length === 0) {
                log.warn('No profiles configured. Run: anc config init');
                return;
            }

            log.header('Configured Profiles');
            for (const p of profiles) {
                const isActive = p === activeProfile;
                const hasConfig = hasSavedConfig(p);
                const marker = isActive ? chalk.green('▸ ') : '  ';
                const status = hasConfig ? chalk.green('✓') : chalk.dim('○');
                const label = isActive ? chalk.bold(p) + chalk.dim(` (active — ${source})`) : p;
                console.log(`${marker}${status} ${label}`);
            }
        });

    // ── config use ───────────────────────────────────
    config
        .command('use')
        .description('Bind current directory to a profile (writes .anypoint-connect.json)')
        .argument('<profile>', 'Profile name to use in this directory')
        .action((profile: string) => {
            const profiles = listProfiles();

            if (profiles.length > 0 && !profiles.includes(profile)) {
                log.warn(`Profile "${profile}" does not exist yet.`);
                log.dim(`  Available profiles: ${profiles.join(', ')}`);
                log.dim(`  Run: anc config init --profile ${profile}`);
                console.log();
            }

            const filePath = writeProjectConfig(profile);
            log.success(`Directory bound to profile "${profile}"`);
            log.kv('File', filePath);
            log.dim('  All commands in this directory will now use this profile.');
        });

    return config;
}
