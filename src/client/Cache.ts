/**
 * Cache Utility
 * Simple in-memory cache with TTL
 */

interface CacheEntry<T> {
    value: T;
    expiresAt: number;
}

export class Cache {
    private readonly store = new Map<string, CacheEntry<unknown>>();
    private readonly defaultTtlMs: number;

    constructor(defaultTtlMinutes: number = 5) {
        this.defaultTtlMs = defaultTtlMinutes * 60 * 1000;
    }

    get<T>(key: string): T | null {
        const entry = this.store.get(key) as CacheEntry<T> | undefined;
        if (!entry) return null;
        if (Date.now() > entry.expiresAt) {
            this.store.delete(key);
            return null;
        }
        return entry.value;
    }

    set<T>(key: string, value: T, ttlMs?: number): void {
        this.store.set(key, {
            value,
            expiresAt: Date.now() + (ttlMs ?? this.defaultTtlMs),
        });
    }

    async getOrCompute<T>(key: string, compute: () => Promise<T>, ttlMs?: number): Promise<T> {
        const cached = this.get<T>(key);
        if (cached !== null) return cached;

        const value = await compute();
        this.set(key, value, ttlMs);
        return value;
    }

    delete(key: string): void {
        this.store.delete(key);
    }

    clear(): void {
        this.store.clear();
    }
}
