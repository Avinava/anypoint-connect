import { createHash, randomBytes } from 'node:crypto';
import type { DesignCenterApi, PublishToExchangeOptions } from './DesignCenterApi.js';
import type { ExchangeApi } from './ExchangeApi.js';

const PREVIEW_TTL_MS = 10 * 60 * 1000;

type PreviewKind = 'create-project' | 'sync-files' | 'publish-exchange';

interface PreviewRecord<T> {
    kind: PreviewKind;
    payload: T;
    expiresAt: number;
}

export interface DesignCenterFileInput {
    path: string;
    content: string;
}

export interface SyncPlanEntry {
    path: string;
    action: 'create' | 'update' | 'unchanged';
    localHash: string;
    remoteHash: string | null;
}

interface SyncPayload {
    orgId: string;
    projectId: string;
    projectName: string;
    branch: string;
    files: DesignCenterFileInput[];
    entries: SyncPlanEntry[];
    commitMessage?: string;
}

interface CreatePayload {
    orgId: string;
    name: string;
    classifier: 'raml' | 'oas';
}

interface PublishPayload {
    orgId: string;
    projectId: string;
    projectName: string;
    branch: string;
    options: PublishToExchangeOptions;
    mainFile: string;
    sourceHash: string;
}

function hash(content: string | Buffer, algorithm: 'sha256' | 'md5' = 'sha256'): string {
    return createHash(algorithm).update(content).digest('hex');
}

function safePath(requested: string): string {
    if (!requested || requested.includes('\\') || requested.startsWith('/')) {
        throw new Error(`Unsafe Design Center path: ${requested}`);
    }
    const segments = requested.split('/');
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
        throw new Error(`Unsafe Design Center path: ${requested}`);
    }
    if (segments[0]?.toLowerCase() === 'exchange_modules') {
        throw new Error('Managed exchange_modules content cannot be synchronized.');
    }
    return segments.join('/');
}

export class DesignCenterWorkflow {
    private readonly previews = new Map<string, PreviewRecord<unknown>>();

    constructor(
        private readonly designCenter: DesignCenterApi,
        private readonly exchange: ExchangeApi,
    ) {}

    private issue<T>(kind: PreviewKind, payload: T): { previewToken: string; expiresAt: string } {
        const previewToken = randomBytes(24).toString('base64url');
        const expiresAt = Date.now() + PREVIEW_TTL_MS;
        this.previews.set(previewToken, { kind, payload, expiresAt });
        return { previewToken, expiresAt: new Date(expiresAt).toISOString() };
    }

    private consume<T>(kind: PreviewKind, token: string): T {
        const preview = this.previews.get(token);
        this.previews.delete(token);
        if (!preview || preview.kind !== kind) throw new Error('Preview token is invalid or already used.');
        if (preview.expiresAt <= Date.now()) throw new Error('Preview token expired; generate a new preview.');
        return preview.payload as T;
    }

    async previewProjectCreate(orgId: string, name: string, classifier: 'raml' | 'oas') {
        const projects = await this.designCenter.getProjects(orgId, true);
        if (projects.some((project) => project.name.toLowerCase() === name.toLowerCase())) {
            throw new Error(`A Design Center project named "${name}" already exists.`);
        }
        return {
            action: 'create' as const,
            name,
            classifier,
            ...this.issue<CreatePayload>('create-project', { orgId, name, classifier }),
        };
    }

    async createProject(previewToken: string) {
        const payload = this.consume<CreatePayload>('create-project', previewToken);
        return this.designCenter.createProject(payload.orgId, payload.name, payload.classifier);
    }

