import { describe, expect, it } from 'vitest';
import { createAuthCommand } from '../../src/commands/auth.js';

describe('auth command help', () => {
    it('describes logout as token removal without claiming credentials are deleted', () => {
        const command = createAuthCommand();
        const logout = command.commands.find((candidate) => candidate.name() === 'logout');

        expect(logout?.description()).toBe('Clear stored OAuth tokens (keeps the Client ID and Secret)');
    });
});
