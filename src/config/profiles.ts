/**
 * Config utility — Profile-based multi-project configuration
 *
 * Resolution chain for profile name (highest priority wins):
 * 1. Explicit `profile` parameter (from --profile CLI flag)
 * 2. ANYPOINT_PROFILE environment variable
 * 3. Project-local .anypoint-connect.json (walks up from cwd)
 * 4. "default" fallback
 *
 * Within a resolved profile, config resolution (highest priority wins):
 * 1. Environment variables (ANYPOINT_CLIENT_ID, etc.)
 * 2. Profile config (~/.anypoint-connect/profiles/<name>/config.json)
 * 3. Project-local .env (cwd fallback)
 *
 * Storage layout:
 *   ~/.anypoint-connect/
 *   ├── profiles/
 *   │   ├── default/
 *   │   │   ├── config.json
 *   │   │   └── tokens.enc
 *   │   └── <profile-name>/
 *   │       ├── config.json
 *   │       └── tokens.enc
 *   └── config.json        ← legacy (auto-migrated to profiles/default/)
 */

import { config as dotenvConfig } from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

// ── Constants ───────────────────────────────────────

const CONFIG_DIR_NAME = '.anypoint-connect';
const CONFIG_FILE_NAME = 'config.json';
const PROFILES_DIR_NAME = 'profiles';
const PROJECT_CONFIG_FILE = '.anypoint-connect.json';
const DEFAULT_PROFILE = 'default';

/** Default OAuth callback URL for local CLI authentication. */
export const DEFAULT_CALLBACK_URL = 'http://localhost:3000/api/callback';

// ── Config Dir ──────────────────────────────────────

/**
 * Get root config directory path (~/.anypoint-connect/)
 */
export function getConfigDir(): string {
    const dir = path.join(process.env.HOME || process.env.USERPROFILE || '/tmp', CONFIG_DIR_NAME);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    return dir;
}

/**
 * Get profile directory path (~/.anypoint-connect/profiles/<name>/)
 */
export function getProfileDir(profile: string = DEFAULT_PROFILE): string {
    const dir = path.join(getConfigDir(), PROFILES_DIR_NAME, profile);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    return dir;
}

function getProfileConfigFilePath(profile: string = DEFAULT_PROFILE): string {
    return path.join(getProfileDir(profile), CONFIG_FILE_NAME);
}

// ── Legacy Migration ────────────────────────────────

/**
 * Auto-migrate legacy root config.json + tokens.enc into profiles/default/.
 * Safe to call multiple times — only migrates if legacy files exist and
 * the default profile directory does not yet have a config.json.
 */
export function migrateIfNeeded(): void {
    const rootDir = getConfigDir();
    const legacyConfig = path.join(rootDir, CONFIG_FILE_NAME);
    const legacyTokens = path.join(rootDir, 'tokens.enc');
    const defaultProfileDir = path.join(rootDir, PROFILES_DIR_NAME, DEFAULT_PROFILE);
    const targetConfig = path.join(defaultProfileDir, CONFIG_FILE_NAME);

    // Only migrate if legacy config exists and default profile doesn't
    if (!fs.existsSync(legacyConfig) || fs.existsSync(targetConfig)) {
        return;
    }

    fs.mkdirSync(defaultProfileDir, { recursive: true, mode: 0o700 });

    // Move config.json
    fs.copyFileSync(legacyConfig, targetConfig);
    fs.unlinkSync(legacyConfig);

    // Move tokens.enc if it exists
    if (fs.existsSync(legacyTokens)) {
        const targetTokens = path.join(defaultProfileDir, 'tokens.enc');
        fs.copyFileSync(legacyTokens, targetTokens);
        fs.unlinkSync(legacyTokens);
    }
}

// ── Project Discovery ───────────────────────────────

export interface ProjectConfig {
    profile: string;
}

/**
 * Walk up from startDir to find .anypoint-connect.json.
 * Returns the parsed content or null if not found.
 */
export function discoverProjectConfig(startDir?: string): ProjectConfig | null {
    let dir = path.resolve(startDir || process.cwd());
    const root = path.parse(dir).root;

    while (dir !== root) {
        const candidate = path.join(dir, PROJECT_CONFIG_FILE);
        if (fs.existsSync(candidate)) {
            try {
                const content = fs.readFileSync(candidate, 'utf8');
                return JSON.parse(content) as ProjectConfig;
            } catch {
                return null;
            }
        }
        dir = path.dirname(dir);
    }

    return null;
}

/**
 * Write a .anypoint-connect.json file in the given directory
 * to bind it to a profile.
 */
export function writeProjectConfig(profile: string, dir?: string): string {
    const targetDir = dir || process.cwd();
    const filePath = path.join(targetDir, PROJECT_CONFIG_FILE);
    const content: ProjectConfig = { profile };
    fs.writeFileSync(filePath, JSON.stringify(content, null, 2) + '\n');
    return filePath;
}

// ── Profile Resolution ──────────────────────────────

export interface ResolvedProfile {
    /** The resolved profile name. */
    name: string;
    /** How the profile was resolved. */
    source: 'flag' | 'env' | 'project-file' | 'default';
}

/**
 * Resolve which profile to use, following the priority chain:
 * 1. Explicit profile parameter (--profile flag)
 * 2. ANYPOINT_PROFILE env var
 * 3. .anypoint-connect.json in cwd (or startDir)
 * 4. "default" fallback
 */
