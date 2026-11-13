import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearConfigCache, getConfig } from '../../src/config/profiles.js';
import { parseAuthMode } from '../../src/config/auth-modes.js';

describe('auth mode configuration', () => {
    let home: string;
    beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), 'cfg-home-'));
        vi.stubEnv('HOME', home);
        for (const key of [
            'ANYPOINT_AUTH_MODE',
            'ANYPOINT_ORG_ID',
            'ANYPOINT_ACCESS_TOKEN',
            'ANYPOINT_CLIENT_ID',
            'ANYPOINT_CLIENT_SECRET',
            'ANYPOINT_PROFILE',
        ]) {
            vi.stubEnv(key, '');
        }
        clearConfigCache();
    });
    afterEach(() => {
        vi.unstubAllEnvs();
        clearConfigCache();
        rmSync(home, { recursive: true, force: true });
    });
    const cwd = () => mkdtempSync(join(tmpdir(), 'cfg-cwd-'));

    it('defaults to the human login and keeps the organization optional', () => {
        vi.stubEnv('ANYPOINT_CLIENT_ID', 'id');
        vi.stubEnv('ANYPOINT_CLIENT_SECRET', 's');
        const config = getConfig({ cwd: cwd() });
        expect(config.authMode).toBe('authorization_code');
        expect(config.orgId).toBeUndefined();
    });

    it('reads an explicit organization for a human login', () => {
        vi.stubEnv('ANYPOINT_CLIENT_ID', 'id');
        vi.stubEnv('ANYPOINT_CLIENT_SECRET', 's');
        vi.stubEnv('ANYPOINT_ORG_ID', 'org-1');
        expect(getConfig({ cwd: cwd() }).orgId).toBe('org-1');
    });

    it('requires an organization for client_credentials, before any request', () => {
        vi.stubEnv('ANYPOINT_AUTH_MODE', 'client_credentials');
        vi.stubEnv('ANYPOINT_CLIENT_ID', 'id');
        vi.stubEnv('ANYPOINT_CLIENT_SECRET', 's');
        expect(() => getConfig({ cwd: cwd() })).toThrow('ANYPOINT_ORG_ID');
        vi.stubEnv('ANYPOINT_ORG_ID', 'org-1');
        clearConfigCache();
        expect(getConfig({ cwd: cwd() })).toMatchObject({ authMode: 'client_credentials', orgId: 'org-1' });
    });

    it('needs no client credentials for bearer, but needs a token and an organization', () => {
        vi.stubEnv('ANYPOINT_AUTH_MODE', 'bearer');
        vi.stubEnv('ANYPOINT_ORG_ID', 'org-1');
        expect(() => getConfig({ cwd: cwd() })).toThrow('ANYPOINT_ACCESS_TOKEN');
        vi.stubEnv('ANYPOINT_ACCESS_TOKEN', 'tok');
        clearConfigCache();
        expect(getConfig({ cwd: cwd() })).toMatchObject({ authMode: 'bearer', accessToken: 'tok' });
    });

    it('still demands client credentials for the browser login', () => {
        expect(() => getConfig({ cwd: cwd() })).toThrow('not configured');
    });

    it('rejects an unknown mode', () => {
        expect(() => parseAuthMode('oauth', 'ANYPOINT_AUTH_MODE')).toThrow('must be one of');
    });
});
