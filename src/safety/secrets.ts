/**
 * Secret detection and redaction
 * Keeps secret values out of tool responses, CLI output and error messages.
 */

/** The placeholder the platform returns for stored secure property values. */
export const MASKED = '******';

const SECRET_SEGMENTS = new Set([
    'password',
    'passwd',
    'pwd',
    'secret',
    'token',
    'credential',
    'credentials',
    'passphrase',
    'apikey',
    'privatekey',
    'clientsecret',
]);

const SECRET_PAIRS = [
    ['private', 'key'],
    ['api', 'key'],
    ['client', 'secret'],
    ['access', 'key'],
];

/**
 * True when a property name looks like it holds a secret. The name is split on `.`, `_`, `-`
 * and camel-case boundaries, so `db.password`, `clientSecret` and `API_KEY` all match while
 * `tokenizer.mode` or `keystore.type` do not.
 */
export function looksSecret(key: string): boolean {
    const segments = key
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .toLowerCase()
        .split(/[\s._\-/:]+/)
        .filter(Boolean);
    if (segments.some((segment) => SECRET_SEGMENTS.has(segment))) return true;
    for (let i = 0; i < segments.length - 1; i++) {
        if (SECRET_PAIRS.some(([a, b]) => segments[i] === a && segments[i + 1] === b)) return true;
    }
    return false;
}

/** Mask a value, keeping the last two characters of long values so a caller can tell values apart. */
export function redactValue(value: string): string {
    if (value === MASKED) return MASKED;
    return value.length > 8 ? `${MASKED}…${value.slice(-2)}` : MASKED;
}

/**
 * Mask secret-looking entries of a flat record. `keys` forces masking for extra names
 * (for example every key of a secure property map).
 */
export function redactRecord(record: Record<string, string>, options: { keys?: Iterable<string> } = {}) {
    const forced = new Set(options.keys ?? []);
    return Object.fromEntries(
        Object.entries(record).map(([key, value]) => [
            key,
            forced.has(key) || looksSecret(key) ? redactValue(String(value)) : value,
        ]),
    ) as Record<string, string>;
}

/**
 * Recursively mask secret-looking fields in an arbitrary JSON value, such as an API error
 * body the platform echoed back.
 */
export function redactDeep(value: unknown, depth = 0): unknown {
    if (depth > 20) return value;
    if (Array.isArray(value)) return value.map((item) => redactDeep(item, depth + 1));
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>).map(([key, item]) => [
                key,
                looksSecret(key) && typeof item === 'string' ? redactValue(item) : redactDeep(item, depth + 1),
            ]),
        );
    }
    return value;
}

/**
 * Replace every occurrence of known secret values in free text. Values shorter than four
 * characters are skipped because they would match ordinary text.
 */
export function redactText(text: string, knownSecrets: Iterable<string>): string {
    const values = [...new Set(knownSecrets)].filter((v) => v && v !== MASKED && v.length >= 4);
    values.sort((a, b) => b.length - a.length);
    let result = text;
    for (const value of values) result = result.split(value).join(MASKED);
    return result;
}
