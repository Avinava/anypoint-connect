import { beforeEach, describe, expect, it, vi } from 'vitest';
import password from '@inquirer/password';
import { promptForClientSecret } from '../../src/commands/config.js';

vi.mock('@inquirer/password', () => ({
    default: vi.fn(),
}));

describe('config secret prompt', () => {
    beforeEach(() => {
        vi.mocked(password).mockReset();
    });

    it('masks newly entered Client Secrets', async () => {
        vi.mocked(password).mockResolvedValue('new-secret');

        await expect(promptForClientSecret()).resolves.toBe('new-secret');
        expect(password).toHaveBeenCalledWith({
            message: 'Client Secret:',
            mask: true,
        });
    });

    it('preserves an existing secret when the masked prompt is left blank', async () => {
        vi.mocked(password).mockResolvedValue('');

        await expect(promptForClientSecret('existing-secret')).resolves.toBe('existing-secret');
        expect(password).toHaveBeenCalledWith({
            message: 'Client Secret (leave blank to keep the secret ending cret):',
            mask: true,
        });
    });
});
