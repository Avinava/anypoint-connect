/**
 * Tests for RateLimiter
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { RateLimiter } from '../../src/client/RateLimiter.js';

describe('RateLimiter', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('should execute a function and return its result', async () => {
        const limiter = new RateLimiter({ requestsPerMinute: 6000, concurrentRequests: 10 });
        const result = await limiter.execute(async () => 42);
        expect(result).toBe(42);
    });

    it('should propagate errors from executed functions', async () => {
        const limiter = new RateLimiter({ requestsPerMinute: 6000 });
        await expect(
            limiter.execute(async () => {
                throw new Error('boom');
            }),
        ).rejects.toThrow('boom');
    });

    it('should execute multiple requests', async () => {
        const limiter = new RateLimiter({ requestsPerMinute: 60000, concurrentRequests: 10 });
        const results: number[] = [];

        await Promise.all([
            limiter.execute(async () => {
                results.push(1);
            }),
            limiter.execute(async () => {
                results.push(2);
            }),
            limiter.execute(async () => {
                results.push(3);
            }),
        ]);

        expect(results).toHaveLength(3);
        expect(results).toContain(1);
        expect(results).toContain(2);
        expect(results).toContain(3);
    });

    it('should use default config when none provided', async () => {
        const limiter = new RateLimiter();
        const result = await limiter.execute(async () => 'ok');
        expect(result).toBe('ok');
    });
});
