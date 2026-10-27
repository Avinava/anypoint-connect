import { describe, expect, it } from 'vitest';
import {
    buildNotifications,
    displayThreshold,
    evaluationInterval,
    normalizeAlert,
    normalizeRuntimeManagerAlert,
    notificationsOf,
    outsideDomains,
    parseSeverity,
    severityLabel,
    storedThreshold,
    summarizeRecipients,
    windowMinutes,
} from '../../src/workflows/alerts.js';
import { apiAlert, appAlert, runtimeManagerAlert } from '../fixtures/alerts.js';

describe('alert thresholds and windows', () => {
    it('converts percent inputs to fractions for percent metrics only', () => {
        expect(storedThreshold('memory_utilization', 85)).toBe(0.85);
        expect(storedThreshold('cpu_utilization', 99.9)).toBe(0.999);
        expect(storedThreshold('message_error_count', 5)).toBe(5);
        expect(storedThreshold('api_response_time', 1500)).toBe(1500);
        expect(displayThreshold('memory_utilization', 0.85)).toBe(85);
        expect(displayThreshold('message_count', 10)).toBe(10);
    });

    it.each([
        ['memory_utilization', 0],
        ['memory_utilization', 101],
        ['cpu_utilization', -1],
        ['message_count', 1.5],
        ['message_response_time', -10],
    ] as const)('rejects %s threshold %s', (metric, value) => {
        expect(() => storedThreshold(metric, value)).toThrow('threshold');
    });

    it('builds and reads evaluation windows', () => {
        expect(evaluationInterval(5)).toBe('5m');
        expect(() => evaluationInterval(0)).toThrow('durationMinutes');
        expect(() => evaluationInterval(61)).toThrow('durationMinutes');
        expect(windowMinutes('10m')).toBe(10);
        expect(windowMinutes('1h')).toBe(60);
    });
});

describe('alert notifications', () => {
    it('requires explicit notifications and maps message to messageTemplate', () => {
        expect(() => buildNotifications([])).toThrow('At least one notification');
        expect(
            buildNotifications([
                { type: 'EMAIL', recipients: ['ops@example.com'], subject: 'S', message: 'M' },
                { type: 'SLACK', channelId: 'C0SAMPLE', message: 'M' },
            ]),
        ).toEqual([
            { type: 'EMAIL', recipients: ['ops@example.com'], subject: 'S', messageTemplate: 'M' },
            { type: 'SLACK', channelId: 'C0SAMPLE', messageTemplate: 'M' },
        ]);
        expect(() =>
            buildNotifications([{ type: 'EMAIL', recipients: ['not-an-address'], subject: 'S', message: 'M' }]),
        ).toThrow('not email addresses');
        expect(() =>
            buildNotifications([{ type: 'EMAIL', recipients: ['a@example.com'], subject: '', message: 'M' }]),
        ).toThrow('subject');
    });

    it('reads notificationTemplates and writes them back as notifications', () => {
        expect(notificationsOf(appAlert())).toEqual([
            {
                type: 'EMAIL',
                recipients: ['ops@example.com', 'pager@example.org'],
                subject: 'Memory high',
                messageTemplate: 'Memory is high',
            },
        ]);
    });

    it('masks recipients to a count and domains', () => {
        expect(summarizeRecipients(notificationsOf(appAlert()))).toEqual({
            recipientCount: 2,
            recipientDomains: ['example.com', 'example.org'],
            slackChannels: 0,
        });
    });

    it('lists outside domains without returning the user address', () => {
        const outside = outsideDomains(notificationsOf(appAlert()), 'someone@example.com');
        expect(outside).toEqual(['example.org']);
        expect(JSON.stringify(outside)).not.toContain('someone');
    });
});

describe('severity', () => {
    it('accepts 0-3 and labels, and shows labels for every family', () => {
        expect(parseSeverity(3)).toBe(3);
        expect(parseSeverity('low')).toBe(0);
        expect(parseSeverity('CRITICAL')).toBe(3);
        expect(parseSeverity('2')).toBe(2);
        expect(() => parseSeverity(4)).toThrow('severity');
        expect(() => parseSeverity('urgent')).toThrow('severity');
        expect([0, 1, 2, 3].map(severityLabel)).toEqual(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
        expect(['INFO', 'warning', 'Error'].map(severityLabel)).toEqual(['LOW', 'MEDIUM', 'HIGH']);
    });
});

describe('normalizeRuntimeManagerAlert', () => {
    it('reads recipients from actions, the target from condition.resources, and the event type', () => {
        const view = normalizeRuntimeManagerAlert(runtimeManagerAlert());
        expect(view).toEqual({
            id: 'rm-1',
            source: 'runtime-manager',
            name: 'orders deploy failed',
            enabled: true,
            severity: 'LOW',
            status: undefined,
            state: undefined,
            entity: { type: 'application', name: 'orders-sapi', resources: ['orders-sapi'] },
            condition: { event: 'deployment-failed' },
            conditionType: 'event',
            isSystem: false,
            productName: 'cloudhub',
            recipientCount: 3,
        });
        expect(JSON.stringify(view)).not.toContain('example.com');
        const revealed = normalizeRuntimeManagerAlert(runtimeManagerAlert(), { reveal: true });
        expect(revealed.recipientDomains).toEqual(['example.com']);
    });
});

describe('normalizeAlert', () => {
    it.each(['CLOUDHUB', 'CLOUDHUB2', 'RTF', 'HYBRID'] as const)('normalizes a %s app alert', (deploymentType) => {
        const view = normalizeAlert(appAlert({}, deploymentType));
        expect(view).toMatchObject({
            id: 'alert-1',
            source: 'monitoring',
            enabled: true,
            status: 'ACTIVE',
            state: 'OK',
            entity: { type: 'application', name: 'orders-sapi', deploymentType, environment: 'Sandbox' },
            condition: {
                metric: 'memory_utilization',
                operator: 'GREATER_THAN',
                threshold: 85,
                unit: 'percent',
                windowMinutes: 5,
            },
            recipientCount: 2,
        });
        expect(JSON.stringify(view)).not.toContain('ops@example.com');
    });

    it('normalizes an API alert and reveals recipients only on request', () => {
        const view = normalizeAlert(apiAlert());
        expect(view.entity).toMatchObject({ type: 'api', name: 'orders-api', apiInstanceId: '1001' });
        expect(view.condition).toMatchObject({ metric: 'api_response_code_count', threshold: 10, windowMinutes: 10 });
        expect(view).toMatchObject({ recipientCount: 1, slackChannels: 1 });
        expect(normalizeAlert(appAlert(), { reveal: true }).notifications?.[0].recipients).toContain('ops@example.com');
    });
});
