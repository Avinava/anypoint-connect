# Common recipes

All names and outputs on this page are synthetic. Replace `sample-orders-api` and `Sandbox` with values
you are authorized to use. Start with [Getting started](getting-started.md) if `anc auth status` does not
show an authenticated profile.

## Confirm readiness

```bash
anc auth status
anc apps list --env Sandbox
```

<div class="anc-output">
<span class="anc-output-label">Representative output</span>
<pre>✓ Authenticated
Profile          default
Can Refresh      Yes

NAME                 STATUS     VERSION   REPLICAS
sample-orders-api    RUNNING    1.2.3     2</pre>
</div>

An empty application table still proves that the environment is visible. A 403 or “environment not
found” result needs the [readiness decision table](readiness.md).

## Inspect one application before changing it

```bash
anc apps status sample-orders-api --env Sandbox
```

For an MCP agent, ask:

```text
Inspect sample-orders-api in Sandbox. Start with readiness, then report deployment status,
artifact version, runtime, replicas, and any unhealthy workers. Do not make changes.
```

## Tail only relevant errors

```bash
anc logs tail sample-orders-api --env Sandbox --level ERROR
anc logs tail sample-orders-api --env Sandbox --level ERROR --search "TimeoutException"
```

Use the least sensitive search term that identifies the failing flow. Logs can contain production data;
do not paste raw output into a repository or public conversation.

## Check traffic, latency, and memory

```bash
anc monitor summary --env Sandbox --app sample-orders-api --from 24h
anc monitor summary --env Sandbox --app sample-orders-api --by worker
anc monitor runtime --env Sandbox --app sample-orders-api
anc monitor trend --env Sandbox --app sample-orders-api --signal memory -g 1h --from 7d
```

Read percentiles with the request count. For memory, a sawtooth is normal collection; an
old-generation baseline that keeps rising over several days, and an old-generation peak close to its
limit, are the signals that matter. [Monitoring](monitoring.md) explains every field.

## Investigate an incident window

```bash
anc monitor summary --env Sandbox --app sample-orders-api --by route --from 3h
anc monitor trend --env Sandbox --app sample-orders-api --signal traffic -g 5m --from 3h
anc monitor trend --env Sandbox --app sample-orders-api --signal gc -g 5m --from 3h
```

For an MCP agent, ask:

```text
sample-orders-api in Sandbox slowed down in the last three hours. Use get_metrics by route and by
worker, get_metrics_timeseries at 5m for traffic and gc, and analyze_errors for the same window.
Report what changed and when. Do not make changes.
```

## Deploy only after inspecting the target

First capture the current deployment, then look at the plan without changing anything:

```bash
anc apps status sample-orders-api --env Sandbox
anc deploy target/sample-orders-api-1.3.0-mule-application.jar \
  --app sample-orders-api --env Sandbox --dry-run
```

The plan shows the Exchange coordinates read from the JAR's Maven metadata, its SHA-256, and whether the
app will be created or only its artifact reference updated. Run the same command without `--dry-run`
when you intend to publish and deploy:

```bash
anc deploy target/sample-orders-api-1.3.0-mule-application.jar \
  --app sample-orders-api --env Sandbox
```

!!! warning "Without `--dry-run`, this command applies the change"

    The CLI publishes the JAR and deploys it to non-production environments immediately after printing
    the summary. Production requires typing a confirmation phrase. An MCP `deploy_jar` call without
    `confirm: true` is a preview that cannot mutate.

