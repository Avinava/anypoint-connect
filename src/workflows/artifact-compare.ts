/**
 * Deployed artifact comparison
 * Compares a Mule application jar with another jar or with a git checkout of its source.
 * Only names, sizes, versions and hashes are reported, never file contents.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { strFromU8, unzipSync } from 'fflate';
import type { AnypointClient } from '../client/AnypointClient.js';

const execFileAsync = promisify(execFile);

/** Ceiling on the uncompressed size of the indexed entries, against zip bombs. */
const MAX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;

/** Longest list of paths returned per category; the summary keeps the full counts. */
const MAX_LISTED = 200;

/** Repo directories that end up in the jar. */
const MULE_DIR = 'src/main/mule/';
const RESOURCES_DIR = 'src/main/resources/';

export interface JarEntryInfo {
    size: number;
    sha256: string;
    /** Git blob ID of the entry bytes, for comparing with a git tree without reading files. */
    gitSha1: string;
}

export interface PomInfo {
    groupId?: string;
    artifactId?: string;
    version?: string;
    /** Declared, non-test dependencies as `group:artifact:version`. */
    dependencies: string[];
}

export interface JarIndex {
    sha256: string;
    size: number;
    /** Every file entry except `repository/**`. */
    entries: Map<string, JarEntryInfo>;
    pom?: PomInfo;
    pomVersion?: string;
    /** Resolved dependencies from `classloader-model.json`, as `group:artifact:version`. */
    resolvedDependencies?: string[];
    skipped: { repository: number; directories: number };
}

export interface PathDifference {
    path: string;
    jarPath?: string;
    deployedSize?: number;
    repoSize?: number;
}

export interface DependencyDifferences {
    changed: Array<{ dependency: string; deployed: string; repo: string }>;
    missingInRepo: string[];
    extraInRepo: string[];
}

export interface ArtifactComparison {
    verdict: 'identical' | 'differs';
    against: Record<string, unknown>;
    sha256: { deployed: string; repo?: string; match?: boolean };
    pomVersion: { deployed?: string; repo?: string };
    summary: {
        compared: number;
        changed: number;
        missingInRepo: number;
        extraInRepo: number;
        unmapped: number;
        skippedRepositoryEntries: number;
    };
    changed: PathDifference[];
    missingInRepo: PathDifference[];
    extraInRepo: PathDifference[];
    dependencies: DependencyDifferences;
    workingTreeChanges?: Array<{ path: string; status: string }>;
    notes: string[];
}

/** Git blob object ID: SHA-1 over `blob <len>\0` followed by the bytes. */
export function gitBlobSha1(bytes: Uint8Array): string {
    return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/** Refuse refs that git could read as an option, or that hold unexpected characters. */
export function validateGitRef(ref: string): string {
    if (!ref || ref.startsWith('-') || ref.length > 200 || !/^[A-Za-z0-9._/@{}~^+-]+$/.test(ref)) {
        throw new Error(`Invalid git ref: ${JSON.stringify(ref)}`);
    }
    return ref;
}

/**
 * Where a jar entry comes from in a Mule 4 project, most likely first:
 * - `META-INF/maven/<g>/<a>/pom.xml` comes from `pom.xml`;
 * - other `META-INF/**` entries and compiled `*.class` files are generated, so they map nowhere;
 * - an `*.xml` entry comes from `src/main/mule/`, or else `src/main/resources/` (e.g. log4j2.xml);
 * - anything else (`api/**`, `*.properties`, `*.yaml`, `*.json`, `*.dwl`, ...) comes from `src/main/resources/`.
 */
export function jarEntryToRepoCandidates(entry: string): string[] {
    if (!entry || entry.endsWith('/') || entry.startsWith('repository/')) return [];
    if (/^META-INF\/maven\/[^/]+\/[^/]+\/pom\.xml$/.test(entry)) return ['pom.xml'];
    if (entry.startsWith('META-INF/') || entry.endsWith('.class')) return [];
    if (entry.toLowerCase().endsWith('.xml')) return [`${MULE_DIR}${entry}`, `${RESOURCES_DIR}${entry}`];
    return [`${RESOURCES_DIR}${entry}`];
}

/** True for a repo path that the build copies into the jar. */
function isPackagedRepoPath(file: string): boolean {
    return file === 'pom.xml' || file.startsWith(MULE_DIR) || file.startsWith(RESOURCES_DIR);
}

function stripBlocks(xml: string, tags: string[]): string {
    let result = xml;
    for (const tag of tags) result = result.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'g'), '');
    return result;
}

