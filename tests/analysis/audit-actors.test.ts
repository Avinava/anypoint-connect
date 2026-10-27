import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditLogEntry } from '../../src/api/AuditLogApi.js';
import { ACTOR_RULES, classifyAuditActor, classifyAuditEntries } from '../../src/analysis/audit-actors.js';
import { registerAuditTools } from '../../src/mcp/tools/audit.js';

const app = [{ objectType: 'Application', objectName: 'orders-sapi' }];
const staff = { userName: 'Anypoint Staff' };
const patcher = { clientName: 'Automatic Patching Service', clientId: 'sample-client' };
const entry = (fields: Partial<AuditLogEntry>): AuditLogEntry => ({ action: 'Modify', timestamp: 1, ...fields });

describe('audit actor classification table', () => {
    it.each([
        [
            'staff user modifying an app',
            entry({ ...staff, objects: app }),
            'platform-patch',
            'platform-modify-application',
        ],
        [
            'patcher client modifying an app',
            entry({ ...patcher, objects: app }),
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
            entry({ ...patcher, action: 'Restart Replica', objects: app }),
            'platform-replica',
            'replica-restarted-or-moved',
        ],
        [
            'replica moved, replica object',
            entry({ ...staff, action: 'Move', objects: [{ objectType: 'Replica' }] }),
            'platform-replica',
            'replica-restarted-or-moved',
        ],
        [
            'Patch Fabric by staff',
            entry({ ...staff, action: 'Patch Fabric', objects: [{ objectType: 'Fabric' }] }),
            'platform-infrastructure',
            'infrastructure-patch-action',
        ],
        [
            'Patch Network by the patcher',
            entry({ ...patcher, action: 'Patch Network' }),
            'platform-infrastructure',
            'infrastructure-patch-action',
        ],
        [
            'patch on a network object by staff',
            entry({ ...staff, action: 'Patch', objects: [{ objectType: 'Private Network' }] }),
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
        expect(classifyAuditActor(input)).toEqual({ actorClass, actorRule });
    });

    describe('regression: platform classes need a recognized platform identity', () => {
        it.each([
            [
                'a connected app with no user restarting a replica',
                entry({ clientId: 'sample-app', action: 'Restart Replica', objects: app }),
            ],
            [
                'a connected app with no user moving a replica',
                entry({ clientId: 'sample-app', action: 'Move', objects: [{ objectType: 'Replica' }] }),
            ],
            ['an entry with no actor at all', entry({ action: 'Restart Replica' })],
            ['a user running Patch Fabric', entry({ userName: 'sample.user', action: 'Patch Fabric' })],
            ['a connected app running Patch Network', entry({ clientId: 'sample-app', action: 'Patch Network' })],
            ['a bare client ID modifying an app', entry({ clientId: 'sample-patcher-id', objects: app })],
        ])('%s is user-or-pipeline', (_name, input) => {
            expect(classifyAuditActor(input).actorClass).toBe('user-or-pipeline');
        });

        it('matches replica verbs as whole words ("Remove" is not "move")', () => {
            expect(classifyAuditActor(entry({ ...staff, action: 'Remove Replica' })).actorRule).toBe(
                'platform-identity',
            );
            expect(classifyAuditActor(entry({ ...staff, action: 'Moved Replica' })).actorRule).toBe(
                'replica-restarted-or-moved',
            );
        });
    });

    it('keeps every rule id unique', () => {
        const ids = ACTOR_RULES.map((r) => r.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('counts every class, zeros included', () => {
        const { byClass, entries } = classifyAuditEntries([
            entry({ ...staff, objects: app }),
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
            data: [entry({ ...staff, objects: app }), entry({ userName: 'sample.user', objects: app })],
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

    it('says how to narrow a truncated result', async () => {
        client.auditLog.query.mockResolvedValue({
            total: 500,
            data: [entry({ clientId: 'sample-app', objects: app })],
        });
        const body = JSON.parse((await handlers.get('get_audit_log')!({})).content[0].text);
        expect(body).toMatchObject({ total: 500, returned: 1 });
        expect(body.notice).toContain('objectTypes ["Application"]');
        expect(body.entries[0].actorClass).toBe('user-or-pipeline');
    });
});
