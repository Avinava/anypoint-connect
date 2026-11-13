import { describe, expect, it, vi } from 'vitest';
import type { AnypointClient } from '../../src/client/AnypointClient.js';
import type { AlertWriteBody, MonitoringAlert } from '../../src/api/AlertsApi.js';
import { executeDeleteAlert, executeUpdateAlert, notificationsOf } from '../../src/workflows/alerts.js';
import { ORG, appAlert } from '../fixtures/alerts.js';

function bodyOf(alert: MonitoringAlert, overrides: Partial<AlertWriteBody> = {}): AlertWriteBody {
    return {
        id: alert.id,
        name: alert.name,
        severity: alert.severity,
        enabled: alert.enabled,
        settings: alert.settings,
        entity: alert.entity,
        notifications: notificationsOf(alert),
        ...overrides,
    } as AlertWriteBody;
}

function fakeClient(lists: Array<{ alerts: MonitoringAlert[]; complete: boolean }>) {
    let i = 0;
    const alerts = {
        update: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue('accepted'),
        listAll: vi.fn().mockImplementation(async () => lists[Math.min(i++, lists.length - 1)]),
    };
    return { client: { alerts } as unknown as AnypointClient, alerts };
}

const newNotifications = [
    {
        type: 'EMAIL' as const,
        recipients: ['new@example.com'],
        subject: 'Memory high',
        messageTemplate: 'Memory is high',
    },
];

describe('executeUpdateAlert verification', () => {
    it('does not verify a notification-only change while the listed notifications are unchanged', async () => {
        const existing = appAlert();
        const { client } = fakeClient([{ alerts: [existing], complete: true }]);
        const result = await executeUpdateAlert(client, {
            orgId: ORG,
            existing,
            body: bodyOf(existing, { notifications: newNotifications }),
        });
        expect(result.accepted).toBe(true);
        expect(result.verified).toBe(false);
    });

    it('verifies once the listed notifications carry the new values', async () => {
        const existing = appAlert();
        const listed = appAlert({ notificationTemplates: newNotifications });
        const { client } = fakeClient([{ alerts: [listed], complete: true }]);
        const result = await executeUpdateAlert(client, {
            orgId: ORG,
            existing,
            body: bodyOf(existing, { notifications: newNotifications }),
        });
        expect(result.verified).toBe(true);
    });

    it('polls without resending the write until the change shows, within the deadline', async () => {
        const existing = appAlert();
        const pending = appAlert({ alertStatus: 'PENDING' });
        const done = appAlert({ notificationTemplates: newNotifications });
        const { client, alerts } = fakeClient([
            { alerts: [pending], complete: true },
            { alerts: [existing], complete: true },
            { alerts: [done], complete: true },
        ]);
        const result = await executeUpdateAlert(
            client,
            { orgId: ORG, existing, body: bodyOf(existing, { notifications: newNotifications }) },
            { waitMs: 5000, pollIntervalMs: 1 },
        );
        expect(result.verified).toBe(true);
        expect(alerts.update).toHaveBeenCalledTimes(1);
        expect(alerts.listAll).toHaveBeenCalledTimes(3);
    });

    it('returns unverified when the deadline passes', async () => {
        const existing = appAlert();
        const { client, alerts } = fakeClient([{ alerts: [appAlert({ alertStatus: 'PENDING' })], complete: true }]);
        const result = await executeUpdateAlert(
            client,
            { orgId: ORG, existing, body: bodyOf(existing, { notifications: newNotifications }) },
            { waitMs: 20, pollIntervalMs: 5 },
        );
        expect(result.verified).toBe(false);
        expect(result.status).toBe('PENDING');
        expect(alerts.update).toHaveBeenCalledTimes(1);
    });

    it('stops waiting when cancelled', async () => {
        const existing = appAlert();
        const { client } = fakeClient([{ alerts: [appAlert({ alertStatus: 'PENDING' })], complete: true }]);
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 10);
        const started = Date.now();
        const result = await executeUpdateAlert(
            client,
            { orgId: ORG, existing, body: bodyOf(existing, { notifications: newNotifications }) },
            { waitMs: 60_000, pollIntervalMs: 1000, signal: controller.signal },
        );
        expect(result.verified).toBe(false);
        expect(Date.now() - started).toBeLessThan(2000);
    });
});

describe('executeDeleteAlert completion', () => {
    it('polls a complete list until the alert is gone', async () => {
        const alert = appAlert();
        const { client, alerts } = fakeClient([
            { alerts: [appAlert({ alertStatus: 'PENDING' })], complete: true },
            { alerts: [], complete: true },
        ]);
        const result = await executeDeleteAlert(client, ORG, alert, { waitMs: 5000, pollIntervalMs: 1 });
        expect(result.verifiedAbsent).toBe(true);
        expect(alerts.delete).toHaveBeenCalledTimes(1);
    });

    it('never claims deletion from an incomplete list, even when waiting', async () => {
        const alert = appAlert();
        const { client } = fakeClient([{ alerts: [], complete: false }]);
        const result = await executeDeleteAlert(client, ORG, alert, { waitMs: 20, pollIntervalMs: 5 });
        expect(result.verifiedAbsent).toBe(false);
        expect(result.status).toBe('UNVERIFIED');
    });
});
