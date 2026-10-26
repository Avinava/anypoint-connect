import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerAnalysisTools } from '../../../src/mcp/tools/analysis.js';
import { STARTUP_LOG } from '../../analysis/fixtures/startup-logs.js';
import { SAMPLE_MIXED_LEVELS } from '../../analysis/fixtures/sample-logs.js';

describe('log analysis MCP tools', () => {
    const handlers = new Map<string, (input: any) => Promise<any>>();
    const server = {
        registerTool: vi.fn((name: string, _definition: unknown, handler: (input: any) => Promise<any>) => {
            handlers.set(name, handler);
        }),
    };
    const client = {
        getDefaultOrgId: vi.fn(),
        accessManagement: { resolveEnvironment: vi.fn() },
        logs: { getLogFile: vi.fn() },
    };
    const text = (result: any): string => result.content[0].text;
    const base = { appName: 'orders-sapi', environment: 'Sandbox' };

    beforeEach(() => {
        handlers.clear();
        vi.clearAllMocks();
        client.getDefaultOrgId.mockResolvedValue('org-1');
        client.accessManagement.resolveEnvironment.mockResolvedValue({ id: 'env-1', name: 'Sandbox' });
        client.logs.getLogFile.mockResolvedValue({ deploymentId: 'dep-1', specId: 'spec-2', text: STARTUP_LOG });
        registerAnalysisTools(server as any, client as any);
    });

    it('fetches the log file through the shared helper', async () => {
        await handlers.get('get_log_stats')!(base);
        expect(client.logs.getLogFile).toHaveBeenCalledWith('org-1', 'env-1', 'orders-sapi');
    });

    describe('analyze_errors', () => {
        it('groups the start-up error with its multi-line report', async () => {
            const out = text(await handlers.get('analyze_errors')!(base));
            expect(out).toContain('Total: 1 errors');
            expect(out).toContain('Caused by: java.net.ConnectException');
        });

        it('level WARN also analyzes warnings', async () => {
            const out = text(await handlers.get('analyze_errors')!({ ...base, level: 'WARN' }));
            expect(out).toContain('Total: 2 errors');
            expect(out).toContain('Token cache empty');
        });

        it('search and logger select the errors analyzed', async () => {
            const miss = text(await handlers.get('analyze_errors')!({ ...base, search: 'no such text' }));
            expect(miss).toBe('No errors found in orders-sapi logs (matching "no such text").');

            const hit = text(
                await handlers.get('analyze_errors')!({
                    ...base,
                    logger: 'OnErrorPropagate',
                    search: 'HTTP:CONNECTIVITY',
                }),
            );
            expect(hit).toContain('Total: 1 errors');
        });
    });

    describe('get_log_patterns', () => {
        it('filters by logger before detecting patterns', async () => {
            const out = text(await handlers.get('get_log_patterns')!({ ...base, logger: 'LoggerMessageProcessor' }));
            expect(out).toContain('30 entries analyzed');
            expect(out).not.toContain('Mule is up and kicking');
        });

        it('filters by level', async () => {
            client.logs.getLogFile.mockResolvedValue({
                deploymentId: 'dep-1',
                specId: 'spec-2',
                text: SAMPLE_MIXED_LEVELS,
            });
            const out = text(await handlers.get('get_log_patterns')!({ ...base, level: 'WARN' }));
            expect(out).toContain('3 entries analyzed');
        });
    });

    describe('get_log_stats', () => {
        it('reports top loggers and honours search', async () => {
            const out = text(await handlers.get('get_log_stats')!({ ...base, search: 'token' }));
            expect(out).toContain('**Volume:** 2 entries');
            expect(out).toContain('### Top Loggers');
            expect(out).toContain('- com.example.orders.TokenCache: 1');
        });

        it('notes when the logs come from the last successful spec', async () => {
            client.logs.getLogFile.mockResolvedValue({
                deploymentId: 'dep-1',
                specId: 'spec-1',
                fallbackFromSpecId: 'spec-2',
                text: STARTUP_LOG,
            });
            const out = text(await handlers.get('get_log_stats')!(base));
            expect(out.startsWith('> The current spec spec-2 has no log lines yet')).toBe(true);
        });

        it('returns a tool error for an invalid regex', async () => {
            const result = await handlers.get('get_log_stats')!({ ...base, search: '[', regex: true });
            expect(result.isError).toBe(true);
        });
    });
});
