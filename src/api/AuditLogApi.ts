/**
 * Audit Log API
 * Query platform audit events for change tracking and compliance
 */

import type { HttpClient } from '../client/HttpClient.js';

export interface AuditLogObject {
    objectType: string;
    objectId?: string;
    objectName?: string;
    parentId?: string | null;
    parentType?: string | null;
    environmentId?: string | null;
    environmentName?: string | null;
}

export interface AuditLogEntry {
    action: string;
    timestamp: number;
    userId?: string | null;
    userName?: string | null;
    clientId?: string | null;
    clientName?: string | null;
    clientIP?: string | null;
    platform?: string;
    failed?: boolean;
    failedCause?: string | null;
    objects?: AuditLogObject[];
    payload?: Record<string, unknown>;
}

export interface AuditLogResponse {
    data: AuditLogEntry[];
    total: number;
}

export interface AuditLogQuery {
    startDate: string;
    endDate: string;
    actions?: string[];
    objectTypes?: string[];
    limit?: number;
    offset?: number;
}

const BASE = '/audit/v2';

export class AuditLogApi {
    constructor(private readonly http: HttpClient) {}

    /**
     * Query audit log entries for an organization
     */
    async query(orgId: string, query: AuditLogQuery): Promise<AuditLogResponse> {
        return this.http.post<AuditLogResponse>(`${BASE}/organizations/${orgId}/query`, query);
    }
}