function firstTag(xml: string, tag: string): string | undefined {
    return new RegExp(`<${tag}>\\s*([^<]*?)\\s*</${tag}>`).exec(xml)?.[1];
}

/**
 * Read a pom's own coordinates and its declared dependencies. `${...}` placeholders are
 * resolved from `<properties>` and the project coordinates; anything else is left as is.
 */
export function parsePom(xml: string): PomInfo {
    const clean = xml.replace(/<!--[\s\S]*?-->/g, '');
    const properties: Record<string, string> = {};
    const propertiesBlock = /<properties>([\s\S]*?)<\/properties>/.exec(clean)?.[1] ?? '';
    for (const match of propertiesBlock.matchAll(/<([\w.-]+)>\s*([^<]*?)\s*<\/\1>/g)) properties[match[1]] = match[2];

    const parent = /<parent>([\s\S]*?)<\/parent>/.exec(clean)?.[1] ?? '';
    const top = stripBlocks(clean, [
        'parent',
        'dependencyManagement',
        'build',
        'profiles',
        'reporting',
        'pluginRepositories',
        'repositories',
        'distributionManagement',
    ]);
    const own = stripBlocks(top, ['dependencies', 'properties']);
    const groupId = firstTag(own, 'groupId') ?? firstTag(parent, 'groupId');
    const artifactId = firstTag(own, 'artifactId');
    const rawVersion = firstTag(own, 'version') ?? firstTag(parent, 'version');

    const resolve = (value: string | undefined): string | undefined =>
        value?.replace(/\$\{([^}]+)\}/g, (placeholder, name: string) => {
            if (name === 'project.version' || name === 'version') return rawVersion ?? placeholder;
            if (name === 'project.groupId' || name === 'groupId') return groupId ?? placeholder;
            if (name === 'project.artifactId' || name === 'artifactId') return artifactId ?? placeholder;
            return properties[name] ?? placeholder;
        });

    const dependencies: string[] = [];
    const dependenciesBlock = /<dependencies>([\s\S]*?)<\/dependencies>/.exec(top)?.[1] ?? '';
    for (const match of dependenciesBlock.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
        const body = stripBlocks(match[1], ['exclusions']);
        if (firstTag(body, 'scope') === 'test') continue;
        const g = resolve(firstTag(body, 'groupId'));
        const a = resolve(firstTag(body, 'artifactId'));
        if (!g || !a) continue;
        dependencies.push(`${g}:${a}:${resolve(firstTag(body, 'version')) ?? 'managed'}`);
    }

    return { groupId: resolve(groupId), artifactId: resolve(artifactId), version: resolve(rawVersion), dependencies };
}

function parseClassloaderModel(text: string): string[] | undefined {
    try {
        const model = JSON.parse(text) as {
            dependencies?: Array<{ artifactCoordinates?: { groupId?: string; artifactId?: string; version?: string } }>;
        };
        return (model.dependencies ?? [])
            .map((d) => d.artifactCoordinates)
            .filter((c): c is { groupId: string; artifactId: string; version: string } =>
                Boolean(c?.groupId && c.artifactId),
            )
            .map((c) => `${c.groupId}:${c.artifactId}:${c.version ?? '?'}`);
    } catch {
        return undefined;
    }
}

