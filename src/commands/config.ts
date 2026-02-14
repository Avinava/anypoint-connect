/**
 * Config CLI Commands
 * anc config init | show | set <key> <value> | path
 */

import { Command } from 'commander';
import * as readline from 'readline';
import chalk from 'chalk';
import { log } from '../utils/logger.js';
import {
    readSavedConfig,
    writeSavedConfig,
    updateSavedConfig,
    hasSavedConfig,
    getConfigDir,
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
        .description('Interactive setup — saves credentials to ~/.anypoint-connect/config.json')
        .action(async () => {
            const existing = readSavedConfig();

            if (existing && hasSavedConfig()) {
                log.info('Existing configuration found. Values will be used as defaults.');
                log.dim(`  Config file: ${getConfigDir()}/config.json`);
                console.log();
            }

            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout,
            });

            try {
                log.header('Anypoint Connect Setup');
                log.dim('  Credentials are saved to ~/.anypoint-connect/config.json (chmod 600)');
                log.dim('  Tokens are saved to ~/.anypoint-connect/tokens.enc (AES-256-GCM)');
                console.log();

                const clientId = await ask(
                    rl,
                    '  Client ID:',
                    existing?.clientId
                );

                const clientSecret = await ask(
                    rl,
                    '  Client Secret:',
                    existing?.clientSecret ? '••••••' + existing.clientSecret.slice(-4) : undefined
                );

                const callbackUrl = await ask(
                    rl,
                    '  Callback URL:',
                    existing?.callbackUrl || 'http://localhost:3000/api/callback'
                );

                const baseUrl = await ask(
                    rl,
                    '  Base URL:',
                    existing?.baseUrl || 'https://anypoint.mulesoft.com'
                );

                const defaultEnv = await ask(
                    rl,
                    '  Default Environment (optional):',
                    existing?.defaultEnv
                );

                rl.close();

                // If user entered the masked secret, keep the original
                const resolvedSecret =
                    clientSecret.startsWith('••••••') && existing?.clientSecret
                        ? existing.clientSecret
                        : clientSecret;

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

                writeSavedConfig(saved);

                console.log();
                log.success('Configuration saved!');
                log.kv('Location', `${getConfigDir()}/config.json`);
                console.log();
                log.info('Next step: authenticate with Anypoint Platform');
                log.dim('  anc auth login');
            } catch (error) {
                rl.close();
                log.error(`Setup failed: ${error instanceof Error ? error.message : error}`);
                process.exit(1);
            }
        });

    // ── config show ──────────────────────────────────
    config
        .command('show')
        .description('Display current configuration (secrets masked)')
        .action(() => {
            const saved = readSavedConfig();

            if (!saved) {
                log.warn('No configuration found. Run: anc config init');
                return;
            }

            log.header('Anypoint Connect Configuration');
            log.kv('Config File', `${getConfigDir()}/config.json`);
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
        .action((key: string, value: string) => {
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

            updateSavedConfig({ [key]: value });
            const display = key === 'clientSecret' ? '••••••' + value.slice(-4) : value;
            log.success(`Set ${key} = ${display}`);
        });

    // ── config path ──────────────────────────────────
    config
        .command('path')
        .description('Print the config directory path')
        .action(() => {
            console.log(getConfigDir());
        });

    return config;
}