    async previewSync(
        orgId: string,
        projectNameOrId: string,
        files: DesignCenterFileInput[],
        branch = 'master',
        commitMessage?: string,
    ) {
        const project = await this.designCenter.findByNameOrThrow(orgId, projectNameOrId);
        const normalized = files.map((file) => ({ path: safePath(file.path), content: file.content }));
        if (new Set(normalized.map((file) => file.path)).size !== normalized.length) {
            throw new Error('The sync input contains duplicate paths.');
        }
        const remoteFiles = await this.designCenter.getFiles(orgId, project.id, branch);
        const remotePaths = new Set(
            remoteFiles
                .filter((file) => file.type.toLowerCase() === 'file')
                .map((file) => file.path.replace(/^\//, '')),
        );
        const entries: SyncPlanEntry[] = [];
        for (const file of normalized) {
            const localHash = hash(file.content);
            if (!remotePaths.has(file.path)) {
                entries.push({ path: file.path, action: 'create', localHash, remoteHash: null });
                continue;
            }
            const remoteContent = await this.designCenter.getFileContent(orgId, project.id, file.path, branch);
            const remoteHash = hash(remoteContent);
            entries.push({
                path: file.path,
                action: remoteHash === localHash ? 'unchanged' : 'update',
                localHash,
                remoteHash,
            });
        }
        const payload: SyncPayload = {
            orgId,
            projectId: project.id,
            projectName: project.name,
            branch,
            files: normalized,
            entries,
            ...(commitMessage ? { commitMessage } : {}),
        };
        return { project: project.name, branch, entries, ...this.issue<SyncPayload>('sync-files', payload) };
    }

    async sync(previewToken: string) {
        const payload = this.consume<SyncPayload>('sync-files', previewToken);
        return this.designCenter.withLock(payload.orgId, payload.projectId, payload.branch, async () => {
            const currentFiles = await this.designCenter.getFiles(payload.orgId, payload.projectId, payload.branch);
            const currentPaths = new Set(
                currentFiles
                    .filter((file) => file.type.toLowerCase() === 'file')
                    .map((file) => file.path.replace(/^\//, '')),
            );
            const conflicts: string[] = [];
            for (const entry of payload.entries) {
                const exists = currentPaths.has(entry.path);
                if (!exists && entry.remoteHash !== null) {
                    conflicts.push(entry.path);
                    continue;
                }
                if (exists) {
                    const content = await this.designCenter.getFileContent(
                        payload.orgId,
                        payload.projectId,
                        entry.path,
                        payload.branch,
                    );
                    if (hash(content) !== entry.remoteHash) conflicts.push(entry.path);
                }
            }
            if (conflicts.length > 0) {
                throw new Error(`Design Center changed after preview; sync aborted for: ${conflicts.join(', ')}`);
            }
            const changed = payload.entries.filter((entry) => entry.action !== 'unchanged');
            if (changed.length > 0) {
                await this.designCenter.maintainLock(payload.orgId, payload.projectId, payload.branch);
                const byPath = new Map(payload.files.map((file) => [file.path, file]));
                await this.designCenter.saveFiles(
                    payload.orgId,
                    payload.projectId,
                    changed.map((entry) => byPath.get(entry.path) as DesignCenterFileInput),
                    payload.branch,
                    payload.commitMessage,
                );
                for (const entry of changed) {
                    const saved = await this.designCenter.getFileContent(
                        payload.orgId,
                        payload.projectId,
                        entry.path,
                        payload.branch,
                    );
                    if (hash(saved) !== entry.localHash)
                        throw new Error(`Post-save verification failed for ${entry.path}.`);
                }
            }
            return {
                project: payload.projectName,
                branch: payload.branch,
                changed: changed.length,
                entries: payload.entries,
            };
        });
    }

    async previewPublication(
        orgId: string,
        projectNameOrId: string,
        options: PublishToExchangeOptions,
        branch = 'master',
    ) {
        const project = await this.designCenter.findByNameOrThrow(orgId, projectNameOrId);
        const exchangeMeta = await this.designCenter.getExchangeJson(orgId, project.id, branch);
        const mainFile = safePath(options.main || (exchangeMeta?.main as string) || '');
        const source = await this.designCenter.getFileContent(orgId, project.id, mainFile, branch);
        const resolvedOptions: PublishToExchangeOptions = {
            ...options,
            main: mainFile,
            groupId: options.groupId || (exchangeMeta?.groupId as string) || orgId,
            assetId: options.assetId || (exchangeMeta?.assetId as string) || options.name,
        };
        const payload: PublishPayload = {
            orgId,
            projectId: project.id,
            projectName: project.name,
            branch,
            options: resolvedOptions,
            mainFile,
            sourceHash: hash(source),
        };
        return {
            project: project.name,
            branch,
            coordinates: {
                groupId: resolvedOptions.groupId,
                assetId: resolvedOptions.assetId,
                version: resolvedOptions.version,
            },
            apiVersion: resolvedOptions.apiVersion,
            classifier: resolvedOptions.classifier,
            mainFile,
            sourceHash: payload.sourceHash,
            ...this.issue<PublishPayload>('publish-exchange', payload),
        };
    }

    async publish(previewToken: string) {
        const payload = this.consume<PublishPayload>('publish-exchange', previewToken);
        const result = await this.designCenter.withLock(payload.orgId, payload.projectId, payload.branch, async () => {
            const current = await this.designCenter.getFileContent(
                payload.orgId,
                payload.projectId,
                payload.mainFile,
                payload.branch,
            );
            if (hash(current) !== payload.sourceHash)
                throw new Error('The main contract changed after publication preview.');
            return this.designCenter.publishToExchangeLocked(
                payload.orgId,
                payload.projectId,
                payload.options,
                payload.branch,
            );
        });
        const downloaded = await this.exchange.downloadSpecArtifact(result.groupId, result.assetId, result.version);
        if (!downloaded.metadataHashMatches)
            throw new Error('Exchange artifact hash verification failed after publication.');
        return { ...result, sourceHash: payload.sourceHash, exchangeArtifactHash: downloaded.sha256, verified: true };
    }
}
