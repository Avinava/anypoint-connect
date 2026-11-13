# Library API

The client the CLI and MCP server use is exported for direct use in TypeScript or JavaScript. Run
`anc config init` and `anc auth login` first: the constructor supplies the Connected App credentials,
while `profileName` selects the encrypted OAuth token store created by the CLI login.

The package is ESM-only and exposes a single entry point, `@sfdxy/anypoint-connect`; internal paths are
not part of the public API.

```typescript
import { AnypointClient } from '@sfdxy/anypoint-connect';

const client = new AnypointClient({
  clientId: process.env.ANYPOINT_CLIENT_ID!,
  clientSecret: process.env.ANYPOINT_CLIENT_SECRET!,
  profileName: process.env.ANYPOINT_PROFILE || 'default',
});

// identity and organization context
const me = await client.whoami();
const orgId = me.organization.id;

// environments, then apps in one of them
const sandbox = await client.accessManagement.resolveEnvironment(orgId, 'Sandbox');
const apps = await client.cloudHub2.getDeployments(orgId, sandbox.id);
```

## What is exported

| Export | Purpose |
| --- | --- |
| `AnypointClient` | Facade with one property per platform domain: `accessManagement`, `cloudHub2`, `logs`, `monitoring`, `exchange`, `apiManager`, `designCenter`, `designCenterWorkflow`, `governance`, `auditLog`, `anypointMQ`, `objectStore` |
| `AccessManagementApi`, `CloudHub2Api`, `LogsApi`, `MonitoringApi`, `ExchangeApi`, `ApiManagerApi`, `DesignCenterApi`, `GovernanceApi`, `AuditLogApi`, `AnypointMQApi`, `ObjectStoreApi` | The domain clients and their types |
| `DesignCenterWorkflow` | Token-bound preview and apply for Design Center project creation, file sync, and Exchange publication |
| `AMQL_MAX_LIMIT`, `GRANULARITY`, `amqlString` | Monitoring constants and the AMQL string-literal escaper |
| `TrafficMetrics`, `RouteMetrics`, `RuntimeMetrics`, `MemoryPoolMetrics`, `GcCollectorMetrics`, `TimeSeriesPoint`, `TimeSeriesSignal`, `MetricsScope`, `MetricsGroupBy`, `MetricsExport`, `MetricRow`, `Granularity` | Monitoring types |
| `AmqlQueryError`, `errorMessage` | Monitoring query error and the shared error formatter |
| `TokenManager`, `OAuthFlow`, `FileStore`, `TokenStore` | Authentication building blocks |
| `ClientCredentialsProvider`, `BearerProvider`, `TokenProvider`, `AUTH_MODES`, `AuthMode` | Service authentication: an in-memory token from client credentials, or a supplied bearer token; the one interface `HttpClient` needs |
| `HttpClient`, `Cache`, `RateLimiter` | Transport, caching, and throttling |

## Streaming logs

`tailLogs` is an async iterable, so backpressure is the consumer's loop rather than a callback queue:

```typescript
for await (const entries of client.logs.tailLogs(orgId, sandbox.id, 'sample-orders-api', { level: 'ERROR' })) {
  entries.forEach((e) => console.log(`[${e.priority}] ${e.message}`));
}
```

`tailLogs` yields only records. `tailEvents` yields typed events and accepts an `AbortSignal` and an exact
spec:

```typescript
const controller = new AbortController();
for await (const event of client.logs.tailEvents(orgId, sandbox.id, 'sample-orders-api', {
  signal: controller.signal, // stops the wait and the request in flight
  specId: 'spec-id',         // optional: follow exactly this spec, never another
})) {
  if (event.type === 'records') event.entries.forEach((e) => console.log(e.message));
  else if (event.type === 'specChange') console.log(`following ${event.to}`);
  else if (event.type === 'gap') console.warn(event.message); // lines may have been missed
  else console.warn(event.message);                           // a read failed; following continues
}
```

Records that share a millisecond are all delivered (identical lines are counted, not collapsed), and a
filter never hides a record from the position tracking. Without `specId` the stream follows the current
spec and emits `specChange` when a rollout moves it. With `specId`, a spec that is not the application's,
or has no log file, is an error instead of being replaced by another.

