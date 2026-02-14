/**
 * Formatter utility
 * Table and JSON output for CLI
 */

import chalk from 'chalk';

/**
 * Print data as an aligned table
 */
export function printTable(headers: string[], rows: string[][]): void {
    const colWidths = headers.map((h, i) => {
        const maxData = rows.reduce((max, row) => Math.max(max, (row[i] || '').length), 0);
        return Math.max(h.length, maxData) + 2;
    });

    // Header
    const headerLine = headers.map((h, i) => chalk.bold(h.padEnd(colWidths[i]))).join('');
    console.log(headerLine);
    console.log(chalk.dim('─'.repeat(colWidths.reduce((a, b) => a + b, 0))));

    // Rows
    for (const row of rows) {
        const line = row.map((cell, i) => (cell || '').padEnd(colWidths[i])).join('');
        console.log(line);
    }
}

/**
 * Format a date as a short readable string
 */
export function formatDate(date: Date | string | number): string {
    const d = new Date(date);
    return d.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });
}

/**
 * Format milliseconds into human-readable string
 */
export function formatMs(ms: number): string {
    if (ms >= 60000) return `${(ms / 60000).toFixed(1)}min`;
    if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.round(ms)}ms`;
}

/**
 * Format bytes into human-readable string
 */
export function formatBytes(bytes: number): string {
    if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
    if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${bytes} B`;
}
