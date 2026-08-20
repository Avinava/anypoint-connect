/**
 * Design Center API
 * Manage API specification projects: list, read files, save changes, publish to Exchange
 * Uses the lock/save/unlock pattern for write operations.
 *
 * Note: Most Design Center endpoints require both x-organization-id and x-owner-id headers.
 * The owner ID is the authenticated user's ID (from /accounts/api/me).
 */

import type { HttpClient } from '../client/HttpClient.js';
import type { Cache } from '../client/Cache.js';
import { errorMessage } from '../utils/errors.js';

// ── Interfaces ─────────────────────────────────────

export interface DesignCenterProject {
    id: string;
    name: string;
    type: string; // 'raml' | 'raml-fragment' | 'oas' | 'graphql'
    organizationId: string;
    createdDate?: string;
    lastModifiedDate?: string;
    createdBy?: { firstName: string; lastName: string; userName: string };
}

export interface DesignCenterFile {
    path: string;
    type: string; // 'FILE' | 'FOLDER' (DC API returns uppercase)
    language?: string;
}

export interface DesignCenterBranch {
    name: string;
    commitId?: string;
    isDefault?: boolean;
}

export interface DesignCenterSaveFile {
    path: string;
    content: string;
}

export interface PublishToExchangeOptions {
    name: string;
    apiVersion: string;
    version: string; // asset version (semver)
    classifier: string; // 'raml' | 'raml-fragment' | 'oas' | 'oas3'
    main?: string; // main file name
    groupId?: string; // defaults to org ID
    assetId?: string; // defaults to project name slugified
}

// ── API ────────────────────────────────────────────

const BASE = '/designcenter/api-designer';

export class DesignCenterApi {
    constructor(
        private readonly http: HttpClient,
        private readonly cache: Cache,
    ) {}

    /**
     * Build the required headers for Design Center API calls.
     * Most endpoints need both x-organization-id and x-owner-id.
     */
    private dcHeaders(orgId: string, ownerId: string, extra?: Record<string, string>) {
        return {
            'x-organization-id': orgId,
            'x-owner-id': ownerId,
            ...extra,
        };
    }

    /**
     * Get the authenticated user's ID (needed for x-owner-id header).
     */
    async getOwnerId(): Promise<string> {
        return this.cache.getOrCompute('dc:ownerId', async () => {
            const me = await this.http.get<{ user: { id: string } }>('/accounts/api/me');
            return me.user.id;
        });
    }

    // ── Projects ───────────────────────────────────

    /**
     * List all Design Center projects in the organization.
     */
    async getProjects(orgId: string, refresh = false): Promise<DesignCenterProject[]> {
        const ownerId = await this.getOwnerId();
        const cacheKey = `dc:projects:${orgId}`;
        if (refresh) this.cache.delete(cacheKey);
        return this.cache.getOrCompute(cacheKey, async () => {
            return this.http.get<DesignCenterProject[]>(`${BASE}/projects`, {
                headers: this.dcHeaders(orgId, ownerId),
            });
        });
    }

    /**
     * Get project details by ID.
     */
    async getProject(orgId: string, projectId: string): Promise<DesignCenterProject> {
        const ownerId = await this.getOwnerId();
        return this.http.get<DesignCenterProject>(`${BASE}/projects/${projectId}`, {
            headers: this.dcHeaders(orgId, ownerId),
        });
    }

    /** Find a project by exact name. Partial project matching is intentionally unsafe. */
    async findByName(orgId: string, name: string): Promise<DesignCenterProject | null> {
        const projects = await this.getProjects(orgId);
        const exact = projects.find((project) => project.name === name);
        if (exact) return exact;
        const insensitive = projects.filter((project) => project.name.toLowerCase() === name.toLowerCase());
        if (insensitive.length > 1) {
            throw new Error(`Multiple projects have the same case-insensitive name "${name}"; use the project ID.`);
        }
        return insensitive[0] || null;
    }

    /**
     * Find a project by name, throwing if not found.
     * Preferred over findByName when the project must exist.
     */
    async findByNameOrThrow(orgId: string, name: string): Promise<DesignCenterProject> {
        const projects = await this.getProjects(orgId);
        const byId = projects.find((candidate) => candidate.id === name);
        const project = byId || (await this.findByName(orgId, name));
        if (!project) {
            throw new Error(`Project "${name}" not found. Use list_design_center_projects to see available projects.`);
        }
        return project;
    }

    /** Create a new API design project after an exact collision check. */
    async createProject(orgId: string, name: string, classifier: 'raml' | 'oas'): Promise<DesignCenterProject> {
        const projects = await this.getProjects(orgId, true);
        if (projects.some((project) => project.name.toLowerCase() === name.toLowerCase())) {
            throw new Error(`A Design Center project named "${name}" already exists.`);
        }
        const ownerId = await this.getOwnerId();
        const project = await this.http.post<DesignCenterProject>(
            `${BASE}/projects`,
            { name, classifier },
            { headers: this.dcHeaders(orgId, ownerId, { Accept: 'application/json' }) },
        );
        this.cache.delete(`dc:projects:${orgId}`);
        return project;
    }

