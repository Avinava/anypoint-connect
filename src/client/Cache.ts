/**
 * Cache Utility
 * Simple in-memory cache with TTL and observability counters
 */

interface CacheEntry<T> {
    value: T;
    expiresAt: number;
}

export interface CacheStats {
    /** Number of entries currently in the cache */
    size: number;
    /** Total cache hits (key found and not expired) */
    hits: number;
    /** Total cache misses (key not found or expired) */
    misses: number;
    /** Entries removed due to TTL expiry */
    evictions: number;
    /** Hit rate as a fraction (0–1), or 0 if no lookups */
    hitRate: number;
}

export class Cache {
    private readonly store = new Map<string, CacheEntry<unknown>>();
    private readonly defaultTtlMs: number;
    private _hits = 0;
    private _misses = 0;
    private _evictions = 0;

    constructor(defaultTtlMinutes: number = 5) {
        this.defaultTtlMs = defaultTtlMinutes * 60 * 1000;
    }

    get<T>(key: string): T | null {
        const entry = this.store.get(key) as CacheEntry<T> | undefined;
        if (!entry) {
            this._misses++;
            return null;
        }
        if (Date.now() > entry.expiresAt) {
            this.store.delete(key);
            this._evictions++;
            this._misses++;
            return null;
        }
        this._hits++;
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

    /** Returns current cache statistics */
    stats(): CacheStats {
        const total = this._hits + this._misses;
        return {
            size: this.store.size,
            hits: this._hits,
            misses: this._misses,
            evictions: this._evictions,
            hitRate: total > 0 ? this._hits / total : 0,
        };
    }
}
