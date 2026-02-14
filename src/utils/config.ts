/**
 * Config utility
 * 
 * Resolution chain (highest priority wins):
 * 1. Environment variables (ANYPOINT_CLIENT_ID, etc.)
 * 2. Global config file (~/.anypoint-connect/config.json)
 * 3. Project-local .env (cwd fallback)
 * 
 * Persistent config lives at ~/.anypoint-connect/config.json
 * Tokens live at ~/.anypoint-connect/tokens.enc
 */

import { config as dotenvConfig } from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

// ── Config Dir ──────────────────────────────────────

const CONFIG_DIR_NAME = '.anypoint-connect';
const CONFIG_FILE_NAME = 'config.json';

/**
 * Get config directory path (~/.anypoint-connect/)
 */
export function getConfigDir(): string {
    const dir = path.join(
        process.env.HOME || process.env.USERPROFILE || '/tmp',
        CONFIG_DIR_NAME
    );
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    return dir;
}

function getConfigFilePath(): string {
    return path.join(getConfigDir(), CONFIG_FILE_NAME);
}

// ── Saved Config (persistent) ───────────────────────

export interface SavedConfig {
    clientId: string;
    clientSecret: string;
    callbackUrl: string;
    baseUrl: string;
    defaultEnv?: string;
}

/**
 * Read the saved global config file
 */
export function readSavedConfig(): SavedConfig | null {
    const configPath = getConfigFilePath();
    if (!fs.existsSync(configPath)) return null;

    try {
        const content = fs.readFileSync(configPath, 'utf8');
        return JSON.parse(content) as SavedConfig;
    } catch {
        return null;
    }
}

/**
 * Write config to the global config file
 */
export function writeSavedConfig(config: SavedConfig): void {
    const configPath = getConfigFilePath();
    fs.writeFileSync(
        configPath,
        JSON.stringify(config, null, 2) + '\n',
        { mode: 0o600 }
    );
}

/**
 * Update specific fields in the saved config
 */
export function updateSavedConfig(updates: Partial<SavedConfig>): SavedConfig {
    const current = readSavedConfig() || {
        clientId: '',
        clientSecret: '',
        callbackUrl: 'http://localhost:3000/api/callback',
        baseUrl: 'https://anypoint.mulesoft.com',
    };

    const merged = { ...current, ...updates };
    writeSavedConfig(merged);
    return merged;
}

/**
 * Check if a saved config exists and has credentials
 */
export function hasSavedConfig(): boolean {
    const saved = readSavedConfig();
    return !!(saved?.clientId && saved?.clientSecret);
}

// ── Resolved Config (runtime) ───────────────────────

export interface Config {
    clientId: string;
    clientSecret: string;
    callbackUrl: string;
    baseUrl: string;
    defaultEnv?: string;
}

let cachedConfig: Config | null = null;

/**
 * Resolve config using the priority chain:
 * 1. Environment variables
 * 2. Global config (~/.anypoint-connect/config.json)
 * 3. Project-local .env
 */
export function getConfig(): Config {
    if (cachedConfig) return cachedConfig;

    // Layer 3: Try loading project-local .env as lowest priority
    const envPath = path.resolve(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
        dotenvConfig({ path: envPath, override: false });
    }

    // Layer 2: Load global saved config
    const saved = readSavedConfig();

    // Layer 1 + 2 merge: env vars override saved config
    const clientId = process.env.ANYPOINT_CLIENT_ID || saved?.clientId;
    const clientSecret = process.env.ANYPOINT_CLIENT_SECRET || saved?.clientSecret;

    if (!clientId || !clientSecret) {
        throw new Error(
            'Anypoint Connect is not configured.\n\n' +
            'Run this first:\n' +
            '  anc config init\n\n' +
            'Or set environment variables:\n' +
            '  export ANYPOINT_CLIENT_ID=...\n' +
            '  export ANYPOINT_CLIENT_SECRET=...\n'
        );
    }

    cachedConfig = {
        clientId,
        clientSecret,
        callbackUrl:
            process.env.ANYPOINT_CALLBACK_URL ||
            saved?.callbackUrl ||
            'http://localhost:3000/api/callback',
        baseUrl:
            process.env.ANYPOINT_BASE_URL ||
            saved?.baseUrl ||
            'https://anypoint.mulesoft.com',
        defaultEnv:
            process.env.ANYPOINT_DEFAULT_ENV ||
            saved?.defaultEnv,
    };

    return cachedConfig;
}

/**
 * Clear the cached config (for testing or after config changes)
 */
export function clearConfigCache(): void {
    cachedConfig = null;
}
