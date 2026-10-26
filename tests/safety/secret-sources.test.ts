import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    parseProperties,
    resolveSecretSource,
    resolveSecretSources,
    secretSourceSchema,
} from '../../src/safety/secret-sources.js';
import {
    PROJECT_ROOT_ENV,
    resolveProjectRoot,
    resolveReadablePath,
    resolveWritablePath,
} from '../../src/safety/paths.js';

const SECRET = 'value-that-must-not-leak';

let base: string;
let root: string;
let outside: string;

function write(file: string, content: string, dir = root) {
    const full = path.join(dir, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    return full;
}

function errorOf(fn: () => unknown): Error {
    try {
        fn();
    } catch (error) {
        return error as Error;
    }
    throw new Error('expected an error');
}

beforeEach(() => {
    // realpath: on macOS the temp dir is reached through the /var -> /private/var symlink.
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'anc-secret-sources-')));
    root = path.join(base, 'project');
    outside = path.join(base, 'outside');
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
});

afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
});

describe('parseProperties', () => {
    it('handles =, : and whitespace separators', () => {
        expect(parseProperties('a=1\nb: 2\nc 3\nd = spaced value\n')).toEqual({
            a: '1',
            b: '2',
            c: '3',
            d: 'spaced value',
        });
    });

    it('skips # and ! comments and blank lines', () => {
        expect(parseProperties('# comment\n! also a comment\n\n   \nkey=value\n')).toEqual({ key: 'value' });
    });

    it('joins backslash continuations and strips leading whitespace of the next line', () => {
        expect(parseProperties('long = first \\\n    second \\\n  third\nnext=1')).toEqual({
            long: 'first second third',
            next: '1',
        });
    });

    it('does not treat an escaped backslash at the end of a line as a continuation', () => {
        expect(parseProperties('path=C:\\\\\nnext=1')).toEqual({ path: 'C:\\', next: '1' });
    });

    it('decodes \\uXXXX and character escapes in keys and values', () => {
        expect(parseProperties('greeting=caf\\u00e9\ntabbed=a\\tb\nkey\\ with\\ space=v\nhash\\#key=x')).toEqual({
            greeting: 'café',
            tabbed: 'a\tb',
            'key with space': 'v',
            'hash#key': 'x',
        });
    });

    it('handles CRLF line endings and keys without a value', () => {
        expect(parseProperties('a=1\r\nempty\r\n')).toEqual({ a: '1', empty: '' });
    });
});

