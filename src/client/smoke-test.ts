/**
 * Client application credentials and API smoke tests
 * Shared by the MCP tools and the CLI. Client secrets are resolved on the server, used for
 * one request or one file write, and scrubbed from everything returned.
 */

import * as fs from 'node:fs';
import axios from 'axios';
import type { AnypointClient } from './AnypointClient.js';
import type { ApiPolicy, ClientApplication } from '../api/ApiManagerApi.js';
import { MASKED, redactText } from '../safety/secrets.js';
import { resolveWritablePath } from '../safety/paths.js';
import { errorMessage } from '../utils/errors.js';

/** Methods that run without the write guard. */
export const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Largest body excerpt returned, in bytes. */
export const BODY_EXCERPT_BYTES = 4096;

/** Response headers worth showing; everything else is dropped. */
const HEADER_ALLOWLIST = [
    'content-type',
    'content-length',
    'date',
    'location',
    'retry-after',
    'www-authenticate',
    'x-correlation-id',
    'x-request-id',
    'x-ratelimit-limit',
    'x-ratelimit-remaining',
    'x-ratelimit-reset',
];

/** Mask a client secret as `******…<last4>`; short values are fully masked. */
export function maskClientSecret(secret: string | undefined): string {
    if (!secret) return '';
    return secret.length > 8 ? `${MASKED}…${secret.slice(-4)}` : MASKED;
}

/** Every form a credential pair can take on the wire, for scrubbing. */
export function credentialVariants(clientId?: string, clientSecret?: string): string[] {
    const values = [clientId, clientSecret].filter((v): v is string => Boolean(v));
    const variants = [...values, ...values.map((v) => encodeURIComponent(v))];
    if (clientId && clientSecret) variants.push(Buffer.from(`${clientId}:${clientSecret}`).toString('base64'));
    return variants;
}

/** A client application with the secret masked; safe to print or return. */
export function describeClientApplication(app: ClientApplication) {
    return {
        id: app.id,
        name: app.name,
        description: app.description,
        clientId: app.clientId,
        clientSecret: maskClientSecret(app.clientSecret),
        url: app.url,
        redirectUri: app.redirectUri,
        grantTypes: app.grantTypes,
    };
}

