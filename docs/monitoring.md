# Monitoring

Anypoint Monitoring answers most runtime-health questions without opening a log. This page maps each
question to the MCP tool or CLI command that answers it, explains how to read the numbers, and ends with
an AMQL reference for the questions the built-in views do not cover.

All metrics come from the CloudHub 2.0 Monitoring datasources. The monitoring tools only read data. Each
one takes an environment, an optional application name, and a window: `hoursBack` for MCP tools (default
24), and `--from` / `--to` for CLI commands (default the last 24 hours; relative values such as `6h` or
`7d`, or ISO timestamps).

## Which tool answers which question

| Question | MCP tool | CLI |
| --- | --- | --- |
| Which apps get traffic, and how many requests fail? | `get_metrics` | `anc monitor summary --env Sandbox` |
| How slow is one app, at p50 through p99? | `get_metrics` with `appName` | `anc monitor summary --env Sandbox --app sample-orders-api` |
| Is one replica unhealthy or carrying more load than the others? | `get_metrics` with `groupBy: "worker"` | `anc monitor summary --env Sandbox --app sample-orders-api --by worker` |
| Which inbound or outbound route is failing? | `get_metrics` with `groupBy: "route"` | `anc monitor summary --env Sandbox --app sample-orders-api --by route` |
| Does the app behave differently in another environment? | `get_metrics` without `environment` | `anc monitor summary --app sample-orders-api` (no `--env`) |
| Is the heap under pressure, or is old generation filling up? | `get_runtime_metrics` | `anc monitor runtime --env Sandbox --app sample-orders-api` |
| How much garbage collection ran, and how long did it take? | `get_runtime_metrics` (window total) or `get_metrics_timeseries` with `signal: "gc"` | `anc monitor runtime …` or `anc monitor trend --signal gc …` |
| Is a worker short on CPU or RAM? | `get_runtime_metrics` | `anc monitor runtime --env Sandbox` |
| What happened, minute by minute, during an incident? | `get_metrics_timeseries` with `granularity: "1m"` or `"5m"` | `anc monitor trend --env Sandbox --app sample-orders-api --signal traffic -g 5m --from 3h` |
| Is the old-generation baseline rising over days? | `get_metrics_timeseries` with `signal: "memory"`, `granularity: "1h"` or `"1d"` | `anc monitor trend --signal memory -g 1h --from 7d …` |
| Anything else | `raw_amql_query` | `anc monitor query "<amql>"` |
| Keep a copy of a period's metrics | — | `anc monitor download --env Sandbox --from 7d --format csv` |

Start broad and narrow down: `get_metrics` per app for the environment, then `groupBy: "worker"` or
`"route"` for the app that stands out, then `get_runtime_metrics` if the symptoms point at memory or CPU,
then a time series around the incident window. Log evidence for the same window comes from
`analyze_errors` and `get_log_stats`.

## Traffic, failures, and latency

`get_metrics` (CLI: `anc monitor summary`) returns one row per app, per worker, or per route. App and
worker rows contain:

| Field | Meaning |
| --- | --- |
| `requestCount`, `failedCount`, `failureRate` | Inbound requests, those with status `FAILED`, and the ratio (0–1; 0 when there were no requests) |
| `avgResponseTime`, `minResponseTime`, `maxResponseTime` | Inbound response time, milliseconds |
| `p50`, `p75`, `p90`, `p95`, `p99` | Inbound response-time percentiles, milliseconds |
| `outboundCount`, `outboundFailedCount`, `outboundAvgResponseTime` | Calls the app made to dependencies, and their average time in milliseconds |
| `messageCount`, `messageErrorCount` | Mule message volume and message errors |

Route rows carry `direction` (`inbound` or `outbound`), `route`, `requestCount`, `failedCount`,
`avgResponseTime`, and `p95`, sorted by failures first. `route` is `null` (shown as `(unlabelled)`) when
the runtime did not label the call.

Reading them:

- **Read percentiles with the request count.** At a few dozen requests a single slow call moves p99.
- **Failures are outcome-based.** A request counts as failed when Monitoring recorded its status as
  `FAILED`; an error the flow handled and answered with a success status does not appear here. Use
  `analyze_errors` for handled errors.
- **Outbound failures with healthy inbound traffic** usually mean a dependency is failing and the app is
  absorbing it, through retries, fallbacks, or error handlers. Check the outbound route rows.
- **Worker imbalance.** Compare `requestCount` and latency across workers. One worker with similar
  traffic but much higher latency or failures points at that replica (restart, noisy neighbour, memory);
  uneven traffic points at load balancing or long-lived client connections.
- **Cross-environment comparison.** Without an environment, rows add `envName`, so the same app is shown
  side by side in every environment. Lower environments with little traffic make poor latency baselines.

## JVM and host health

`get_runtime_metrics` (CLI: `anc monitor runtime`) returns one row per worker:

