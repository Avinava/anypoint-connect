/**
 * Anypoint Connect MCP Server
 * Exposes Anypoint Platform operations via Model Context Protocol
 *
 * Tools, resources, and prompts are registered by modular registrars
 * under src/mcp/ — this file wires them to one stdio server.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getConfig, resolveProfile } from '../config/profiles.js';
import { AnypointClient } from '../client/AnypointClient.js';
import { VERSION } from '../version.js';

import {
    registerIdentityTools,
    registerAppReadTools,
    registerAppLifecycleTools,
    registerAppDeployTools,
    registerLogTools,
    registerAnalysisTools,
    registerMonitoringTools,
    registerExchangeTools,
    registerApiManagerTools,
    registerDesignCenterTools,
    registerGovernanceTools,
    registerProfileTools,
    registerAuditTools,
    registerAnypointMQTools,
    registerObjectStoreTools,
} from './tools/index.js';
import { registerResources } from './resources.js';
import { registerPrompts } from './prompts.js';

export class AnypointConnectMcpServer {
    private server: McpServer;
    private client: AnypointClient;

    constructor() {
        this.server = new McpServer({
            name: 'anypoint-connect',
            version: VERSION,
        });

        const resolved = resolveProfile();
        const config = getConfig({ profile: resolved.name });

        console.error(`Profile: "${resolved.name}" (source: ${resolved.source})`);

        this.client = new AnypointClient({
            clientId: config.clientId,
            clientSecret: config.clientSecret,
            redirectUri: config.callbackUrl,
            baseUrl: config.baseUrl,
            profileName: config.profile,
        });

        // Register tools by domain
        registerIdentityTools(this.server, this.client);
        registerAppReadTools(this.server, this.client);
        registerAppLifecycleTools(this.server, this.client);
        registerAppDeployTools(this.server, this.client);
        registerLogTools(this.server, this.client);
        registerAnalysisTools(this.server, this.client);
        registerMonitoringTools(this.server, this.client);
        registerExchangeTools(this.server, this.client);
        registerApiManagerTools(this.server, this.client);
        registerDesignCenterTools(this.server, this.client);
        registerGovernanceTools(this.server, this.client);
        registerProfileTools(this.server);
        registerAuditTools(this.server, this.client);
        registerAnypointMQTools(this.server, this.client);
        registerObjectStoreTools(this.server, this.client);

        // Register resources and prompts
        registerResources(this.server, this.client, this.client.getCache());
        registerPrompts(this.server);
    }

    async start() {
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        console.error('Anypoint Connect MCP Server running on stdio');
    }
}
