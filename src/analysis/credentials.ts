/**
 * Log Analysis - Credential markers
 * Counts log lines that carry session or bearer credentials (Authorization headers, session IDs,
 * OAuth token parameters, JWTs) per marker, per spec and per replica. Only counts leave this
 * module: matching lines and values are never returned, so a scan is safe to show in a transcript.
 */

import type { LogPart } from '../api/LogsApi.js';
import { lineHeader } from './parser.js';

export interface CredentialMarker {
    id: string;
    description: string;
    pattern: RegExp;
}

/** Every marker the scan looks for. A line can count under more than one marker. */
export const CREDENTIAL_MARKERS: readonly CredentialMarker[] = [
    {
        id: 'authorization-bearer',
        description: 'Authorization header (or field) with a Bearer value',
        pattern: /authorization["']?\s*[:=]\s*["']?bearer\s+\S/i,
    },
    {
        id: 'bearer-token',
        description: 'Bearer followed by a token-shaped value',
        pattern: /\bbearer\s+[A-Za-z0-9._~+/-]{16,}/i,
    },
    {
        id: 'session-id',
        description: 'sessionId or session_id with a value (field, parameter or XML element)',
        pattern: /\bsession_?id["']?\s*[:=]\s*["']?[A-Za-z0-9!._-]{8,}|<(?:\w+:)?sessionId>\s*[^<\s]{8,}/i,
    },
    {
        id: 'sforce-session',
        description: 'Sforce-Session header with a value',
        pattern: /\bsforce-session["']?\s*[:=]\s*["']?[A-Za-z0-9!._-]{8,}/i,
    },
    {
        id: 'salesforce-session-id',
        description: 'Salesforce session ID shape (org ID, "!", token)',
        pattern: /\b00D[A-Za-z0-9]{12,15}![A-Za-z0-9._]{20,}/,
    },
    {
        id: 'oauth-token-param',
        description: 'access_token, refresh_token or id_token with a value',
        pattern: /\b(?:access|refresh|id)_token["']?\s*[:=]\s*["']?[^\s"'&,;]{8,}/i,
    },
    {
        id: 'jwt',
        description: 'JWT-shaped value (base64url header.payload.signature)',
        pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/,
    },
];

export type MarkerCounts = Record<string, number>;

export interface ReplicaScan {
    replica: string;
    linesWithMarkers: number;
    byMarker: MarkerCounts;
}

export interface SpecScan {
    specId: string;
    scannedLines: number;
    linesWithMarkers: number;
    byMarker: MarkerCounts;
    byReplica: ReplicaScan[];
}

export interface CredentialScan {
    scannedLines: number;
    linesWithMarkers: number;
    clean: boolean;
    /** Every marker, zeros included. */
    byMarker: MarkerCounts;
    bySpec: SpecScan[];
}

/** Lines before the first entry header of a file have no replica. */
export const UNKNOWN_REPLICA = '(unknown)';

function zeroCounts(): MarkerCounts {
    return Object.fromEntries(CREDENTIAL_MARKERS.map((m) => [m.id, 0]));
}

function nonZero(counts: MarkerCounts): MarkerCounts {
    return Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0));
}

/** The ids of the markers a line carries. */
export function markersIn(line: string): string[] {
    return CREDENTIAL_MARKERS.filter((m) => m.pattern.test(line)).map((m) => m.id);
}

/**
 * Scan each spec's log text line by line. Continuation lines (stack traces, JSON Logger bodies,
 * HTTP dumps) belong to the entry above them and share its time and replica. With a window, lines
 * outside it are skipped, and so are lines before a file's first entry, whose time is unknown.
 */
export function scanForCredentials(
    parts: LogPart[],
    window: { startTime?: number; endTime?: number } = {},
): CredentialScan {
    const total = zeroCounts();
    const bounded = window.startTime !== undefined || window.endTime !== undefined;
    let scannedLines = 0;
    let linesWithMarkers = 0;
    const bySpec: SpecScan[] = [];

    for (const part of parts) {
        const spec = { scannedLines: 0, linesWithMarkers: 0, byMarker: zeroCounts() };
        const replicas = new Map<string, { linesWithMarkers: number; byMarker: MarkerCounts }>();
        let current: { timestamp: number; instanceId: string } | null = null;

        for (const line of part.text.split(/\r?\n/)) {
            if (!line.trim()) continue;
            current = lineHeader(line) ?? current;
            if (bounded) {
                if (!current) continue;
                if (window.startTime !== undefined && current.timestamp < window.startTime) continue;
                if (window.endTime !== undefined && current.timestamp > window.endTime) continue;
            }
            spec.scannedLines++;
            const found = markersIn(line);
            if (found.length === 0) continue;

            const replicaId = current?.instanceId || UNKNOWN_REPLICA;
            const replica = replicas.get(replicaId) ?? { linesWithMarkers: 0, byMarker: zeroCounts() };
            replicas.set(replicaId, replica);
            spec.linesWithMarkers++;
            replica.linesWithMarkers++;
            for (const id of found) {
                spec.byMarker[id]++;
                replica.byMarker[id]++;
                total[id]++;
            }
        }

        scannedLines += spec.scannedLines;
        linesWithMarkers += spec.linesWithMarkers;
        bySpec.push({
            specId: part.specId,
            scannedLines: spec.scannedLines,
            linesWithMarkers: spec.linesWithMarkers,
            byMarker: nonZero(spec.byMarker),
            byReplica: [...replicas.entries()]
                .map(([replica, r]) => ({
                    replica,
                    linesWithMarkers: r.linesWithMarkers,
                    byMarker: nonZero(r.byMarker),
                }))
                .sort((a, b) => b.linesWithMarkers - a.linesWithMarkers || a.replica.localeCompare(b.replica)),
        });
    }

    return { scannedLines, linesWithMarkers, clean: linesWithMarkers === 0, byMarker: total, bySpec };
}
