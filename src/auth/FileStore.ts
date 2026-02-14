/**
 * File Token Store
 * AES-256-GCM encrypted file storage at ~/.anypoint-connect/tokens.enc
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import type { TokenStore, AnypointTokens } from './TokenStore.js';
import { getConfigDir } from '../utils/config.js';

const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const TOKEN_FILE_NAME = 'tokens.enc';

export class FileStore implements TokenStore {
    private readonly filePath: string;
    private readonly encryptionKey: Buffer;

    constructor() {
        const configDir = getConfigDir();
        this.filePath = path.join(configDir, TOKEN_FILE_NAME);

        // Derive key from machine-specific data
        const machineId = `${os.hostname()}-${os.userInfo().username}-anypoint-connect`;
        this.encryptionKey = crypto.scryptSync(machineId, 'anc-salt-v1', 32);
    }

    async save(tokens: AnypointTokens): Promise<void> {
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, this.encryptionKey, iv);

        const serialized = JSON.stringify(tokens);
        let encrypted = cipher.update(serialized, 'utf8', 'hex');
        encrypted += cipher.final('hex');

        const authTag = cipher.getAuthTag();

        const data = {
            iv: iv.toString('hex'),
            authTag: authTag.toString('hex'),
            data: encrypted,
        };

        fs.writeFileSync(this.filePath, JSON.stringify(data), { mode: 0o600 });
    }

    async load(): Promise<AnypointTokens | null> {
        if (!fs.existsSync(this.filePath)) {
            return null;
        }

        try {
            const content = fs.readFileSync(this.filePath, 'utf8');
            const { iv, authTag, data } = JSON.parse(content);

            const decipher = crypto.createDecipheriv(
                ENCRYPTION_ALGORITHM,
                this.encryptionKey,
                Buffer.from(iv, 'hex')
            );
            decipher.setAuthTag(Buffer.from(authTag, 'hex'));

            let decrypted = decipher.update(data, 'hex', 'utf8');
            decrypted += decipher.final('utf8');

            return JSON.parse(decrypted) as AnypointTokens;
        } catch {
            await this.clear();
            return null;
        }
    }

    async clear(): Promise<void> {
        if (fs.existsSync(this.filePath)) {
            fs.unlinkSync(this.filePath);
        }
    }

    async exists(): Promise<boolean> {
        return fs.existsSync(this.filePath);
    }
}
