/**
 * Production Safety Guards
 * Pre-deploy checks and environment detection
 */

import * as fs from 'fs';
import * as readline from 'readline';
import type { CH2Deployment } from '../api/CloudHub2Api.js';
import chalk from 'chalk';
import { checkPreapproval } from './preapproval.js';

/**
 * Check if an environment is a production environment
 */
export function isProductionEnv(envName: string, isProduction?: boolean): boolean {
    if (isProduction === true) return true;
    const lower = envName.toLowerCase();
    return lower === 'production' || lower === 'prod' || lower.includes('production');
}

/**
 * Build a deployment summary for confirmation
 */
export function buildDeploySummary(
    appName: string,
    envName: string,
    existing: CH2Deployment | null,
    newVersion?: string,
    isProduction?: boolean,
): string {
    const lines: string[] = [];

    if (isProductionEnv(envName, isProduction)) {
        lines.push(chalk.red.bold('\n  ⚠️  PRODUCTION DEPLOYMENT'));
        lines.push(chalk.red('  ════════════════════════════════════\n'));
    }

    lines.push(`  ${chalk.dim('App:')}         ${chalk.bold(appName)}`);
    lines.push(`  ${chalk.dim('Environment:')} ${chalk.bold(envName)}`);

    if (existing) {
        const version = existing.application?.ref?.version || 'unknown';
        const status = existing.status || 'unknown';
        const replicas = existing.target?.replicas || 0;
        lines.push(
            `  ${chalk.dim('Current:')}     v${version} (${status}, ${replicas} replica${replicas !== 1 ? 's' : ''})`,
        );
    } else {
        lines.push(`  ${chalk.dim('Current:')}     ${chalk.yellow('New deployment')}`);
    }

    if (newVersion) {
        lines.push(`  ${chalk.dim('New Version:')} v${newVersion}`);
    }

    lines.push('');
    return lines.join('\n');
}

/**
 * Validate a JAR file exists and looks correct
 */
export function validateJarFile(jarPath: string): {
    valid: boolean;
    error?: string;
    artifactId?: string;
    version?: string;
} {
    if (!fs.existsSync(jarPath)) {
        return { valid: false, error: `File not found: ${jarPath}` };
    }

    const stat = fs.statSync(jarPath);
    if (stat.size === 0) {
        return { valid: false, error: 'JAR file is empty' };
    }

    if (!jarPath.endsWith('.jar')) {
        return { valid: false, error: 'File does not have .jar extension' };
    }

    // Try to extract artifact info from filename
    const basename = jarPath.split('/').pop() || '';
    const match = basename.match(/^(.+?)-(\d+\.\d+\.\d+(?:-.+?)?)-mule-application\.jar$/);

    return {
        valid: true,
        artifactId: match?.[1],
        version: match?.[2],
    };
}

/**
 * Confirm a production write from the CLI. Outside production, with --force, or when a project
 * productionPreapproval covers `tool` (the matching MCP tool name) and the environment, no prompt
 * is shown; otherwise the typed phrase is required.
 */
export async function confirmProductionWrite(
    env: { name: string; id?: string; isProduction?: boolean },
    tool: string,
    force = false,
): Promise<boolean> {
    if (!isProductionEnv(env.name, env.isProduction) || force) return true;
    const decision = checkPreapproval(env, tool);
    if (decision.productionPreapproved) {
        console.log(
            chalk.yellow(
                `  Production pre-approved for ${tool} in ${env.name} (${decision.preapprovalSource}${decision.preapprovalExpires ? `, until ${decision.preapprovalExpires}` : ''})`,
            ),
        );
        return true;
    }
    return confirmProductionDeploy(env.name, env.isProduction);
}

/**
 * Ask for production deployment confirmation
 */
export async function confirmProductionDeploy(envName: string, isProduction?: boolean): Promise<boolean> {
    if (!isProductionEnv(envName, isProduction)) return true;

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    return new Promise((resolve) => {
        rl.question(chalk.red.bold(`  Type 'deploy to production' to confirm: `), (answer) => {
            rl.close();
            resolve(answer.trim().toLowerCase() === 'deploy to production');
        });
    });
}
