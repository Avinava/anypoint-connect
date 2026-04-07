/**
 * Anypoint MQ API
 * Queue/exchange management and message browsing
 */

import type { HttpClient } from '../client/HttpClient.js';
import type { Cache } from '../client/Cache.js';

export interface MQDestination {
    destinationId: string;
    type: 'queue' | 'exchange';
    encrypted: boolean;
    deadLetterQueueId?: string;
    defaultTtl?: number;
    defaultLockTtl?: number;
    maxDeliveries?: number;
    fifo?: boolean;
}

export interface MQStats {
    destination: string;
    messagesVisible: number;
    messagesInFlight: number;
    messagesSent: number;
    messagesReceived: number;
    messagesAcked: number;
}

export interface MQMessage {
    id: string;
    headers: Record<string, string>;
    properties: Record<string, string>;
    body: string;
    createdAt?: string;
}

const ADMIN_BASE = '/mq/admin/api/v1';
const BROKER_BASE = '/mq/broker/api/v1';

export class AnypointMQApi {
    constructor(
        private readonly http: HttpClient,
        private readonly cache: Cache,
    ) {}

    /**
     * List all MQ destinations (queues and exchanges) in a region
     */
    async listDestinations(orgId: string, envId: string, regionId: string): Promise<MQDestination[]> {
        const cacheKey = `mq:dests:${orgId}:${envId}:${regionId}`;
        return this.cache.getOrCompute(cacheKey, async () => {
            return this.http.get<MQDestination[]>(
                `${ADMIN_BASE}/organizations/${orgId}/environments/${envId}/regions/${regionId}/destinations`,
            );
        });
    }

    /**
     * Get statistics for a specific queue
     */
    async getQueueStats(orgId: string, envId: string, regionId: string, queueId: string): Promise<MQStats> {
        return this.http.get<MQStats>(
            `${ADMIN_BASE}/organizations/${orgId}/environments/${envId}/regions/${regionId}/destinations/queues/${encodeURIComponent(queueId)}/stats`,
        );
    }

    /**
     * Browse messages from a queue without consuming them
     */
    async browseMessages(
        orgId: string,
        envId: string,
        regionId: string,
        queueId: string,
        batchSize: number = 10,
    ): Promise<MQMessage[]> {
        return this.http.get<MQMessage[]>(
            `${BROKER_BASE}/organizations/${orgId}/environments/${envId}/regions/${regionId}/destinations/queues/${encodeURIComponent(queueId)}/messages?poolingTime=1000&batchSize=${batchSize}`,
        );
    }

    /**
     * Publish a message to an Anypoint MQ queue
     */
    async publishMessage(
        orgId: string,
        envId: string,
        regionId: string,
        queueId: string,
        body: string,
        headers?: Record<string, string>,
        properties?: Record<string, string>,
    ): Promise<{ messageId: string }> {
        return this.http.put<{ messageId: string }>(
            `${BROKER_BASE}/organizations/${orgId}/environments/${envId}/regions/${regionId}/destinations/queues/${encodeURIComponent(queueId)}/messages`,
            {
                body,
                headers: headers || {},
                properties: properties || {},
            },
        );
    }
}
