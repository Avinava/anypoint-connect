/**
 * CloudHub 2.0 API
 * Deployment management via Application Manager API v2
 */

import type { HttpClient } from '../client/HttpClient.js';
import type { Cache } from '../client/Cache.js';

/**
 * Maven-style artifact coordinate used both by a live deployment (`CH2Deployment`)
 * and by a create/update payload (`CreateDeploymentPayload`). Defined once so the two
 * cannot drift.
 */
export interface ArtifactRef {
    groupId: string;
    artifactId: string;
    version: string;
    packaging: string;
}

/**
 * CPU/memory allocation for a deployment. All fields optional so this single shape
 * serves both the (partial) read response and the (mapper-populated) create payload.
 */
export interface DeploymentResources {
    cpu?: { limit?: string; reserved?: string };
    memory?: { limit?: string; reserved?: string };
}

export interface CH2Deployment {
    id: string;
    name: string;
    status: string;
    application: {
        ref: ArtifactRef;
        desiredState: string;
        configuration?: Record<string, unknown>;
        integrations?: Record<string, unknown>;
        vCores?: number;
    };
    target: {
        provider: string;
        targetId: string;
        deploymentSettings: {
            http?: { inbound?: { publicUrl?: string } };
            runtime?: { version: string; releaseChannel?: string };
            autoscaling?: { enabled: boolean; minReplicas?: number; maxReplicas?: number };
            updateStrategy?: string;
            resources?: DeploymentResources;
            clustered?: boolean;
            enforceDeployingReplicasAcrossNodes?: boolean;
            jvm?: { args?: string };
        };
        replicas: Array<{
            id: string;
            state: string;
            deploymentLocation?: string;
            currentDeploymentVersion?: string;
            reason?: string;
        }>;
    };
    lastSuccessfulVersion?: string;
    desiredVersion?: string;
    createdAt?: string;
    updatedAt?: string;
}

export interface CH2DeploymentResponse {
    items: CH2Deployment[];
    total: number;
}

export interface CreateDeploymentPayload {
    name: string;
    application: {
        ref: ArtifactRef;
        desiredState: string;
        /** CloudHub 2.0 replica size as a decimal vCore value (0.1, 0.2, 0.5, 1, …). */
        vCores?: number;
        configuration?: {
            'mule.agent.application.properties.service'?: {
                applicationName: string;
                properties?: Record<string, string>;
                secureProperties?: Record<string, string>;
            };
        };
    };
    target: {
        provider: string;
        targetId: string;
        deploymentSettings: {
            runtime: { version: string; releaseChannel?: string };
            http?: { inbound?: { publicUrl?: string } };
            resources?: DeploymentResources;
            clustered?: boolean;
            enforceDeployingReplicasAcrossNodes?: boolean;
            updateStrategy?: string;
            jvm?: { args?: string };
        };
        replicas?: number;
    };
}

const BASE = '/amc/application-manager/api/v2';

export class CloudHub2Api {
    constructor(
        private readonly http: HttpClient,
        private readonly cache: Cache,
    ) {}

    /**
     * Build the required Anypoint environment-scoped headers.
     */
    private envHeaders(orgId: string, envId: string) {
        return { 'X-ANYPNT-ORG-ID': orgId, 'X-ANYPNT-ENV-ID': envId };
    }

    /**
     * List all CH2 deployments in an environment
     */
    async getDeployments(orgId: string, envId: string): Promise<CH2Deployment[]> {
        return this.cache.getOrCompute(`ch2:${orgId}:${envId}`, async () => {
            const response = await this.http.get<CH2DeploymentResponse>(
                `${BASE}/organizations/${orgId}/environments/${envId}/deployments`,
                { headers: this.envHeaders(orgId, envId) },
            );
            return response.items || [];
        });
    }

    /**
     * Get specific deployment details
     */
    async getDeployment(orgId: string, envId: string, deploymentId: string): Promise<CH2Deployment> {
        return this.http.get<CH2Deployment>(
            `${BASE}/organizations/${orgId}/environments/${envId}/deployments/${deploymentId}`,
            { headers: this.envHeaders(orgId, envId) },
        );
    }

    /**
     * Create a new deployment
     */
    async createDeployment(orgId: string, envId: string, payload: CreateDeploymentPayload): Promise<CH2Deployment> {
        this.cache.delete(`ch2:${orgId}:${envId}`);
        return this.http.post<CH2Deployment>(
            `${BASE}/organizations/${orgId}/environments/${envId}/deployments`,
            payload,
            { headers: this.envHeaders(orgId, envId) },
        );
    }

