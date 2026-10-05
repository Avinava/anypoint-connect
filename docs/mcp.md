# MCP server

`anc mcp` starts a stdio Model Context Protocol server. An MCP host can use it to read runtime evidence
and, with explicit confirmation, publish, deploy, and change applications.

Set up credentials first. The server has nothing to offer an unauthenticated session:

```bash
anc config init      # once, or --profile <name> for multi-org
anc auth login
anc auth status
```

If the Connected App does not exist yet, follow the exact fields in
[Connected App and credentials](credentials.md). The server never receives credentials through MCP.

## Setup by host

Every host runs the same command; only the file and the wrapping key differ.

| Host | Where it goes | Wrapping key |
| --- | --- | --- |
| Claude Code | `.mcp.json`, or `claude mcp add` | `mcpServers` |
| Claude Desktop | `claude_desktop_config.json` | `mcpServers` |
| Codex | `.codex/config.toml`, or `codex mcp add` | `[mcp_servers.anypoint-connect]` |
| VS Code, Copilot Chat | `.vscode/mcp.json` | `servers`, plus `"type": "stdio"` |
| Copilot CLI, Gemini, other MCP clients | `.mcp.json` | `mcpServers` |

The `mcpServers` form, used by Claude Code, Claude Desktop, Copilot CLI, and Gemini:

```json
{
  "mcpServers": {
    "anypoint-connect": {
      "command": "npx",
      "args": ["-y", "@sfdxy/anypoint-connect@0.15.0", "mcp"]
    }
  }
}
```

VS Code wraps the same entry in `servers` and wants an explicit transport:

```json
{
  "servers": {
    "anypoint-connect": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@sfdxy/anypoint-connect@0.15.0", "mcp"]
    }
  }
}
```

Codex uses TOML, and stores the server in shared configuration so its CLI, desktop app, and IDE
extension all see it:

```toml
[mcp_servers.anypoint-connect]
command = "npx"
args = ["-y", "@sfdxy/anypoint-connect@0.15.0", "mcp"]
```

Installed globally, point at the binary instead and skip the download:

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

Pin the version anywhere the configuration is shared. Verify with `codex mcp list`, `copilot mcp list`,
`/mcp` in Claude Code, or a window reload in VS Code. The first `npx` start downloads the package, so
expect one slow launch.

No `env` block is needed: the server resolves the active profile from `.anypoint-connect.json` in the
project, falling back to `default`. See [Profiles](profiles.md).

## Credentials never reach the agent

The server holds the session; the agent calls tools. No token, Client ID, or Client Secret is passed
through the protocol, and nothing asks an agent to handle a secret. Keep it that way — if a workflow
seems to need a credential in the conversation, something is configured wrong.

## Tools

Tools are grouped by domain: identity and organization, project profile, applications (read, deploy,
lifecycle), logs and log analysis, monitoring, Exchange, API Manager, Design Center, API Governance, audit
log, Anypoint MQ, and Object Store. The [tool catalog](tools.md) is generated from the server's registry
and lists every tool with its inputs and whether it reads or writes.

Names follow one scheme: `list_*` returns a collection, `get_*` returns one thing or a computed view, and
guarded Design Center writes come as `preview_<verb>_<noun>` paired with `<verb>_<noun>`.

Properties that matter more than the list:

- **Deployment tools are dry-run by default.** `deploy_jar`, `deploy_app`, `update_app_artifact`,
  `rollback_app`, `publish_app_jar`, and `delete_app` return a preview and change nothing without
  `confirm: true`. Restart, scale, stop, start, settings, Object Store writes, and MQ publish apply on
  call. The [safety model](safety.md) lists every case.
- **Design Center writes need a preview token** from the matching `preview_*` tool.
- **Readiness is checkable.** `whoami` and `list_environments` establish access before real work, which
  stops a missing permission from being reported as an application problem. See
  [Access readiness](readiness.md).
- **Monitoring is consolidated.** `get_metrics`, `get_runtime_metrics`, `get_metrics_timeseries`, and
  `raw_amql_query` cover traffic, JVM and host health, trends, and freeform queries. See
  [Monitoring](monitoring.md).

## Prompts

| Prompt | Arguments | What it drives |
| --- | --- | --- |
| `pre-deploy-check` | `appName`, `sourceEnv`, `targetEnv` | Source and target status, version drift, recent errors, and a metrics baseline before a promotion |
| `troubleshoot-app` | `appName`, `environment`, `symptom` (optional) | Replica health, clustered errors, log patterns, per-worker metrics and time series, then runtime metrics if memory or CPU is suspected |
| `api-governance-audit` | `environment` | Policies, SLA tiers, contracts, and security gaps across managed APIs |
| `environment-overview` | `environment` | App inventory, failure and latency rankings, the dominant error, and runtime versions |
| `improve-api-spec` | `project` | Read a Design Center spec, improve it, preview the sync, and apply only after approval |

## Resources

| Resource | URI |
| --- | --- |
| Environments | `anypoint://environments` |
| Cache diagnostics | `anypoint://diagnostics/cache` |

## What people actually ask

```text
What apps are running in Sandbox?
Analyze the errors in sample-orders-api in Sandbox — what is failing and why?
Give me a health summary of sample-orders-api in Sandbox for the last six hours.
Is sample-orders-api leaking memory? Show the old-generation trend over the past week.
Which worker of sample-orders-api in Production is slower than the others?
Compare sample-orders-api traffic and failures across every environment.
Compare the Development and Production deployments and tell me what drifted.
What changed in the platform in the last 24 hours?
What policies are applied to the Sample Orders API?
Publish target/sample-orders-api-1.3.0-mule-application.jar and deploy it to Sandbox.
Bump sample-orders-api in Sandbox to v1.3.0, artifact only.
Roll sample-orders-api back to its newest distinct historical artifact.
What is in the dead-letter queue for order-events?
```

## Using it through mule-skills

[`mule-skills`](https://avinava.github.io/mule-skills/) ships this server preconfigured with a pinned
version, and its workflows already know how to use it: `mule-ops` for runtime health, `mule-troubleshooting`
for incidents, and a readiness gate that offers alternatives when access is missing rather than failing
mid-analysis. If you use those skills, you do not need to configure this server separately.