**How the log is read.** The stream asks the structured log endpoint only for records after the last one
seen (epoch-millisecond `startTime`, oldest first), and a `transport` event with `mode: 'incremental'`
says so. That endpoint returns 10 records per request whatever `limit` says and has no cursor, so a read
walks forward by the last record's time and drops repeats by the platform's `docId`. A backlog is drained
at once, up to 50 requests per read, and records are never skipped: a very busy app makes the tail lag
instead of losing lines (the client's request limit allows roughly 16 records per second per stream). When
it falls more than two minutes behind it says so with a `gap` event and skips ahead to the last 30
seconds. More than 10 records in one millisecond cannot be paged inside; a `gap` event says so once. A 404
means the spec has no records yet and is followed as such. If the endpoint answers 400, 405 or 501, or
returns an unexpected shape, the stream says so with `{ type: 'transport', mode: 'file', reason }` and
falls back to downloading the log file on each read and parsing its newest 500,000 characters, where a
`gap` event says when more arrived between reads than that covers. A server error is reported as an
`error` event and retried, never taken for an unsupported endpoint.

## Monitoring

Every method takes a `MetricsScope`: the organization ID, an optional environment ID (omit it on
`getMetrics` to compare every environment), a window in epoch milliseconds, and an optional app name.

```typescript
import { AmqlQueryError, amqlString } from '@sfdxy/anypoint-connect';

const to = Date.now();
const scope = { orgId, envId: sandbox.id, from: to - 24 * 60 * 60 * 1000, to, appName: 'sample-orders-api' };

const perWorker = await client.monitoring.getMetrics(scope, 'worker');      // TrafficMetrics[]
const routes = await client.monitoring.getRouteMetrics(scope);              // RouteMetrics[]
const runtime = await client.monitoring.getRuntimeMetrics(scope);           // RuntimeMetrics[]
const memory = await client.monitoring.getTimeSeries(scope, 'memory', '1h'); // TimeSeriesPoint[]

for (const w of runtime) {
  if (w.oldGenPeakRatio !== null && w.oldGenPeakRatio > 0.9) {
    console.log(`${w.workerId}: old generation at ${(w.oldGenPeakRatio * 100).toFixed(0)}% of its limit`);
  }
}

try {
  const rows = await client.monitoring.search(
    `SELECT COUNT(requests) AS "request_count", "app.name" FROM "mulesoft.app.inbound" ` +
      `WHERE "sub_org.id" = ${amqlString(orgId)} AND timestamp BETWEEN ${scope.from} AND ${scope.to} ` +
      `GROUP BY "app.name"`,
    { limit: 500 },
  );
  console.log(rows);
} catch (error) {
  if (error instanceof AmqlQueryError) {
    console.error(error.message, error.status, error.query);
  } else {
    throw error;
  }
}
```

- `search(query, { limit, offset })` returns one page (default 200 rows, maximum `AMQL_MAX_LIMIT`, 2000);
  `searchAll(query)` follows pagination up to a fixed cap.
- `exportMetrics(orgId, envId, envName, from, to)` returns per-app traffic plus totals for one
  environment, the same data as `anc monitor download`.
- A rejected or failed query throws `AmqlQueryError` with the platform's message, the HTTP `status`, the
  `query`, and the platform `transactionId` when one is returned. An empty array always means the query
  ran and matched nothing.
- Use `amqlString` for any value you put inside a string literal. The built-in methods validate that
  organization and environment IDs are UUIDs.

Units and the AMQL rules are in [Monitoring](monitoring.md).

## Design Center round trip

Writes go through the same token-bound workflow as the CLI and MCP tools. A preview token is valid for
ten minutes, once, in the process that issued it.

```typescript
const project = await client.designCenter.findByNameOrThrow(orgId, 'sample-orders-api-spec');
const content = await client.designCenter.getFileContent(orgId, project.id, 'api.raml');

const preview = await client.designCenterWorkflow.previewSync(
  orgId,
  'sample-orders-api-spec',
  [{ path: 'api.raml', content: updatedContent }],
  'master',
  'Describe order status values',
);
console.log(preview.entries); // create, update, or unchanged, with hashes
await client.designCenterWorkflow.sync(preview.previewToken);

const publication = await client.designCenterWorkflow.previewPublication(orgId, 'sample-orders-api-spec', {
  name: 'Sample Orders API',
  apiVersion: 'v1',
  version: '1.3.0',
  classifier: 'raml',
});
await client.designCenterWorkflow.publish(publication.previewToken);
```

`getFileContent` takes a project ID; the workflow methods accept a project name or ID. The sync input
lists only the files to create or update; nothing is deleted.

## What you inherit, and what you do not

Using the client directly still gives you bearer-token injection, automatic refresh, rate limiting, and
the response cache; those live below the facade.

You do not get the confirmation gates. The dry-run defaults described in the [safety model](safety.md)
are enforced by the MCP tools and the CLI, not by the API clients. If you call `cloudHub2` methods
yourself, you own the guard rails: read the current deployment before mutating, change only the artifact
reference of an existing app, and never delete by name without binding to a deployment ID. The Design
Center workflow is the exception: its hash and lock checks run in the workflow itself.

Credentials come from the constructor. For interactive use, prefer the stored profile via the CLI rather
than passing secrets around in code; see [Profiles](profiles.md).

A build-free JavaScript example is available in the repository's
[`examples/library`](https://github.com/Avinava/anypoint-connect/tree/main/examples/library) directory.
The library does not implement a client-credentials grant; a new machine still needs a user-authorized
profile before these calls can obtain a bearer token.
