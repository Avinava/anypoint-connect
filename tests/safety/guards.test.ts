/**
 * Tests for Safety Guards
 */
import { describe, it, expect } from 'vitest';
import {
    isProductionEnv,
    validateJarFile,
    buildDeploySummary,
} from '../../src/safety/guards.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('isProductionEnv', () => {
    it('should detect "production" as production', () => {
        expect(isProductionEnv('production')).toBe(true);
    });

    it('should detect "Production" (case-insensitive)', () => {
        expect(isProductionEnv('Production')).toBe(true);
    });

    it('should detect "prod" as production', () => {
        expect(isProductionEnv('prod')).toBe(true);
    });

    it('should detect names containing "production"', () => {
        expect(isProductionEnv('us-east-production')).toBe(true);
    });

    it('should not flag Sandbox as production', () => {
        expect(isProductionEnv('Sandbox')).toBe(false);
    });

    it('should not flag Development as production', () => {
        expect(isProductionEnv('Development')).toBe(false);
    });

    it('should respect the explicit isProduction flag', () => {
        expect(isProductionEnv('Sandbox', true)).toBe(true);
    });

    it('should not override false detection without flag', () => {
        expect(isProductionEnv('Sandbox', false)).toBe(false);
    });
});

describe('validateJarFile', () => {
    const tmpDir = os.tmpdir();

    it('should fail for non-existent file', () => {
        const result = validateJarFile('/nonexistent/file.jar');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('File not found');
    });

    it('should fail for non-.jar extension', () => {
        const tmpFile = path.join(tmpDir, 'test-file.zip');
        fs.writeFileSync(tmpFile, 'content');
        try {
            const result = validateJarFile(tmpFile);
            expect(result.valid).toBe(false);
            expect(result.error).toContain('.jar extension');
        } finally {
            fs.unlinkSync(tmpFile);
        }
    });

    it('should fail for empty jar files', () => {
        const tmpFile = path.join(tmpDir, 'empty.jar');
        fs.writeFileSync(tmpFile, '');
        try {
            const result = validateJarFile(tmpFile);
            expect(result.valid).toBe(false);
            expect(result.error).toContain('empty');
        } finally {
            fs.unlinkSync(tmpFile);
        }
    });

    it('should pass for valid jar file', () => {
        const tmpFile = path.join(tmpDir, 'my-app-1.2.0-mule-application.jar');
        fs.writeFileSync(tmpFile, 'PK content here');
        try {
            const result = validateJarFile(tmpFile);
            expect(result.valid).toBe(true);
            expect(result.artifactId).toBe('my-app');
            expect(result.version).toBe('1.2.0');
        } finally {
            fs.unlinkSync(tmpFile);
        }
    });

    it('should extract SNAPSHOT versions', () => {
        const tmpFile = path.join(tmpDir, 'my-api-2.0.0-SNAPSHOT-mule-application.jar');
        fs.writeFileSync(tmpFile, 'PK content');
        try {
            const result = validateJarFile(tmpFile);
            expect(result.valid).toBe(true);
            expect(result.artifactId).toBe('my-api');
            expect(result.version).toBe('2.0.0-SNAPSHOT');
        } finally {
            fs.unlinkSync(tmpFile);
        }
    });

    it('should pass for jar without standard naming', () => {
        const tmpFile = path.join(tmpDir, 'custom-name.jar');
        fs.writeFileSync(tmpFile, 'content');
        try {
            const result = validateJarFile(tmpFile);
            expect(result.valid).toBe(true);
            expect(result.artifactId).toBeUndefined();
            expect(result.version).toBeUndefined();
        } finally {
            fs.unlinkSync(tmpFile);
        }
    });
});

describe('buildDeploySummary', () => {
    it('should include app name and environment', () => {
        const summary = buildDeploySummary('my-api', 'Sandbox', null);
        expect(summary).toContain('my-api');
        expect(summary).toContain('Sandbox');
    });

    it('should show "New deployment" when no existing app', () => {
        const summary = buildDeploySummary('my-api', 'Sandbox', null);
        expect(summary).toContain('New deployment');
    });

    it('should show production warning for production env', () => {
        const summary = buildDeploySummary('my-api', 'Production', null);
        expect(summary).toContain('PRODUCTION DEPLOYMENT');
    });

    it('should not show production warning for sandbox', () => {
        const summary = buildDeploySummary('my-api', 'Sandbox', null);
        expect(summary).not.toContain('PRODUCTION DEPLOYMENT');
    });

    it('should include version when provided', () => {
        const summary = buildDeploySummary('my-api', 'Sandbox', null, '1.2.0');
        expect(summary).toContain('1.2.0');
    });

    it('should show existing deployment info', () => {
        const existing = {
            id: '1',
            name: 'my-api',
            status: 'APPLIED',
            application: { ref: { version: '1.1.0' } },
            target: { replicas: [{}] },
        } as any;
        const summary = buildDeploySummary('my-api', 'Sandbox', existing, '1.2.0');
        expect(summary).toContain('1.1.0');
        expect(summary).toContain('APPLIED');
    });
});
