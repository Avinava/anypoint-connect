<p align="center">
  <img src="assets/logo.svg" alt="Anypoint Connect Banner" width="100%" />
</p>

# Anypoint Connect

> CLI + MCP toolkit for Anypoint Platform — deploy, tail logs, pull metrics, manage API specs, with production safety nets.

[![CI](https://github.com/Avinava/anypoint-connect/actions/workflows/ci.yml/badge.svg)](https://github.com/Avinava/anypoint-connect/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@sfdxy/anypoint-connect)](https://www.npmjs.com/package/@sfdxy/anypoint-connect)

```bash
npm install -g @sfdxy/anypoint-connect
```

---

## Architecture

```mermaid
graph LR
    CLI["CLI — anc"] --> AC["AnypointClient"]
    MCP["MCP Server"] --> AC
    LIB["Library"] --> AC

    AC --> HTTP["HttpClient"]
    HTTP --> AP["Anypoint Platform API"]

    AC --> CH2["CloudHub2"]
    AC --> MON["Monitoring"]
    AC --> LOGS["Logs"]
    AC --> EX["Exchange"]
    AC --> APIM["API Manager"]
    AC --> DC["Design Center"]
    AC --> AUDIT["Audit Log"]
    AC --> MQ["Anypoint MQ"]
    AC --> OS["Object Store"]
```

```
src/
├── auth/              OAuth2 + encrypted token storage
│   ├── OAuthFlow.ts         Browser callback at /api/callback
│   ├── TokenManager.ts      Auto-refresh with 5-min buffer
│   ├── FileStore.ts         AES-256-GCM encrypted tokens
│   └── TokenStore.ts        Storage interface
├── client/            HTTP + facade
│   ├── AnypointClient.ts    Main facade (single entry point)
│   ├── HttpClient.ts        Axios with Bearer injection
│   ├── RateLimiter.ts       Token bucket throttling
│   └── Cache.ts             TTL in-memory cache with observability
├── api/               Domain API clients
│   ├── CloudHub2Api.ts      Deploy, redeploy, restart, scale, poll
│   ├── LogsApi.ts           Tail, download (CH2 native)
│   ├── MonitoringApi.ts     AMQL queries (request + JVM metrics), JSON/CSV export
│   ├── ExchangeApi.ts       Search assets, download specs
│   ├── ApiManagerApi.ts     API instances, policies, SLA tiers
│   ├── DesignCenterApi.ts   Projects, files, lock/save, publish
│   ├── AuditLogApi.ts       Platform audit events (who changed what)
│   ├── AnypointMQApi.ts     Queue/exchange management, message browsing
│   ├── ObjectStoreApi.ts    Object Store v2 — stores, keys, values
│   └── AccessManagementApi.ts  User, environments, org entitlements
├── analysis/          Log analysis pipeline
│   ├── LogAnalyzer.ts       Pipeline orchestrator
│   ├── parser.ts            Multi-line joiner + JSON Logger parser
│   ├── error-context.ts     Error context windows (before/after)
│   ├── error-grouper.ts     Clusters similar errors
│   ├── pattern-detector.ts  Recurring message templates
│   ├── stats.ts             Level distribution, error spikes
│   ├── types.ts             Shared type definitions
│   └── utils.ts             Noise detection, templatization
├── commands/          CLI commands
│   ├── config.ts      init | show | set | path | profiles | use
│   ├── auth.ts        login | logout | status (--profile)
│   ├── apps.ts        list | status | restart | scale
│   ├── deploy.ts      deploy with prod safety net
│   ├── logs.ts        tail | download
│   ├── monitor.ts     view | perf | trend | workers | memory | memory-trend | compare | download
│   ├── exchange.ts    search | info | download-spec
│   ├── api.ts         list | policies | sla-tiers
│   └── design-center.ts  list | files | pull | push | publish
├── safety/            Production guards
│   └── guards.ts      Env detection, JAR validation, confirmation
├── utils/
│   └── config.ts      Profile-based config resolution
├── cli.ts             CLI entry point (bin: anc)
├── mcp.ts             MCP server entry point
└── index.ts           Library barrel export
```

### Config Resolution

Config uses **named profiles** for multi-org support. A profile is first resolved, then credentials within that profile:

**Profile resolution** (highest priority wins):

| Priority | Source | Example |
|----------|--------|---------|
| **1** | `--profile` CLI flag | `anc apps list --profile client-a --env Sandbox` |
| **2** | `ANYPOINT_PROFILE` env var | `export ANYPOINT_PROFILE=client-a` |
| **3** | `.anypoint-connect.json` in project | `{ "profile": "client-a" }` (walks up from cwd) |
| **4** | Fallback | `"default"` |

**Credential resolution** within a profile (highest priority wins):

| Priority | Source | When to use |
|----------|--------|-------------|
| **1 (highest)** | Environment variables | CI/CD pipelines, Docker, per-session overrides |
| **2** | Profile config.json | Day-to-day development — persists per profile |
| **3 (lowest)** | `.env` in cwd | Legacy/project-local fallback |

Storage layout:

```
~/.anypoint-connect/
└── profiles/
    ├── default/
    │   ├── config.json     OAuth credentials (chmod 600)
    │   └── tokens.enc      AES-256-GCM encrypted tokens
    └── client-a/
        ├── config.json
        └── tokens.enc
```

---

## Setup

### 1. Install

```bash
# Global install (recommended)
npm install -g @sfdxy/anypoint-connect

# Or from source
git clone https://github.com/Avinava/anypoint-connect.git
cd anypoint-connect
npm install && npm run build
npm link   # makes "anc" available globally
```

### 2. Create a Connected App in Anypoint Platform

1. Log in to [Anypoint Platform](https://anypoint.mulesoft.com)
2. Go to **Access Management → Connected Apps**
3. Click **Create app**, choose **App that acts on a user's behalf**
4. Set the **Redirect URI** to `http://localhost:3000/api/callback`
5. Grant scopes:
   - `General` → **View Organization**, **View Environment**
   - `Runtime Manager` → **Read Applications**, **Create/Modify Applications**
   - `CloudHub` → **Read Applications**, **Manage Applications**
   - `Monitoring` → **Read Metrics**
   - `Design Center` → **Read/Write Designer**
   - `Exchange` → **Exchange Contributor**
   - `Audit Logs` → **View Audit Logs** (optional, for `get_audit_log`)
6. Copy the **Client ID** and **Client Secret**

### 3. Configure

```bash
# Default profile (single-org)
anc config init

# Named profile (multi-org)
anc config init --profile client-a
anc config init --profile client-b
```

### 4. Authenticate

```bash
anc auth login                     # Default profile
anc auth login --profile client-a  # Specific profile
anc auth status                    # Check current auth
```

### 5. Bind a Project to a Profile

```bash
cd ~/projects/client-a-integrations
anc config use client-a
# Creates .anypoint-connect.json → { "profile": "client-a" }
# Now all commands & MCP in this folder auto-use "client-a"
```

### Managing Config

```bash
anc config show                      # Show config (secrets masked)
anc config show --profile client-a   # Show specific profile
anc config set defaultEnv Production  # Update a value
anc config profiles                  # List all profiles

# Override per-session
ANYPOINT_PROFILE=client-b anc apps list --env Sandbox
```

---

## CLI Reference

### Applications

```bash
anc apps list --env Sandbox
anc apps status my-api --env Sandbox
anc apps restart my-api --env Production      # prod confirmation prompt
anc apps scale my-api --env Sandbox --replicas 2
anc apps scale my-api --env Production --replicas 3 --force  # skip confirmation
```

### Deploy

```bash
# Standard deploy
anc deploy target/my-api-1.2.0-mule-application.jar \
  --app my-api --env Sandbox --runtime 4.8.0

# Production deploy — triggers safety confirmation
anc deploy target/my-api.jar --app my-api --env Production
#   ⚠️  PRODUCTION DEPLOYMENT
#   App:         my-api
#   Environment: Production
#   Current:     v1.1.0 (APPLIED, 2 replicas)
#   New Version: v1.2.0
#   Type 'deploy to production' to confirm: _

# CI/CD (skip confirmation)
anc deploy app.jar --app my-api --env Production --force
```

### Logs

```bash
# Stream logs in real-time
anc logs tail my-api --env Sandbox
anc logs tail my-api --env Sandbox --level ERROR --search "NullPointerException"

# Download logs
anc logs download my-api --env Sandbox --from 24h
anc logs download my-api --env Production --from 7d --level ERROR
anc logs download my-api --env Production \
  --from "2026-02-01T00:00:00Z" --to "2026-02-14T00:00:00Z" --output prod-logs.log
```

### Monitoring

```bash
# View metrics table (default: last 24h)
anc monitor view --env Sandbox
anc monitor view --env Production --app my-api --from 7d

# Performance percentiles
anc monitor perf --env Production

# JVM memory usage
anc monitor memory --env Production
anc monitor memory --env Production --app my-api

# Memory trend over time
anc monitor memory-trend --env Production --app my-api --granularity 1h

# Worker/replica metrics
anc monitor workers --env Production --app my-api

# Cross-environment comparison
anc monitor compare

# Export
anc monitor download --env Production --from 30d --format json
anc monitor download --env Sandbox --from 7d --format csv --output metrics.csv
```

### Exchange

```bash
anc exchange search "order" --type rest-api --limit 10
anc exchange info my-api-spec
anc exchange info org-id/my-api-spec --version 1.2.0
anc exchange download-spec my-api-spec -o spec.json
```

### API Manager

```bash
anc api list --env Production
anc api policies "order-api" --env Production
anc api policies 18888853 --env Production
anc api sla-tiers "order-api" --env Production
```

### Design Center

```bash
# List projects & files
anc dc list
anc dc files my-api-spec --branch develop

# Pull a spec file (auto-decodes JSON-encoded content)
anc dc pull my-api-spec api.raml -o local-spec.raml

# Push (smart path resolution: auto-matches local filename to remote)
anc dc push my-api-spec local-spec.raml --message "Add new endpoint"

# Push with explicit remote path
anc dc push my-api-spec local-spec.raml --path api.raml

# Publish to Exchange
anc dc publish my-api-spec --version 1.2.0 --classifier raml
anc dc publish my-api-spec --version 2.0.0 --classifier oas3 --api-version v2
```

### Authentication

```bash
anc auth login                     # Default profile
anc auth login --profile client-a  # Specific profile
anc auth status                    # Check current auth
anc auth logout                    # Clear stored tokens
```

---

## MCP Server

The MCP server exposes all Anypoint operations as tools for AI assistants (Claude, Cursor, etc.).

### Prerequisites

```bash
anc config init    # one-time setup (or --profile <name> for multi-org)
anc auth login     # get tokens
```

### Configuration

Add to your MCP client config (Claude Desktop, Gemini, Cursor, etc.):

```json
{
  "mcpServers": {
    "anypoint-connect": {
      "command": "npx",
      "args": ["-y", "@sfdxy/anypoint-connect", "mcp"]
    }
  }
}
```

Or if installed globally, use the CLI directly:

```json
{
  "mcpServers": {
    "anypoint-connect": {
      "command": "anc",
      "args": ["mcp"]
    }
  }
}
```

The MCP server auto-detects the active profile from the project's `.anypoint-connect.json` (or falls back to `default`). No `env` block needed.

### MCP Tools

| Tool | Description |
|------|-------------|
| **Identity & Org** | |
| `whoami` | Get authenticated user & org info |
| `list_environments` | List all environments in the org |
| `get_entitlements` | Get org license: vCores, MQ, Object Store, API quotas, subscription |
| **Applications** | |
| `list_apps` | List deployed apps with status, version, vCores, and replica count |
| `get_app_status` | Detailed deployment status: resources (CPU/memory), autoscaling, JVM, replicas |
| `get_app_resources` | Consolidated resource allocation view for all apps in an environment |
| `get_app_settings` | Read application properties and secure property keys |
| `deploy_app` | ⚠️ Deploy or redeploy an app using Maven coordinates (groupId:artifactId:version) |
| `update_app_settings` | ⚠️ Update application properties with merge (triggers rolling restart) |
| `restart_app` | ⚠️ Rolling restart of an application |
| `scale_app` | ⚠️ Scale application replicas (1–8) |
| `stop_app` | ⚠️ Stop an application without deleting the deployment |
| `start_app` | Start a previously stopped application |
| **Logs & Analysis** | |
| `get_logs` | Fetch recent log entries with optional keyword search |
| `download_logs` | Download logs for a time range |
| `analyze_errors` | Clustered error groups with before/after context windows |
| `get_log_patterns` | Top recurring message templates with counts |
| `get_log_stats` | Statistical health summary: error rate, spikes, noise % |
| **Monitoring (AMQL)** | |
| `get_metrics` | Inbound/outbound request count and response time |
| `get_performance_metrics` | Percentile-based performance metrics (p50/p95/p99) |
| `get_metrics_timeseries` | Time-series metrics for trending analysis |
| `get_worker_metrics` | Per-worker/replica performance metrics |
| `get_memory_metrics` | JVM memory usage: heap, GC stats, thread counts |
| `get_memory_timeseries` | JVM memory time-series for leak detection and trending |
| `compare_env_performance` | Compare performance across all environments |
| `raw_amql_query` | Execute freeform AMQL queries for ad-hoc analysis |
| **Exchange** | |
| `search_exchange` | Search assets in Exchange |
| `get_exchange_asset` | Get detailed asset info: versions, dependencies, instances, files |
| `download_api_spec` | Download RAML/OAS spec from Exchange |
| **API Manager** | |
| `list_api_instances` | List managed API instances with governance info |
| `get_api_policies` | Get policies and SLA tiers for an API |
| `get_api_alerts` | View configured alerts for an API instance |
| **Design Center** | |
| `list_design_center_projects` | List all API spec projects |
| `get_design_center_files` | List files in a Design Center project |
| `read_design_center_file` | Read file content with smart path resolution |
| `update_design_center_file` | ⚠️ Push updated file (lock/save/unlock) |
| `publish_to_exchange` | ⚠️ Publish Design Center project to Exchange |
| **Audit Log** | |
| `get_audit_log` | Query platform changes: who did what, when |
| **Anypoint MQ** | |
| `list_queues` | List MQ destinations (queues/exchanges) in a region |
| `get_queue_stats` | Queue depth, in-flight, and throughput stats |
| `get_dlq_messages` | Browse dead-letter queue messages without consuming |
| `publish_mq_message` | Publish a message to an MQ queue (test, replay, seed data) |
| **Object Store v2** | |
| `list_stores` | List Object Stores in an environment |
| `get_store_keys` | List keys in an Object Store with pagination |
| `get_store_value` | Retrieve and auto-format a value by key |
| `put_store_value` | ⚠️ Write or update a value by key |
| `delete_store_value` | ⚠️ Delete a key and its value |
| **Profile** | |
| `get_project_profile` | Show active profile, resolution source, and available profiles |
| `set_project_profile` | Bind project directory to a named profile |

### MCP Prompts

| Prompt | Description |
|--------|-------------|
| `pre-deploy-check` | Readiness check before promoting an app between environments |
| `troubleshoot-app` | Systematic diagnosis: replica health, error patterns, metrics anomalies |
| `api-governance-audit` | Review policies, SLA tiers, and security gaps across all APIs |
| `environment-overview` | Full health report: app status, error rates, performance rankings |
| `improve-api-spec` | Guided pull→analyze→improve→push workflow for API spec quality |

### MCP Resource

| Resource | URI |
|----------|-----|
| Environments | `anypoint://environments` |
| Cache Diagnostics | `anypoint://diagnostics/cache` |

### Example Interactions

- *"What apps are running in Sandbox?"*
- *"Show me the resource allocation across all Production apps"*
- *"Show me the last 50 error logs for my-api in Production"*
- *"Analyze the errors in my-api in Production — what's failing and why?"*
- *"What are the top log patterns for billing-api in Development?"*
- *"Give me a health summary of external-sapi in Production"*
- *"Compare Development and Production environments"*
- *"What policies are applied to the Order API?"*
- *"Show me the RAML spec for the order-api project"*
- *"Improve the API descriptions for order-api"*
- *"Scale order-service to 3 replicas in Production"*
- *"Show me the JVM memory usage for all apps in Production"*
- *"Is my-api leaking memory? Show me the heap trend over the past week"*
- *"What changed in the platform in the last 24 hours?"*
- *"Check our org entitlements — do we have MQ provisioned?"*
- *"Show me the app settings for billing-api in Production"*
- *"Run this AMQL query: SELECT COUNT(requests) FROM mulesoft.app.inbound..."*
- *"What's in the dead-letter queue for order-events?"*
- *"Search the logs for correlation ID abc-123"*
- *"Deploy order-api v1.3.0 to Sandbox with 2 replicas"*
- *"Redeploy billing-service to Production with the latest version from Exchange"*
- *"Update the db.url property for order-api in Sandbox"*
- *"Stop the test-processor app in Development"*
- *"Start the test-processor app back up"*
- *"What versions of order-management-api are in Exchange?"*
- *"Are there any alerts configured for the Order API?"*
- *"Write a watermark value to the default Object Store in Sandbox"*
- *"Delete the stale cache key from Object Store"*
- *"Publish a test message to the order-events queue"*

---

## Programmatic Usage

```typescript
import { AnypointClient } from '@sfdxy/anypoint-connect';

const client = new AnypointClient({
  clientId: process.env.ANYPOINT_CLIENT_ID!,
  clientSecret: process.env.ANYPOINT_CLIENT_SECRET!,
});

// Get user info
const me = await client.whoami();
console.log(me.organization.name);

// List environments
const orgId = me.organization.id;
const envs = await client.accessManagement.getEnvironments(orgId);

// List apps in sandbox
const sandbox = envs.find(e => e.name === 'Sandbox')!;
const apps = await client.cloudHub2.getDeployments(orgId, sandbox.id);

// Tail logs
for await (const entries of client.logs.tailLogs(orgId, sandbox.id, 'my-api')) {
  entries.forEach(e => console.log(`[${e.priority}] ${e.message}`));
}

// Get metrics
const metrics = await client.monitoring.getAppMetrics(
  orgId, sandbox.id,
  Date.now() - 24 * 60 * 60 * 1000,
  Date.now()
);

// Design Center: pull, edit, push
const projects = await client.designCenter.getProjects(orgId);
const spec = await client.designCenter.getFileContent(orgId, projects[0].id, 'api.raml');
await client.designCenter.updateFile(orgId, projects[0].id, 'api.raml', updatedContent);
await client.designCenter.publishToExchange(orgId, projects[0].id, {
  name: 'My API', apiVersion: 'v1', version: '1.0.0', classifier: 'raml'
});
```

---

## Release Process

Releases are automated via GitHub Actions:

```bash
# 1. Bump version in package.json
npm version patch   # or minor / major

# 2. Push the tag
git push --follow-tags

# 3. GitHub Actions will:
#    - Run CI (build, test, lint)
#    - Publish to npm as @sfdxy/anypoint-connect
#    - Create a GitHub Release with auto-generated notes
```

---

## License

MIT
