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

const program = new Command();

program.name('anc').description('Anypoint Connect — CLI for Anypoint Platform').version(VERSION);

program.addCommand(createConfigCommand());
program.addCommand(createAuthCommand());
program.addCommand(createAppsCommand());
program.addCommand(createDeployCommand());
program.addCommand(createLogsCommand());
program.addCommand(createMonitorCommand());
program.addCommand(createExchangeCommand());
program.addCommand(createApiCommand());
program.addCommand(createDesignCenterCommand());

program.parse();