| Field | Unit | Meaning |
| --- | --- | --- |
| `heapUsedAvg`, `heapUsedPeak`, `heapCommittedAvg` | bytes | Total heap used and committed |
| `oldGenPool` | — | Name of the old-generation pool, for example `tenured_gen`; `null` if none was reported |
| `oldGenUsedAvg`, `oldGenUsedPeak` | bytes | Old-generation usage in the window |
| `oldGenLimit` | bytes | Maximum size of that pool; `null` when the pool is unbounded |
| `oldGenPeakRatio` | 0–1 | `oldGenUsedPeak / oldGenLimit`; `null` when there is no limit |
| `metaspaceUsedAvg` | bytes | Class metadata |
| `oldGenGcCount`, `oldGenGcTimeMs` | count, ms | Old-generation collections and time spent in them **inside the window** |
| `gcCollectors[]` | count, ms | The same per collector, with an `oldGeneration` flag |
| `pools[]` | bytes | Every memory pool with used, peak, committed, and limit |
| `availableProcessors`, `totalPhysicalMemory` | count, bytes | Worker capacity |
| `systemCpuLoadAvg`/`Max`, `processCpuLoadAvg`/`Max` | 0–1 | Host and JVM CPU load; 1 means fully busy |
| `freePhysicalMemoryAvg` | bytes | Average free physical memory |

### Reading memory

- **A sawtooth is normal.** Heap and young-generation usage rise and fall with every collection. Total
  heap peak on its own says little.
- **Old generation is the signal.** Objects that survive collection land there. Watch the old-generation
  peak against its limit (`oldGenPeakRatio`), and above all its **baseline over several days**: the low
  points after old-generation collections. A baseline that keeps rising across days, without falling back
  after collections, is the leak signal. A high but flat baseline is a sizing question, not a leak.
- **Pressure shows up as GC work.** A ratio close to 1 together with frequent old-generation collections
  and growing `oldGenGcTimeMs` means the JVM is spending time reclaiming little. That precedes
  out-of-memory restarts and latency spikes.
- **Use a long window for the baseline.** Compare `get_metrics_timeseries` with `signal: "memory"` over
  7 days at `1h` or `1d` granularity. A one-hour view cannot distinguish a leak from a busy hour.
- **Restarts reset the picture.** After a restart or redeploy the baseline starts again from a low value;
  compare like-for-like periods.

### Reading GC and CPU

- GC counts and times are **deltas inside the window or bucket**, not lifetime totals. If a worker
  restarts in the middle of the window, the counter starts again and the delta covers only the activity
  that was observed.
- CPU loads are fractions from 0 to 1. Sustained `systemCpuLoadMax` near 1 with low traffic points at
  garbage collection or a busy background job; read it with the GC numbers.
- Free physical memory is an average. Monitoring cannot compute a reliable minimum or maximum for it.

## Incident windows and trends

`get_metrics_timeseries` (CLI: `anc monitor trend`) returns one point per bucket:

| Signal | Rows | Fields |
| --- | --- | --- |
| `traffic` | per app | `requestCount`, `failedCount`, `avgResponseTime`, `p95` |
| `latency` | per app | `p50`, `p75`, `p90`, `p95`, `p99` |
| `memory` | per worker | `heapUsed`, `oldGenUsed`, `metaspaceUsed` (bytes, bucket average) |
| `cpu` | per worker | `systemCpuLoad`, `processCpuLoad` (0–1), `freePhysicalMemory` (bytes) |
| `gc` | per worker | `oldGenGcCount`, `oldGenGcTimeMs`, `gcCount`, `gcTimeMs` (per-bucket deltas) |

Granularity is one of `1m`, `5m`, `15m`, `30m`, `1h`, or `1d` (default `1h`). Use `1m` or `5m` for an
incident window of a few hours, and `1h` or `1d` for multi-day trends. Very small buckets over a long
window produce many rows and are slow to compute.

## Empty results and errors

The two outcomes mean different things:

- **An empty result** means the query ran and found nothing in scope: the window predates the deployment,
  the app name does not match exactly, the environment is wrong, or the app received no traffic.
