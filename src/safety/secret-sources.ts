/**
 * Secret sources
 * Property values resolved on the server from a project file or environment variables,
 * so the values never travel in a tool call or appear in a transcript.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseDotenv } from 'dotenv';
import { z } from 'zod';
import { resolveReadablePath } from './paths.js';

export const fileSecretSourceSchema = z.object({
    file: z.string().describe('Path inside the project root to a .env, .properties or flat JSON file'),
    format: z
        .enum(['env', 'properties', 'json'])
        .optional()
        .describe('File format. Default: from the extension (.json, .properties, otherwise env)'),
    keys: z.array(z.string()).optional().describe('Only take these keys from the file (default: all)'),
    rename: z
        .record(z.string(), z.string())
        .optional()
        .describe('Map a file key to a different property name, e.g. {"DB_PASSWORD": "db.password"}'),
    prefix: z.string().optional().describe('Prefix added to every property name taken from the file'),
});

export const envSecretSourceSchema = z.object({
    env: z
        .record(z.string(), z.string())
        .describe('Map of property name to the environment variable that holds its value in the server process'),
});

export const secretSourceSchema = z.union([fileSecretSourceSchema, envSecretSourceSchema]);

export type FileSecretSource = z.infer<typeof fileSecretSourceSchema>;
export type EnvSecretSource = z.infer<typeof envSecretSourceSchema>;
export type SecretSource = z.infer<typeof secretSourceSchema>;

/** Parse a Java `.properties` file: `=`/`:`/space separators, comments, continuations, escapes. */
export function parseProperties(text: string): Record<string, string> {
    const result: Record<string, string> = {};
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        let line = lines[i].replace(/^\s+/, '');
        if (!line || line.startsWith('#') || line.startsWith('!')) continue;
        while (/(^|[^\\])(\\\\)*\\$/.test(line) && i + 1 < lines.length) {
            line = line.slice(0, -1) + lines[++i].replace(/^\s+/, '');
        }
        let separator = -1;
        for (let j = 0; j < line.length; j++) {
            if (line[j] === '\\') {
                j++;
                continue;
            }
            if (line[j] === '=' || line[j] === ':' || /\s/.test(line[j])) {
                separator = j;
                break;
            }
        }
        const rawKey = separator === -1 ? line : line.slice(0, separator);
        let rest = separator === -1 ? '' : line.slice(separator);
        rest = rest.replace(/^\s*[=:]?\s*/, '');
        result[unescapeProperties(rawKey)] = unescapeProperties(rest);
    }
    return result;
}

function unescapeProperties(value: string): string {
    return value.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, escape: string) => {
        if (escape.startsWith('u') && escape.length === 5) return String.fromCharCode(parseInt(escape.slice(1), 16));
        return { t: '\t', n: '\n', r: '\r', f: '\f' }[escape] ?? escape;
    });
}

function detectFormat(file: string): 'env' | 'properties' | 'json' {
    const ext = path.extname(file).toLowerCase();
    if (ext === '.json') return 'json';
    if (ext === '.properties') return 'properties';
    return 'env';
}

function parseFile(text: string, format: 'env' | 'properties' | 'json', file: string): Record<string, string> {
    if (format === 'env') return parseDotenv(text);
    if (format === 'properties') return parseProperties(text);
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error(`Secret source ${file} is not valid JSON`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`Secret source ${file} must be a flat JSON object`);
    }
    const entries = Object.entries(parsed as Record<string, unknown>);
    const invalid = entries.filter(([, value]) => typeof value !== 'string').map(([key]) => key);
    if (invalid.length) throw new Error(`Secret source ${file} has non-string values for: ${invalid.join(', ')}`);
    return Object.fromEntries(entries) as Record<string, string>;
}

/**
 * Resolve one source into property values. Errors name keys and files, never values.
 */
export function resolveSecretSource(
    source: SecretSource,
    options: { projectRoot?: string; env?: NodeJS.ProcessEnv } = {},
): Record<string, string> {
    if ('env' in source) {
        const env = options.env ?? process.env;
        const missing = Object.entries(source.env)
            .filter(([, variable]) => env[variable] === undefined || env[variable] === '')
            .map(([, variable]) => variable);
        if (missing.length)
            throw new Error(`Environment variables not set in the server process: ${missing.join(', ')}`);
        return Object.fromEntries(Object.entries(source.env).map(([key, variable]) => [key, env[variable] as string]));
    }

    const resolved = resolveReadablePath(source.file, { projectRoot: options.projectRoot });
    const values = parseFile(
        fs.readFileSync(resolved.path, 'utf8'),
        source.format ?? detectFormat(source.file),
        source.file,
    );
    const selected = source.keys ?? Object.keys(values);
    const missing = selected.filter((key) => !(key in values));
    if (missing.length) throw new Error(`Keys not found in ${source.file}: ${missing.join(', ')}`);

    const result: Record<string, string> = {};
    for (const key of selected) {
        result[`${source.prefix ?? ''}${source.rename?.[key] ?? key}`] = values[key];
    }
    return result;
}

/** Resolve several sources in order; later sources win on duplicate keys. */
export function resolveSecretSources(
    sources: SecretSource[] | undefined,
    options: { projectRoot?: string; env?: NodeJS.ProcessEnv } = {},
): Record<string, string> {
    return Object.assign({}, ...(sources ?? []).map((source) => resolveSecretSource(source, options)));
}