/** Index a Mule application jar: hashes per entry, the pom and the resolved dependencies. */
export function indexJar(bytes: Uint8Array, options: { maxUncompressedBytes?: number } = {}): JarIndex {
    const limit = options.maxUncompressedBytes ?? MAX_UNCOMPRESSED_BYTES;
    const skipped = { repository: 0, directories: 0 };
    let total = 0;
    const files = unzipSync(bytes, {
        filter(entry) {
            if (entry.name.startsWith('repository/')) {
                skipped.repository++;
                return false;
            }
            if (entry.name.endsWith('/')) {
                skipped.directories++;
                return false;
            }
            total += entry.originalSize;
            if (total > limit) throw new Error(`Jar content exceeds ${limit} bytes uncompressed`);
            return true;
        },
    });

    const entries = new Map<string, JarEntryInfo>();
    for (const [name, content] of Object.entries(files)) {
        entries.set(name, {
            size: content.length,
            sha256: createHash('sha256').update(content).digest('hex'),
            gitSha1: gitBlobSha1(content),
        });
    }

    const pomXmlName = Object.keys(files).find((name) => /^META-INF\/maven\/[^/]+\/[^/]+\/pom\.xml$/.test(name));
    const pomPropsName = Object.keys(files).find((name) =>
        /^META-INF\/maven\/[^/]+\/[^/]+\/pom\.properties$/.test(name),
    );
    const pom = pomXmlName ? parsePom(strFromU8(files[pomXmlName])) : undefined;
    const propsVersion = pomPropsName
        ? /^\s*version\s*[=:]\s*(\S+)\s*$/m.exec(strFromU8(files[pomPropsName]))?.[1]
        : undefined;
    const model = files['META-INF/mule-artifact/classloader-model.json'];

    return {
        sha256: createHash('sha256').update(bytes).digest('hex'),
        size: bytes.length,
        entries,
        pom,
        pomVersion: propsVersion ?? pom?.version,
        resolvedDependencies: model ? parseClassloaderModel(strFromU8(model)) : undefined,
        skipped,
    };
}

function splitCoordinate(coordinate: string): { key: string; version: string } {
    const parts = coordinate.split(':');
    return { key: parts.slice(0, 2).join(':'), version: parts.slice(2).join(':') };
}

/** Compare two dependency lists by `group:artifact`, reporting version changes and one-sided entries. */
export function diffDependencies(deployed: string[] = [], repo: string[] = []): DependencyDifferences {
    const left = new Map(deployed.map((d) => [splitCoordinate(d).key, splitCoordinate(d).version]));
    const right = new Map(repo.map((d) => [splitCoordinate(d).key, splitCoordinate(d).version]));
    const result: DependencyDifferences = { changed: [], missingInRepo: [], extraInRepo: [] };
    for (const [key, version] of left) {
        if (!right.has(key)) result.missingInRepo.push(`${key}:${version}`);
        else if (right.get(key) !== version)
            result.changed.push({ dependency: key, deployed: version, repo: right.get(key)! });
    }
    for (const [key, version] of right) if (!left.has(key)) result.extraInRepo.push(`${key}:${version}`);
    return result;
}

function hasDependencyDifferences(diff: DependencyDifferences): boolean {
    return diff.changed.length + diff.missingInRepo.length + diff.extraInRepo.length > 0;
}

function finish(
    base: Omit<ArtifactComparison, 'verdict' | 'summary' | 'changed' | 'missingInRepo' | 'extraInRepo'>,
    lists: { changed: PathDifference[]; missingInRepo: PathDifference[]; extraInRepo: PathDifference[] },
    counts: { compared: number; unmapped: number; skippedRepositoryEntries: number },
): ArtifactComparison {
    const byPath = (a: PathDifference, b: PathDifference) => a.path.localeCompare(b.path);
    const differs =
        lists.changed.length + lists.missingInRepo.length + lists.extraInRepo.length > 0 ||
        hasDependencyDifferences(base.dependencies) ||
        Boolean(base.pomVersion.deployed && base.pomVersion.repo && base.pomVersion.deployed !== base.pomVersion.repo);
    const notes = [...base.notes];
    for (const [name, list] of Object.entries(lists)) {
        if (list.length > MAX_LISTED) notes.push(`${name} lists the first ${MAX_LISTED} of ${list.length} paths`);
    }
    return {
        verdict: differs ? 'differs' : 'identical',
        ...base,
        summary: {
            compared: counts.compared,
            changed: lists.changed.length,
            missingInRepo: lists.missingInRepo.length,
            extraInRepo: lists.extraInRepo.length,
            unmapped: counts.unmapped,
            skippedRepositoryEntries: counts.skippedRepositoryEntries,
        },
        changed: lists.changed.sort(byPath).slice(0, MAX_LISTED),
        missingInRepo: lists.missingInRepo.sort(byPath).slice(0, MAX_LISTED),
        extraInRepo: lists.extraInRepo.sort(byPath).slice(0, MAX_LISTED),
        notes,
    };
}

/**
 * Compare the deployed jar with a local jar. "Repo" in the output means the local jar.
 * Equal SHA-256 short-circuits; otherwise every entry outside `repository/` is compared,
 * so a rebuild that only changed timestamps still counts as identical.
 */
