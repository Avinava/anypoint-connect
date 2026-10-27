import { describe, expect, it } from 'vitest';
import { CREDENTIAL_MARKERS, markersIn, scanForCredentials, UNKNOWN_REPLICA } from '../../src/analysis/credentials.js';

const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
const FAKE_JWT = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'sample-user', iat: 1 })}.c2FtcGxlLXNpZ25hdHVyZQ`;
const FAKE_TOKEN = 'sampleTokenValue0123456789abcdef';
const FAKE_SF_SESSION = `00D000000000001!${'A'.repeat(24)}`;

const at = (minute: number, replica: string, message: string) =>
    `2026-01-01T10:${String(minute).padStart(2, '0')}:00.000Z INFO [${replica}] sample.Logger event:e1 [thread] - ${message}`;

describe('credential marker table', () => {
    it.each([
        ['authorization-bearer', `Authorization: Bearer ${FAKE_TOKEN}`],
        ['authorization-bearer', `{"authorization":"Bearer ${FAKE_TOKEN}"}`],
        ['bearer-token', `token is bearer ${FAKE_TOKEN}`],
        ['session-id', 'sessionId=abcdef0123456789'],
        ['session-id', '<urn:sessionId>abcdef0123456789</urn:sessionId>'],
        ['sforce-session', 'header Sforce-Session: abcdef0123456789'],
        ['sforce-session', '{"Sforce-Session":"abcdef0123456789"}'],
        ['salesforce-session-id', `session ${FAKE_SF_SESSION}`],
        ['oauth-token-param', 'callback?access_token=abcdefgh12345&state=x'],
        ['oauth-token-param', '"refresh_token": "abcdefgh12345"'],
        ['jwt', `token ${FAKE_JWT}`],
    ])('%s matches %s', (id, line) => {
        expect(markersIn(line)).toContain(id);
    });

    it.each([
        'Processing order 42 for customer sample',
        'sessionId field missing',
        'docs mention the Sforce-Session header',
        'Sforce-Session:',
        'Bearer of bad news',
        'access_token=',
        'eyJ not a token',
    ])('does not flag an ordinary line: %s', (line) => {
        expect(markersIn(line)).toEqual([]);
    });

    it('has unique ids', () => {
        const ids = CREDENTIAL_MARKERS.map((m) => m.id);
        expect(new Set(ids).size).toBe(ids.length);
    });
});

describe('scanForCredentials', () => {
    const spec1 = [
        'orphan line before any header with access_token=abcdefgh12345',
        at(0, 'r-old', 'starting'),
        at(1, 'r-old', `outbound call Authorization: Bearer ${FAKE_TOKEN}`),
    ].join('\n');
    const spec2 = [
        at(5, 'r-new', 'request headers:'),
        `  Sforce-Session: ${FAKE_SF_SESSION}`,
        at(6, 'r-new2', `jwt ${FAKE_JWT}`),
        at(7, 'r-new', 'done'),
    ].join('\n');
    const parts = [
        { specId: 'spec-1', text: spec1 },
        { specId: 'spec-2', text: spec2 },
    ];

    it('counts per marker, per spec and per replica, attributing continuation lines', () => {
        const scan = scanForCredentials(parts);
        expect(scan.clean).toBe(false);
        expect(scan.scannedLines).toBe(7);
        expect(scan.linesWithMarkers).toBe(4);
        expect(scan.byMarker).toMatchObject({
            'authorization-bearer': 1,
            'bearer-token': 1,
            'oauth-token-param': 1,
            'sforce-session': 1,
            'salesforce-session-id': 1,
            jwt: 1,
            'session-id': 0,
        });
        expect(scan.bySpec[0]).toMatchObject({ specId: 'spec-1', linesWithMarkers: 2 });
        expect(scan.bySpec[0].byReplica.map((r) => r.replica).sort()).toEqual([UNKNOWN_REPLICA, 'r-old'].sort());
        expect(scan.bySpec[1].byReplica).toEqual([
            { replica: 'r-new', linesWithMarkers: 1, byMarker: { 'sforce-session': 1, 'salesforce-session-id': 1 } },
            { replica: 'r-new2', linesWithMarkers: 1, byMarker: { jwt: 1 } },
        ]);
    });

    it('never returns line text or values', () => {
        const text = JSON.stringify(scanForCredentials(parts));
        for (const value of [FAKE_TOKEN, FAKE_JWT, FAKE_SF_SESSION, 'abcdefgh12345', 'outbound call']) {
            expect(text).not.toContain(value);
        }
    });

    it('respects a time window and skips lines of unknown time inside a bounded window', () => {
        const scan = scanForCredentials(parts, { startTime: Date.parse('2026-01-01T10:05:00.000Z') });
        expect(scan.bySpec[0]).toMatchObject({ scannedLines: 0, linesWithMarkers: 0 });
        expect(scan.linesWithMarkers).toBe(2);
        expect(scan.byMarker['oauth-token-param']).toBe(0);
    });

    it('reports a clean log', () => {
        const scan = scanForCredentials([{ specId: 'spec-1', text: at(0, 'r-1', 'all fine') }]);
        expect(scan).toMatchObject({ clean: true, linesWithMarkers: 0, scannedLines: 1 });
        expect(scan.bySpec[0].byReplica).toEqual([]);
    });
});
