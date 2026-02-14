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

const program = new Command();

program
    .name('anc')
    .description('Anypoint Connect — CLI for Anypoint Platform')
    .version('0.1.0');

program.addCommand(createConfigCommand());
program.addCommand(createAuthCommand());
program.addCommand(createAppsCommand());
program.addCommand(createDeployCommand());
program.addCommand(createLogsCommand());
program.addCommand(createMonitorCommand());

program.parse();