export function compareJarToJar(deployedBytes: Uint8Array, localBytes: Uint8Array, localLabel = 'local jar') {
    const deployed = indexJar(deployedBytes);
    const local = deployedBytes === localBytes ? deployed : indexJar(localBytes);
    const changed: PathDifference[] = [];
    const missingInRepo: PathDifference[] = [];
    const extraInRepo: PathDifference[] = [];

    if (deployed.sha256 !== local.sha256) {
        for (const [name, entry] of deployed.entries) {
            const other = local.entries.get(name);
            if (!other) missingInRepo.push({ path: name, deployedSize: entry.size });
            else if (other.sha256 !== entry.sha256)
                changed.push({ path: name, deployedSize: entry.size, repoSize: other.size });
        }
        for (const [name, entry] of local.entries) {
            if (!deployed.entries.has(name)) extraInRepo.push({ path: name, repoSize: entry.size });
        }
    }

    const notes: string[] = [];
    if (!deployed.resolvedDependencies || !local.resolvedDependencies) {
        notes.push('A jar has no classloader-model.json; dependencies compared from the declared pom dependencies');
    }
    const dependencies =
        deployed.resolvedDependencies && local.resolvedDependencies
            ? diffDependencies(deployed.resolvedDependencies, local.resolvedDependencies)
            : diffDependencies(deployed.pom?.dependencies, local.pom?.dependencies);

    return finish(
        {
            against: { type: 'jar', path: localLabel, size: local.size },
            sha256: { deployed: deployed.sha256, repo: local.sha256, match: deployed.sha256 === local.sha256 },
            pomVersion: { deployed: deployed.pomVersion, repo: local.pomVersion },
            dependencies,
            notes,
        },
        { changed, missingInRepo, extraInRepo },
        {
            compared: deployed.entries.size,
            unmapped: 0,
            skippedRepositoryEntries: deployed.skipped.repository,
        },
    );
}

async function git(repoPath: string, args: string[]): Promise<string> {
    try {
        const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args], {
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
            env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
        });
        return stdout;
    } catch (error) {
        const stderr = (error as { stderr?: string }).stderr?.trim();
        throw new Error(`git ${args[0]} failed${stderr ? `: ${stderr.split('\n')[0]}` : ''}`);
    }
}

interface RepoEntry {
    oid: string;
    size: number;
}

/** List packaged files at a ref, relative to the project directory, without reading their contents. */
async function listTree(repoPath: string, ref: string): Promise<Map<string, RepoEntry>> {
    const out = await git(repoPath, ['ls-tree', '-r', '-l', '-z', ref, '--', 'pom.xml', MULE_DIR, RESOURCES_DIR]);
    const entries = new Map<string, RepoEntry>();
    for (const record of out.split('\0')) {
        const tab = record.indexOf('\t');
        if (tab < 0) continue;
        const [, type, oid, size] = record.slice(0, tab).split(/\s+/);
        if (type !== 'blob') continue;
        entries.set(record.slice(tab + 1), { oid, size: Number(size) });
    }
    return entries;
}

/**
 * Overlay uncommitted and untracked changes in the packaged paths onto a tree listing. Changed
 * files are hashed as git blobs in place; their contents are never returned.
 */
async function overlayWorkingTree(
    repoPath: string,
    entries: Map<string, RepoEntry>,
): Promise<Array<{ path: string; status: string }>> {
    const prefix = (await git(repoPath, ['rev-parse', '--show-prefix'])).trim();
    const out = await git(repoPath, [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
        '--',
        'pom.xml',
        MULE_DIR,
        RESOURCES_DIR,
    ]);
    const records = out.split('\0').filter(Boolean);
    const changes: Array<{ path: string; status: string }> = [];
    const touched: string[] = [];
    for (let i = 0; i < records.length; i++) {
        const status = records[i].slice(0, 2);
        const file = records[i].slice(3);
        if (status[0] === 'R' || status[0] === 'C') touched.push(records[++i]);
        touched.push(file);
        const relative = file.startsWith(prefix) ? file.slice(prefix.length) : file;
        changes.push({ path: relative, status: status.trim() });
    }

    for (const file of touched) {
        if (!file.startsWith(prefix)) continue;
        const relative = file.slice(prefix.length);
        const absolute = path.join(repoPath, relative);
        let stat: fs.Stats;
        try {
            stat = fs.lstatSync(absolute);
        } catch {
            entries.delete(relative);
            continue;
        }
        const bytes = stat.isSymbolicLink()
            ? Buffer.from(fs.readlinkSync(absolute))
            : stat.isFile()
              ? fs.readFileSync(absolute)
              : undefined;
        if (!bytes) continue;
        entries.set(relative, { oid: gitBlobSha1(bytes), size: bytes.length });
    }
    return changes;
}

