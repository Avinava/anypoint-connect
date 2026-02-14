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
