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
covers artifact identity, digest binding, artifact-only updates, and rollback.

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
      "args": ["-y", "@sfdxy/anypoint-connect@0.15.0", "mcp"]
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
