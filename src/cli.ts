#!/usr/bin/env node
/**
 * Anypoint Connect CLI
 * anc — CLI tool for Anypoint Platform operations
 */

import { Command } from 'commander';
import { createConfigCommand } from './commands/config.js';
import { createAuthCommand } from './commands/auth.js';
import { createAppsCommand } from './commands/apps.js';
import { createDeployCommand } from './commands/deploy.js';
import { createLogsCommand } from './commands/logs.js';
import { createMonitorCommand } from './commands/monitor.js';
import { createExchangeCommand } from './commands/exchange.js';
import { createApiCommand } from './commands/api.js';
import { createDesignCenterCommand } from './commands/design-center.js';
import { VERSION } from './version.js';
import { migrateIfNeeded } from './utils/config.js';

// Auto-migrate legacy config to profiles/default/ if needed
migrateIfNeeded();

const program = new Command();

program
    .name('anc')
    .description('Anypoint Connect — CLI for Anypoint Platform\n\nSupports named profiles for multi-org workflows. Use --profile on auth/config commands\nor place .anypoint-connect.json in your project to auto-select a profile.')
    .version(VERSION);

program.addCommand(createConfigCommand());
program.addCommand(createAuthCommand());
program.addCommand(createAppsCommand());
program.addCommand(createDeployCommand());
program.addCommand(createLogsCommand());
program.addCommand(createMonitorCommand());
program.addCommand(createExchangeCommand());
program.addCommand(createApiCommand());
program.addCommand(createDesignCenterCommand());

program
    .command('mcp')
    .description('Start the MCP (Model Context Protocol) server over stdio')
    .action(async () => {
        const { AnypointConnectMcpServer } = await import('./mcp.js');
        const server = new AnypointConnectMcpServer();
        await server.start();
    });

program.parse();
