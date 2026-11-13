/**
 * Logger utility
 * Chalk-based colored console output
 */

import chalk from 'chalk';

/**
 * Where informational output goes. Standard output normally; standard error under `--json`, so a
 * command's stdout carries only its result and parses as one JSON value.
 */
let infoToStderr = false;
const info = (...args: unknown[]) => (infoToStderr ? console.error : console.log)(...args);

export const log = {
    /** Send informational output to stderr, leaving stdout for machine-readable results. */
    toStderr: () => {
        infoToStderr = true;
    },

    info: (msg: string) => info(chalk.blue('ℹ'), msg),
    success: (msg: string) => info(chalk.green('✔'), msg),
    warn: (msg: string) => info(chalk.yellow('⚠'), msg),
    error: (msg: string) => console.error(chalk.red('✖'), msg),
    dim: (msg: string) => info(chalk.dim(msg)),
    bold: (msg: string) => info(chalk.bold(msg)),

    // Log levels for log tailing
    logLine: (level: string, message: string, timestamp?: string) => {
        const ts = timestamp ? chalk.dim(`[${timestamp}] `) : '';
        switch (level.toUpperCase()) {
            case 'ERROR':
                info(`${ts}${chalk.red.bold('ERROR')} ${message}`);
                break;
            case 'WARN':
            case 'WARNING':
                info(`${ts}${chalk.yellow('WARN ')} ${message}`);
                break;
            case 'DEBUG':
                info(`${ts}${chalk.dim('DEBUG')} ${chalk.dim(message)}`);
                break;
            default:
                info(`${ts}${chalk.cyan('INFO ')} ${message}`);
                break;
        }
    },

    // Section header
    header: (title: string) => {
        info();
        info(chalk.bold.underline(title));
        info();
    },

    // Key-value pair
    kv: (key: string, value: string | number | boolean) => {
        info(`  ${chalk.dim(key + ':')} ${value}`);
    },
};
