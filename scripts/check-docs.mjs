import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const packageJson = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8'));
const expectedVersion = packageJson.version;
const failures = [];

// Keep release identity checks in one place for CI, manual releases, and docs-only builds.
try {
    execFileSync(process.execPath, [join(repositoryRoot, 'scripts/check-release.mjs')], {
        cwd: repositoryRoot,
        stdio: 'pipe',
    });
} catch (error) {
    failures.push(`Release metadata check failed (${error.message})`);
}

function collectFiles(path) {
    const absolutePath = join(repositoryRoot, path);
    if (!existsSync(absolutePath)) return [];
    if (!statSync(absolutePath).isDirectory()) return [absolutePath];

    return readdirSync(absolutePath).flatMap((entry) => collectFiles(join(path, entry)));
}

const contentFiles = ['README.md', '.env.example', 'docs', 'examples']
    .flatMap(collectFiles)
    .filter((path) => ['.md', '.json', '.toml', '.example', '.mjs', '.sh', '.ps1'].includes(extname(path)))
    .filter((path) => !relative(repositoryRoot, path).startsWith('docs/PLAN-'));

// Identifiers that must never be committed (org, environment, app, or customer names) live in a
// gitignored local file so the denylist itself never enters history. One entry per line.
const denylistPath = join(repositoryRoot, '.identifier-denylist');
const denylist = existsSync(denylistPath)
    ? readFileSync(denylistPath, 'utf8')
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith('#'))
    : [];
const scannedFiles = [...contentFiles, ...['src', 'tests', 'scripts', 'CHANGELOG.md'].flatMap(collectFiles)];

for (const file of scannedFiles) {
    const content = readFileSync(file, 'utf8').toLowerCase();
    for (const identifier of denylist) {
        if (content.includes(identifier.toLowerCase())) {
            failures.push(`${relative(repositoryRoot, file)}: denylisted identifier found`);
        }
    }
}

for (const file of contentFiles) {
    const relativePath = relative(repositoryRoot, file);
    const content = readFileSync(file, 'utf8');

    for (const match of content.matchAll(/@sfdxy\/anypoint-connect@(\d+\.\d+\.\d+)/g)) {
        if (match[1] !== expectedVersion) {
            failures.push(`${relativePath}: package pin ${match[1]} does not match ${expectedVersion}`);
        }
    }

    const credentialLiteral = content.match(/\b[a-f0-9]{24,64}\b/i);
    if (credentialLiteral) {
        failures.push(`${relativePath}: credential-shaped literal found (${credentialLiteral[0].slice(0, 8)}…)`);
    }

    for (const identifier of ['my-api', 'example-api', 'external-sapi']) {
        if (content.includes(identifier)) {
            failures.push(`${relativePath}: legacy sample identifier "${identifier}" found`);
        }
    }
}

// The tool catalog is generated from the registry; fail when the registered tools and the catalog diverge.
const registeredTools = new Set(
    collectFiles('src/mcp/tools')
        .flatMap((file) => [...readFileSync(file, 'utf8').matchAll(/registerTool\(\s*'([a-z_]+)'/g)])
        .map((match) => match[1]),
);
const catalogPath = join(repositoryRoot, 'docs/tools.md');
const catalogTools = new Set(
    existsSync(catalogPath)
        ? [...readFileSync(catalogPath, 'utf8').matchAll(/^\| `([a-z_]+)` \|/gm)].map((match) => match[1])
        : [],
);
for (const tool of registeredTools) {
    if (!catalogTools.has(tool)) failures.push(`docs/tools.md: missing ${tool}; run npm run docs:tools`);
}
for (const tool of catalogTools) {
    if (!registeredTools.has(tool)) failures.push(`docs/tools.md: ${tool} is not registered; run npm run docs:tools`);
}

for (const file of contentFiles.filter((path) => extname(path) === '.md')) {
    const count = readFileSync(file, 'utf8').match(/\b\d+ (?:MCP )?tools\b/);
    if (count) {
        failures.push(
            `${relative(repositoryRoot, file)}: hard-coded tool count "${count[0]}"; link to the catalog instead`,
        );
    }
}

const libraryPackagePath = join(repositoryRoot, 'examples/library/package.json');
const libraryPackage = JSON.parse(readFileSync(libraryPackagePath, 'utf8'));
if (libraryPackage.dependencies?.['@sfdxy/anypoint-connect'] !== expectedVersion) {
    failures.push('examples/library/package.json: dependency version does not match the root package');
}

for (const jsonFile of collectFiles('examples/mcp').filter((path) => extname(path) === '.json')) {
    try {
        JSON.parse(readFileSync(jsonFile, 'utf8'));
    } catch (error) {
        failures.push(`${relative(repositoryRoot, jsonFile)}: invalid JSON (${error.message})`);
    }
}

try {
    execFileSync(process.execPath, ['--check', join(repositoryRoot, 'examples/library/list-apps.mjs')], {
        stdio: 'pipe',
    });
} catch (error) {
    failures.push(`examples/library/list-apps.mjs: syntax check failed (${error.message})`);
}

if (process.platform !== 'win32' && existsSync('/bin/bash')) {
    try {
        execFileSync('/bin/bash', ['-n', join(repositoryRoot, 'examples/cli/readiness.sh')], { stdio: 'pipe' });
    } catch (error) {
        failures.push(`examples/cli/readiness.sh: syntax check failed (${error.message})`);
    }
}

if (failures.length > 0) {
    console.error('Documentation checks failed:');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
}

console.log(`Documentation checks passed for package ${expectedVersion}.`);