describe('resolveSecretSource: files', () => {
    it('reads a .env file', () => {
        write('.env', `DB_PASSWORD=${SECRET}\nAPI_TOKEN="quoted value"\n# comment\n`);
        expect(resolveSecretSource({ file: '.env' }, { projectRoot: root })).toEqual({
            DB_PASSWORD: SECRET,
            API_TOKEN: 'quoted value',
        });
    });

    it('reads a .properties file by extension', () => {
        write('conf/secure.properties', 'db.password: abc\nsf.token=def\n');
        expect(resolveSecretSource({ file: 'conf/secure.properties' }, { projectRoot: root })).toEqual({
            'db.password': 'abc',
            'sf.token': 'def',
        });
    });

    it('reads a flat JSON file by extension', () => {
        write('secrets.json', JSON.stringify({ 'db.password': 'abc', 'sf.token': 'def' }));
        expect(resolveSecretSource({ file: 'secrets.json' }, { projectRoot: root })).toEqual({
            'db.password': 'abc',
            'sf.token': 'def',
        });
    });

    it('honors an explicit format over the extension', () => {
        write('secrets.txt', 'a: 1\n');
        expect(resolveSecretSource({ file: 'secrets.txt', format: 'properties' }, { projectRoot: root })).toEqual({
            a: '1',
        });
    });

    it('applies keys, rename and prefix', () => {
        write('.env', 'CRM_PASSWORD=p1\nCRM_TOKEN=t1\nUNUSED=u\n');
        const result = resolveSecretSource(
            {
                file: '.env',
                keys: ['CRM_PASSWORD', 'CRM_TOKEN'],
                rename: { CRM_PASSWORD: 'crm.password' },
                prefix: 'app.',
            },
            { projectRoot: root },
        );
        expect(result).toEqual({ 'app.crm.password': 'p1', 'app.CRM_TOKEN': 't1' });
    });

    it('names missing keys without leaking the values that were found', () => {
        write('.env', `PRESENT=${SECRET}\n`);
        const error = errorOf(() =>
            resolveSecretSource({ file: '.env', keys: ['PRESENT', 'ABSENT'] }, { projectRoot: root }),
        );
        expect(error.message).toBe('Keys not found in .env: ABSENT');
        expect(error.message).not.toContain(SECRET);
    });

    it('rejects JSON with non-string values, naming only the keys', () => {
        write('secrets.json', JSON.stringify({ ok: SECRET, port: 8081, nested: { a: 'b' }, flag: true }));
        const error = errorOf(() => resolveSecretSource({ file: 'secrets.json' }, { projectRoot: root }));
        expect(error.message).toContain('non-string values for: port, nested, flag');
        expect(error.message).not.toContain(SECRET);
    });

    it('rejects a JSON array and invalid JSON', () => {
        write('array.json', '["a"]');
        write('broken.json', '{"a": ');
        expect(() => resolveSecretSource({ file: 'array.json' }, { projectRoot: root })).toThrow(
            'must be a flat JSON object',
        );
        expect(() => resolveSecretSource({ file: 'broken.json' }, { projectRoot: root })).toThrow('is not valid JSON');
    });

    it('rejects a file over 1 MB', () => {
        write('big.env', `A=${'x'.repeat(1024 * 1024)}\n`);
        expect(() => resolveSecretSource({ file: 'big.env' }, { projectRoot: root })).toThrow(
            'File exceeds 1048576 bytes: big.env',
        );
    });

    it('rejects a path that escapes the root with ..', () => {
        write('.env', `A=${SECRET}\n`, outside);
        expect(() => resolveSecretSource({ file: '../outside/.env' }, { projectRoot: root })).toThrow(
            'File must be inside the project root',
        );
    });

    it('rejects an absolute path outside the root', () => {
        const file = write('.env', `A=${SECRET}\n`, outside);
        expect(() => resolveSecretSource({ file }, { projectRoot: root })).toThrow(
            'File must be inside the project root',
        );
    });

    it('rejects a symlink inside the root that points outside it', () => {
        const target = write('.env', `A=${SECRET}\n`, outside);
        fs.symlinkSync(target, path.join(root, 'linked.env'));
        expect(() => resolveSecretSource({ file: 'linked.env' }, { projectRoot: root })).toThrow(
            'File must be inside the project root',
        );
    });

    it('allows a symlink that stays inside the root', () => {
        const target = write('real/.env', 'A=1\n');
        fs.symlinkSync(target, path.join(root, 'alias.env'));
        expect(resolveSecretSource({ file: 'alias.env' }, { projectRoot: root })).toEqual({ A: '1' });
    });

    it('rejects a directory and a missing file', () => {
        fs.mkdirSync(path.join(root, 'conf'));
        expect(() => resolveSecretSource({ file: 'conf' }, { projectRoot: root })).toThrow('Not a regular file: conf');
        expect(() => resolveSecretSource({ file: 'missing.env' }, { projectRoot: root })).toThrow(
            'File not found: missing.env',
        );
    });
});

describe('resolveSecretSource: environment variables', () => {
    it('maps property names to variables', () => {
        const env = { ANC_DB_PASSWORD: SECRET };
        expect(resolveSecretSource({ env: { 'db.password': 'ANC_DB_PASSWORD' } }, { env })).toEqual({
            'db.password': SECRET,
        });
    });

    it('names every missing or empty variable and never a value', () => {
        const env = { ANC_SET: SECRET, ANC_EMPTY: '' };
        const error = errorOf(() =>
            resolveSecretSource({ env: { a: 'ANC_SET', b: 'ANC_MISSING', c: 'ANC_EMPTY' } }, { env }),
        );
        expect(error.message).toBe('Environment variables not set in the server process: ANC_MISSING, ANC_EMPTY');
        expect(error.message).not.toContain(SECRET);
    });
});

