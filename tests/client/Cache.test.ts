/**
 * Tests for Cache
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { Cache } from '../../src/client/Cache.js';

describe('Cache', () => {
    let cache: Cache;

    beforeEach(() => {
        vi.useFakeTimers();
        cache = new Cache();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('should store and retrieve values', () => {
        cache.set('key1', { data: 'hello' }, 60000);
        expect(cache.get('key1')).toEqual({ data: 'hello' });
    });

    it('should return null for missing keys', () => {
        expect(cache.get('nonexistent')).toBeNull();
    });

    it('should expire entries after TTL', () => {
        cache.set('key1', 'value', 5000);
        expect(cache.get('key1')).toBe('value');

        vi.advanceTimersByTime(5001);
        expect(cache.get('key1')).toBeNull();
    });

    it('should not expire entries before TTL', () => {
        cache.set('key1', 'value', 5000);
        vi.advanceTimersByTime(4999);
        expect(cache.get('key1')).toBe('value');
    });

    it('should overwrite existing keys', () => {
        cache.set('key1', 'first', 60000);
        cache.set('key1', 'second', 60000);
        expect(cache.get('key1')).toBe('second');
    });

    it('should delete specific keys', () => {
        cache.set('key1', 'value1', 60000);
        cache.set('key2', 'value2', 60000);
        cache.delete('key1');
        expect(cache.get('key1')).toBeNull();
        expect(cache.get('key2')).toBe('value2');
    });

    it('should clear all entries', () => {
        cache.set('key1', 'value1', 60000);
        cache.set('key2', 'value2', 60000);
        cache.clear();
        expect(cache.get('key1')).toBeNull();
        expect(cache.get('key2')).toBeNull();
    });

    it('should handle complex objects', () => {
        const obj = { nested: { arr: [1, 2, 3], flag: true } };
        cache.set('complex', obj, 60000);
        expect(cache.get('complex')).toEqual(obj);
    });

    it('should compute and cache a value with getOrCompute', async () => {
        const compute = vi.fn().mockResolvedValue('computed-value');
        const result = await cache.getOrCompute('key', compute, 60000);
        expect(result).toBe('computed-value');
        expect(compute).toHaveBeenCalledOnce();

        // Second call should use cache
        const result2 = await cache.getOrCompute('key', compute, 60000);
        expect(result2).toBe('computed-value');
        expect(compute).toHaveBeenCalledOnce(); // not called again
    });
});
