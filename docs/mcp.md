# MCP server

`anc mcp` starts a stdio Model Context Protocol server exposing 56 tools, so an AI agent can read runtime
evidence and — with explicit confirmation — perform lifecycle operations.

Set up credentials first. The server has nothing to offer an unauthenticated session:

```bash
anc config init      # once, or --profile <name> for multi-org
anc auth login
anc auth status
```

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
      "args": ["-y", "@sfdxy/anypoint-connect@0.11.0", "mcp"]
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
      "args": ["-y", "@sfdxy/anypoint-connect@0.11.0", "mcp"]
    }
  }
}
```

Codex uses TOML, and stores the server in shared configuration so its CLI, desktop app, and IDE
extension all see it:

```toml
[mcp_servers.anypoint-connect]
command = "npx"
args = ["-y", "@sfdxy/anypoint-connect@0.11.0", "mcp"]
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

56 tools across identity, applications, logs and analysis, monitoring, Exchange, API Manager, Design
Center, audit log, Anypoint MQ, Object Store, and profile management. The full table with descriptions is
on the [tool catalog](tools.md) page.

Two properties matter more than the list:

- **Mutating tools are dry-run by default.** Without `confirm: true` they return a preview and change
  nothing. See the [safety model](safety.md).
- **Readiness is checkable.** `whoami` and `list_environments` establish access state before real work,
  which is what stops a missing scope from being reported as an application problem. See
  [Access readiness](readiness.md).

## Prompts

| Prompt | What it drives |
| --- | --- |
| `pre-deploy-check` | Readiness before promoting an app between environments |
| `troubleshoot-app` | Replica health, error patterns, and metric anomalies in order |
| `api-governance-audit` | Policies, SLA tiers, and security gaps across APIs |
| `environment-overview` | Status, error rates, and performance rankings for an environment |
| `improve-api-spec` | Pull, analyze, improve, and push an API specification |

## Resources

| Resource | URI |
| --- | --- |
| Environments | `anypoint://environments` |
| Cache diagnostics | `anypoint://diagnostics/cache` |

## What people actually ask

```text
What apps are running in Sandbox?
Analyze the errors in my-api in Production — what is failing and why?
Give me a health summary of external-sapi in Production for the last six hours.
Is my-api leaking memory? Show the heap trend over the past week.
Compare Development and Production and tell me what drifted.
What changed in the platform in the last 24 hours?
What policies are applied to the Order API?
Publish target/example-api-1.0.0-mule-application.jar and deploy it to Sandbox.
Bump example-api in Production to v1.4.12, artifact only.
Roll example-api back to its newest distinct historical artifact.
What is in the dead-letter queue for order-events?
```

## Using it through mule-skills

[`mule-skills`](https://avinava.github.io/mule-skills/) ships this server preconfigured with a pinned
version, and its workflows already know how to use it: `mule-ops` for runtime health, `mule-troubleshooting`
for incidents, and a readiness gate that offers alternatives when access is missing rather than failing
mid-analysis. If you use those skills, you do not need to configure this server separately.