    /**
     * Update an existing deployment (redeploy)
     */
    async updateDeployment(
        orgId: string,
        envId: string,
        deploymentId: string,
        payload: Partial<CreateDeploymentPayload>,
    ): Promise<CH2Deployment> {
        this.cache.delete(`ch2:${orgId}:${envId}`);
        return this.http.patch<CH2Deployment>(
            `${BASE}/organizations/${orgId}/environments/${envId}/deployments/${deploymentId}`,
            payload,
            { headers: this.envHeaders(orgId, envId) },
        );
    }

    /**
     * Delete a deployment
     */
    async deleteDeployment(orgId: string, envId: string, deploymentId: string): Promise<void> {
        this.cache.delete(`ch2:${orgId}:${envId}`);
        await this.http.delete(`${BASE}/organizations/${orgId}/environments/${envId}/deployments/${deploymentId}`, {
            headers: this.envHeaders(orgId, envId),
        });
    }

    /**
     * Find deployment by app name
     */
    async findByName(orgId: string, envId: string, appName: string): Promise<CH2Deployment | null> {
        const deployments = await this.getDeployments(orgId, envId);
        return deployments.find((d) => d.name.toLowerCase() === appName.toLowerCase()) || null;
    }

    /**
     * Poll deployment until it reaches a terminal state
     */
    async waitForDeployment(
        orgId: string,
        envId: string,
        deploymentId: string,
        onStatus?: (status: string, replicas: CH2Deployment['target']['replicas']) => void,
        timeoutMs: number = 300000,
    ): Promise<CH2Deployment> {
        const startTime = Date.now();
        const pollIntervalMs = 5000;

        while (Date.now() - startTime < timeoutMs) {
            const deployment = await this.getDeployment(orgId, envId, deploymentId);

            if (onStatus) {
                onStatus(deployment.status, deployment.target.replicas);
            }

            // Terminal states
            if (deployment.status === 'APPLIED' || deployment.status === 'RUNNING') {
                return deployment;
            }

            if (deployment.status === 'FAILED' || deployment.status === 'DEPLOYMENT_FAILED') {
                throw new Error(`Deployment failed: ${deployment.status}`);
            }

            await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        }

        throw new Error(`Deployment timed out after ${timeoutMs / 1000}s`);
    }

    /**
     * Restart an application (triggers rolling restart)
     */
    async restartApp(orgId: string, envId: string, deploymentId: string): Promise<CH2Deployment> {
        this.cache.delete(`ch2:${orgId}:${envId}`);
        return this.http.patch<CH2Deployment>(
            `${BASE}/organizations/${orgId}/environments/${envId}/deployments/${deploymentId}`,
            {
                application: { desiredState: 'STARTED' },
            },
            { headers: this.envHeaders(orgId, envId) },
        );
    }

    /**
     * Scale an application to the specified number of replicas
     */
    async scaleApp(orgId: string, envId: string, deploymentId: string, replicas: number): Promise<CH2Deployment> {
        this.cache.delete(`ch2:${orgId}:${envId}`);
        return this.http.patch<CH2Deployment>(
            `${BASE}/organizations/${orgId}/environments/${envId}/deployments/${deploymentId}`,
            {
                target: { replicas },
            },
            { headers: this.envHeaders(orgId, envId) },
        );
    }

    /**
     * Update ONLY the application artifact reference on an existing deployment.
     * This is the safe redeploy: it PATCHes just `application.ref`, so the live
     * runtime, target/space, replicas, and settings are all preserved.
     */
    async updateArtifactRef(
        orgId: string,
        envId: string,
        deploymentId: string,
        ref: ArtifactRef,
    ): Promise<CH2Deployment> {
        this.cache.delete(`ch2:${orgId}:${envId}`);
        return this.http.patch<CH2Deployment>(
            `${BASE}/organizations/${orgId}/environments/${envId}/deployments/${deploymentId}`,
            { application: { ref } },
            { headers: this.envHeaders(orgId, envId) },
        );
    }

    /**
     * Roll an application back to a previous artifact reference. Mechanically identical
     * to `updateArtifactRef` (narrow ref-only PATCH); named separately so callers express
     * rollback intent and so the two can diverge later if needed.
     */
    async rollbackToRef(orgId: string, envId: string, deploymentId: string, ref: ArtifactRef): Promise<CH2Deployment> {
        return this.updateArtifactRef(orgId, envId, deploymentId, ref);
    }
}
