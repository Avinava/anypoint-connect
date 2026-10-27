/**
 * MCP Tool Registrar — API Manager tools
 * list_api_instances, get_api_policies, get_api_alerts, list_api_contracts,
 * get_client_application, smoke_test_api
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AnypointClient } from '../../client/AnypointClient.js';
import { guardWrite, mcpError, mcpText, resolveEnvironment, writeInputs } from './shared.js';
import {
    SAFE_METHODS,
    credentialVariants,
    describeClientApplication,
    executeSmokeTest,
    planSmokeTest,
    writeCredentialsFile,
} from '../../client/smoke-test.js';
import { redactText } from '../../safety/secrets.js';
import { errorMessage } from '../../utils/errors.js';

const apiRefSchema = z.string().describe('API name (partial match) or numeric API instance ID from list_api_instances');

export function registerApiManagerTools(server: McpServer, client: AnypointClient) {
    server.registerTool(
        'list_api_instances',
        {
            title: 'List API Instances',
            description:
                "Lists all managed API instances registered in API Manager for an environment. Returns each API's name, instance ID, status (active/inactive), asset version, technology (Mule 3 or 4), endpoint URI, deprecation flag, and active contract count. Use this to review API governance posture or find the API instance ID needed for get_api_policies.",
            inputSchema: {
                environment: z.string().describe('Environment name or ID'),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ environment }) => {
            try {
                const { orgId, env } = await resolveEnvironment(client, environment);
                const assets = await client.apiManager.getApis(orgId, env.id);

                const instances = assets.flatMap((asset) =>
                    asset.apis.map((api) => ({
                        apiName: asset.exchangeAssetName,
                        apiId: api.id,
                        status: api.status,
                        version: api.assetVersion,
                        technology: api.technology,
                        endpoint: api.endpointUri,
                        deprecated: api.deprecated,
                        contracts: api.activeContractsCount,
                    })),
                );

                return mcpText({ environment: env.name, instances });
            } catch (error) {
                return mcpError(error);
            }
        },
    );

    server.registerTool(
        'get_api_policies',
        {
            title: 'Get API Policies & SLA Tiers',
            description:
                'Returns the full policy chain and SLA tier configuration for a managed API instance. For each policy, shows the template name (e.g. "client-id-enforcement", "rate-limiting"), version, execution order, whether it is disabled, and its configuration. For each SLA tier, shows the name, rate limits, auto-approve setting, and how many client apps have contracted it. Use this to audit API security and rate-limiting configuration.',
            inputSchema: {
                apiName: apiRefSchema,
                environment: z.string().describe('Environment name or ID'),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ apiName, environment }) => {
            try {
                const { orgId, env } = await resolveEnvironment(client, environment);
                const { apiId } = await client.apiManager.resolveApiInstance(orgId, env, apiName);

                const [policies, tiers] = await Promise.all([
                    client.apiManager.getPolicies(orgId, env.id, apiId),
                    client.apiManager.getSlaTiers(orgId, env.id, apiId),
                ]);

                return mcpText({
                    apiId,
                    policies: policies.map((p) => ({
                        id: p.id,
                        template: p.template?.assetId || p.policyTemplateId,
                        version: p.template?.assetVersion,
                        order: p.order,
                        disabled: p.disabled,
                        config: p.configurationData,
                    })),
                    slaTiers: tiers.map((t) => ({
                        name: t.name,
                        status: t.status,
                        autoApprove: t.autoApprove,
                        limits: t.limits,
                        appCount: t.applicationCount,
                    })),
                });
            } catch (error) {
                return mcpError(error);
            }
        },
    );

    server.registerTool(
        'get_api_alerts',
        {
            title: 'Get API Alerts',
            description:
                'Returns the configured alerts for a managed API instance. Shows alert conditions, thresholds, notification settings, and enabled/disabled status. Use this to audit monitoring coverage, verify alerting is configured for critical APIs, or troubleshoot why alerts are not firing.',
            inputSchema: {
                apiName: apiRefSchema,
                environment: z.string().describe('Environment name or ID'),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ apiName, environment }) => {
            try {
                const { orgId, env } = await resolveEnvironment(client, environment);
                const { apiId } = await client.apiManager.resolveApiInstance(orgId, env, apiName);

                const alerts = await client.apiManager.getAlerts(orgId, env.id, apiId);

                return mcpText({
                    apiId,
                    environment: env.name,
                    alertCount: alerts.length,
                    alerts,
                });
            } catch (error) {
                return mcpError(error);
            }
        },
    );

    server.registerTool(
        'list_api_contracts',
        {
            title: 'List API Contracts',
            description:
                'Lists the contracts on a managed API instance: which client applications may call it, on which SLA tier, and whether each contract is approved, pending or revoked. Returns the contract ID, client application name and ID, tier and status. Never returns credentials; use get_client_application for a masked view of one app.',
            inputSchema: {
                environment: z.string().describe('Environment name or ID'),
                api: apiRefSchema,
            },
            annotations: { readOnlyHint: true },
        },
        async ({ environment, api }) => {
            try {
                const { orgId, env } = await resolveEnvironment(client, environment);
                const resolved = await client.apiManager.resolveApiInstance(orgId, env, api);
                const contracts = await client.apiManager.getContracts(orgId, env.id, resolved.apiId);

                return mcpText({
                    environment: env.name,
                    apiId: resolved.apiId,
                    apiName: resolved.asset?.exchangeAssetName,
                    total: contracts.length,
                    contracts: contracts.map((c) => ({
                        contractId: c.id,
                        clientAppId: c.application?.id ?? c.applicationId,
                        clientAppName: c.application?.name,
                        tier: c.tier?.name ?? null,
                        status: c.status,
                    })),
                });
            } catch (error) {
                return mcpError(error);
            }
        },
    );

    server.registerTool(
        'get_client_application',
        {
            title: 'Get Client Application',
            description:
                'Returns a client application from the API Platform: name, client ID and the client secret masked as "******…last4". The full secret is never returned. To use the credentials, pass writeCredentialsTo: the server writes CLIENT_ID and CLIENT_SECRET in .env format to that file inside the project root (mode 0600) and returns only the path. That file then works as a secret source for other tools.',
            inputSchema: {
                appId: z
                    .union([z.number().int(), z.string()])
                    .describe('Client application ID (see list_api_contracts)'),
                writeCredentialsTo: z
                    .string()
                    .optional()
                    .describe('Path inside the project root to write CLIENT_ID/CLIENT_SECRET (.env format, mode 0600)'),
                overwrite: z.boolean().optional().describe('Replace writeCredentialsTo when it already exists'),
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
        },
        async ({ appId, writeCredentialsTo, overwrite }) => {
            let secrets: string[] = [];
            try {
                const orgId = await client.getDefaultOrgId();
                const app = await client.apiManager.getClientApplication(orgId, appId);
                secrets = credentialVariants(undefined, app.clientSecret);
                const credentialsWrittenTo = writeCredentialsTo
                    ? writeCredentialsFile(writeCredentialsTo, app, { overwrite })
                    : undefined;
                const text = JSON.stringify(
                    {
                        ...describeClientApplication(app),
                        ...(credentialsWrittenTo ? { credentialsWrittenTo, fileMode: '0600' } : {}),
                    },
                    null,
                    2,
                );
                return mcpText(redactText(text, secrets));
            } catch (error) {
                return mcpError(redactText(errorMessage(error), secrets));
            }
        },
    );

    server.registerTool(
        'smoke_test_api',
        {
            title: 'Smoke Test API',
            description:
                "Sends one HTTP request to a managed API and reports the status, latency, a few response headers and a body excerpt (4 KB at most). The server resolves the client credentials: from clientAppId, or from the API's only approved contract. They are sent as client_id/client_secret headers, or as HTTP basic auth when the API's client-id-enforcement policy reads credentials from the basic auth header, and are scrubbed from every output and error. The URL is the API instance's endpoint plus path, or url when given. GET, HEAD and OPTIONS run directly; other methods return a preview until confirm is true (plus confirmProduction in production).",
            inputSchema: {
                environment: z.string().describe('Environment name or ID'),
                api: apiRefSchema,
                path: z.string().optional().describe('Path appended to the API endpoint URI, e.g. /api/orders?limit=1'),
                url: z
                    .string()
                    .optional()
                    .describe('Absolute URL to call instead of the endpoint URI (required when the API has none)'),
                method: z.string().optional().describe('HTTP method (default GET)'),
                clientAppId: z
                    .union([z.number().int(), z.string()])
                    .optional()
                    .describe('Client application whose credentials to send (default: the only approved contract)'),
                headers: z.record(z.string(), z.string()).optional().describe('Extra request headers'),
                body: z.unknown().optional().describe('Request body: a string or a JSON value'),
                expectStatus: z.number().int().optional().describe('Expected status code; passed reflects it'),
                timeoutMs: z.number().int().min(100).max(120000).optional().describe('Request timeout (default 30000)'),
                ...writeInputs,
            },
            annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
        },
        async (input) => {
            try {
                const { orgId, env } = await resolveEnvironment(client, input.environment);
                const plan = await planSmokeTest(client, orgId, env, input);

                if (!SAFE_METHODS.has(plan.method)) {
                    const blocked = guardWrite({
                        orgId,
                        env,
                        tool: 'smoke_test_api',
                        confirm: input.confirm,
                        confirmProduction: input.confirmProduction,
                        preview: {
                            action: 'smoke_test_api',
                            environment: env.name,
                            api: plan.api,
                            method: plan.method,
                            url: plan.url,
                            clientApp: plan.clientApp,
                            note: `${plan.method} may change data in the API's backend`,
                        },
                    });
                    if (blocked) return blocked;
                }

                const result = await executeSmokeTest(client, orgId, plan, input);
                return mcpText({ environment: env.name, ...result });
            } catch (error) {
                return mcpError(error);
            }
        },
    );
}
