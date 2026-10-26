/**
 * Project-scoped file access
 * Every file a tool reads secrets from or writes output to must sit inside the project root,
 * so a tool call cannot reach arbitrary files on the machine.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Environment variable that pins the project root, for MCP servers started outside the project. */
export const PROJECT_ROOT_ENV = 'ANYPOINT_CONNECT_PROJECT_ROOT';

/** The git toplevel of the working directory, or the working directory itself. */
export function resolveProjectRoot(cwd: string = process.cwd()): string {
    const pinned = process.env[PROJECT_ROOT_ENV];
    if (pinned) return fs.realpathSync(path.resolve(pinned));
    try {
        const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
            cwd,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        if (top) return fs.realpathSync(top);
    } catch {
        // Not a git checkout; fall back to the working directory.
    }
    return fs.realpathSync(path.resolve(cwd));
}

function isInside(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Resolve a path for reading. The real path (symlinks followed) must stay inside the root,
 * and the file must be a regular file no larger than `maxBytes`.
 */
export function resolveReadablePath(
    file: string,
    options: { projectRoot?: string; maxBytes?: number } = {},
): { path: string; size: number } {
    const root = fs.realpathSync(options.projectRoot ?? resolveProjectRoot());
    const absolute = path.resolve(root, file);
    if (!fs.existsSync(absolute)) throw new Error(`File not found: ${file}`);
    const real = fs.realpathSync(absolute);
    if (!isInside(root, real)) throw new Error(`File must be inside the project root (${root}): ${file}`);
    const stat = fs.statSync(real);
    if (!stat.isFile()) throw new Error(`Not a regular file: ${file}`);
    const maxBytes = options.maxBytes ?? 1024 * 1024;
    if (stat.size > maxBytes) throw new Error(`File exceeds ${maxBytes} bytes: ${file}`);
    return { path: real, size: stat.size };
}

/**
 * Resolve a path for writing. The parent directory must exist inside the root, and an
 * existing file is only replaced when `overwrite` is set.
 */
export function resolveWritablePath(file: string, options: { projectRoot?: string; overwrite?: boolean } = {}): string {
    const root = fs.realpathSync(options.projectRoot ?? resolveProjectRoot());
    const absolute = path.resolve(root, file);
    const parent = path.dirname(absolute);
    if (!fs.existsSync(parent)) throw new Error(`Directory not found: ${path.dirname(file)}`);
    const realParent = fs.realpathSync(parent);
    const target = path.join(realParent, path.basename(absolute));
    if (!isInside(root, target)) throw new Error(`File must be inside the project root (${root}): ${file}`);
    if (fs.existsSync(target)) {
        if (fs.lstatSync(target).isSymbolicLink()) throw new Error(`Refusing to write through a symlink: ${file}`);
        if (!options.overwrite) throw new Error(`File exists: ${file}. Pass overwrite to replace it.`);
    }
    return target;
}
