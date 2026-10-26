import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import {
    compareJarToGit,
    compareJarToJar,
    diffDependencies,
    gitBlobSha1,
    indexJar,
    jarEntryToRepoCandidates,
    parsePom,
    validateGitRef,
} from '../../src/workflows/artifact-compare.js';

const POM = `<?xml version="1.0"?>
<project>
    <modelVersion>4.0.0</modelVersion>
    <parent><groupId>com.example.parent</groupId><artifactId>parent-pom</artifactId><version>9.9.9</version></parent>
    <groupId>com.example</groupId>
    <artifactId>orders-sapi</artifactId>
    <version>1.2.0</version>
    <properties><http.version>1.9.0</http.version></properties>
    <dependencies>
        <dependency><groupId>org.mule.connectors</groupId><artifactId>mule-http-connector</artifactId><version>\${http.version}</version><classifier>mule-plugin</classifier></dependency>
        <dependency><groupId>org.mule.connectors</groupId><artifactId>mule-db-connector</artifactId><version>1.14.0</version></dependency>
        <dependency><groupId>org.mule.tests</groupId><artifactId>munit-runner</artifactId><version>3.0.0</version><scope>test</scope></dependency>
    </dependencies>
    <build><plugins><plugin><groupId>org.mule.tools.maven</groupId><artifactId>mule-maven-plugin</artifactId><version>4.1.0</version></plugin></plugins></build>
</project>
`;

const SOURCES: Record<string, string> = {
    'src/main/mule/orders-sapi.xml': '<mule><flow name="orders-main"/></mule>\n',
    'src/main/mule/global.xml': '<mule><configuration/></mule>\n',
    'src/main/resources/log4j2.xml': '<Configuration/>\n',
    'src/main/resources/api/orders-sapi.raml': '#%RAML 1.0\ntitle: orders-sapi\n',
    'src/main/resources/config-dev.yaml': 'http:\n  port: "8081"\n',
};

function jarFiles(overrides: Record<string, string | null> = {}, pom = POM): Record<string, string> {
    const files: Record<string, string> = {
        'orders-sapi.xml': SOURCES['src/main/mule/orders-sapi.xml'],
        'global.xml': SOURCES['src/main/mule/global.xml'],
        'log4j2.xml': SOURCES['src/main/resources/log4j2.xml'],
        'api/orders-sapi.raml': SOURCES['src/main/resources/api/orders-sapi.raml'],
        'config-dev.yaml': SOURCES['src/main/resources/config-dev.yaml'],
        'com/example/OrdersHelper.class': 'compiled',
        'META-INF/maven/com.example/orders-sapi/pom.xml': pom,
        'META-INF/maven/com.example/orders-sapi/pom.properties':
            'groupId=com.example\nartifactId=orders-sapi\nversion=' +
            (/<version>(1\.\d+\.\d+)</.exec(pom)?.[1] ?? '') +
            '\n',
        'META-INF/mule-artifact/classloader-model.json': JSON.stringify({
            version: '1.2.0',
            dependencies: [
                {
                    artifactCoordinates: {
                        groupId: 'org.mule.connectors',
                        artifactId: 'mule-http-connector',
                        version: '1.9.0',
                    },
                },
            ],
        }),
        'repository/org/mule/connectors/mule-http-connector/1.9.0/mule-http-connector-1.9.0-mule-plugin.jar': 'x',
    };
    for (const [name, content] of Object.entries(overrides)) {
        if (content === null) delete files[name];
        else files[name] = content;
    }
    return files;
}

function buildJar(files: Record<string, string>): Uint8Array {
    return zipSync(Object.fromEntries(Object.entries(files).map(([name, content]) => [name, strToU8(content)])));
}

