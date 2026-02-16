#!/usr/bin/env node
/**
 * Anypoint Connect MCP Server
 * Exposes Anypoint Platform operations via Model Context Protocol
 *
 * Tools, resources, and prompts are registered by modular registrars
 * under src/mcp/ — this file is the thin orchestrator.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getConfig } from './utils/config.js';
import { AnypointClient } from './client/AnypointClient.js';
import { VERSION } from './version.js';

import {
    registerIdentityTools,
    registerApplicationTools,
    registerLogTools,
    registerMonitoringTools,
    registerExchangeTools,
    registerApiManagerTools,
    registerDesignCenterTools,
} from './mcp/tools/index.js';
import { registerResources } from './mcp/resources.js';
import { registerPrompts } from './mcp/prompts.js';

export class AnypointConnectMcpServer {
    private server: McpServer;
    private client: AnypointClient;

    constructor() {
        this.server = new McpServer({
            name: 'anypoint-connect',
            version: VERSION,
        });

        const config = getConfig();
        this.client = new AnypointClient({
            clientId: config.clientId,
            clientSecret: config.clientSecret,
            redirectUri: config.callbackUrl,
            baseUrl: config.baseUrl,
        });

        // Register tools by domain
        registerIdentityTools(this.server, this.client);
        registerApplicationTools(this.server, this.client);
        registerLogTools(this.server, this.client);
        registerMonitoringTools(this.server, this.client);
        registerExchangeTools(this.server, this.client);
        registerApiManagerTools(this.server, this.client);
        registerDesignCenterTools(this.server, this.client);

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

// Auto-start only when run directly (node dist/mcp.js), not when imported
const isDirectRun =
    import.meta.url === `file://${process.argv[1]}` || import.meta.url === `file://${process.argv[1]}.js`;

if (isDirectRun) {
    const server = new AnypointConnectMcpServer();
    server.start().catch((err) => console.error(`Failed to start: ${err}`));
}
