<p align="center">
  <img src="docs/assets/logo.svg" alt="Anypoint Connect — CLI and MCP toolkit for Anypoint Platform" width="640" />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@sfdxy/anypoint-connect"><img src="https://img.shields.io/npm/v/@sfdxy/anypoint-connect?style=flat-square&color=087ea4" alt="npm version" /></a>
  <a href="https://github.com/Avinava/anypoint-connect/actions"><img src="https://img.shields.io/github/actions/workflow/status/Avinava/anypoint-connect/ci.yml?style=flat-square" alt="CI status" /></a>
  <a href="https://github.com/Avinava/anypoint-connect/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/@sfdxy/anypoint-connect?style=flat-square" alt="MIT license" /></a>
</p>

<p align="center">
  <strong>Operate Anypoint Platform from a CLI, an MCP client, or JavaScript—with guarded mutations and one shared authentication layer.</strong>
</p>

<p align="center">
  <a href="https://avinava.github.io/anypoint-connect/">Documentation</a> ·
  <a href="https://avinava.github.io/anypoint-connect/getting-started/">Getting started</a> ·
  <a href="https://avinava.github.io/anypoint-connect/credentials/">Credentials</a> ·
  <a href="https://avinava.github.io/anypoint-connect/recipes/">Recipes</a>
</p>

---

## Start here

You need Node.js `>=22`; Node.js 24 LTS is recommended. If Node and npm are unfamiliar, follow the
[15-minute setup](https://avinava.github.io/anypoint-connect/getting-started/) instead of guessing through
the commands below.

```bash
# Install
npm install --global @sfdxy/anypoint-connect

# Save a Connected App Client ID and Secret
anc config init

# Authorize your Anypoint user in the browser
anc auth login

# Verify the local session and one visible environment
anc auth status
anc apps list --env Sandbox
```

The Connected App must be **App acts on behalf of a user**, use Authorization Code, redirect to
`http://localhost:3000/api/callback`, and include **Full Access** plus **Background Access**. The
[credential guide](https://avinava.github.io/anypoint-connect/credentials/) gives the exact UI fields,
administrator handoff, storage model, rotation steps, and troubleshooting.

## Credential model

| Item | Purpose | Storage |
| --- | --- | --- |
| Client ID | Identifies the Connected App | Profile `config.json` |
| Client Secret | Authenticates the local client | Profile `config.json`, restricted to the current OS user |
| OAuth tokens | Represent the user-authorized session | AES-256-GCM encrypted `tokens.enc` |

The ID and Secret do not provide access without a browser-authorized user session. Environment variables
can override where app credentials come from, but they do not implement headless CI authentication. This
release does not support the `client_credentials` grant, and its encrypted token file is machine-bound.

## What it does

| Area | Examples |
| --- | --- |
| Applications | Status, deployment spec, resources, settings, deploy, redeploy, rollback, restart, scale, stop, start, delete |
| Logs | Tail, download, error clustering with context, recurring patterns, statistical health |
| Monitoring | Request metrics, percentiles, time series, per-replica metrics, JVM memory and GC, freeform AMQL |
| Exchange | Search, asset details, spec download, JAR publication, environment comparison |
| API Manager | Instances, policies, SLA tiers, alerts |
| Design Center | Projects, branches, conflict-safe file synchronization, governed publication |
| Platform services | Environments, entitlements, audit log, Anypoint MQ, Object Store v2 |

Copyable task flows are in [Common recipes](https://avinava.github.io/anypoint-connect/recipes/); every CLI
command is in the [CLI reference](https://avinava.github.io/anypoint-connect/cli-reference/).

## MCP server

Authenticate in a terminal before starting the server. The MCP host never receives the Client Secret or
OAuth tokens; it sends tool calls to the local server that owns the session.

```json
{
  "mcpServers": {
    "anypoint-connect": {
      "command": "npx",
      "args": ["-y", "@sfdxy/anypoint-connect@0.13.0", "mcp"]
    }
  }
}
```

VS Code uses a `servers` wrapper and Codex uses TOML. See the
[MCP guide](https://avinava.github.io/anypoint-connect/mcp/) or copy a checked-in configuration from
[`examples/mcp`](examples/mcp).

Example requests use synthetic names:

```text
What applications are visible in Sandbox? Read only.
Analyze errors for sample-orders-api in Sandbox over the last two hours.
Preview a deployment of target/sample-orders-api-1.3.0-mule-application.jar to Sandbox; do not apply it.
```

## Safety

Mutating MCP tools are previews until `confirm: true` is supplied. Artifact updates preserve runtime,
target, replicas, and settings. Deletion requires the deployment ID returned by the preview, and
production operations require an additional acknowledgement.

```jsonc
// Preview only
update_app_artifact({
  "appName": "sample-orders-api",
  "environment": "Sandbox",
  "version": "1.3.0"
})

// Apply the reviewed change
update_app_artifact({
  "appName": "sample-orders-api",
  "environment": "Sandbox",
  "version": "1.3.0",
  "confirm": true
})
```

The complete contract is in the [safety model](https://avinava.github.io/anypoint-connect/safety/).

## Library

The library reuses a profile authenticated with `anc auth login`. The Client ID and Secret construct the
client; the profile selects the encrypted token store.

```javascript
import { AnypointClient } from '@sfdxy/anypoint-connect';

const client = new AnypointClient({
  clientId: process.env.ANYPOINT_CLIENT_ID,
  clientSecret: process.env.ANYPOINT_CLIENT_SECRET,
  profileName: process.env.ANYPOINT_PROFILE || 'default',
});

const identity = await client.whoami();
const environments = await client.accessManagement.getEnvironments(identity.organization.id);
console.log(`Authenticated; ${environments.length} environment(s) visible.`);
```

Direct API clients include bearer injection, refresh, rate limiting, and caching. They do not include the
CLI/MCP confirmation gates. Start with the runnable JavaScript example in
[`examples/library`](examples/library) and read the [library guide](https://avinava.github.io/anypoint-connect/library/).

## Profiles and multiple organizations

Use neutral profile names rather than customer names:

```bash
anc config init --profile team-a
anc auth login --profile team-a
anc config use team-a
```

The directory binding contains only a local profile label, but it can still reveal internal context. Add
`.anypoint-connect.json` to the project's `.gitignore`. Resolution rules and storage layout are in
[Profiles](https://avinava.github.io/anypoint-connect/profiles/).

## Development

```bash
nvm use
npm install
npm run build
npm test
npm run lint
npm run docs:check
mkdocs build --strict
```

CI tests Node 22, 24, and 26. Documentation is built with MkDocs Material and published through GitHub
Pages. Releases are tag-triggered and published to npm with provenance.

## License

[MIT](LICENSE)
