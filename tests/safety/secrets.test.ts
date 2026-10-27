import { describe, expect, it } from 'vitest';
import {
    MASKED,
    looksSecret,
    redactDeep,
    redactRecord,
    redactText,
    redactValue,
    sanitizePlatformText,
} from '../../src/safety/secrets.js';

describe('sanitizePlatformText', () => {
    const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJzYW1wbGUifQ', 'c2lnbmF0dXJl'].join('.');
    it.each([
        ['an email address', 'bad recipient person.name@example.net', 'bad recipient ***@example.net'],
        ['a JWT', `token ${jwt} rejected`, `token ${MASKED} rejected`],
        ['a bearer token', 'Authorization: Bearer abc.def-123', `Authorization: Bearer ${MASKED}`],
        ['a secret pair', 'client_secret=topsecretvalue&x=1', `client_secret=${MASKED}&x=1`],
        ['a long opaque value', `key ${'A1b2'.repeat(10)} end`, `key ${MASKED} end`],
    ])('masks %s', (_name, input, expected) => {
        expect(sanitizePlatformText(input)).toBe(expected);
    });

    it('keeps resource UUIDs and ordinary text', () => {
        const text = 'Alert 123e4567-e89b-12d3-a456-426614174000 not present or Deleted';
        expect(sanitizePlatformText(text)).toBe(text);
    });
});

describe('looksSecret', () => {
    it.each(['db.password', 'clientSecret', 'API_KEY', 'private.key', 'sf.token', 'db-passwd', 'aws.access.key'])(
        'matches %s',
        (key) => {
            expect(looksSecret(key)).toBe(true);
        },
    );

    it.each(['tokenizer.mode', 'keystore.type', 'http.port', 'api.version', 'client.id', 'secretary.name'])(
        'does not match %s',
        (key) => {
            expect(looksSecret(key)).toBe(false);
        },
    );
});

describe('redactValue', () => {
    it('masks short values completely', () => {
        expect(redactValue('abc')).toBe(MASKED);
        expect(redactValue('12345678')).toBe(MASKED);
    });

    it('keeps the last two characters of values longer than 8 characters', () => {
        expect(redactValue('123456789')).toBe(`${MASKED}…89`);
        expect(redactValue('supersecretvalue')).toBe(`${MASKED}…ue`);
    });

    it('returns MASKED unchanged', () => {
        expect(redactValue(MASKED)).toBe(MASKED);
    });
});

describe('redactRecord', () => {
    it('masks secret-looking keys and leaves the rest', () => {
        expect(redactRecord({ 'db.password': 'hunter2-long-value', 'http.port': '8081' })).toEqual({
            'db.password': `${MASKED}…ue`,
            'http.port': '8081',
        });
    });

    it('masks forced keys even when their names look harmless', () => {
        const result = redactRecord({ 'db.user': 'admin', 'http.port': '8081' }, { keys: ['db.user'] });
        expect(result).toEqual({ 'db.user': MASKED, 'http.port': '8081' });
    });

    it('does not mutate the input', () => {
        const input = { 'sf.token': 'abcdefghijk' };
        redactRecord(input);
        expect(input).toEqual({ 'sf.token': 'abcdefghijk' });
    });
});

describe('redactDeep', () => {
    it('masks secret-looking string fields in nested objects and arrays', () => {
        const body = {
            message: 'bad request',
            details: [{ clientSecret: 'abcdefghijkl', name: 'orders-sapi' }, 'plain'],
            nested: { config: { 'db.password': 'short', port: 8081 } },
        };
        expect(redactDeep(body)).toEqual({
            message: 'bad request',
            details: [{ clientSecret: `${MASKED}…kl`, name: 'orders-sapi' }, 'plain'],
            nested: { config: { 'db.password': MASKED, port: 8081 } },
        });
    });

    it('recurses into non-string values under secret-looking keys', () => {
        expect(redactDeep({ credentials: { password: 'abcdefghijk', user: 'u' } })).toEqual({
            credentials: { password: `${MASKED}…jk`, user: 'u' },
        });
    });

    it('returns primitives unchanged', () => {
        expect(redactDeep('text')).toBe('text');
        expect(redactDeep(42)).toBe(42);
        expect(redactDeep(null)).toBe(null);
    });
});

describe('redactText', () => {
    it('replaces every occurrence of each known value', () => {
        expect(redactText('a=s3cret-value b=s3cret-value', ['s3cret-value'])).toBe(`a=${MASKED} b=${MASKED}`);
    });

    it('replaces the longest value first so a substring secret cannot leave a tail behind', () => {
        expect(redactText('token=abcdefgh', ['abcd', 'abcdefgh'])).toBe(`token=${MASKED}`);
    });

    it('skips values shorter than four characters', () => {
        expect(redactText('the cat sat', ['cat', 'at'])).toBe('the cat sat');
    });

    it('ignores MASKED and empty values', () => {
        expect(redactText('value ****** here', [MASKED, ''])).toBe('value ****** here');
    });
});
