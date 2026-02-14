#!/usr/bin/env node
/**
 * Anypoint Connect MCP Server
 * Exposes Anypoint Platform operations via Model Context Protocol
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getConfig } from './utils/config.js';
import { AnypointClient } from './client/AnypointClient.js';

class AnypointConnectMcpServer {
    private server: McpServer;
    private client: AnypointClient;

    constructor() {
        this.server = new McpServer({
            name: 'anypoint-connect',
            version: '0.1.0',
        });

        const config = getConfig();
        this.client = new AnypointClient({
            clientId: config.clientId,
            clientSecret: config.clientSecret,
            redirectUri: config.callbackUrl,
            baseUrl: config.baseUrl,
        });

        this.setupTools();
        this.setupResources();
        this.setupPrompts();
    }

    private setupTools() {
        // ── whoami ──────────────────────────────────────
        this.server.tool(
            'whoami',
            'Get current authenticated user and organization info',
            {},
            async () => {
                try {
                    const me = await this.client.whoami();
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                user: `${me.firstName} ${me.lastName}`,
                                username: me.username,
                                email: me.email,
                                organization: me.organization.name,
                                orgId: me.organization.id,
                            }, null, 2),
                        }],
                    };
                } catch (error) {
                    return {
                        content: [{ type: 'text', text: `Auth error: ${error instanceof Error ? error.message : error}. Run "anc auth login" first.` }],
                        isError: true,
                    };
                }
            }
        );

        // ── list_environments ──────────────────────────
        this.server.tool(
            'list_environments',
            'List all environments in the organization',
            {},
            async () => {
                try {
                    const orgId = await this.client.getDefaultOrgId();
                    const envs = await this.client.accessManagement.getEnvironments(orgId);
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify(envs.map(e => ({
                                id: e.id,
                                name: e.name,
                                type: e.type,
                                isProduction: e.isProduction,
                            })), null, 2),
                        }],
                    };
                } catch (error) {
                    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : error}` }], isError: true };
                }
            }
        );

        // ── list_apps ──────────────────────────────────
        this.server.tool(
            'list_apps',
            'List deployed applications in an environment',
            {
                environment: z.string().describe('Environment name or ID'),
            },
            async ({ environment }) => {
                try {
                    const orgId = await this.client.getDefaultOrgId();
                    const env = await this.client.accessManagement.resolveEnvironment(orgId, environment);
                    const deployments = await this.client.cloudHub2.getDeployments(orgId, env.id);

                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify(deployments.map(d => ({
                                name: d.name,
                                status: d.status,
                                version: d.application?.ref?.version,
                                runtime: d.target?.deploymentSettings?.runtime?.version,
                                replicas: d.target?.replicas?.length,
                                id: d.id,
                            })), null, 2),
                        }],
                    };
                } catch (error) {
                    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : error}` }], isError: true };
                }
            }
        );

        // ── get_app_status ─────────────────────────────
        this.server.tool(
            'get_app_status',
            'Get detailed deployment status of an application',
            {
                appName: z.string().describe('Application name'),
                environment: z.string().describe('Environment name or ID'),
            },
            async ({ appName, environment }) => {
                try {
                    const orgId = await this.client.getDefaultOrgId();
                    const env = await this.client.accessManagement.resolveEnvironment(orgId, environment);
                    const deployment = await this.client.cloudHub2.findByName(orgId, env.id, appName);

                    if (!deployment) {
                        return { content: [{ type: 'text', text: `Application "${appName}" not found in ${env.name}` }] };
                    }

                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                name: deployment.name,
                                status: deployment.status,
                                version: deployment.application?.ref?.version,
                                groupId: deployment.application?.ref?.groupId,
                                artifactId: deployment.application?.ref?.artifactId,
                                runtime: deployment.target?.deploymentSettings?.runtime?.version,
                                replicas: deployment.target?.replicas?.map(r => ({
                                    id: r.id,
                                    state: r.state,
                                    location: r.deploymentLocation,
                                })),
                                publicUrl: deployment.target?.deploymentSettings?.http?.inbound?.publicUrl,
                                updatedAt: deployment.updatedAt,
                            }, null, 2),
                        }],
                    };
                } catch (error) {
                    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : error}` }], isError: true };
                }
            }
        );

        // ── get_logs ────────────────────────────────────
        this.server.tool(
            'get_logs',
            'Fetch recent logs for an application. Returns the last N log entries.',
            {
                appName: z.string().describe('Application name'),
                environment: z.string().describe('Environment name or ID'),
                lines: z.number().optional().describe('Number of log lines to fetch (default: 100)'),
                level: z.string().optional().describe('Filter by level: ERROR, WARN, INFO, DEBUG'),
            },
            async ({ appName, environment, lines, level }) => {
                try {
                    const orgId = await this.client.getDefaultOrgId();
                    const env = await this.client.accessManagement.resolveEnvironment(orgId, environment);

                    const entries = await this.client.logs.getLogs(orgId, env.id, appName, {
                        limit: lines || 100,
                        level,
                    });

                    const formatted = entries.map((e: any) => ({
                        timestamp: new Date(e.timestamp).toISOString(),
                        level: e.priority,
                        message: e.message,
                    }));

                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({ total: entries.length, entries: formatted }, null, 2),
                        }],
                    };
                } catch (error) {
                    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : error}` }], isError: true };
                }
            }
        );

        // ── download_logs ──────────────────────────────
        this.server.tool(
            'download_logs',
            'Download logs for a date range. Returns log content as text.',
            {
                appName: z.string().describe('Application name'),
                environment: z.string().describe('Environment name or ID'),
                hoursBack: z.number().describe('How many hours back to fetch (e.g., 24 for last day)'),
                level: z.string().optional().describe('Filter by level: ERROR, WARN, INFO, DEBUG'),
            },
            async ({ appName, environment, hoursBack, level }) => {
                try {
                    const orgId = await this.client.getDefaultOrgId();
                    const env = await this.client.accessManagement.resolveEnvironment(orgId, environment);

                    const to = Date.now();
                    const from = to - hoursBack * 60 * 60 * 1000;

                    const entries = await this.client.logs.getLogsForPeriod(orgId, env.id, appName, from, to, level);

                    const text = entries.map(e => {
                        const ts = new Date(e.timestamp).toISOString();
                        return `${ts} [${e.priority}] ${e.message}`;
                    }).join('\n');

                    return {
                        content: [{
                            type: 'text',
                            text: text || 'No log entries found for the specified period.',
                        }],
                    };
                } catch (error) {
                    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : error}` }], isError: true };
                }
            }
        );

        // ── get_metrics ────────────────────────────────
        this.server.tool(
            'get_metrics',
            'Fetch monitoring metrics (request count, response times, errors) for applications in an environment',
            {
                environment: z.string().describe('Environment name or ID'),
                hoursBack: z.number().optional().describe('How many hours of data (default: 24)'),
                appName: z.string().optional().describe('Filter by specific application name'),
            },
            async ({ environment, hoursBack, appName }) => {
                try {
                    const orgId = await this.client.getDefaultOrgId();
                    const env = await this.client.accessManagement.resolveEnvironment(orgId, environment);

                    const to = Date.now();
                    const from = to - (hoursBack || 24) * 60 * 60 * 1000;

                    const metrics = await this.client.monitoring.getAppMetrics(orgId, env.id, from, to, appName);

                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                environment: env.name,
                                period: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
                                apps: metrics,
                            }, null, 2),
                        }],
                    };
                } catch (error) {
                    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : error}` }], isError: true };
                }
            }
        );

        // ── search_exchange ────────────────────────────
        this.server.tool(
            'search_exchange',
            'Search for assets in Anypoint Exchange (API specs, connectors, templates, examples)',
            {
                query: z.string().optional().describe('Search query (keyword)'),
                type: z.string().optional().describe('Asset type: rest-api, soap-api, http-api, app, connector, template, example, policy'),
                limit: z.number().optional().describe('Max results (default: 20)'),
            },
            async ({ query, type, limit }) => {
                try {
                    const orgId = await this.client.getDefaultOrgId();
                    const assets = await this.client.exchange.searchAssets(orgId, {
                        search: query,
                        type,
                        limit: limit || 20,
                    });

                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify(assets.map(a => ({
                                name: a.name,
                                assetId: a.assetId,
                                groupId: a.groupId,
                                type: a.type,
                                version: a.version,
                                description: a.description,
                            })), null, 2),
                        }],
                    };
                } catch (error) {
                    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : error}` }], isError: true };
                }
            }
        );

        // ── download_api_spec ──────────────────────────
        this.server.tool(
            'download_api_spec',
            'Download the API specification (RAML/OAS) for an Exchange asset. Returns the spec content as text.',
            {
                groupId: z.string().describe('Group ID (usually the org ID)'),
                assetId: z.string().describe('Asset ID'),
                version: z.string().optional().describe('Specific version (defaults to latest)'),
            },
            async ({ groupId, assetId, version }) => {
                try {
                    const spec = await this.client.exchange.downloadSpec(groupId, assetId, version);
                    return {
                        content: [{
                            type: 'text',
                            text: `Classifier: ${spec.classifier}\nFile: ${spec.fileName}\n\n${spec.content}`,
                        }],
                    };
                } catch (error) {
                    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : error}` }], isError: true };
                }
            }
        );

        // ── restart_app ────────────────────────────────
        this.server.tool(
            'restart_app',
            'Restart a deployed application. ⚠️ MUTATIVE: triggers a rolling restart.',
            {
                appName: z.string().describe('Application name'),
                environment: z.string().describe('Environment name or ID'),
            },
            async ({ appName, environment }) => {
                try {
                    const orgId = await this.client.getDefaultOrgId();
                    const env = await this.client.accessManagement.resolveEnvironment(orgId, environment);
                    const deployment = await this.client.cloudHub2.findByName(orgId, env.id, appName);

                    if (!deployment) {
                        return { content: [{ type: 'text', text: `Application "${appName}" not found in ${env.name}` }], isError: true };
                    }

                    await this.client.cloudHub2.restartApp(orgId, env.id, deployment.id);
                    return {
                        content: [{ type: 'text', text: `✅ Restart initiated for ${appName} in ${env.name}` }],
                    };
                } catch (error) {
                    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : error}` }], isError: true };
                }
            }
        );

        // ── scale_app ──────────────────────────────────
        this.server.tool(
            'scale_app',
            'Scale application replicas. ⚠️ MUTATIVE: changes the number of running replicas.',
            {
                appName: z.string().describe('Application name'),
                environment: z.string().describe('Environment name or ID'),
                replicas: z.number().describe('Desired number of replicas'),
            },
            async ({ appName, environment, replicas }) => {
                try {
                    const orgId = await this.client.getDefaultOrgId();
                    const env = await this.client.accessManagement.resolveEnvironment(orgId, environment);
                    const deployment = await this.client.cloudHub2.findByName(orgId, env.id, appName);

                    if (!deployment) {
                        return { content: [{ type: 'text', text: `Application "${appName}" not found in ${env.name}` }], isError: true };
                    }

                    await this.client.cloudHub2.scaleApp(orgId, env.id, deployment.id, replicas);
                    return {
                        content: [{ type: 'text', text: `✅ Scaled ${appName} to ${replicas} replica(s) in ${env.name}` }],
                    };
                } catch (error) {
                    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : error}` }], isError: true };
                }
            }
        );

        // ── compare_environments ───────────────────────
        this.server.tool(
            'compare_environments',
            'Compare application deployments between two environments. Shows version differences, status, and replica counts side by side.',
            {
                env1: z.string().describe('First environment (e.g., Development)'),
                env2: z.string().describe('Second environment (e.g., Production)'),
            },
            async ({ env1, env2 }) => {
                try {
                    const orgId = await this.client.getDefaultOrgId();
                    const [e1, e2] = await Promise.all([
                        this.client.accessManagement.resolveEnvironment(orgId, env1),
                        this.client.accessManagement.resolveEnvironment(orgId, env2),
                    ]);

                    const [apps1, apps2] = await Promise.all([
                        this.client.cloudHub2.getDeployments(orgId, e1.id),
                        this.client.cloudHub2.getDeployments(orgId, e2.id),
                    ]);

                    const allNames = new Set([
                        ...apps1.map(a => a.name),
                        ...apps2.map(a => a.name),
                    ]);

                    const comparison = Array.from(allNames).sort().map(name => {
                        const a1 = apps1.find(a => a.name === name);
                        const a2 = apps2.find(a => a.name === name);
                        return {
                            name,
                            [e1.name]: a1 ? {
                                status: a1.status,
                                version: a1.application?.ref?.version || '-',
                                replicas: a1.target?.replicas?.length || 0,
                            } : 'NOT DEPLOYED',
                            [e2.name]: a2 ? {
                                status: a2.status,
                                version: a2.application?.ref?.version || '-',
                                replicas: a2.target?.replicas?.length || 0,
                            } : 'NOT DEPLOYED',
                            versionMatch: a1 && a2
                                ? a1.application?.ref?.version === a2.application?.ref?.version
                                : null,
                        };
                    });

                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({ comparison }, null, 2),
                        }],
                    };
                } catch (error) {
                    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : error}` }], isError: true };
                }
            }
        );

        // ── list_api_instances ─────────────────────────
        this.server.tool(
            'list_api_instances',
            'List managed API instances in an environment with their status, version, and endpoint',
            {
                environment: z.string().describe('Environment name or ID'),
            },
            async ({ environment }) => {
                try {
                    const orgId = await this.client.getDefaultOrgId();
                    const env = await this.client.accessManagement.resolveEnvironment(orgId, environment);
                    const assets = await this.client.apiManager.getApis(orgId, env.id);

                    const instances = assets.flatMap(asset =>
                        asset.apis.map(api => ({
                            apiName: asset.exchangeAssetName,
                            apiId: api.id,
                            status: api.status,
                            version: api.assetVersion,
                            technology: api.technology,
                            endpoint: api.endpointUri,
                            deprecated: api.deprecated,
                            contracts: api.activeContractsCount,
                        }))
                    );

                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({ environment: env.name, instances }, null, 2),
                        }],
                    };
                } catch (error) {
                    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : error}` }], isError: true };
                }
            }
        );

        // ── get_api_policies ──────────────────────────
        this.server.tool(
            'get_api_policies',
            'Get policies and SLA tiers applied to an API instance',
            {
                apiName: z.string().describe('API name or numeric API instance ID'),
                environment: z.string().describe('Environment name or ID'),
            },
            async ({ apiName, environment }) => {
                try {
                    const orgId = await this.client.getDefaultOrgId();
                    const env = await this.client.accessManagement.resolveEnvironment(orgId, environment);

                    let apiId: number;
                    const numId = parseInt(apiName);
                    if (!isNaN(numId)) {
                        apiId = numId;
                    } else {
                        const found = await this.client.apiManager.findByName(orgId, env.id, apiName);
                        if (!found) {
                            return { content: [{ type: 'text', text: `API "${apiName}" not found in ${env.name}` }], isError: true };
                        }
                        apiId = found.instance.id;
                    }

                    const [policies, tiers] = await Promise.all([
                        this.client.apiManager.getPolicies(orgId, env.id, apiId),
                        this.client.apiManager.getSlaTiers(orgId, env.id, apiId),
                    ]);

                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                apiId,
                                policies: policies.map(p => ({
                                    id: p.id,
                                    template: p.template?.assetId || p.policyTemplateId,
                                    version: p.template?.assetVersion,
                                    order: p.order,
                                    disabled: p.disabled,
                                    config: p.configurationData,
                                })),
                                slaTiers: tiers.map(t => ({
                                    name: t.name,
                                    status: t.status,
                                    autoApprove: t.autoApprove,
                                    limits: t.limits,
                                    appCount: t.applicationCount,
                                })),
                            }, null, 2),
                        }],
                    };
                } catch (error) {
                    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : error}` }], isError: true };
                }
            }
        );
    }

    private setupResources() {
        this.server.registerResource(
            'environments',
            'anypoint://environments',
            {
                description: 'List of all Anypoint environments',
                mimeType: 'application/json',
            },
            async (uri) => {
                try {
                    const orgId = await this.client.getDefaultOrgId();
                    const envs = await this.client.accessManagement.getEnvironments(orgId);
                    return {
                        contents: [{
                            uri: uri.href,
                            text: JSON.stringify(envs, null, 2),
                            mimeType: 'application/json',
                        }],
                    };
                } catch {
                    return { contents: [{ uri: uri.href, text: '[]', mimeType: 'application/json' }] };
                }
            }
        );
    }

    private setupPrompts() {
        this.server.registerPrompt(
            'check-app-health',
            {
                description: 'Check the health of an application by reviewing its logs and metrics',
                argsSchema: {
                    appName: z.string().describe('Application name'),
                    environment: z.string().describe('Environment name'),
                },
            },
            async ({ appName, environment }) => ({
                messages: [{
                    role: 'user',
                    content: {
                        type: 'text',
                        text: `Please check the health of the application "${appName}" in the "${environment}" environment. First get its deployment status, then check recent logs for errors, and finally review the metrics. Provide a summary of the application's health and any issues found.`,
                    },
                }],
            })
        );

        this.server.registerPrompt(
            'troubleshoot-app',
            {
                description: 'Troubleshoot an application by analyzing logs and deployment status',
                argsSchema: {
                    appName: z.string().describe('Application name'),
                    environment: z.string().describe('Environment name'),
                },
            },
            async ({ appName, environment }) => ({
                messages: [{
                    role: 'user',
                    content: {
                        type: 'text',
                        text: `The application "${appName}" in "${environment}" environment appears to be having issues. Please:\n1. Check its deployment status\n2. Look at the last 200 error-level logs\n3. Review metrics for anomalies\n4. Suggest potential root causes and fixes`,
                    },
                }],
            })
        );
    }

    async start() {
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        console.error('Anypoint Connect MCP Server running on stdio');
    }
}

const server = new AnypointConnectMcpServer();
server.start().catch((err) => console.error(`Failed to start: ${err}`));
