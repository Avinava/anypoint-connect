<p align="center">
  <img src="docs/assets/logo.svg" alt="Anypoint Connect Banner" width="600" />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@sfdxy/anypoint-connect"><img src="https://img.shields.io/npm/v/@sfdxy/anypoint-connect?style=flat-square&color=34d399" alt="npm version" /></a>
  <a href="https://github.com/Avinava/anypoint-connect/actions"><img src="https://img.shields.io/github/actions/workflow/status/Avinava/anypoint-connect/ci.yml?style=flat-square&color=38bdf8" alt="CI" /></a>
  <a href="https://github.com/Avinava/anypoint-connect/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/@sfdxy/anypoint-connect?style=flat-square&color=818cf8" alt="License" /></a>
  <a href="https://www.npmjs.com/package/@sfdxy/anypoint-connect"><img src="https://img.shields.io/npm/dm/@sfdxy/anypoint-connect?style=flat-square&color=fbbf24" alt="Downloads" /></a>
</p>

<p align="center">
  <strong>CLI + MCP toolkit for Anypoint Platform — deploy, tail logs, pull metrics, manage API specs, with production safety nets.</strong>
</p>

<p align="center">
  <a href="https://avinava.github.io/anypoint-connect/">Documentation</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#what-it-does">Capabilities</a> •
  <a href="#mcp-server">MCP</a> •
  <a href="#safety">Safety</a> •
  <a href="#ecosystem">Ecosystem</a>
</p>

---

## Quick Start

```bash
# 1. Install
npm install -g @sfdxy/anypoint-connect

# 2. Configure (interactive — prompts for Client ID & Secret)
anc config init

# 3. Authenticate (opens browser for OAuth)
anc auth login

# 4. Verify
anc auth status
```