export function resolveProfile(explicitProfile?: string, startDir?: string): ResolvedProfile {
    if (explicitProfile) {
        return { name: explicitProfile, source: 'flag' };
    }

    const envProfile = process.env.ANYPOINT_PROFILE;
    if (envProfile) {
        return { name: envProfile, source: 'env' };
    }

    const projectConfig = discoverProjectConfig(startDir);
    if (projectConfig?.profile) {
        return { name: projectConfig.profile, source: 'project-file' };
    }

    return { name: DEFAULT_PROFILE, source: 'default' };
}

// ── Profile Listing ─────────────────────────────────

/**
 * List all configured profile names.
 */
export function listProfiles(): string[] {
    const profilesDir = path.join(getConfigDir(), PROFILES_DIR_NAME);
    if (!fs.existsSync(profilesDir)) {
        return [];
    }

    try {
        return fs.readdirSync(profilesDir).filter((name) => {
            const profileDir = path.join(profilesDir, name);
            return fs.statSync(profileDir).isDirectory();
        });
    } catch {
        return [];
    }
}

// ── Saved Config (persistent, per-profile) ──────────

export interface SavedConfig {
    clientId: string;
    clientSecret: string;
    callbackUrl: string;
    baseUrl: string;
    defaultEnv?: string;
}

/**
 * Read the saved config for a profile.
 */
export function readSavedConfig(profile?: string): SavedConfig | null {
    // Run migration on first access
    migrateIfNeeded();

    const resolved = profile || DEFAULT_PROFILE;
    const configPath = getProfileConfigFilePath(resolved);
    if (!fs.existsSync(configPath)) return null;

    try {
        const content = fs.readFileSync(configPath, 'utf8');
        return JSON.parse(content) as SavedConfig;
    } catch {
        return null;
    }
}

/**
 * Write config to a profile's config file.
 */
export function writeSavedConfig(config: SavedConfig, profile?: string): void {
    const resolved = profile || DEFAULT_PROFILE;
    const configPath = getProfileConfigFilePath(resolved);
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}

/**
 * Update specific fields in a profile's config.
 */
export function updateSavedConfig(updates: Partial<SavedConfig>, profile?: string): SavedConfig {
    const current = readSavedConfig(profile) || {
        clientId: '',
        clientSecret: '',
        callbackUrl: DEFAULT_CALLBACK_URL,
        baseUrl: 'https://anypoint.mulesoft.com',
    };

    const merged = { ...current, ...updates };
    writeSavedConfig(merged, profile);
    return merged;
}

/**
 * Check if a profile has saved credentials.
 */
export function hasSavedConfig(profile?: string): boolean {
    const saved = readSavedConfig(profile);
    return !!(saved?.clientId && saved?.clientSecret);
}

// ── Resolved Config (runtime) ───────────────────────

export interface Config {
    clientId: string;
    clientSecret: string;
    callbackUrl: string;
    baseUrl: string;
    defaultEnv?: string;
    /** The profile name this config was resolved from. */
    profile: string;
}

export interface GetConfigOptions {
    /** Explicit profile name (overrides all other resolution). */
    profile?: string;
    /** Directory to search for .anypoint-connect.json (defaults to cwd). */
    cwd?: string;
}

// Per-profile config cache
const configCache = new Map<string, Config>();

/**
 * Resolve config using the priority chain:
 * 1. Environment variables
 * 2. Profile config (~/.anypoint-connect/profiles/<name>/config.json)
 * 3. Project-local .env
 */
export function getConfig(options?: GetConfigOptions): Config {
    const { name: profileName } = resolveProfile(options?.profile, options?.cwd);

    if (configCache.has(profileName)) {
        return configCache.get(profileName)!;
    }

    // Layer 3: Try loading project-local .env as lowest priority
    const envPath = path.resolve(options?.cwd || process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
        dotenvConfig({ path: envPath, override: false });
    }

    // Layer 2: Load profile saved config
    const saved = readSavedConfig(profileName);

    // Layer 1 + 2 merge: env vars override saved config
    const clientId = process.env.ANYPOINT_CLIENT_ID || saved?.clientId;
    const clientSecret = process.env.ANYPOINT_CLIENT_SECRET || saved?.clientSecret;

    if (!clientId || !clientSecret) {
        throw new Error(
            `Anypoint Connect is not configured (profile: "${profileName}").\n\n` +
                'Run this first:\n' +
                `  anc config init --profile ${profileName}\n\n` +
                'Or set environment variables:\n' +
                '  export ANYPOINT_CLIENT_ID=...\n' +
                '  export ANYPOINT_CLIENT_SECRET=...\n',
        );
    }

    const config: Config = {
        clientId,
        clientSecret,
        callbackUrl: process.env.ANYPOINT_CALLBACK_URL || saved?.callbackUrl || DEFAULT_CALLBACK_URL,
        baseUrl: process.env.ANYPOINT_BASE_URL || saved?.baseUrl || 'https://anypoint.mulesoft.com',
        defaultEnv: process.env.ANYPOINT_DEFAULT_ENV || saved?.defaultEnv,
        profile: profileName,
    };

    configCache.set(profileName, config);
    return config;
}

/**
 * Clear the cached config (for testing or after config changes)
 */
export function clearConfigCache(): void {
    configCache.clear();
}
