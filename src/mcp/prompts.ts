/**
 * MCP Prompt Registrar
 * Registers guided workflow prompts for common Anypoint operations
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export function registerPrompts(server: McpServer) {
    // ── Pre-Deployment Readiness Check ──────────────────

    server.registerPrompt(
        'pre-deploy-check',
        {
            title: 'Pre-Deployment Readiness Check',
            description:
                'Runs a comprehensive readiness check before deploying or promoting a Mule application. Validates the current state of the target environment, checks for version drift, reviews recent error rates, and compares source and target configurations.',
            argsSchema: {
                appName: z.string().describe('Application name to deploy'),
                sourceEnv: z.string().describe('Source environment (e.g. "Development")'),
                targetEnv: z.string().describe('Target environment for deployment (e.g. "Production")'),
            },
        },
        async ({ appName, sourceEnv, targetEnv }) => ({
            messages: [
                {
                    role: 'user' as const,
                    content: {
                        type: 'text' as const,
                        text: `I'm about to promote "${appName}" from ${sourceEnv} to ${targetEnv}. Run a pre-deployment readiness check:

1. **Source status**: Use get_app_status to check "${appName}" in ${sourceEnv} — confirm it's APPLIED/RUNNING and healthy.
2. **Target status**: Use get_app_status to check if "${appName}" exists in ${targetEnv} — note the current version and replica count.
3. **Version comparison**: Use compare_environments to compare ${sourceEnv} vs ${targetEnv} and highlight the version difference for this app.
4. **Error check**: Use get_logs to fetch the last 50 ERROR-level logs from ${sourceEnv} — flag any recent errors that might indicate instability.
5. **Metrics baseline**: Use get_metrics for "${appName}" in ${sourceEnv} with the last 24 hours — report error rate and average response time.

Produce a GO / NO-GO recommendation with rationale. If there are concerns, list them as action items before proceeding.`,
                    },
                },
            ],
        }),
    );

    // ── Troubleshoot Application ────────────────────────

    server.registerPrompt(
        'troubleshoot-app',
        {
            title: 'Troubleshoot Application',
            description:
                'Systematically diagnoses issues with a Mule application by checking deployment health, analyzing error logs, reviewing metrics for anomalies, and suggesting MuleSoft-specific root causes and remediations.',
            argsSchema: {
                appName: z.string().describe('Application name that is having issues'),
                environment: z.string().describe('Environment where the issue is occurring'),
                symptom: z
                    .string()
                    .optional()
                    .describe(
                        'Description of the issue (e.g. "high latency", "502 errors", "not processing messages")',
                    ),
            },
        },
        async ({ appName, environment, symptom }) => ({
            messages: [
                {
                    role: 'user' as const,
                    content: {
                        type: 'text' as const,
                        text: `The application "${appName}" in ${environment} is experiencing issues${symptom ? `: "${symptom}"` : ''}. Please diagnose:

1. **Deployment health**: Use get_app_status to check replica states — look for FAILED or PARTIAL_STARTED replicas, recent restarts, or version mismatches.
2. **Error analysis**: Use get_logs with level=ERROR and 200 lines to identify error patterns. Group errors by type (e.g. MULE:CONNECTIVITY, MULE:EXPRESSION, HTTP:TIMEOUT, java.lang.OutOfMemoryError).
3. **Performance check**: Use get_metrics for the last 4 hours — look for spikes in error count, elevated response times, or sudden drops in request volume.
4. **Root cause analysis**: Based on the evidence, identify the most likely root cause from common MuleSoft issues:
   - DataWeave transformation errors (MULE:EXPRESSION)
   - Downstream service timeouts (HTTP:TIMEOUT, HTTP:CONNECTIVITY)
   - Memory pressure / ObjectStore issues
   - Configuration property errors (missing secure properties, wrong endpoint URLs)
   - Database connection pool exhaustion
   - API autodiscovery or policy enforcement failures
5. **Remediation**: Suggest specific fixes. If a restart would help, use restart_app. If scaling is needed, recommend scale_app with a replica count.`,
                    },
                },
            ],
        }),
    );

    // ── API Governance Audit ────────────────────────────

    server.registerPrompt(
        'api-governance-audit',
        {
            title: 'API Governance Audit',
            description:
                'Reviews the API governance posture for an environment: checks which APIs have policies applied, validates that security policies (client-id-enforcement, OAuth, JWT) are present, reviews SLA tier configurations, and identifies gaps.',
            argsSchema: {
                environment: z.string().describe('Environment to audit (e.g. "Production")'),
            },
        },
        async ({ environment }) => ({
            messages: [
                {
                    role: 'user' as const,
                    content: {
                        type: 'text' as const,
                        text: `Run an API governance audit on the ${environment} environment:

1. **Inventory**: Use list_api_instances to get all managed APIs. Note any with status "inactive" or that are deprecated.
2. **Policy review**: For each active API, use get_api_policies to check its policy chain. Flag APIs that are MISSING:
   - Authentication policy (client-id-enforcement, oauth2, jwt-validation)
   - Rate limiting or spike control
3. **SLA compliance**: Check which APIs have SLA tiers configured. Note any with auto-approve enabled in a production environment (potential security concern).
4. **Contract count**: Identify APIs with zero active contracts (may indicate unused/orphaned APIs).
5. **Governance scorecard**: Produce a summary table with columns: API Name | Auth Policy | Rate Limit | SLA Tiers | Contracts | Status
   Mark each cell with ✅ (compliant) or ❌ (gap found).

End with prioritized recommendations for improving governance posture.`,
                    },
                },
            ],
        }),
    );

    // ── Environment Health Overview ─────────────────────

    server.registerPrompt(
        'environment-overview',
        {
            title: 'Environment Health Overview',
            description:
                'Generates a comprehensive health report for an Anypoint environment covering all deployed apps, error rates, performance metrics, and deployment status — ideal for daily standups, handoffs, or executive summaries.',
            argsSchema: {
                environment: z.string().describe('Environment to report on (e.g. "Production")'),
            },
        },
        async ({ environment }) => ({
            messages: [
                {
                    role: 'user' as const,
                    content: {
                        type: 'text' as const,
                        text: `Generate a health overview report for the ${environment} environment:

1. **App inventory**: Use list_apps to get all deployed applications. Count total apps, how many are APPLIED/RUNNING vs FAILED/DEPLOYING.
2. **Error landscape**: Use get_metrics for all apps over the last 24 hours. Rank apps by error count (highest first). Flag any app with error rate above 1%.
3. **Performance**: From the same metrics, identify the 3 slowest apps by average response time. Note any above 1000ms.
4. **Top errors**: For the app with the most errors, use get_logs with level=ERROR and 50 lines to identify the dominant error pattern.
5. **Version audit**: Note any apps running on different Mule runtime versions — inconsistent runtimes can indicate missed upgrades.

Format the report with clear sections and emojis for quick scanning:
- 🟢 Healthy (no errors, good response times)
- 🟡 Warning (elevated errors or latency)
- 🔴 Critical (failures, high error rate)`,
                    },
                },
            ],
        }),
    );

    // ── Improve API Spec ────────────────────────────────

    server.registerPrompt(
        'improve-api-spec',
        {
            title: 'Improve API Specification',
            description:
                'Reads an API specification from Design Center, analyzes its quality (descriptions, types, examples), suggests improvements, and pushes the updated spec back. Automates the full pull → analyze → improve → push workflow.',
            argsSchema: {
                project: z.string().describe('Design Center project name (e.g. "order-api")'),
            },
        },
        async ({ project }) => ({
            messages: [
                {
                    role: 'user' as const,
                    content: {
                        type: 'text' as const,
                        text: `Improve the API specification for the Design Center project "${project}". Follow this workflow:

1. **Discover**: Use get_design_center_files to list all files in the "${project}" project. Identify the main spec file (usually the .raml or .yaml file matching the project name).

2. **Read**: Use read_design_center_file to read the main spec file. Also read any referenced data type files, examples, or fragments.

3. **Analyze**: Evaluate the spec quality against these criteria:
   - **Descriptions**: Are all endpoints, parameters, and types described? Are descriptions detailed enough (purpose, return data, use cases)?
   - **Types**: Are response/request types defined, or are they using "any"?
   - **Examples**: Are there inline examples or !include references?
   - **Parameters**: Do query parameters have descriptions, types, and display names?
   - **Security**: Are endpoints secured appropriately?
   - **Consistency**: Are naming conventions consistent across endpoints?

4. **Improve**: Rewrite the spec with:
   - Multi-line descriptions using YAML block scalar (|) that explain purpose, return data, and common use cases
   - Specific parameter descriptions mentioning format (e.g., "18-character Salesforce record ID")
   - Consistent naming and formatting
   - Keep all !include references, examples, and types unchanged

5. **Push**: Use update_design_center_file to save the improved spec back to Design Center. Use a commit message like "Improved API descriptions and documentation".

6. **Report**: Summarize what was changed — how many descriptions were improved, what patterns were fixed, and any remaining gaps.`,
                    },
                },
            ],
        }),
    );
}
