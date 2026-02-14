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
        // ── Identity ───────────────────────────────────────

        this.server.registerTool(
            'whoami',
            {
                title: 'Who Am I',
                description: 'Returns the currently authenticated Anypoint Platform user, their username, email, organization name, and org ID. Use this first to confirm authentication is working and to obtain the org context needed by other tools.',
                annotations: { readOnlyHint: true },
            },
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

        // ── Environment Discovery ──────────────────────────

        this.server.registerTool(
            'list_environments',
            {
                title: 'List Environments',
                description: 'Lists all Anypoint environments in the organization (e.g. Development, Sandbox, Production). Returns each environment\'s ID, name, type, and whether it is marked as production. Use this to discover available environments before querying apps, logs, or metrics.',
                annotations: { readOnlyHint: true },
            },
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

        // ── Application Management ─────────────────────────

        this.server.registerTool(
            'list_apps',
            {
                title: 'List Applications',
                description: 'Lists all Mule applications deployed in a CloudHub 2.0 environment. Returns each app\'s name, deployment status (APPLIED, STARTED, FAILED), artifact version, Mule runtime version, and replica count. Accepts environment name (e.g. "Development") or environment ID.',
                inputSchema: {
                    environment: z.string().describe('Environment name (e.g. "Development", "Production") or environment ID'),
                },
                annotations: { readOnlyHint: true },
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

        this.server.registerTool(
            'get_app_status',
            {
                title: 'Get Application Status',
                description: 'Returns detailed deployment information for a specific Mule application: status, artifact version (groupId:artifactId:version), Mule runtime version, each replica\'s state and deployment location, the public URL, and last update timestamp. Use this to check if an app is healthy before or after a deployment.',
                inputSchema: {
                    appName: z.string().describe('Application name exactly as deployed (case-insensitive match)'),
                    environment: z.string().describe('Environment name (e.g. "Production") or environment ID'),
                },
                annotations: { readOnlyHint: true },
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

        this.server.registerTool(
            'restart_app',
            {
                title: 'Restart Application',
                description: 'Initiates a rolling restart of a deployed Mule application by re-applying its desired state. This causes new replicas to spin up before old ones are terminated, avoiding downtime. Use when an app is behaving unexpectedly (e.g. memory issues, stale connections) but you don\'t need to redeploy a new version.',
                inputSchema: {
                    appName: z.string().describe('Application name exactly as deployed'),
                    environment: z.string().describe('Environment name or ID'),
                },
                annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
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
                        content: [{ type: 'text', text: `✅ Rolling restart initiated for "${appName}" in ${env.name}. Use get_app_status to monitor progress.` }],
                    };
                } catch (error) {
                    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : error}` }], isError: true };
                }
            }
        );

        this.server.registerTool(
            'scale_app',
            {
                title: 'Scale Application',
                description: 'Changes the number of running replicas for a CloudHub 2.0 application. Scaling up adds more replicas for higher throughput and availability; scaling down reduces cost. Each replica runs as an isolated Mule runtime instance. The change takes effect immediately and new replicas will begin receiving traffic once their health checks pass.',
                inputSchema: {
                    appName: z.string().describe('Application name exactly as deployed'),
                    environment: z.string().describe('Environment name or ID'),
                    replicas: z.number().min(1).max(8).describe('Desired number of replicas (1–8)'),
                },
                annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
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
                        content: [{ type: 'text', text: `✅ Scaled "${appName}" to ${replicas} replica(s) in ${env.name}. Use get_app_status to monitor.` }],
                    };
                } catch (error) {
                    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : error}` }], isError: true };
                }
            }
        );

        // ── Logs ───────────────────────────────────────────

        this.server.registerTool(
            'get_logs',
            {
                title: 'Get Application Logs',
                description: 'Fetches the most recent log entries from a running Mule application. Returns timestamps, log levels (ERROR, WARN, INFO, DEBUG), and messages. Useful for quickly checking an app\'s current state, spotting recent errors, or verifying a deployment succeeded. For large time-range downloads, use download_logs instead.',
                inputSchema: {
                    appName: z.string().describe('Application name exactly as deployed'),
                    environment: z.string().describe('Environment name or ID'),
                    lines: z.number().optional().describe('Number of most recent log entries to return (default: 100, max: 1000)'),
                    level: z.string().optional().describe('Minimum log level filter: ERROR, WARN, INFO, or DEBUG. Only entries at or above this level are returned.'),
                },
                annotations: { readOnlyHint: true },
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

        this.server.registerTool(
            'download_logs',
            {
                title: 'Download Logs for Time Range',
                description: 'Downloads the full application log file and filters it to a specific time window. Returns all matching log entries as formatted text lines (timestamp [LEVEL] message). Use this for historical analysis, incident investigation, or exporting logs. For quick recent checks, use get_logs instead.',
                inputSchema: {
                    appName: z.string().describe('Application name exactly as deployed'),
                    environment: z.string().describe('Environment name or ID'),
                    hoursBack: z.number().describe('How many hours of logs to retrieve (e.g. 1 for last hour, 24 for last day, 168 for last week)'),
                    level: z.string().optional().describe('Minimum log level filter: ERROR, WARN, INFO, or DEBUG'),
                },
                annotations: { readOnlyHint: true },
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

        // ── Monitoring ─────────────────────────────────────

        this.server.registerTool(
            'get_metrics',
            {
                title: 'Get Application Metrics',
                description: 'Fetches runtime performance metrics for applications in an environment using Anypoint Monitoring AMQL queries. Returns inbound request count, average response time (ms), error count, outbound request count, and outbound average response time. Use this to identify performance bottlenecks, high error rates, or traffic patterns.',
                inputSchema: {
                    environment: z.string().describe('Environment name or ID'),
                    hoursBack: z.number().optional().describe('Time window in hours (default: 24). Use 1 for recent, 168 for weekly trends.'),
                    appName: z.string().optional().describe('Filter to a specific application name. Omit to get metrics for all apps.'),
                },
                annotations: { readOnlyHint: true },
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

        // ── Exchange ───────────────────────────────────────

        this.server.registerTool(
            'search_exchange',
            {
                title: 'Search Exchange',
                description: 'Searches Anypoint Exchange for reusable assets: API specifications (RAML, OAS), connectors, integration templates, examples, and policies. Returns matching asset names, IDs, types, versions, and descriptions. Use this to discover existing APIs before building new integrations, find connector availability, or locate example projects.',
                inputSchema: {
                    query: z.string().optional().describe('Search keyword (e.g. "order", "salesforce", "kafka"). Omit to list all assets.'),
                    type: z.string().optional().describe('Filter by asset type: rest-api, soap-api, http-api, raml-fragment, app, connector, template, example, policy, custom'),
                    limit: z.number().optional().describe('Maximum number of results to return (default: 20)'),
                },
                annotations: { readOnlyHint: true },
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

        this.server.registerTool(
            'download_api_spec',
            {
                title: 'Download API Specification',
                description: 'Downloads the API specification file (RAML or OAS/Swagger) for an Exchange asset. Returns the raw spec content as text, along with the classifier (e.g. "raml", "oas", "fat-raml") and filename. Use this to inspect API contracts, generate scaffolding, or understand an API\'s endpoints and data models before building an integration.',
                inputSchema: {
                    groupId: z.string().describe('Group ID of the asset (typically the org ID — use whoami to get it)'),
                    assetId: z.string().describe('Asset ID as shown in Exchange (e.g. "order-management-api")'),
                    version: z.string().optional().describe('Specific version (e.g. "1.2.0"). Omit to download the latest published version.'),
                },
                annotations: { readOnlyHint: true },
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

        // ── Environment Comparison ─────────────────────────

        this.server.registerTool(
            'compare_environments',
            {
                title: 'Compare Environments',
                description: 'Produces a side-by-side comparison of all application deployments across two environments. For each app, shows deployment status, artifact version, and replica count in both environments, plus whether versions match. Use this to detect environment drift before a production promotion, verify that a release was applied consistently, or audit differences between Development and Production.',
                inputSchema: {
                    env1: z.string().describe('First environment name (e.g. "Development")'),
                    env2: z.string().describe('Second environment name (e.g. "Production")'),
                },
                annotations: { readOnlyHint: true },
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

        // ── API Manager ────────────────────────────────────

        this.server.registerTool(
            'list_api_instances',
            {
                title: 'List API Instances',
                description: 'Lists all managed API instances registered in API Manager for an environment. Returns each API\'s name, instance ID, status (active/inactive), asset version, technology (Mule 3 or 4), endpoint URI, deprecation flag, and active contract count. Use this to review API governance posture or find the API instance ID needed for get_api_policies.',
                inputSchema: {
                    environment: z.string().describe('Environment name or ID'),
                },
                annotations: { readOnlyHint: true },
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

        this.server.registerTool(
            'get_api_policies',
            {
                title: 'Get API Policies & SLA Tiers',
                description: 'Returns the full policy chain and SLA tier configuration for a managed API instance. For each policy, shows the template name (e.g. "client-id-enforcement", "rate-limiting"), version, execution order, whether it is disabled, and its configuration. For each SLA tier, shows the name, rate limits, auto-approve setting, and how many client apps have contracted it. Use this to audit API security and rate-limiting configuration.',
                inputSchema: {
                    apiName: z.string().describe('API name (partial match) or numeric API instance ID from list_api_instances'),
                    environment: z.string().describe('Environment name or ID'),
                },
                annotations: { readOnlyHint: true },
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
                description: 'List of all Anypoint environments with their IDs, names, types, and production flags',
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
        // ── Pre-Deployment Readiness Check ──────────────────

        this.server.registerPrompt(
            'pre-deploy-check',
            {
                title: 'Pre-Deployment Readiness Check',
                description: 'Runs a comprehensive readiness check before deploying or promoting a Mule application. Validates the current state of the target environment, checks for version drift, reviews recent error rates, and compares source and target configurations.',
                argsSchema: {
                    appName: z.string().describe('Application name to deploy'),
                    sourceEnv: z.string().describe('Source environment (e.g. "Development")'),
                    targetEnv: z.string().describe('Target environment for deployment (e.g. "Production")'),
                },
            },
            async ({ appName, sourceEnv, targetEnv }) => ({
                messages: [{
                    role: 'user',
                    content: {
                        type: 'text',
                        text: `I'm about to promote "${appName}" from ${sourceEnv} to ${targetEnv}. Run a pre-deployment readiness check:

1. **Source status**: Use get_app_status to check "${appName}" in ${sourceEnv} — confirm it's APPLIED/RUNNING and healthy.
2. **Target status**: Use get_app_status to check if "${appName}" exists in ${targetEnv} — note the current version and replica count.
3. **Version comparison**: Use compare_environments to compare ${sourceEnv} vs ${targetEnv} and highlight the version difference for this app.
4. **Error check**: Use get_logs to fetch the last 50 ERROR-level logs from ${sourceEnv} — flag any recent errors that might indicate instability.
5. **Metrics baseline**: Use get_metrics for "${appName}" in ${sourceEnv} with the last 24 hours — report error rate and average response time.

Produce a GO / NO-GO recommendation with rationale. If there are concerns, list them as action items before proceeding.`,
                    },
                }],
            })
        );

        // ── Troubleshoot Application ────────────────────────

        this.server.registerPrompt(
            'troubleshoot-app',
            {
                title: 'Troubleshoot Application',
                description: 'Systematically diagnoses issues with a Mule application by checking deployment health, analyzing error logs, reviewing metrics for anomalies, and suggesting MuleSoft-specific root causes and remediations.',
                argsSchema: {
                    appName: z.string().describe('Application name that is having issues'),
                    environment: z.string().describe('Environment where the issue is occurring'),
                    symptom: z.string().optional().describe('Description of the issue (e.g. "high latency", "502 errors", "not processing messages")'),
                },
            },
            async ({ appName, environment, symptom }) => ({
                messages: [{
                    role: 'user',
                    content: {
                        type: 'text',
                        text: `The application "${appName}" in ${environment} is experiencing issues${symptom ? `: "${symptom}"` : ''}. Please diagnose:

1. **Deployment health**: Use get_app_status to check replica states — look for FAILED or PARTIAL_STARTED replicas, recent restarts, or version mismatches.
2. **Error analysis**: Use get_logs with level=ERROR and 200 lines to identify error patterns. Group errors by type (e.g. MULE:CONNECTIVITY, MULE:EXPRESSION, HTTP:TIMEOUT, java.lang.OutOfMemoryError).
3. **Performance check**: Use get_metrics for the last 4 hours — look for spikes in error count, elevated response times, or sudden drops in request volume.
4. **Root cause analysis**: Based on the evidence, identify the most likely root cause from common MuleSoft issues:
   - DataWeave transformation errors (MULE:EXPRESSION)
   - Downstream service timeouts (HTTP:TIMEOUT, HTTP:CONNECTIVITY)
   - Memory pressure / ObjectStore issues
   - Configuration property errors (missing secure properties, wrong endpoint URLs)
   - Database connection pool exhaustion
   - API autodiscovery or policy enforcement failures
5. **Remediation**: Suggest specific fixes. If a restart would help, use restart_app. If scaling is needed, recommend scale_app with a replica count.`,
                    },
                }],
            })
        );

        // ── API Governance Audit ────────────────────────────

        this.server.registerPrompt(
            'api-governance-audit',
            {
                title: 'API Governance Audit',
                description: 'Reviews the API governance posture for an environment: checks which APIs have policies applied, validates that security policies (client-id-enforcement, OAuth, JWT) are present, reviews SLA tier configurations, and identifies gaps.',
                argsSchema: {
                    environment: z.string().describe('Environment to audit (e.g. "Production")'),
                },
            },
            async ({ environment }) => ({
                messages: [{
                    role: 'user',
                    content: {
                        type: 'text',
                        text: `Run an API governance audit on the ${environment} environment:

1. **Inventory**: Use list_api_instances to get all managed APIs. Note any with status "inactive" or that are deprecated.
2. **Policy review**: For each active API, use get_api_policies to check its policy chain. Flag APIs that are MISSING:
   - Authentication policy (client-id-enforcement, oauth2, jwt-validation)
   - Rate limiting or spike control
3. **SLA compliance**: Check which APIs have SLA tiers configured. Note any with auto-approve enabled in a production environment (potential security concern).
4. **Contract count**: Identify APIs with zero active contracts (may indicate unused/orphaned APIs).
5. **Governance scorecard**: Produce a summary table with columns: API Name | Auth Policy | Rate Limit | SLA Tiers | Contracts | Status
   Mark each cell with ✅ (compliant) or ❌ (gap found).

End with prioritized recommendations for improving governance posture.`,
                    },
                }],
            })
        );

        // ── Environment Health Overview ─────────────────────

        this.server.registerPrompt(
            'environment-overview',
            {
                title: 'Environment Health Overview',
                description: 'Generates a comprehensive health report for an Anypoint environment covering all deployed apps, error rates, performance metrics, and deployment status — ideal for daily standups, handoffs, or executive summaries.',
                argsSchema: {
                    environment: z.string().describe('Environment to report on (e.g. "Production")'),
                },
            },
            async ({ environment }) => ({
                messages: [{
                    role: 'user',
                    content: {
                        type: 'text',
                        text: `Generate a health overview report for the ${environment} environment:

1. **App inventory**: Use list_apps to get all deployed applications. Count total apps, how many are APPLIED/RUNNING vs FAILED/DEPLOYING.
2. **Error landscape**: Use get_metrics for all apps over the last 24 hours. Rank apps by error count (highest first). Flag any app with error rate above 1%.
3. **Performance**: From the same metrics, identify the 3 slowest apps by average response time. Note any above 1000ms.
4. **Top errors**: For the app with the most errors, use get_logs with level=ERROR and 50 lines to identify the dominant error pattern.
5. **Version audit**: Note any apps running on different Mule runtime versions — inconsistent runtimes can indicate missed upgrades.

Format the report with clear sections and emojis for quick scanning:
- 🟢 Healthy (no errors, good response times)
- 🟡 Warning (elevated errors or latency)
- 🔴 Critical (failures, high error rate)`,
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
