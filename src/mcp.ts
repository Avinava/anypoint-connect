#!/usr/bin/env node
/**
 * Anypoint Connect MCP entry point — `node dist/mcp.js` (also started by `anc mcp`).
 */

import { AnypointConnectMcpServer } from './mcp/server.js';

export { AnypointConnectMcpServer };

// Auto-start only when run directly (node dist/mcp.js), not when imported
const isDirectRun =
    import.meta.url === `file://${process.argv[1]}` || import.meta.url === `file://${process.argv[1]}.js`;

if (isDirectRun) {
    new AnypointConnectMcpServer().start().catch((err) => console.error(`Failed to start: ${err}`));
}
