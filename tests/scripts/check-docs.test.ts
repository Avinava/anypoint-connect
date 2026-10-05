import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('documentation release metadata gate', () => {
    let root: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'anc-docs-check-'));
        for (const path of ['scripts', 'package.json', 'package-lock.json', 'CHANGELOG.md', 'examples']) {
            cpSync(join(process.cwd(), path), join(root, path), { recursive: true });
        }
    });

    afterEach(() => rmSync(root, { recursive: true, force: true }));

    function check() {
        // The public docs checker must also work when invoked outside the repository root.
        return spawnSync(process.execPath, [join(root, 'scripts/check-docs.mjs')], {
            cwd: tmpdir(),
            encoding: 'utf8',
        });
    }

    it('accepts matching release metadata', () => {
        const result = check();
        expect(result.stderr).toBe('');
        expect(result.status).toBe(0);
    });

    it.each(['name', 'version'])('rejects a mismatched lockfile root %s', (field) => {
        const path = join(root, 'package-lock.json');
        const lock = JSON.parse(readFileSync(path, 'utf8'));
        lock.packages[''][field] = field === 'name' ? '@sample/wrong-package' : '0.0.0';
        writeFileSync(path, JSON.stringify(lock));
        const result = check();
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(`Lockfile root ${field} must match package.json`);
    });

    it('fails when the tool catalog and the registered tools diverge', () => {
        cpSync(join(process.cwd(), 'src/mcp/tools'), join(root, 'src/mcp/tools'), { recursive: true });
        cpSync(join(process.cwd(), 'docs/tools.md'), join(root, 'docs/tools.md'));
        expect(check().status).toBe(0);

        const catalog = readFileSync(join(root, 'docs/tools.md'), 'utf8');
        writeFileSync(
            join(root, 'docs/tools.md'),
            catalog.replace(/^\| `whoami` \|.*\n/m, '') + '| `retired_tool` | read | — | Gone. |\n',
        );
        const result = check();
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('docs/tools.md: missing whoami');
        expect(result.stderr).toContain('docs/tools.md: retired_tool is not registered');
    });

    it('rejects hard-coded tool counts in documentation', () => {
        writeFileSync(join(root, 'README.md'), 'Ships 42 MCP tools.\n');
        const result = check();
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('hard-coded tool count');
    });

    it('reports release and documentation failures together', () => {
        writeFileSync(join(root, 'CHANGELOG.md'), '## 0.0.0\n');
        writeFileSync(join(root, 'README.md'), '@sfdxy/anypoint-connect@0.0.0\n');
        const result = check();
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Newest changelog release must match package.json');
        expect(result.stderr).toContain('README.md: package pin 0.0.0 does not match');
    });
});