function envValue(value: string, key: string): string {
    if (/^[A-Za-z0-9._~+/=:@-]*$/.test(value)) return value;
    if (!/['\r\n]/.test(value)) return `'${value}'`;
    throw new Error(`${key} cannot be written in .env format`);
}

/**
 * Write `CLIENT_ID`/`CLIENT_SECRET` in .env format at mode 0600, inside the project root.
 * An existing file is replaced only with `overwrite`, and is removed first so the new file
 * never inherits looser permissions or follows a symlink.
 */
export function writeCredentialsFile(
    file: string,
    app: Pick<ClientApplication, 'clientId' | 'clientSecret'>,
    options: { overwrite?: boolean; projectRoot?: string } = {},
): string {
    const target = resolveWritablePath(file, options);
    const content = `CLIENT_ID=${envValue(app.clientId, 'CLIENT_ID')}\nCLIENT_SECRET=${envValue(app.clientSecret, 'CLIENT_SECRET')}\n`;
    if (options.overwrite && fs.existsSync(target)) fs.rmSync(target);
    fs.writeFileSync(target, content, { mode: 0o600, flag: 'wx' });
    fs.chmodSync(target, 0o600);
    return target;
}

export type CredentialStyle =
    | { mode: 'headers'; idHeader: string; secretHeader: string }
    | { mode: 'basic' }
    | { mode: 'none' };

function headerFromExpression(expression: unknown, fallback: string): string {
    if (typeof expression !== 'string') return fallback;
    const match =
        /headers\[\s*['"]([A-Za-z0-9_-]+)['"]\s*\]/.exec(expression) ?? /headers\.([A-Za-z0-9_-]+)/.exec(expression);
    return match ? match[1] : fallback;
}

/**
 * Decide how to send client credentials from the API's policy chain:
 * - an enabled client-id-enforcement policy whose `credentialsOriginHasHttpBasicAuthenticationHeader`
 *   is `httpBasicAuthenticationHeader` means HTTP basic auth;
 * - any other enabled client-id-enforcement policy means headers, named from its
 *   `clientIdExpression`/`clientSecretExpression` (default `client_id`/`client_secret`);
 * - no such policy means no credentials are needed.
 */
export function inferCredentialStyle(policies: ApiPolicy[]): CredentialStyle {
    const policy = policies.find(
        (p) => !p.disabled && /client-id-enforcement/i.test(p.template?.assetId || p.policyTemplateId || ''),
    );
    if (!policy) return { mode: 'none' };
    const config = policy.configurationData ?? {};
    if (config.credentialsOriginHasHttpBasicAuthenticationHeader === 'httpBasicAuthenticationHeader') {
        return { mode: 'basic' };
    }
    return {
        mode: 'headers',
        idHeader: headerFromExpression(config.clientIdExpression, 'client_id'),
        secretHeader: headerFromExpression(config.clientSecretExpression, 'client_secret'),
    };
}

export interface SmokeTestInput {
    api: string;
    path?: string;
    url?: string;
    method?: string;
    clientAppId?: number | string;
    headers?: Record<string, string>;
    body?: unknown;
    expectStatus?: number;
    timeoutMs?: number;
}

/** Everything resolved before a request is sent. Holds no secrets, so it can be previewed. */
export interface SmokeTestPlan {
    api: { id: number; name?: string };
    method: string;
    url: string;
    credentials: CredentialStyle;
    clientApp?: { id: number | string; name?: string };
}

function joinUrl(base: string, path?: string): string {
    if (!path) return base;
    return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function parseHttpUrl(value: string, label: string): URL {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new Error(`${label} is not an absolute URL: ${value}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`${label} must be http or https`);
    return url;
}

/**
 * Resolve the API instance, target URL, credential style and client application. No secret
 * is fetched here. The URL is the instance's endpoint plus `path`, or `url` when given.
 */
export async function planSmokeTest(
    client: AnypointClient,
    orgId: string,
    env: { id: string; name: string },
    input: SmokeTestInput,
): Promise<SmokeTestPlan> {
    const method = (input.method || 'GET').toUpperCase();
    if (!/^[A-Z]+$/.test(method)) throw new Error(`Invalid HTTP method: ${input.method}`);

    const resolved = await client.apiManager.resolveApiInstance(orgId, env, input.api);
    const endpoint = resolved.instance?.endpointUri || resolved.instance?.proxyUri;

    let url: string;
    if (input.url) {
        url = parseHttpUrl(input.url, 'url').toString();
    } else if (endpoint) {
        url = parseHttpUrl(joinUrl(endpoint, input.path), 'API endpoint').toString();
    } else {
        throw new Error(`API ${resolved.apiId} has no endpoint URI in ${env.name}; pass url`);
    }

    const policies = await client.apiManager.getPolicies(orgId, env.id, resolved.apiId);
    let credentials = inferCredentialStyle(policies);
    if (credentials.mode === 'none' && input.clientAppId !== undefined) {
        credentials = { mode: 'headers', idHeader: 'client_id', secretHeader: 'client_secret' };
    }

    let clientApp: SmokeTestPlan['clientApp'];
    if (input.clientAppId !== undefined) {
        clientApp = { id: input.clientAppId };
    } else if (credentials.mode !== 'none') {
        const contracts = await client.apiManager.getContracts(orgId, env.id, resolved.apiId);
        const approved = contracts.filter((c) => (c.status || '').toUpperCase() === 'APPROVED');
        if (approved.length !== 1) {
            const options = approved.map(
                (c) => `${c.application?.name ?? '?'} (${c.application?.id ?? c.applicationId})`,
            );
            throw new Error(
                approved.length === 0
                    ? `API ${resolved.apiId} enforces client credentials but has no approved contracts; pass clientAppId`
                    : `API ${resolved.apiId} has ${approved.length} approved contracts; pass clientAppId, one of: ${options.join(', ')}`,
            );
        }
        const id = approved[0].application?.id ?? approved[0].applicationId;
        if (id === undefined) throw new Error(`Contract ${approved[0].id} names no client application`);
        clientApp = { id, name: approved[0].application?.name };
    }

    if (clientApp && credentials.mode !== 'none') {
        const target = new URL(url);
        const sameAsEndpoint = endpoint ? new URL(endpoint).origin === target.origin : false;
        if (target.protocol !== 'https:' && !sameAsEndpoint) {
            throw new Error(`Refusing to send client credentials over plain HTTP to ${target.origin}; use https`);
        }
    }

    return {
        api: { id: resolved.apiId, name: resolved.asset?.exchangeAssetName },
        method,
        url,
        credentials,
        clientApp,
    };
}

function readExcerpt(stream: NodeJS.ReadableStream, limit: number): Promise<{ bytes: Buffer; truncated: boolean }> {
    return new Promise((resolve) => {
        const chunks: Buffer[] = [];
        let total = 0;
        let done = false;
        const finish = (truncated: boolean) => {
            if (done) return;
            done = true;
            resolve({ bytes: Buffer.concat(chunks).subarray(0, limit), truncated });
        };
        stream.on('data', (chunk: Buffer | string) => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            chunks.push(buffer);
            total += buffer.length;
            if (total > limit) {
                (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
                finish(true);
            }
        });
        stream.on('end', () => finish(false));
        stream.on('error', () => finish(total > limit));
        stream.on('close', () => finish(total > limit));
    });
}

export interface SmokeTestResult {
    api: SmokeTestPlan['api'];
    request: { method: string; url: string; credentials: string; clientApp?: SmokeTestPlan['clientApp'] };
    status: number;
    statusText: string;
    latencyMs: number;
    passed: boolean;
    expectStatus?: number;
    headers: Record<string, string>;
    body: { excerpt: string; truncated: boolean };
}

function describeCredentials(style: CredentialStyle, clientApp?: SmokeTestPlan['clientApp']): string {
    if (!clientApp || style.mode === 'none') return 'none';
    return style.mode === 'basic' ? 'HTTP basic auth' : `headers ${style.idHeader}/${style.secretHeader}`;
}

/**
 * Send the planned request. The client secret is fetched here, and every string in the
 * result, and any error message, is scrubbed of the credentials before it is returned.
 */
export async function executeSmokeTest(
    client: AnypointClient,
    orgId: string,
    plan: SmokeTestPlan,
    input: Pick<SmokeTestInput, 'headers' | 'body' | 'expectStatus' | 'timeoutMs'>,
): Promise<SmokeTestResult> {
    let secrets: string[] = [];
    try {
        const headers: Record<string, string> = { ...(input.headers ?? {}) };
        const style = plan.credentials;
        if (plan.clientApp && style.mode !== 'none') {
            const app = await client.apiManager.getClientApplication(orgId, plan.clientApp.id);
            secrets = credentialVariants(app.clientId, app.clientSecret);
            plan = { ...plan, clientApp: { id: plan.clientApp.id, name: plan.clientApp.name ?? app.name } };
            if (style.mode === 'basic') {
                headers.Authorization = `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString('base64')}`;
            } else {
                headers[style.idHeader] = app.clientId;
                headers[style.secretHeader] = app.clientSecret;
            }
        }

        const started = Date.now();
        const response = await axios.request<NodeJS.ReadableStream>({
            method: plan.method,
            url: plan.url,
            headers,
            data: plan.method === 'GET' || plan.method === 'HEAD' ? undefined : input.body,
            timeout: input.timeoutMs ?? 30000,
            responseType: 'stream',
            maxRedirects: 0,
            validateStatus: () => true,
        });
        const latencyMs = Date.now() - started;

        // Read past the excerpt limit so a secret straddling the cut is still matched whole.
        const { bytes, truncated } = await readExcerpt(response.data, BODY_EXCERPT_BYTES + 1024);
        const excerpt = redactText(bytes.toString('utf8'), secrets).slice(0, BODY_EXCERPT_BYTES);

        const responseHeaders: Record<string, string> = {};
        for (const name of HEADER_ALLOWLIST) {
            const value = response.headers[name];
            if (value !== undefined && value !== null) {
                responseHeaders[name] = redactText(Array.isArray(value) ? value.join(', ') : String(value), secrets);
            }
        }

        const status = response.status;
        return {
            api: plan.api,
            request: {
                method: plan.method,
                url: redactText(plan.url, secrets),
                credentials: describeCredentials(plan.credentials, plan.clientApp),
                clientApp: plan.clientApp,
            },
            status,
            statusText: redactText(response.statusText || '', secrets),
            latencyMs,
            passed: input.expectStatus !== undefined ? status === input.expectStatus : status < 400,
            expectStatus: input.expectStatus,
            headers: responseHeaders,
            body: { excerpt, truncated: truncated || bytes.length > BODY_EXCERPT_BYTES },
        };
    } catch (error) {
        throw new Error(redactText(`Smoke test failed: ${errorMessage(error)}`, secrets));
    }
}