function readRepoPom(repoPath: string, ref: string, workingTree: boolean): Promise<string | undefined> {
    if (workingTree) {
        const file = path.join(repoPath, 'pom.xml');
        return Promise.resolve(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined);
    }
    return git(repoPath, ['show', `${ref}:./pom.xml`]).catch(() => undefined);
}

/**
 * Compare the deployed jar with a git checkout of its source, by git blob ID. `repoPath` is the
 * Mule project directory (it may be a subdirectory of a larger repository).
 */
export async function compareJarToGit(
    deployedBytes: Uint8Array,
    options: { repoPath: string; gitRef?: string; includeWorkingTree?: boolean },
): Promise<ArtifactComparison> {
    const ref = validateGitRef(options.gitRef ?? 'HEAD');
    if (options.includeWorkingTree && ref !== 'HEAD') {
        throw new Error('includeWorkingTree compares the working tree, which is based on HEAD; omit gitRef');
    }
    const repoPath = path.resolve(options.repoPath);
    const deployed = indexJar(deployedBytes);
    const repo = await listTree(repoPath, ref);
    const workingTreeChanges = options.includeWorkingTree ? await overlayWorkingTree(repoPath, repo) : undefined;

    const changed: PathDifference[] = [];
    const missingInRepo: PathDifference[] = [];
    const claimed = new Set<string>();
    let compared = 0;
    let unmapped = 0;
    for (const [name, entry] of deployed.entries) {
        const candidates = jarEntryToRepoCandidates(name);
        if (candidates.length === 0) {
            unmapped++;
            continue;
        }
        compared++;
        const match = candidates.find((candidate) => repo.has(candidate));
        if (!match) {
            missingInRepo.push({ path: candidates[0], jarPath: name, deployedSize: entry.size });
            continue;
        }
        claimed.add(match);
        const repoEntry = repo.get(match)!;
        if (repoEntry.oid !== entry.gitSha1) {
            changed.push({ path: match, jarPath: name, deployedSize: entry.size, repoSize: repoEntry.size });
        }
    }
    const extraInRepo: PathDifference[] = [...repo.entries()]
        .filter(([file]) => isPackagedRepoPath(file) && !claimed.has(file))
        .map(([file, entry]) => ({ path: file, repoSize: entry.size }));

    const pomText = await readRepoPom(repoPath, ref, Boolean(options.includeWorkingTree));
    const repoPom = pomText ? parsePom(pomText) : undefined;
    const notes = [
        'Compiled classes and generated META-INF files are not compared',
        'Resources changed by Maven filtering at build time show as changed',
    ];
    if (!repoPom) notes.push('No pom.xml found in the repo');

    return finish(
        {
            against: {
                type: 'git',
                repoPath,
                gitRef: ref,
                includeWorkingTree: Boolean(options.includeWorkingTree),
            },
            sha256: { deployed: deployed.sha256 },
            pomVersion: { deployed: deployed.pomVersion, repo: repoPom?.version },
            dependencies: diffDependencies(deployed.pom?.dependencies, repoPom?.dependencies),
            notes,
            ...(workingTreeChanges ? { workingTreeChanges } : {}),
        },
        { changed, missingInRepo, extraInRepo },
        { compared, unmapped, skippedRepositoryEntries: deployed.skipped.repository },
    );
}

/** Fetch the jar an application currently runs, from Exchange, bounded by `maxBytes`. */
export async function fetchDeployedJar(
    client: AnypointClient,
    orgId: string,
    env: { id: string; name: string },
    appName: string,
    options: { maxBytes?: number } = {},
) {
    const deployment = await client.cloudHub2.findDetailByName(orgId, env.id, appName);
    if (!deployment) throw new Error(`Application "${appName}" not found in ${env.name}`);
    const { groupId, artifactId, version } = deployment.application.ref;
    const jar = await client.exchange.downloadAppJar(orgId, groupId, artifactId, version, options);
    return { ref: { groupId, artifactId, version }, ...jar };
}