    // ── Branches ───────────────────────────────────

    /**
     * List branches for a project.
     */
    async getBranches(orgId: string, projectId: string): Promise<DesignCenterBranch[]> {
        const ownerId = await this.getOwnerId();
        return this.http.get<DesignCenterBranch[]>(`${BASE}/projects/${projectId}/branches`, {
            headers: this.dcHeaders(orgId, ownerId),
        });
    }

    async createBranch(orgId: string, projectId: string, name: string, commitId?: string): Promise<DesignCenterBranch> {
        const ownerId = await this.getOwnerId();
        return this.http.post<DesignCenterBranch>(
            `${BASE}/projects/${projectId}/branches`,
            { name, ...(commitId ? { commitId } : {}) },
            { headers: this.dcHeaders(orgId, ownerId, { Accept: 'application/json' }) },
        );
    }

    // ── Files ──────────────────────────────────────

    /**
     * List all files in a project branch.
     */
    async getFiles(orgId: string, projectId: string, branch = 'master'): Promise<DesignCenterFile[]> {
        const ownerId = await this.getOwnerId();
        return this.http.get<DesignCenterFile[]>(`${BASE}/projects/${projectId}/branches/${branch}/files`, {
            headers: this.dcHeaders(orgId, ownerId),
        });
    }

    /**
     * Read a file's content from a project branch.
     * Automatically decodes JSON-wrapped responses from the DC API
     * so callers always receive clean, human-readable text.
     */
    async getFileContent(orgId: string, projectId: string, filePath: string, branch = 'master'): Promise<string> {
        const ownerId = await this.getOwnerId();
        const encodedPath = encodeURIComponent(filePath);
        const raw = await this.http.get<string>(
            `${BASE}/projects/${projectId}/branches/${branch}/files/${encodedPath}`,
            {
                headers: this.dcHeaders(orgId, ownerId, { Accept: 'text/plain' }),
                responseType: 'text',
            },
        );
        // The DC API returns file content as a JSON string literal
        // (quoted with escaped newlines). Decode it to clean text.
        if (typeof raw === 'string' && raw.startsWith('"') && raw.endsWith('"')) {
            try {
                return JSON.parse(raw);
            } catch {
                return raw;
            }
        }
        return raw;
    }

    /**
     * Resolve a local filename to its matching remote path in the project.
     * Returns the matched remote path, or throws with helpful suggestions.
     */
    async resolveFilePath(orgId: string, projectId: string, localName: string, branch = 'master'): Promise<string> {
        const files = await this.getFiles(orgId, projectId, branch);
        const fileList = files.filter((f) => f.type.toLowerCase() === 'file');

        // Exact match
        const exact = fileList.find((f) => f.path === localName);
        if (exact) return exact.path;

        // Basename match (e.g., '/tmp/api.raml' → 'api.raml')
        const basename = localName.includes('/') ? localName.split('/').pop()! : localName;
        const byBasename = fileList.filter((f) => {
            const remoteName = f.path.includes('/') ? f.path.split('/').pop()! : f.path;
            return remoteName === basename;
        });
        if (byBasename.length === 1) return byBasename[0].path;

        // Multiple matches or no match — build helpful error
        if (byBasename.length > 1) {
            const candidates = byBasename.map((f) => `  - ${f.path}`).join('\n');
            throw new Error(
                `Multiple files match "${basename}":\n${candidates}\nUse --path to specify the exact remote path.`,
            );
        }

        // No match — suggest similar files
        const suggestions = fileList
            .filter((f) => f.path.endsWith('.raml') || f.path.endsWith('.yaml') || f.path.endsWith('.json'))
            .slice(0, 5)
            .map((f) => `  - ${f.path}`)
            .join('\n');
        throw new Error(
            `"${basename}" not found in project. Available spec files:\n${suggestions || '  (none)'}\nUse --path to specify the exact remote path.`,
        );
    }

    // ── Lock / Save / Unlock ──────────────────────

    /**
     * Acquire a write lock on a project branch.
     */
    async acquireLock(orgId: string, projectId: string, branch = 'master'): Promise<void> {
        const ownerId = await this.getOwnerId();
        try {
            await this.http.post<void>(
                `${BASE}/projects/${projectId}/branches/${branch}/acquireLock`,
                {},
                {
                    headers: this.dcHeaders(orgId, ownerId),
                },
            );
        } catch (e) {
            throw new Error(`Failed to acquire lock: ${errorMessage(e)}`);
        }
    }

    /**
     * Release the write lock on a project branch.
     */
    async releaseLock(orgId: string, projectId: string, branch = 'master'): Promise<void> {
        const ownerId = await this.getOwnerId();
        try {
            await this.http.post<void>(
                `${BASE}/projects/${projectId}/branches/${branch}/releaseLock`,
                {},
                {
                    headers: this.dcHeaders(orgId, ownerId),
                },
            );
        } catch (e) {
            throw new Error(`Failed to release lock: ${errorMessage(e)}`);
        }
    }

