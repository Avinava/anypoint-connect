/**
 * MCP Tool Registrar — Identity tools
 * whoami, list_environments, get_entitlements
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AnypointClient } from '../../client/AnypointClient.js';
import { errorMessage } from '../../utils/errors.js';
import { mcpError } from './shared.js';

export function registerIdentityTools(server: McpServer, client: AnypointClient) {
    server.registerTool(
        'whoami',
        {
            title: 'Who Am I',
            description:
                'Returns the currently authenticated Anypoint Platform user, their username, email, organization name, and org ID. Use this first to confirm authentication is working and to obtain the org context needed by other tools.',
            annotations: { readOnlyHint: true },
        },
        async () => {
            try {
                const me = await client.whoami();
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(
                                {
                                    user: `${me.firstName} ${me.lastName}`,
                                    username: me.username,
                                    email: me.email,
                                    organization: me.organization.name,
                                    orgId: me.organization.id,
                                },
                                null,
                                2,
                            ),
                        },
                    ],
                };
            } catch (error) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Auth error: ${errorMessage(error)}. Run "anc auth login" first.`,
                        },
                    ],
                    isError: true,
                };
            }
        },
    );

    server.registerTool(
        'list_environments',
        {
            title: 'List Environments',
            description:
                "Lists all Anypoint environments in the organization (e.g. Development, Sandbox, Production). Returns each environment's ID, name, type, and whether it is marked as production. Use this to discover available environments before querying apps, logs, or metrics.",
            annotations: { readOnlyHint: true },
        },
        async () => {
            try {
                const orgId = await client.getDefaultOrgId();
                const envs = await client.accessManagement.getEnvironments(orgId);
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(
                                envs.map((e) => ({
                                    id: e.id,
                                    name: e.name,
                                    type: e.type,
                                    isProduction: e.isProduction,
                                })),
                                null,
                                2,
                            ),
                        },
                    ],
                };
            } catch (error) {
                return mcpError(error);
            }
        },
    );

    server.registerTool(
        'get_entitlements',
        {
            title: 'Get Organization Entitlements',
            description:
                'Returns the platform features and capacity licensed for this organization: vCore allocations (production/sandbox/design), Anypoint MQ quotas, Object Store limits, API Manager, monitoring, Runtime Fabric, autoscaling, alerts, and subscription type/expiration. Use this BEFORE calling MQ, Object Store, or other optional-feature tools to verify the org has those capabilities — avoids 403 errors on unprovisioned services.',
            annotations: { readOnlyHint: true },
        },
        async () => {
            try {
                const orgId = await client.getDefaultOrgId();
                const org = await client.accessManagement.getOrgDetails(orgId);
                const e = org.entitlements;

                const summary = {
                    organization: org.name,
                    subscription: org.subscription,
                    compute: {
                        vCoresProduction: e.vCoresProduction,
                        vCoresSandbox: e.vCoresSandbox,
                        vCoresDesign: e.vCoresDesign,
                        autoscaling: e.autoscaling,
                        globalDeployment: e.globalDeployment,
                    },
                    messaging: {
                        mqMessages: e.mqMessages,
                        mqRequests: e.mqRequests,
                        mqAdvancedFeatures: e.mqAdvancedFeatures,
                    },
                    objectStore: {
                        requestUnits: e.objectStoreRequestUnits,
                        keys: e.objectStoreKeys,
                    },
                    networking: {
                        staticIps: e.staticIps,
                        vpcs: e.vpcs,
                        loadBalancer: e.loadBalancer,
                    },
                    apiManagement: {
                        apis: e.apis,
                        apiMonitoring: e.apiMonitoring,
                        monitoringCenter: e.monitoringCenter,
                        alerts: e.armAlerts,
                    },
                    designCenter: e.designCenter,
                    runtimeFabric: e.runtimeFabric,
                    runtimeFabricCloud: e.runtimeFabricCloud,
                    visualization: e.appViz,
                };

                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(summary, null, 2),
                        },
                    ],
                };
            } catch (error) {
                return mcpError(error);
            }
        },
    );
}