- **An error** means the query did not run. The response carries the platform's message, for example a
  syntax error, an unknown datasource or attribute, or a missing permission. Library callers receive an
  `AmqlQueryError`; see the [library guide](library.md#monitoring).

## AMQL reference

`raw_amql_query` and `anc monitor query` run a freeform Anypoint Monitoring Query Language query and return
the rows unchanged. Use them when the built-in views do not answer the question.

### Datasources

| Datasource | Key fields |
| --- | --- |
| `"mulesoft.app.inbound"` | `requests`, `response_time` (ms), `"response.status"` (`'FAILED'`), `"http.route"`, `"worker.id"`, `"app.name"`, `"env.id"`, `"env.name"` |
| `"mulesoft.app.outbound"` | Same as inbound, for calls the app makes; `"http.route"` identifies the dependency route |
| `"mulesoft.message"` | `total_count`, `error_count` |
| `"mulesoft.app.jvm.memory"` | `usage`, `committed`, `init`, `"limit"` (bytes; `-1` means unbounded), `"type"` (`heap` or `off-heap`), `"pool"` (`total-heap`, `tenured_gen`, `eden_space`, `survivor_space`, `metaspace`, …) |
| `"mulesoft.app.jvm.gc"` | `count`, `duration` (ms), `name` (collector). Both counters are cumulative per worker and collector |
| `"mulesoft.app.jvm.cpu"` | `available_processors`, `total_physical_memory_size` |
| `"mulesoft.app.memory"` | `system_cpu_load`, `process_cpu_load` (0–1), `free_physical_memory_size` (bytes) |
| `"mulesoft.entity"` | Entity-level view keyed by `"entity.id"` and `"entity.name"`; it has no `"app.name"` |

Functions: `COUNT`, `SUM`, `AVG`, `MIN`, `MAX`, `PERCENTILE(field, 0.95)`, `LATEST(field)`, with
`GROUP BY`, `ORDER BY`, and `TIMESERIES PT1M | PT5M | PT15M | PT30M | PT1H | P1D`.

### Rules that avoid wrong answers

- **Always filter on `"sub_org.id"` and a timestamp range** (`timestamp BETWEEN <from-ms> AND <to-ms>`,
  epoch milliseconds). Add `"env.id"` and `"app.name"` as needed. An unbounded query is slow and mixes
  environments.
- **GC counters are cumulative.** Activity in a window is `MAX(count) − MIN(count)` (and the same for
  `duration`), grouped by worker and collector. `SUM` over a cumulative counter is meaningless.
- **Quote `"limit"`.** It is a reserved word; unquoted it is a syntax error. The same applies to dotted
  names such as `"app.name"`.
- **Use only `AVG` for physical-memory sizes on `"mulesoft.app.memory"`.** `MIN` or `MAX` on
  `free_physical_memory_size` fails on the server, after a long wait.
- **`SELECT *` is not supported.** Name every field.
- **Single-letter aliases such as `h`, `d`, and `t` are reserved.** Use descriptive quoted aliases such as
  `AS "p95"`.
- **An in-query `LIMIT` is ignored.** Page with the tool's `limit` (default 200, maximum 2000) and
  `offset`, or the CLI's `--limit` and `--offset`.
- **Escape a quote inside a string literal by doubling it:** `'O''Reilly'`.

`whoami` and `list_environments` return the organization and environment IDs to use in place of
`<org-id>` and `<env-id>`. On the command line, keep the query in a file to avoid nested quoting:
`anc monitor query "$(cat failing-routes.amql)" --limit 500`.

### Example: failing outbound routes

```sql
SELECT COUNT(requests) AS "failed_count", "app.name", "http.route"
FROM "mulesoft.app.outbound"
WHERE "sub_org.id" = '<org-id>' AND "env.id" = '<env-id>'
  AND timestamp BETWEEN <from-ms> AND <to-ms>
  AND "response.status" = 'FAILED'
GROUP BY "app.name", "http.route"
```

### Example: old generation against its limit, per worker

List the pool names first if you do not know which collector the app uses (group by `"pool"` alone), then:

```sql
SELECT MAX(usage) AS "used_peak", AVG(usage) AS "used_avg", MAX("limit") AS "limit_max",
       "worker.id", "pool"
FROM "mulesoft.app.jvm.memory"
WHERE "sub_org.id" = '<org-id>' AND "env.id" = '<env-id>'
  AND "app.name" = 'sample-orders-api'
  AND timestamp BETWEEN <from-ms> AND <to-ms>
  AND "pool" = 'tenured_gen'
GROUP BY "worker.id", "pool"
```

### Example: garbage collection inside a window

```sql
SELECT MAX(count) AS "count_max", MIN(count) AS "count_min",
       MAX(duration) AS "duration_max", MIN(duration) AS "duration_min",
       "worker.id", name
FROM "mulesoft.app.jvm.gc"
WHERE "sub_org.id" = '<org-id>' AND "env.id" = '<env-id>'
  AND "app.name" = 'sample-orders-api'
  AND timestamp BETWEEN <from-ms> AND <to-ms>
GROUP BY "worker.id", name
```

Collections in the window are `count_max − count_min`; milliseconds spent are
`duration_max − duration_min`.

### Example: five-minute latency and CPU during an incident

```sql
SELECT timestamp, COUNT(requests) AS "request_count", PERCENTILE(response_time, 0.95) AS "p95", "app.name"
FROM "mulesoft.app.inbound"
WHERE "sub_org.id" = '<org-id>' AND "env.id" = '<env-id>'
  AND "app.name" = 'sample-orders-api'
  AND timestamp BETWEEN <from-ms> AND <to-ms>
GROUP BY "app.name"
TIMESERIES PT5M
```

```sql
SELECT timestamp, AVG(system_cpu_load) AS "system_cpu", AVG(free_physical_memory_size) AS "free_memory",
       "worker.id"
FROM "mulesoft.app.memory"
WHERE "sub_org.id" = '<org-id>' AND "env.id" = '<env-id>'
  AND "app.name" = 'sample-orders-api'
  AND timestamp BETWEEN <from-ms> AND <to-ms>
GROUP BY "worker.id"
TIMESERIES PT5M
```

Exported metrics and query results are production data once they are on disk. Keep them out of
repositories and remove identifiers before sharing.
