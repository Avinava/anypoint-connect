/**
 * Tests for FileStore (encrypted token storage)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FileStore } from '../../src/auth/FileStore.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AnypointTokens } from '../../src/auth/TokenStore.js';

describe('FileStore', () => {
    const originalHome = process.env.HOME;
    let tmpHome: string;

    beforeEach(() => {
        tmpHome = path.join(os.tmpdir(), `anc-test-home-${Date.now()}`);
        fs.mkdirSync(tmpHome, { recursive: true });
        process.env.HOME = tmpHome;
    });

    afterEach(() => {
        process.env.HOME = originalHome;
        fs.rmSync(tmpHome, { recursive: true, force: true });
    });

    const sampleTokens: AnypointTokens = {
        accessToken: 'access-token-123',
        refreshToken: 'refresh-token-456',
        tokenType: 'Bearer',
        expiresIn: 3600,
        expiresAt: Date.now() + 3600000,
        scope: 'full offline_access',
    };

    it('should save and load tokens', async () => {
        const store = new FileStore();
        await store.save(sampleTokens);
        const loaded = await store.load();

        expect(loaded).not.toBeNull();
        expect(loaded!.accessToken).toBe('access-token-123');
        expect(loaded!.refreshToken).toBe('refresh-token-456');
        expect(loaded!.tokenType).toBe('Bearer');
        expect(loaded!.expiresIn).toBe(3600);
        expect(loaded!.scope).toBe('full offline_access');
    });

    it('should return null when no tokens exist', async () => {
        const store = new FileStore();
        const loaded = await store.load();
        expect(loaded).toBeNull();
    });

    it('should clear tokens', async () => {
        const store = new FileStore();
        await store.save(sampleTokens);
        expect(await store.exists()).toBe(true);

        await store.clear();
        expect(await store.exists()).toBe(false);
        expect(await store.load()).toBeNull();
    });

    it('should overwrite existing tokens', async () => {
        const store = new FileStore();
        await store.save(sampleTokens);

        const newTokens: AnypointTokens = {
            ...sampleTokens,
            accessToken: 'new-access-token',
        };
        await store.save(newTokens);

        const loaded = await store.load();
        expect(loaded!.accessToken).toBe('new-access-token');
    });

    it('should store tokens as encrypted data (not plaintext)', async () => {
        const store = new FileStore();
        await store.save(sampleTokens);

        const configDir = path.join(tmpHome, '.anypoint-connect');
        const tokenFile = path.join(configDir, 'tokens.enc');
        const raw = fs.readFileSync(tokenFile, 'utf8');

        // File should be valid JSON with encrypted fields
        const parsed = JSON.parse(raw);
        expect(parsed).toHaveProperty('iv');
        expect(parsed).toHaveProperty('authTag');
        expect(parsed).toHaveProperty('data');

        // Raw data should NOT contain the access token in plaintext
        expect(raw).not.toContain('access-token-123');
    });

    it('should return null for corrupted token files', async () => {
        const store = new FileStore();
        const configDir = path.join(tmpHome, '.anypoint-connect');
        fs.mkdirSync(configDir, { recursive: true });
        fs.writeFileSync(path.join(configDir, 'tokens.enc'), 'corrupted data');

        const loaded = await store.load();
        expect(loaded).toBeNull();
    });

    it('should report exists correctly', async () => {
        const store = new FileStore();
        expect(await store.exists()).toBe(false);

        await store.save(sampleTokens);
        expect(await store.exists()).toBe(true);

        await store.clear();
        expect(await store.exists()).toBe(false);
    });
});