describe('resolveSecretSources', () => {
    it('merges sources in order, later sources winning', () => {
        write('.env', 'a=from-file\nb=file-only\n');
        const result = resolveSecretSources([{ file: '.env' }, { env: { a: 'ANC_A' } }], {
            projectRoot: root,
            env: { ANC_A: 'from-env' },
        });
        expect(result).toEqual({ a: 'from-env', b: 'file-only' });
    });

    it('returns an empty record for no sources', () => {
        expect(resolveSecretSources(undefined)).toEqual({});
    });
});

describe('secretSourceSchema', () => {
    it('accepts file and env sources and rejects other shapes', () => {
        expect(secretSourceSchema.safeParse({ file: '.env', keys: ['A'] }).success).toBe(true);
        expect(secretSourceSchema.safeParse({ env: { a: 'B' } }).success).toBe(true);
        expect(secretSourceSchema.safeParse({ value: 'x' }).success).toBe(false);
    });
});

describe('resolveReadablePath', () => {
    it('returns the real path and size', () => {
        const file = write('a.env', 'A=1\n');
        expect(resolveReadablePath('a.env', { projectRoot: root })).toEqual({ path: file, size: 4 });
    });

    it('honors a custom size limit', () => {
        write('a.env', 'A=12345\n');
        expect(() => resolveReadablePath('a.env', { projectRoot: root, maxBytes: 4 })).toThrow('File exceeds 4 bytes');
    });
});

describe('resolveWritablePath', () => {
    it('returns the target for a new file inside the root', () => {
        fs.mkdirSync(path.join(root, 'out'));
        expect(resolveWritablePath('out/creds.env', { projectRoot: root })).toBe(path.join(root, 'out', 'creds.env'));
    });

    it('refuses to overwrite an existing file without the flag', () => {
        write('creds.env', 'A=1\n');
        expect(() => resolveWritablePath('creds.env', { projectRoot: root })).toThrow(
            'File exists: creds.env. Pass overwrite to replace it.',
        );
        expect(resolveWritablePath('creds.env', { projectRoot: root, overwrite: true })).toBe(
            path.join(root, 'creds.env'),
        );
    });

    it('refuses a symlink target even with overwrite', () => {
        const target = write('real.env', 'A=1\n');
        fs.symlinkSync(target, path.join(root, 'link.env'));
        expect(() => resolveWritablePath('link.env', { projectRoot: root, overwrite: true })).toThrow(
            'Refusing to write through a symlink: link.env',
        );
    });

    it('refuses a path outside the root', () => {
        expect(() => resolveWritablePath('../outside/creds.env', { projectRoot: root })).toThrow(
            'File must be inside the project root',
        );
    });

    it('refuses a directory symlink that leads outside the root', () => {
        fs.symlinkSync(outside, path.join(root, 'escape'));
        expect(() => resolveWritablePath('escape/creds.env', { projectRoot: root })).toThrow(
            'File must be inside the project root',
        );
    });

    it('refuses a missing parent directory', () => {
        expect(() => resolveWritablePath('nope/creds.env', { projectRoot: root })).toThrow('Directory not found: nope');
    });
});

describe('resolveProjectRoot', () => {
    const saved = process.env[PROJECT_ROOT_ENV];
    afterEach(() => {
        if (saved === undefined) delete process.env[PROJECT_ROOT_ENV];
        else process.env[PROJECT_ROOT_ENV] = saved;
    });

    it('honors ANYPOINT_CONNECT_PROJECT_ROOT', () => {
        process.env[PROJECT_ROOT_ENV] = root;
        expect(resolveProjectRoot(outside)).toBe(root);
    });

    it('uses the git toplevel of the working directory', () => {
        delete process.env[PROJECT_ROOT_ENV];
        execFileSync('git', ['init', '-q'], { cwd: root });
        const sub = path.join(root, 'src', 'main');
        fs.mkdirSync(sub, { recursive: true });
        expect(resolveProjectRoot(sub)).toBe(root);
    });

    it('falls back to the working directory outside git', () => {
        delete process.env[PROJECT_ROOT_ENV];
        expect(resolveProjectRoot(outside)).toBe(outside);
    });
});
