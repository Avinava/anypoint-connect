import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const packageJson = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8'));
const expectedVersion = packageJson.version;
const failures = [];

const packageLock = JSON.parse(readFileSync(join(repositoryRoot, 'package-lock.json'), 'utf8'));
if (packageLock.version !== expectedVersion || packageLock.packages?.['']?.version !== expectedVersion) {
    failures.push('package-lock.json: root versions do not match package.json');
}

const changelog = readFileSync(join(repositoryRoot, 'CHANGELOG.md'), 'utf8');
const latestChangelogVersion = changelog.match(/^## (\d+\.\d+\.\d+)\b/m)?.[1];
if (latestChangelogVersion !== expectedVersion) {
    failures.push(`CHANGELOG.md: newest release does not match ${expectedVersion}`);
}

function collectFiles(path) {
    const absolutePath = join(repositoryRoot, path);
    if (!existsSync(absolutePath)) return [];
    if (!statSync(absolutePath).isDirectory()) return [absolutePath];

    return readdirSync(absolutePath).flatMap((entry) => collectFiles(join(path, entry)));
}

const contentFiles = ['README.md', '.env.example', 'docs', 'examples']
    .flatMap(collectFiles)
    .filter((path) => ['.md', '.json', '.toml', '.example', '.mjs', '.sh', '.ps1'].includes(extname(path)));

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