Unattended `--force` belongs only in a reviewed pipeline. The [safety model](safety.md#publishing-a-jar)
covers artifact identity, digest binding, one-update changes, and rollback.

## Deploy a listener-driven app without overlap

Apps with streaming, subscription or polling listeners must not run two generations at once. Stop, change
and start in one call:

```jsonc
update_app({ "appName": "orders-sapi", "environment": "Sandbox", "version": "1.4.0", "mode": "stopStart" })
// review the preview, then repeat with "confirm": true
```

```bash
anc apps update orders-sapi -e Sandbox --version 1.4.0 --stop-start --dry-run
```

To make every later deployment replace replicas instead of overlapping them, set the strategy once with
`"updateStrategy": "recreate"` (CLI `--update-strategy recreate`). It avoids overlap too, but measured
outages were about twice as long as `stopStart` (about 110 s against 57 s); see the
[safety model](safety.md) for the numbers.

To check the rollout afterwards, read the replaced generation's logs alongside the new one's. Each update
starts a new deployment spec with its own log file, and log tools read only the current one by default:

```bash
anc logs search orders-sapi --env Sandbox --since 30m --previous-specs 1
```

In MCP, pass `"previousSpecs": 1` to `get_logs` or `download_logs`. Entries carry their replica, so the
last line of the old generation and the first of the new one show any overlap or gap.

## Move an app off a retired runtime

```bash
anc runtimes list -e Sandbox --app orders-sapi
anc apps update orders-sapi -e Sandbox --version 1.4.1 --runtime 4.9 --java 17 --dry-run
```

The preview checks the runtime against the target before anything is written. Over MCP, the same check
runs in `update_app` and `update_app_artifact` with `runtime`, and `list_runtime_versions` shows the
options.

## Add or rotate one secret

Keep the value in a project file the server can read, never in the conversation:

```jsonc
update_app_settings({
  "appName": "orders-sapi",
  "environment": "Sandbox",
  "securePropertiesFrom": [{ "file": "config/sandbox.env", "keys": ["CRM_CLIENT_SECRET"], "rename": { "CRM_CLIENT_SECRET": "crm.client.secret" } }]
})
```

```bash
anc apps settings set orders-sapi -e Sandbox --secure-from-file config/sandbox.env:CRM_CLIENT_SECRET --dry-run
```

The other secure properties keep their stored values. The app reads the new one as `${crm.client.secret}`.

## Move a plain-text secret to secure

`get_app_settings` lists secret-looking plain properties under `warnings`. Move each one without exposing
its value:

```jsonc
update_app_settings({ "appName": "orders-sapi", "environment": "Sandbox", "moveToSecure": ["db.password"] })
```

```bash
anc apps settings set orders-sapi -e Sandbox --move-to-secure db.password --dry-run
```

Remove a property with `removeProperties` (CLI `--remove`). Settings changes restart the app, so add
`mode: "stopStart"` for listener-driven apps.

## Check that a repository matches what runs

```bash
anc apps compare orders-sapi -e Production --repo . --ref main --working-tree
```

Over MCP, use `compare_deployed_artifact` with `against: { "repoPath": ".", "gitRef": "main", "includeWorkingTree": true }`.
The result is `identical` or `differs`, with changed, missing and extra files and dependency differences,
listed by name and hash only. Compare against a local build with `--jar target/<file>.jar`.

## Smoke test an API with its client credentials

```jsonc
list_api_contracts({ "environment": "Sandbox", "api": "orders-sapi" })
smoke_test_api({ "environment": "Sandbox", "api": "orders-sapi", "path": "/api/health" })
```

The server reads the approved client application's credentials and sends them itself; the secret never
appears in the result. For scripts, `get_client_application` with `writeCredentialsTo` saves them to a
mode-0600 `.env` file inside the project.

## Keep log downloads small

```jsonc
download_logs({ "appName": "orders-sapi", "environment": "Sandbox", "hoursBack": 48, "mode": "summary" })
download_logs({ "appName": "orders-sapi", "environment": "Sandbox", "hoursBack": 48, "search": "timeout", "level": "WARN" })
download_logs({ "appName": "orders-sapi", "environment": "Sandbox", "hoursBack": 48, "outputFile": "logs/orders-48h.log" })
```

Summary mode returns counts by level, logger and hour plus the top message templates. `outputFile` writes
everything matched to a file inside the project and returns only the path and counts.

## Check logs for leaked credentials

```jsonc
scan_logs_for_credentials({ "appName": "orders-sapi", "environment": "Production", "previousSpecs": 1 })
```

```bash
anc logs credentials orders-sapi --env Production --since 24h --previous-specs 1
```

The result counts lines that carry an `Authorization: Bearer` header, a bearer token, a `sessionId`, a
`Sforce-Session` header, a Salesforce session ID, an `access_token` / `refresh_token` / `id_token`
parameter, or a JWT, per marker, per spec and per replica. It never returns the lines or the values. A
non-zero count means the app logs credentials; fix its logging, then scan again after the next deploy.

## Find who changed an app

```jsonc
get_audit_log({ "hoursBack": 72, "objectTypes": ["Application"], "actions": ["Create", "Modify", "Delete"] })
```

Each entry carries `actorClass`: `platform-patch` (platform staff or the automatic patcher modifying an
app), `platform-replica` (a replica restarted or moved by the platform), `platform-infrastructure` (Patch
Fabric, Patch Network) or `user-or-pipeline`, plus the `actorRule` that matched. `summary.byClass` counts
the returned entries per class. Pass `platformClientIds` when the platform patcher appears under a client
ID in your organization. Keep the filters: an unfiltered query over several days can return more entries
than one response holds, and the response then says how many matched.

## Update an API specification in Design Center

```bash
anc dc pull sample-orders-api-spec api.raml -o api.raml
# edit api.raml locally
anc dc push sample-orders-api-spec api.raml --message "Describe order status values"
anc dc publish sample-orders-api-spec --version 1.3.0 --classifier raml
```

`push` and `publish` print a preview and ask before writing. The push fails as a whole if anyone changed
the file in Design Center after the preview.

## Connect an MCP host

Authenticate in a terminal first, then use a pinned server command:

```json
{
  "mcpServers": {
    "anypoint-connect": {
      "command": "npx",
      "args": ["-y", "@sfdxy/anypoint-connect@0.17.0", "mcp"]
    }
  }
}
```

Useful first prompts:

```text
What applications are visible in Sandbox? Read only.
Analyze errors for sample-orders-api in Sandbox over the last two hours.
Compare the Development and Sandbox deployments and list version drift.
Preview the deployment of target/sample-orders-api-1.3.0-mule-application.jar to Sandbox; do not apply it.
```

Host-specific JSON and TOML files are in the
[runnable examples](https://github.com/Avinava/anypoint-connect/tree/main/examples/mcp).

## Run the JavaScript example without a build step

The repository includes an `.mjs` example that reuses an authenticated profile. It requires no
TypeScript compiler:

```bash
cd examples/library
npm install
cp .env.example .env
# Edit only the placeholder values in .env, then:
node --env-file=.env list-apps.mjs
```

The [library guide](library.md) explains why direct API clients inherit token refresh, caching, and rate
limiting but not the CLI/MCP confirmation gates.
