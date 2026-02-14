/**
 * Logger utility
 * Chalk-based colored console output
 */

import chalk from 'chalk';

export const log = {
    info: (msg: string) => console.log(chalk.blue('ℹ'), msg),
    success: (msg: string) => console.log(chalk.green('✔'), msg),
    warn: (msg: string) => console.log(chalk.yellow('⚠'), msg),
    error: (msg: string) => console.error(chalk.red('✖'), msg),
    dim: (msg: string) => console.log(chalk.dim(msg)),
    bold: (msg: string) => console.log(chalk.bold(msg)),

    // Log levels for log tailing
    logLine: (level: string, message: string, timestamp?: string) => {
        const ts = timestamp ? chalk.dim(`[${timestamp}] `) : '';
        switch (level.toUpperCase()) {
            case 'ERROR':
                console.log(`${ts}${chalk.red.bold('ERROR')} ${message}`);
                break;
            case 'WARN':
            case 'WARNING':
                console.log(`${ts}${chalk.yellow('WARN ')} ${message}`);
                break;
            case 'DEBUG':
                console.log(`${ts}${chalk.dim('DEBUG')} ${chalk.dim(message)}`);
                break;
            default:
                console.log(`${ts}${chalk.cyan('INFO ')} ${message}`);
                break;
        }
    },

    // Section header
    header: (title: string) => {
        console.log();
        console.log(chalk.bold.underline(title));
        console.log();
    },

    // Key-value pair
    kv: (key: string, value: string | number | boolean) => {
        console.log(`  ${chalk.dim(key + ':')} ${value}`);
    },
};
