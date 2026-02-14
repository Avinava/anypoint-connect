/**
 * Rate Limiter
 * Simple token bucket rate limiter
 */

export interface RateLimiterConfig {
    requestsPerMinute?: number;
    concurrentRequests?: number;
}

export class RateLimiter {
    private readonly maxConcurrent: number;
    private readonly minIntervalMs: number;
    private running = 0;
    private lastRequestTime = 0;
    private queue: Array<() => void> = [];

    constructor(config?: RateLimiterConfig) {
        this.maxConcurrent = config?.concurrentRequests ?? 10;
        const rpm = config?.requestsPerMinute ?? 100;
        this.minIntervalMs = (60 * 1000) / rpm;
    }

    async execute<T>(fn: () => Promise<T>): Promise<T> {
        await this.waitForSlot();
        this.running++;

        try {
            return await fn();
        } finally {
            this.running--;
            this.releaseSlot();
        }
    }

    private async waitForSlot(): Promise<void> {
        // Wait for concurrency slot
        if (this.running >= this.maxConcurrent) {
            await new Promise<void>((resolve) => {
                this.queue.push(resolve);
            });
        }

        // Wait for rate limit interval
        const now = Date.now();
        const elapsed = now - this.lastRequestTime;
        if (elapsed < this.minIntervalMs) {
            await new Promise((resolve) => setTimeout(resolve, this.minIntervalMs - elapsed));
        }
        this.lastRequestTime = Date.now();
    }

    private releaseSlot(): void {
        const next = this.queue.shift();
        if (next) next();
    }
}
