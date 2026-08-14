import type { CH2Deployment } from '../api/CloudHub2Api.js';
import type { Environment } from '../api/AccessManagementApi.js';
import { isProductionEnv } from './guards.js';

export interface ApplicationDeletionPreview {
    action: 'delete deployment';
    app: string;
    environment: string;
    environmentId: string;
    deploymentId: string;
    status: string;
    artifactRef: CH2Deployment['application']['ref'];
    runtime?: string;
    targetId: string;
    replicas: number;
    production: boolean;
    irreversible: true;
    preserved: 'Exchange artifact and other Anypoint resources';
    alternative: 'Use stop_app to take the application offline without deleting its deployment configuration.';
}

export function buildApplicationDeletionPreview(
    deployment: CH2Deployment,
    environment: Environment,
): ApplicationDeletionPreview {
    return {
        action: 'delete deployment',
        app: deployment.name,
        environment: environment.name,
        environmentId: environment.id,
        deploymentId: deployment.id,
        status: deployment.status,
        artifactRef: deployment.application.ref,
        runtime: deployment.target.deploymentSettings.runtime?.version,
        targetId: deployment.target.targetId,
        replicas: deployment.target.replicas,
        production: isProductionEnv(environment.name, environment.isProduction),
        irreversible: true,
        preserved: 'Exchange artifact and other Anypoint resources',
        alternative: 'Use stop_app to take the application offline without deleting its deployment configuration.',
    };
}

export function deploymentIdMatches(expectedDeploymentId: string | undefined, currentDeploymentId: string): boolean {
    return Boolean(expectedDeploymentId) && expectedDeploymentId === currentDeploymentId;
}