    /** Refresh a branch lock before the service's approximately one-minute expiry. */
    async maintainLock(orgId: string, projectId: string, branch = 'master'): Promise<void> {
        const ownerId = await this.getOwnerId();
        await this.http.post<void>(
            `${BASE}/projects/${projectId}/branches/${branch}/status`,
            {},
            { headers: this.dcHeaders(orgId, ownerId) },
        );
    }

    /**
     * Save a file to a project branch. Requires the lock to be held.
     */
    async saveFile(
        orgId: string,
        projectId: string,
        filePath: string,
        content: string,
        branch = 'master',
        commitMessage?: string,
    ): Promise<void> {
        await this.saveFiles(orgId, projectId, [{ path: filePath, content }], branch, commitMessage);
    }

    /** Save multiple files in the API's single batch operation. Requires a held lock. */
    async saveFiles(
        orgId: string,
        projectId: string,
        files: DesignCenterSaveFile[],
        branch = 'master',
        commitMessage?: string,
    ): Promise<void> {
        const ownerId = await this.getOwnerId();
        try {
            await this.http.post<void>(
                `${BASE}/projects/${projectId}/branches/${branch}/save`,
                files.map((file) => ({ path: file.path, content: file.content, type: 'FILE' })),
                {
                    headers: this.dcHeaders(orgId, ownerId, commitMessage ? { 'x-commit-message': commitMessage } : {}),
                },
            );
        } catch (e) {
            throw new Error(`Failed to save files: ${errorMessage(e)}`);
        }
    }

    async withLock<T>(orgId: string, projectId: string, branch: string, operation: () => Promise<T>): Promise<T> {
        await this.acquireLock(orgId, projectId, branch);
        try {
            const result = await operation();
            await this.releaseLock(orgId, projectId, branch);
            return result;
        } catch (operationError) {
            try {
                await this.releaseLock(orgId, projectId, branch);
            } catch {
                // Preserve the operation failure; the branch lock expires server-side.
            }
            throw operationError;
        }
    }

    /**
     * Atomically update a file: acquires lock → saves → releases lock.
     * Uses try/finally to always release the lock, even on failure.
     */
    async updateFile(
        orgId: string,
        projectId: string,
        filePath: string,
        content: string,
        branch = 'master',
        commitMessage?: string,
    ): Promise<void> {
        // Clear project cache since we're modifying
        this.cache.delete(`dc:projects:${orgId}`);

        await this.withLock(orgId, projectId, branch, () =>
            this.saveFile(orgId, projectId, filePath, content, branch, commitMessage),
        );
    }

    // ── Publish ────────────────────────────────────

    /**
     * Read and parse the exchange.json metadata from a Design Center project.
     * Returns null if the file doesn't exist or can't be parsed.
     */
    async getExchangeJson(
        orgId: string,
        projectId: string,
        branch = 'master',
    ): Promise<Record<string, unknown> | null> {
        try {
            const raw = await this.getFileContent(orgId, projectId, 'exchange.json', branch);
            return JSON.parse(raw);
        } catch {
            return null;
        }
    }

    /**
     * Legacy direct publication path retained for compatibility.
     * New callers should use the preview-bound DesignCenterWorkflow.
     *
     * The DC XP API expects all publish parameters in the JSON body, NOT in the URL path.
     * Endpoint: POST /designcenter/api-designer/projects/{projectId}/branches/{branch}/publish/exchange
     *
     * Requires a branch lock (same as file saves). Uses lock → publish → unlock pattern.
     * If assetId or main file aren't specified, we auto-detect them from exchange.json.
     */
    async publishToExchange(
        orgId: string,
        projectId: string,
        options: PublishToExchangeOptions,
        branch = 'master',
    ): Promise<{ groupId: string; assetId: string; version: string }> {
        return this.withLock(orgId, projectId, branch, () =>
            this.publishToExchangeLocked(orgId, projectId, options, branch),
        );
    }

    /** Publish while the caller holds the branch lock. */
    async publishToExchangeLocked(
        orgId: string,
        projectId: string,
        options: PublishToExchangeOptions,
        branch = 'master',
    ): Promise<{ groupId: string; assetId: string; version: string }> {
        const ownerId = await this.getOwnerId();

        // Read exchange.json for defaults (assetId, main file, etc.)
        const exchangeMeta = await this.getExchangeJson(orgId, projectId, branch);

        const groupId = options.groupId || (exchangeMeta?.groupId as string) || orgId;
        const assetId = options.assetId || (exchangeMeta?.assetId as string) || options.name;
        const mainFile = options.main || (exchangeMeta?.main as string);

        return this.http
            .post<{ groupId: string; assetId: string; version: string }>(
                `${BASE}/projects/${projectId}/branches/${branch}/publish/exchange`,
                {
                    name: options.name,
                    apiVersion: options.apiVersion,
                    version: options.version,
                    classifier: options.classifier,
                    main: mainFile,
                    assetId,
                    groupId,
                },
                {
                    headers: this.dcHeaders(orgId, ownerId),
                },
            )
            .catch((e) => {
                throw new Error(`Failed to publish: ${errorMessage(e)}`);
            });
    }
}