function git(cwd: string, ...args: string[]) {
    return execFileSync(
        'git',
        [
            '-c',
            'user.email=dev@example.com',
            '-c',
            'user.name=dev',
            '-c',
            'commit.gpgsign=false',
            '-c',
            'core.hooksPath=/dev/null',
            ...args,
        ],
        { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
}

function writeTree(root: string, files: Record<string, string>) {
    for (const [name, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
        fs.writeFileSync(path.join(root, name), content);
    }
}

describe('artifact compare helpers', () => {
    it('maps jar entries to their source directories', () => {
        expect(jarEntryToRepoCandidates('orders-sapi.xml')).toEqual([
            'src/main/mule/orders-sapi.xml',
            'src/main/resources/orders-sapi.xml',
        ]);
        expect(jarEntryToRepoCandidates('flows/sub.xml')).toEqual([
            'src/main/mule/flows/sub.xml',
            'src/main/resources/flows/sub.xml',
        ]);
        expect(jarEntryToRepoCandidates('api/orders-sapi.raml')).toEqual(['src/main/resources/api/orders-sapi.raml']);
        expect(jarEntryToRepoCandidates('config-dev.yaml')).toEqual(['src/main/resources/config-dev.yaml']);
        expect(jarEntryToRepoCandidates('app.properties')).toEqual(['src/main/resources/app.properties']);
        expect(jarEntryToRepoCandidates('dw/transform.dwl')).toEqual(['src/main/resources/dw/transform.dwl']);
        expect(jarEntryToRepoCandidates('META-INF/maven/com.example/orders-sapi/pom.xml')).toEqual(['pom.xml']);
        expect(jarEntryToRepoCandidates('META-INF/mule-artifact/mule-artifact.json')).toEqual([]);
        expect(jarEntryToRepoCandidates('com/example/OrdersHelper.class')).toEqual([]);
        expect(jarEntryToRepoCandidates('repository/a/b.jar')).toEqual([]);
        expect(jarEntryToRepoCandidates('api/')).toEqual([]);
    });

    it('computes git blob IDs like git hash-object', () => {
        expect(gitBlobSha1(strToU8('hello\n'))).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
    });

    it('refuses refs that look like options or hold odd characters', () => {
        expect(validateGitRef('main')).toBe('main');
        expect(validateGitRef('release/1.2^{tree}')).toBe('release/1.2^{tree}');
        expect(() => validateGitRef('--output=/tmp/x')).toThrow('Invalid git ref');
        expect(() => validateGitRef('main; rm -rf')).toThrow('Invalid git ref');
        expect(() => validateGitRef('')).toThrow('Invalid git ref');
    });

    it('parses pom coordinates and non-test dependencies with properties resolved', () => {
        expect(parsePom(POM)).toEqual({
            groupId: 'com.example',
            artifactId: 'orders-sapi',
            version: '1.2.0',
            dependencies: [
                'org.mule.connectors:mule-http-connector:1.9.0',
                'org.mule.connectors:mule-db-connector:1.14.0',
            ],
        });
    });

    it('diffs dependencies by group and artifact', () => {
        expect(diffDependencies(['g:a:1', 'g:b:1', 'g:c:1'], ['g:a:1', 'g:b:2', 'g:d:1'])).toEqual({
            changed: [{ dependency: 'g:b', deployed: '1', repo: '2' }],
            missingInRepo: ['g:c:1'],
            extraInRepo: ['g:d:1'],
        });
    });

    it('indexes a jar without the repository folder', () => {
        const bytes = buildJar(jarFiles());
        const index = indexJar(bytes);
        expect(index.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
        expect(index.skipped.repository).toBe(1);
        expect([...index.entries.keys()].some((name) => name.startsWith('repository/'))).toBe(false);
        expect(index.pomVersion).toBe('1.2.0');
        expect(index.resolvedDependencies).toEqual(['org.mule.connectors:mule-http-connector:1.9.0']);
    });

    it('refuses a jar whose content exceeds the uncompressed limit', () => {
        expect(() => indexJar(buildJar(jarFiles()), { maxUncompressedBytes: 10 })).toThrow('uncompressed');
    });
});

describe('compareJarToJar', () => {
    it('reports identical jars', () => {
        const bytes = buildJar(jarFiles());
        const result = compareJarToJar(bytes, buildJar(jarFiles()));
        expect(result.verdict).toBe('identical');
        expect(result.changed).toEqual([]);
    });

    it('reports changed, added and removed entries', () => {
        const deployed = buildJar(jarFiles());
        const local = buildJar(
            jarFiles({ 'global.xml': '<mule><changed/></mule>', 'config-dev.yaml': null, 'new.dwl': '%dw 2.0' }),
        );
        const result = compareJarToJar(deployed, local);
        expect(result.verdict).toBe('differs');
        expect(result.sha256.match).toBe(false);
        expect(result.changed.map((c) => c.path)).toEqual(['global.xml']);
        expect(result.missingInRepo.map((c) => c.path)).toEqual(['config-dev.yaml']);
        expect(result.extraInRepo.map((c) => c.path)).toEqual(['new.dwl']);
        expect(JSON.stringify(result)).not.toContain('<changed/>');
    });
});

describe('compareJarToGit', () => {
    let repo: string;

    beforeEach(() => {
        repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'anc-compare-')));
        git(repo, 'init', '-q');
        writeTree(repo, { 'pom.xml': POM, ...SOURCES, 'README.md': 'not packaged\n' });
        git(repo, 'add', '-A');
        git(repo, 'commit', '-q', '-m', 'init');
    });

    afterEach(() => {
        fs.rmSync(repo, { recursive: true, force: true });
    });

    it('reports identical when every packaged file matches HEAD', async () => {
        const result = await compareJarToGit(buildJar(jarFiles()), { repoPath: repo });
        expect(result.verdict).toBe('identical');
        expect(result.pomVersion).toEqual({ deployed: '1.2.0', repo: '1.2.0' });
        expect(result.summary).toMatchObject({ compared: 6, changed: 0, missingInRepo: 0, extraInRepo: 0 });
        expect(result.dependencies).toEqual({ changed: [], missingInRepo: [], extraInRepo: [] });
    });

    it('reports changed, missing and extra paths, a version change and dependency drift', async () => {
        const deployedPom = POM.replace('<version>1.2.0</version>', '<version>1.1.0</version>').replace(
            '1.14.0',
            '1.13.0',
        );
        const deployed = buildJar(
            jarFiles({
                'global.xml': '<mule><old/></mule>\n',
                'legacy.properties': 'a=b\n',
                'config-dev.yaml': null,
                'META-INF/maven/com.example/orders-sapi/pom.xml': deployedPom,
                'META-INF/maven/com.example/orders-sapi/pom.properties': 'version=1.1.0\n',
            }),
        );
        const result = await compareJarToGit(deployed, { repoPath: repo });
        expect(result.verdict).toBe('differs');
        expect(result.pomVersion).toEqual({ deployed: '1.1.0', repo: '1.2.0' });
        expect(result.changed.map((c) => c.path)).toEqual(['pom.xml', 'src/main/mule/global.xml']);
        expect(result.changed[1]).toMatchObject({ jarPath: 'global.xml', deployedSize: 20 });
        expect(result.missingInRepo).toEqual([
            { path: 'src/main/resources/legacy.properties', jarPath: 'legacy.properties', deployedSize: 4 },
        ]);
        expect(result.extraInRepo).toEqual([
            {
                path: 'src/main/resources/config-dev.yaml',
                repoSize: Buffer.byteLength(SOURCES['src/main/resources/config-dev.yaml']),
            },
        ]);
        expect(result.dependencies.changed).toEqual([
            { dependency: 'org.mule.connectors:mule-db-connector', deployed: '1.13.0', repo: '1.14.0' },
        ]);
        expect(JSON.stringify(result)).not.toContain('<old/>');
    });

    it('compares an older ref', async () => {
        fs.writeFileSync(path.join(repo, 'src/main/mule/global.xml'), '<mule><v2/></mule>\n');
        git(repo, 'commit', '-q', '-am', 'v2');
        const deployed = buildJar(jarFiles());
        expect((await compareJarToGit(deployed, { repoPath: repo })).verdict).toBe('differs');
        expect((await compareJarToGit(deployed, { repoPath: repo, gitRef: 'HEAD~1' })).verdict).toBe('identical');
    });

    it('detects uncommitted and untracked working tree changes only when asked', async () => {
        fs.writeFileSync(path.join(repo, 'src/main/mule/global.xml'), '<mule><wip/></mule>\n');
        fs.writeFileSync(path.join(repo, 'src/main/resources/extra.dwl'), '%dw 2.0\n');
        const deployed = buildJar(jarFiles());

        expect((await compareJarToGit(deployed, { repoPath: repo })).verdict).toBe('identical');

        const result = await compareJarToGit(deployed, { repoPath: repo, includeWorkingTree: true });
        expect(result.verdict).toBe('differs');
        expect(result.changed.map((c) => c.path)).toEqual(['src/main/mule/global.xml']);
        expect(result.extraInRepo.map((c) => c.path)).toEqual(['src/main/resources/extra.dwl']);
        expect(result.workingTreeChanges).toEqual([
            { path: 'src/main/mule/global.xml', status: 'M' },
            { path: 'src/main/resources/extra.dwl', status: '??' },
        ]);
    });

    it('treats a deleted working tree file as missing', async () => {
        fs.rmSync(path.join(repo, 'src/main/resources/config-dev.yaml'));
        const result = await compareJarToGit(buildJar(jarFiles()), { repoPath: repo, includeWorkingTree: true });
        expect(result.missingInRepo.map((c) => c.path)).toEqual(['src/main/resources/config-dev.yaml']);
    });

    it('works for a Mule project in a subdirectory of the repository', async () => {
        const mono = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'anc-mono-')));
        try {
            git(mono, 'init', '-q');
            const project = path.join(mono, 'apps', 'orders-sapi');
            writeTree(project, { 'pom.xml': POM, ...SOURCES });
            writeTree(mono, { 'src/main/mule/other.xml': '<mule/>' });
            git(mono, 'add', '-A');
            git(mono, 'commit', '-q', '-m', 'init');
            fs.writeFileSync(path.join(project, 'src/main/resources/config-dev.yaml'), 'changed: true\n');

            const result = await compareJarToGit(buildJar(jarFiles()), {
                repoPath: project,
                includeWorkingTree: true,
            });
            expect(result.extraInRepo).toEqual([]);
            expect(result.changed.map((c) => c.path)).toEqual(['src/main/resources/config-dev.yaml']);
            expect(result.workingTreeChanges).toEqual([{ path: 'src/main/resources/config-dev.yaml', status: 'M' }]);
        } finally {
            fs.rmSync(mono, { recursive: true, force: true });
        }
    });

    it('refuses an option-like ref and a working tree with another ref', async () => {
        const deployed = buildJar(jarFiles());
        await expect(compareJarToGit(deployed, { repoPath: repo, gitRef: '-p' })).rejects.toThrow('Invalid git ref');
        await expect(
            compareJarToGit(deployed, { repoPath: repo, gitRef: 'main', includeWorkingTree: true }),
        ).rejects.toThrow('omit gitRef');
    });
});