No Connected App yet? The four-step setup, including the exact scopes to grant, is in
[Getting started](https://avinava.github.io/anypoint-connect/getting-started/). Requires Node.js
`>=20.0.0`.

```bash
anc apps list --env Sandbox
anc logs tail my-api --env Sandbox
anc monitor view --env Production
```

Working across several organizations? Use named profiles —
[Profiles and multiple orgs](https://avinava.github.io/anypoint-connect/profiles/).

## What it does

| Area | Examples |
| --- | --- |
| Applications | Status, deployment spec, resources, settings, deploy, redeploy, rollback, restart, scale, stop, start, delete |
| Logs | Tail, download, error clustering with context windows, recurring patterns, statistical health |
| Monitoring | Request metrics, percentiles, time series, per-replica, JVM memory and GC, freeform AMQL |
| Exchange | Search, asset detail, spec download, JAR publication, environment comparison |
| API Manager | Instances, policies, SLA tiers, alerts |
| Design Center | Projects, files, read, update, publish |
| Platform | Environments, entitlements, audit log |
| Anypoint MQ | Queues, depth and throughput, dead-letter browsing, test publishing |
| Object Store v2 | Stores, keys, values |

Every command is documented in the
[CLI reference](https://avinava.github.io/anypoint-connect/cli-reference/).

## MCP server

56 tools for AI agents. Set up credentials first — the server has nothing to offer an unauthenticated
session.

```bash
anc config init
anc auth login
```

Every host runs the same command; only the file and the wrapping key differ.

| Host | Where it goes | Wrapping key |
| --- | --- | --- |
| Claude Code | `.mcp.json`, or `claude mcp add` | `mcpServers` |
| Claude Desktop | `claude_desktop_config.json` | `mcpServers` |
| Codex | `.codex/config.toml`, or `codex mcp add` | `[mcp_servers.anypoint-connect]` |
| VS Code, Copilot Chat | `.vscode/mcp.json` | `servers`, plus `"type": "stdio"` |
| Copilot CLI, Gemini, other MCP clients | `.mcp.json` | `mcpServers` |

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

Installed globally, use `"command": "anc", "args": ["mcp"]` and skip the download. No `env` block is
needed: the active profile resolves from the project's `.anypoint-connect.json`, falling back to
`default`. Credentials never pass through the protocol — the server holds the session, the agent calls
tools.

Per-host examples, prompts, and resources are in the
[MCP guide](https://avinava.github.io/anypoint-connect/mcp/); the full tool table is in the
[catalog](https://avinava.github.io/anypoint-connect/tools/).

## Safety

Every mutating operation is **dry-run by default**: without `confirm: true` it returns a preview and
changes nothing. Redeploying an existing app changes **only** the artifact reference, so runtime, target,
replicas, and settings are preserved and a version bump cannot silently downgrade a runtime or halve
capacity. `update_app_settings` PATCHes only application properties, merging protected values rather than
blanking them. Deletion requires a deployment-ID-bound confirmation — plus a separate acknowledgement in
production — so it fails closed if the deployment changed since you looked.

```jsonc
// preview
deploy_jar({ "jarPath": "target/example-api-1.0.0-mule-application.jar", "appName": "example-api", "environment": "Sandbox" })
// apply
deploy_jar({ "jarPath": "target/example-api-1.0.0-mule-application.jar", "appName": "example-api", "environment": "Sandbox", "confirm": true })
```

Full model in [Safety](https://avinava.github.io/anypoint-connect/safety/); the build, publish, deploy,
and rollback path in [Deploying a JAR](https://avinava.github.io/anypoint-connect/deployment-tools/).

## When something fails

Access problems come in six distinct states — not configured, not authenticated, environment not visible,
not permitted, transient, and ready — and they have different fixes. The error text names which one you
are in. See [Access readiness](https://avinava.github.io/anypoint-connect/readiness/) and
[Troubleshooting](https://avinava.github.io/anypoint-connect/troubleshooting/).

## Library

```typescript
import { AnypointClient } from '@sfdxy/anypoint-connect';

const client = new AnypointClient({
  clientId: process.env.ANYPOINT_CLIENT_ID!,
  clientSecret: process.env.ANYPOINT_CLIENT_SECRET!,
});

const me = await client.whoami();
const envs = await client.accessManagement.getEnvironments(me.organization.id);
```

The API clients give you token refresh, rate limiting, and caching, but not the confirmation gates — those
live in the CLI and MCP layers. More in the
[library guide](https://avinava.github.io/anypoint-connect/library/).

## Documentation

Published at **<https://avinava.github.io/anypoint-connect/>** with search.

| Page | Contents |
| --- | --- |
| [Getting started](docs/getting-started.md) | Install, Connected App, scopes, credentials, authenticate |
| [Profiles](docs/profiles.md) | Multiple organizations, resolution order, storage layout |
| [Access readiness](docs/readiness.md) | The six access states and their fixes |
| [CLI reference](docs/cli-reference.md) | Every command group |
| [MCP server](docs/mcp.md) | Host setup, prompts, resources |
| [Tool catalog](docs/tools.md) | All 56 tools, and how to choose between overlapping ones |
| [Safety model](docs/safety.md) | Dry runs, narrow updates, bound deletion |
| [Deploying a JAR](docs/deployment-tools.md) | Build, publish, deploy, roll back |
| [Library API](docs/library.md) | Programmatic use |
| [Troubleshooting](docs/troubleshooting.md) | Symptoms and causes |
| [Architecture](docs/architecture.md) | Layers and design notes |

## Ecosystem

The canonical package matrix and supported combination live in the
[`mule-skills` ecosystem hub](https://avinava.github.io/mule-skills/ecosystem/). This is the only tool
in the set that needs Anypoint credentials. A complete release crosses two boundaries: `mule-build`
produces and versions the artifact, while this package puts it in an environment. More detail is on
the local [ecosystem page](docs/ecosystem.md).

## Development

```bash
npm install
npm run build
npm test
npm run lint
```

Releases are tag-triggered: bump the version, push the tag with `git push --follow-tags`, and GitHub
Actions runs CI, publishes to npm with provenance, and creates the release.

## License

[MIT](LICENSE)
