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

## Check performance and memory

```bash
anc monitor view --env Sandbox --app sample-orders-api --from 24h
anc monitor perf --env Sandbox
anc monitor memory-trend --env Sandbox --app sample-orders-api --granularity 1h
```

Read percentiles with request count. For memory, a sawtooth is normal collection; a rising post-GC
baseline over a longer window is the stronger leak signal.

## Deploy only after inspecting the target

First capture the current deployment:

```bash
anc apps status sample-orders-api --env Sandbox
```

Then run the deployment when you intend to apply it:

```bash
anc deploy target/sample-orders-api-1.3.0-mule-application.jar \
  --app sample-orders-api \
  --env Sandbox \
  --runtime 4.8.0
```

!!! warning "This CLI command applies the change"

    The CLI prints a summary, then applies non-production deployments immediately. Production requires
    a typed confirmation. Use an MCP `deploy_jar` call without `confirm: true` when you need a preview
    that cannot mutate.

Unattended `--force` should be used only in a reviewed pipeline. See
[Deploying a JAR](deployment-tools.md) for publishing, artifact-only updates, and rollback.

## Connect an MCP host

Authenticate in a terminal first, then use a pinned server command:

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

Useful first prompts:

```text
What applications are visible in Sandbox? Read only.
Analyze errors for sample-orders-api in Sandbox over the last two hours.
Compare Development and Sandbox deployments and list version drift.
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
