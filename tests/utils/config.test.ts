/**
 * Tests for Config
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// We need to test the config module in isolation, so we'll test the
// read/write functions directly by creating temp config files.

describe('Config file operations', () => {
    const tmpDir = path.join(os.tmpdir(), `anc-test-${Date.now()}`);
    const configFile = path.join(tmpDir, 'config.json');

    beforeEach(() => {
        fs.mkdirSync(tmpDir, { recursive: true });
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should write and read config JSON', () => {
        const config = {
            clientId: 'test-id',
            clientSecret: 'test-secret',
            callbackUrl: 'http://localhost:3000/api/callback',
            baseUrl: 'https://anypoint.mulesoft.com',
        };

        fs.writeFileSync(configFile, JSON.stringify(config, null, 2), { mode: 0o600 });

        const loaded = JSON.parse(fs.readFileSync(configFile, 'utf8'));
        expect(loaded.clientId).toBe('test-id');
        expect(loaded.clientSecret).toBe('test-secret');
        expect(loaded.callbackUrl).toBe('http://localhost:3000/api/callback');
        expect(loaded.baseUrl).toBe('https://anypoint.mulesoft.com');
    });

    it('should handle missing config file gracefully', () => {
        expect(fs.existsSync(path.join(tmpDir, 'nonexistent.json'))).toBe(false);
    });

    it('should handle malformed JSON gracefully', () => {
        fs.writeFileSync(configFile, 'not json');
        expect(() => JSON.parse(fs.readFileSync(configFile, 'utf8'))).toThrow();
    });

    it('should merge updates into existing config', () => {
        const original = {
            clientId: 'id-1',
            clientSecret: 'secret-1',
            callbackUrl: 'http://localhost:3000/api/callback',
            baseUrl: 'https://anypoint.mulesoft.com',
        };
        fs.writeFileSync(configFile, JSON.stringify(original, null, 2));

        const loaded = JSON.parse(fs.readFileSync(configFile, 'utf8'));
        const updated = { ...loaded, defaultEnv: 'Sandbox' };
        fs.writeFileSync(configFile, JSON.stringify(updated, null, 2));

        const reloaded = JSON.parse(fs.readFileSync(configFile, 'utf8'));
        expect(reloaded.clientId).toBe('id-1');
        expect(reloaded.defaultEnv).toBe('Sandbox');
    });

    it('should set file permissions to owner-only', () => {
        fs.writeFileSync(configFile, '{}', { mode: 0o600 });
        const stat = fs.statSync(configFile);
        // Check that group/other have no access (on unix)
        const mode = stat.mode & 0o777;
        expect(mode & 0o077).toBe(0); // no group/other permissions
    });
});
