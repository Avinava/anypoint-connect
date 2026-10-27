import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditLogEntry } from '../../src/api/AuditLogApi.js';
import { ACTOR_RULES, classifyAuditActor, classifyAuditEntries } from '../../src/analysis/audit-actors.js';
import { registerAuditTools } from '../../src/mcp/tools/audit.js';

const app = [{ objectType: 'Application', objectName: 'orders-sapi' }];
const entry = (fields: Partial<AuditLogEntry>): AuditLogEntry => ({ action: 'Modify', timestamp: 1, ...fields });

describe('audit actor classification table', () => {
    it.each([
        [
            'staff user modifying an app',
            entry({ userName: 'Anypoint Staff', objects: app }),
            'platform-patch',
            'platform-modify-application',
        ],
        [
            'automatic patcher client modifying an app',
            entry({ clientName: 'Automatic Patching Service', clientId: 'sample-client', objects: app }),
            'platform-patch',
            'platform-modify-application',
        ],
        [
            'configured patcher client id',
            entry({ clientId: 'sample-patcher-id', objects: app }),
            'platform-patch',
            'platform-modify-application',
        ],
        [
            'staff user doing something else',
            entry({ action: 'Create', userName: 'MuleSoft Support', objects: [{ objectType: 'Alert' }] }),
            'platform-patch',
            'platform-identity',
        ],
        [
            'replica restarted by the platform',
            entry({ action: 'Restart Replica', objects: app }),
            'platform-replica',
            'replica-restarted-or-moved',
        ],
        [
            'replica moved, replica object',
            entry({ action: 'Move', objects: [{ objectType: 'Replica' }] }),
            'platform-replica',
            'replica-restarted-or-moved',
        ],
        [
            'Patch Fabric',
            entry({ action: 'Patch Fabric', objects: [{ objectType: 'Fabric' }] }),
            'platform-infrastructure',
            'infrastructure-patch-action',
        ],
        ['Patch Network', entry({ action: 'Patch Network' }), 'platform-infrastructure', 'infrastructure-patch-action'],
        [
            'patch on a network object',
            entry({ action: 'Patch', objects: [{ objectType: 'Private Network' }] }),
            'platform-infrastructure',
            'infrastructure-patch-object',
        ],
        ['a user modifying an app', entry({ userName: 'sample.user', objects: app }), 'user-or-pipeline', 'default'],
        [
            'a pipeline client modifying an app',
            entry({ clientName: 'release-pipeline', clientId: 'ci-client', objects: app }),
            'user-or-pipeline',
            'default',
        ],
        [
            'a user restarting a replica',
            entry({ action: 'Restart Replica', userName: 'sample.user', objects: app }),
            'user-or-pipeline',
            'default',
        ],
    ])('%s', (_name, input, actorClass, actorRule) => {
        expect(classifyAuditActor(input, { platformClientIds: ['sample-patcher-id'] })).toEqual({
            actorClass,
            actorRule,
        });
    });

    it('keeps every rule id unique', () => {
        const ids = ACTOR_RULES.map((r) => r.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('counts every class, zeros included', () => {
        const { byClass, entries } = classifyAuditEntries([
            entry({ userName: 'Anypoint Staff', objects: app }),
            entry({ userName: 'sample.user', objects: app }),
            entry({ userName: 'sample.user', objects: app }),
        ]);
        expect(byClass).toEqual({
            'platform-patch': 1,
            'platform-replica': 0,
            'platform-infrastructure': 0,
            'user-or-pipeline': 2,
        });
        expect(entries[0]).toMatchObject({ userName: 'Anypoint Staff', actorClass: 'platform-patch' });
    });
});

describe('get_audit_log', () => {
    const handlers = new Map<string, (input: any) => Promise<any>>();
    const server = {
        registerTool: vi.fn((name: string, _d: unknown, h: (input: any) => Promise<any>) => handlers.set(name, h)),
    };
    const client = { getDefaultOrgId: vi.fn().mockResolvedValue('org-1'), auditLog: { query: vi.fn() } };

    beforeEach(() => {
        handlers.clear();
        vi.clearAllMocks();
        registerAuditTools(server as any, client as any);
    });

    it('classifies entries, summarizes by class and keeps the filters', async () => {
        client.auditLog.query.mockResolvedValue({
            total: 2,
            data: [
                entry({ userName: 'Anypoint Staff', objects: app }),
                entry({ userName: 'sample.user', objects: app }),
            ],
        });
        const body = JSON.parse(
            (await handlers.get('get_audit_log')!({ objectTypes: ['Application'], actions: ['Modify'], limit: 5 }))
                .content[0].text,
        );
        expect(client.auditLog.query).toHaveBeenCalledWith(
            'org-1',
            expect.objectContaining({ objectTypes: ['Application'], actions: ['Modify'], limit: 5 }),
        );
        expect(body.summary.byClass).toMatchObject({ 'platform-patch': 1, 'user-or-pipeline': 1 });
        expect(body.entries.map((e: any) => e.actorClass)).toEqual(['platform-patch', 'user-or-pipeline']);
        expect(body.notice).toBeUndefined();
    });

    it('says how to narrow a truncated result and honors platformClientIds', async () => {
        client.auditLog.query.mockResolvedValue({
            total: 500,
            data: [entry({ clientId: 'sample-patcher-id', objects: app })],
        });
        const body = JSON.parse(
            (await handlers.get('get_audit_log')!({ platformClientIds: ['sample-patcher-id'] })).content[0].text,
        );
        expect(body).toMatchObject({ total: 500, returned: 1 });
        expect(body.notice).toContain('objectTypes ["Application"]');
        expect(body.entries[0].actorClass).toBe('platform-patch');
    });
});
