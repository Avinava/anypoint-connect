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
    type: 'file' | 'folder';
    language?: string;
}

export interface DesignCenterBranch {
    name: string;
    commitId?: string;
    isDefault?: boolean;
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
    ) { }

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
    async getProjects(orgId: string): Promise<DesignCenterProject[]> {
        const ownerId = await this.getOwnerId();
        const cacheKey = `dc:projects:${orgId}`;
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

    /**
     * Find a project by name (case-insensitive partial match).
     */
    async findByName(orgId: string, name: string): Promise<DesignCenterProject | null> {
        const projects = await this.getProjects(orgId);
        const lower = name.toLowerCase();
        return projects.find((p) => p.name.toLowerCase().includes(lower)) || null;
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
     * The filePath should be URI-encoded if it contains special characters.
     */
    async getFileContent(orgId: string, projectId: string, filePath: string, branch = 'master'): Promise<string> {
        const ownerId = await this.getOwnerId();
        const encodedPath = encodeURIComponent(filePath);
        const content = await this.http.get<string>(
            `${BASE}/projects/${projectId}/branches/${branch}/files/${encodedPath}`,
            {
                headers: this.dcHeaders(orgId, ownerId, { Accept: 'text/plain' }),
                responseType: 'text',
            },
        );
        return content;
    }

    // ── Lock / Save / Unlock ──────────────────────

    /**
     * Acquire a write lock on a project branch.
     */
    async acquireLock(orgId: string, projectId: string, branch = 'master'): Promise<void> {
        const ownerId = await this.getOwnerId();
        await this.http.post<void>(`${BASE}/projects/${projectId}/branches/${branch}/acquireLock`, {}, {
            headers: this.dcHeaders(orgId, ownerId),
        });
    }

    /**
     * Release the write lock on a project branch.
     */
    async releaseLock(orgId: string, projectId: string, branch = 'master'): Promise<void> {
        const ownerId = await this.getOwnerId();
        await this.http.post<void>(`${BASE}/projects/${projectId}/branches/${branch}/releaseLock`, {}, {
            headers: this.dcHeaders(orgId, ownerId),
        });
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
        const ownerId = await this.getOwnerId();
        await this.http.post<void>(
            `${BASE}/projects/${projectId}/branches/${branch}/save`,
            [
                {
                    path: filePath,
                    content,
                    type: 'file',
                },
            ],
            {
                headers: this.dcHeaders(orgId, ownerId, commitMessage ? { 'x-commit-message': commitMessage } : {}),
            },
        );
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

        await this.acquireLock(orgId, projectId, branch);
        try {
            await this.saveFile(orgId, projectId, filePath, content, branch, commitMessage);
        } finally {
            await this.releaseLock(orgId, projectId, branch);
        }
    }

    // ── Publish ────────────────────────────────────

    /**
     * Publish a Design Center project to Anypoint Exchange.
     */
    async publishToExchange(
        orgId: string,
        projectId: string,
        options: PublishToExchangeOptions,
        branch = 'master',
    ): Promise<{ groupId: string; assetId: string; version: string }> {
        const ownerId = await this.getOwnerId();
        const groupId = options.groupId || orgId;
        const assetId = options.assetId || projectId;

        const response = await this.http.post<{ groupId: string; assetId: string; version: string }>(
            `${BASE}/projects/${projectId}/branches/${branch}/publish/exchange/${groupId}/${assetId}/${options.version}`,
            {
                name: options.name,
                apiVersion: options.apiVersion,
                classifier: options.classifier,
                main: options.main,
            },
            {
                headers: this.dcHeaders(orgId, ownerId),
            },
        );

        return response;
    }
}
