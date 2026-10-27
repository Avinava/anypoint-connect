# Changelog

## 0.17.0 - 2026-10-27

### Behavior change: production takes only marked, production-deployable builds

- mule-build 3.2.0 writes `META-INF/mule-build/build-info.json` into every jar. For a production
  environment, only a marker with `schemaVersion` 1, `tool` `mule-build`, `stripped: false` and
  `productionDeployable: true` passes. A stripped jar, a marker of another schema or tool, an inconsistent
  marker (`productionDeployable` not equal to `!stripped`), or an unreadable one is refused in the preview
  and on confirm, with no override. Outside production these are warnings.
- **A jar without a marker is refused for production** as "build provenance unknown". To deploy
  artifacts built by another pipeline, opt in per organization and environment with
  `set_unmarked_artifact_allowance` (stored as `unmarkedArtifactAllowances` in
  `~/.anypoint-connect/production-approvals.json`, optional `expires` and `projectPath`). Production
  previews show `provenancePolicy` (`unmarkedAllowed`, `source`, `expires`).
- Where it is checked: `deploy_jar` and `anc deploy` check the local jar they publish. `deploy_app`,
  `update_app`, `update_app_artifact`, `rollback_app` and `anc apps update` download the artifact the
  change selects from Exchange and check its own marker for every production change, with or without a
  local jar; a failed download or an MD5 mismatch refuses the change. Their new `jarPath` input (CLI:
  `--jar`) binds the change to a local jar: its SHA-256 must equal the Exchange artifact's, in any
  environment. `publish_app_jar` takes an optional `environment` for the same check before publishing.
  Previews report `buildProvenance` and `artifactVerification`.

### Added
- `scan_logs_for_credentials` (CLI: `anc logs credentials`) counts log lines that carry session or bearer
  credentials (`Authorization: Bearer`, bearer tokens, `sessionId`, `Sforce-Session`, Salesforce session
  IDs, `access_token` / `refresh_token` / `id_token`, JWTs) per marker, per spec and per replica, over the
  same window as `get_logs`, `previousSpecs` included. It never returns the lines or the values. A
  separate read-only tool keeps `get_logs` and `download_logs` returning lines and this one never.
- `get_audit_log` classifies each entry with `actorClass` (`platform-patch`, `platform-replica`,
  `platform-infrastructure`, `user-or-pipeline`) and the `actorRule` that matched, adds
  `summary.byClass`, `returned`, and a `notice` when the result was cut. Every platform class requires a
  recognized platform identity (staff or service user name, or the patcher's client name); connected apps
  and pipelines with no user stay `user-or-pipeline`. Replica verbs match whole words. The rules live in
  one table (`src/analysis/audit-actors.ts`).
- Production pre-approval: `set_production_preapproval` stores `productionPreapprovals` entries
  (`orgId`, `environmentId`, `environmentName` for display, `tools` or `"all-mutating"`, optional
  `expires` and `projectPath`) in the user-level `~/.anypoint-connect/production-approvals.json`, never
  in the repository. A covered organization, environment and tool skips `confirmProduction` and the
  CLI's typed phrase, and `--allow-production` for `anc apps delete` (only when `delete_app` is named) and
  `anc api smoke`. Names are never matched, so approvals do not carry across organizations.
  `confirm: true`, `expectedSha256`, `expectedDeploymentId` and every refusal still apply. Production
  previews and results carry `production`, `productionPreapproved`, `preapprovalSource` and
  `preapprovalWarning` (a project file that tried to grant approval, which is ignored).
  `get_project_profile` and `whoami` show `productionPolicy`.
- `LogsApi.getLogParts` returns each spec's log text separately.
- Tests run with `HOME` pointed at an empty directory, so they never read the real user settings.

### Changed

- `set_project_profile` and `anc config use` update the nearest `.anypoint-connect.json` (walking up)
  and keep its other fields (`conventions`) instead of writing a new file with only `profile`, and a
  binding to a profile that has no credentials yet is now actually written, as its warning says.

## 0.16.3 - 2026-10-26

### Fixed

- Creating an app without properties no longer ends `FAILED` with "Cannot invoke ResourceRef.getId()
  because r is null". The create payload always carries the properties service, empty when there are no
  properties.
- `anc apps update <app> --version 1.2.0` and `anc dc publish --version` reach the subcommand instead of
  printing the CLI version. Program options are now read only before the subcommand.

### Added

- `previousSpecs` on `get_logs` and `download_logs` (CLI `--previous-specs` on `anc logs search` and
  `anc logs download`) also reads up to 10 earlier deployment specs, merged by time. Each update starts a
  new spec with its own log file, so by default the generation an update replaced disappears from view.
  Responses list the specs read in `specIds`.

### Documentation

- The safety model and the listener-app recipe give measured rollout gaps: `recreate` and `stopStart`
  both avoid overlap, with outages of about 110 s and 57 s.

## 0.16.2 - 2026-10-26

0.16.0 and 0.16.1 were tagged but never published to npm; this is the first 0.16 package. It contains
everything listed under them.

### Fixed

- The `anc` command is installed again. npm 11 removes a `bin` entry written as `./dist/cli.js` when
  publishing, so the package would have shipped without the CLI. The release check now rejects such
  paths.

## 0.16.1 - 2026-10-26

### Changed

- The README covers the 0.16 features: one-call `update_app`, runtime checks, secret sources and
  `moveToSecure`, artifact comparison, API contracts and smoke tests, and log summaries. It links each to
  its recipe and links the 0.15.x migration tables. No code changes.

## 0.16.0 - 2026-10-26

This release makes application changes one previewed call, keeps secret values out of conversations and
output, and makes logs usable at volume. Every MCP write now previews first and needs a second flag in
production; see the migration tables below.

### Fixed

- Log search no longer misses lines right after a start. Multi-line entries (error reports, start-up
  banners, stack traces, logged payloads) were split into separate entries stamped with the fetch time,
  so they were lost under a level filter and pushed real lines out of the limit. They now stay with
  their entry, keep its timestamp and level, and are searchable.
- When a newly applied spec has no log file yet, log tools read the last successful spec and say so.
- Waits no longer finish on a status left over from the previous spec, and no longer report the brief
  `FAILED` a stopped app shows while it starts. A failure is reported once it persists past a 90-second
  grace window, and is reported with the replica's reason when one is given.
- `restart_app` and `anc apps restart` restart the app. They previously re-sent the desired state, which
  did nothing on a running app.
- `anc deploy` exits non-zero when the rollout fails or times out.
- API error bodies echoed by the platform have secret-looking fields masked.

### Added

- `update_app` and `anc apps update` change artifact, runtime, settings and update strategy in one
  update. `mode: "stopStart"` (CLI `--stop-start`) stops the app, applies the change and starts it, so old
  and new replicas never process events together. `updateStrategy: "rolling" | "recreate"` sets the
  platform strategy.
- Runtime checks: a requested runtime is checked against what the app's target offers, and a retired
  current runtime is detected, before anything is written. The preview names the nearest supported
  versions. `list_runtime_versions` and `anc runtimes list` show a target's catalog.
- `update_app_settings` and `anc apps settings set`:
  - `securePropertiesFrom` and `propertiesFrom` read values on the server from a `.env`, `.properties` or
    JSON file inside the project, or from environment variables.
  - `removeProperties` and `removeSecureProperties` delete keys.
  - `moveToSecure` turns a plain property into a secure one without the value leaving the server.
- `get_app_settings` masks secret-looking plain values by default and lists each under `warnings` with
  the `moveToSecure` fix. `anc apps settings get` does the same.
- `get_app_status` reports a `phase` (`RUNNING`, `STARTING`, `UPDATING`, `DEGRADED`, `FAILED`,
  `STOPPING`, `STOPPED`) with `settled` and `reason`, and accepts `wait`. `stop_app`, `start_app`,
  `scale_app`, `restart_app` and the deploy tools accept `wait`.
- Naming conventions: `.anypoint-connect.json` `conventions` sets the asset ID and version templates used
  when publishing (`{app}`, `{artifactId}`, `{pomVersion}`, `{timestamp}`, `{gitShort}`).
  `suggest_asset_name` and the deploy preview report the pattern of the asset an app runs today.
- `compare_deployed_artifact` and `anc apps compare` compare the JAR an app runs with a git ref (optionally
  including uncommitted changes) or a local JAR, by file name and hash, plus dependencies.
- API Manager: `list_api_contracts`, `get_client_application` (secret masked; `writeCredentialsTo`
  writes a mode-0600 `.env` file in the project) and `smoke_test_api`, which calls an API with its
  client credentials without returning them. CLI: `anc api contracts`, `client-app`, `smoke`.
- Logs: `get_logs` gains `regex`, `logger`, `hoursBack`, `startTime`/`endTime` and returns the match
  count before the limit. `download_logs` gains `search`, `regex`, `logger`, `level`, `mode: "summary"`
  with counts by level, logger and time bucket, `maxLines`, and `outputFile`. The analysis tools accept
  `level`, `search`, `regex` and `logger`. CLI: `anc logs search`, and `--grep`, `--logger`, `--summary`
  on `anc logs download`.
- CLI: `anc apps stop`, `anc apps start`, `anc apps status --wait`.

### Changed

- Every MCP write previews unless `confirm: true`, and production also needs `confirmProduction: true`.
  This now covers `update_app_settings`, `restart_app`, `scale_app`, `stop_app` and `start_app`, which
  previously applied on call, and adds the production flag to the deploy tools.
- Changes to an existing app go through one workflow and one PATCH. `deploy_jar`, `deploy_app` and
  `anc deploy` accept runtime and settings changes for an existing app instead of rejecting or silently
  ignoring them. Region, vCores, replicas and JVM arguments are still create-only, and are now refused
  rather than ignored by `deploy_app`.
- `restart_app` is a stop, wait, start: expect a short outage.
- `get_app_settings` no longer returns `rawConfiguration`. Other configuration services are returned as
  `otherConfiguration`, masked.
- `download_logs` returns lines oldest first with logger and stack traces, and is annotated as writing,
  because `outputFile` can write a local file.

### Migration from 0.15.x

MCP tools:

| 0.15 | 0.16 |
| --- | --- |
| `update_app_settings`, `restart_app`, `scale_app`, `stop_app`, `start_app` applied on call | Call once for the preview, then again with `confirm: true` |
| Any write in production with `confirm: true` | Add `confirmProduction: true` |
| `update_app_artifact` to change the version, then `update_app_settings` | One `update_app` call |
| `stop_app`, `update_app_artifact`, `start_app` for listener-driven apps | `update_app` with `mode: "stopStart"` |
| Secrets in `secureProperties` | `securePropertiesFrom` with a file or environment variable |
| Raw API PATCH to delete or move a property | `removeProperties`, `removeSecureProperties`, `moveToSecure` |
| `get_app_settings` `rawConfiguration` | `properties`, `securePropertyKeys`, `otherConfiguration` |
| `get_app_status` `status` for health | `phase` and `settled` (`status` is still returned) |

CLI:

| 0.15 | 0.16 |
| --- | --- |
| `anc apps restart` re-sent the desired state | `anc apps restart` stops, waits and starts |
| `anc deploy` rejected `--runtime` for an existing app | `anc deploy --runtime` moves the app to that runtime |
| Settings through the platform UI | `anc apps settings get`, `anc apps settings set` |

Library:

- `mergeApplicationProperties` is replaced by `planSettingsChange`, which also removes and moves keys
  and returns a diff.
- `CloudHub2Api.waitForDeployment(org, env, id, options)` takes an options object and returns
  `{deployment, snapshot, timedOut}` instead of throwing on failure.
- `CloudHub2Api.restartApp` is removed; use `planAppChange` with `restart: true`.
- New: `patchDeployment`, `RuntimesApi`, `planAppChange`/`executeAppChange`, `deploymentPhase`/`waitForAppPhase`,
  the secret helpers and `resolveSecretSources`.
- `LogsApi.getLogs` returns enriched entries. New: `searchLogs`, `queryLogs` and `getLogFile`.

## 0.15.0 - 2026-10-05

This release consolidates the MCP and CLI surface. Tool and command names changed; see the migration
tables below.

### Fixed

- Memory metrics work on CloudHub 2.0. They previously queried a datasource that no longer exists and
  silently returned nothing.
- Monitoring queries no longer hide failures. Syntax errors, unknown attributes, unsupported
  aggregations and oversized pages are reported with the platform's message instead of as empty results.
- Garbage-collection activity is reported as the change inside the window. The platform exposes
  cumulative counters, which previously inflated totals.
- Application names in monitoring filters are escaped, and organization and environment IDs are validated
  before they reach a query.
- `anc deploy <jar>` publishes the JAR before deploying it. It previously validated the file but deployed
  whatever Exchange asset matched coordinates guessed from the file name.
- `anc design-center push` and `publish` preview first and apply through the conflict-checked, verified
  workflow, asking for confirmation unless `--yes` is given.

### Added

- `get_metrics` groups by app, worker or HTTP route, compares every environment when no environment is
  given, and reports failures, failure rate, p50/p75/p90/p95/p99, outbound failures and Mule message
  volume.
- `get_runtime_metrics` reports per-worker heap, old-generation usage against its limit, metaspace,
  old-generation GC activity, CPU load and physical memory.
- `get_metrics_timeseries` charts `traffic`, `latency`, `memory`, `cpu` or `gc` with buckets from `1m`
  to `1d`.
- `raw_amql_query` documents the available datasources and fields, accepts an `offset`, and allows pages
  of up to 2,000 rows.
- CLI: `anc monitor summary`, `runtime`, `trend --signal`, `query`; `anc deploy --dry-run`;
  `anc api alerts`.
- A [monitoring guide](docs/monitoring.md), and a tool catalog generated from the server's registry with
  a documentation check that fails when the two diverge.
- The library exports the monitoring types, `AmqlQueryError`, and a package `exports` map.

### Changed

- MCP tool modules are organized by domain: application read, deploy and lifecycle tools, Exchange,
  Design Center, governance and monitoring. `deploy_jar` and `anc deploy` share one implementation.
- Source layout: `src/workflows/` (JAR deployment, Design Center), `src/config/profiles.ts`, and
  `src/mcp/server.ts`. `src/mcp.ts` remains the executable entry point.
- The CLI group `dc` is now `design-center`; `dc` still works as an alias.
- Log analysis reads stack traces from any `stackTrace`-style field in logger payloads.

### Removed

- `publish_to_exchange` and `update_design_center_file`. Their unpreviewed write paths are replaced by
  the preview and apply pairs below.

### Migration from 0.14.x

MCP tools:

| 0.14 | 0.15 |
| --- | --- |
| `get_metrics` | `get_metrics` (rows now include failures and percentiles) |
| `get_performance_metrics` | `get_metrics` |
| `get_worker_metrics` | `get_metrics` with `groupBy: "worker"` |
| `compare_env_performance` | `get_metrics` without `environment` |
| `get_memory_metrics` | `get_runtime_metrics` (no thread counts; the platform no longer reports them) |
| `get_metrics_timeseries` | `get_metrics_timeseries` with `signal: "traffic"` or `"latency"` |
| `get_memory_timeseries` | `get_metrics_timeseries` with `signal: "memory"` or `"gc"` |
| `compare_environments` | `compare_app_deployments` |
| `get_design_center_files` | `list_design_center_files` |
| `get_store_keys` | `list_store_keys` |
| `preview_design_center_project_create` | `preview_create_design_center_project` |
| `preview_design_center_sync` | `preview_sync_design_center_files` |
| `preview_exchange_publication` | `preview_publish_exchange_asset` |
| `publish_previewed_exchange_asset` | `publish_exchange_asset` |
| `publish_to_exchange` | `preview_publish_exchange_asset`, then `publish_exchange_asset` |
| `update_design_center_file` | `preview_sync_design_center_files`, then `sync_design_center_files` |

CLI:

| 0.14 | 0.15 |
| --- | --- |
| `anc monitor view`, `perf` | `anc monitor summary` |
| `anc monitor workers` | `anc monitor summary --by worker` |
| `anc monitor compare` | `anc monitor summary` without `--env` |
| `anc monitor memory` | `anc monitor runtime` |
| `anc monitor trend` | `anc monitor trend --signal traffic` (or `latency`) |
| `anc monitor memory-trend` | `anc monitor trend --signal memory` (or `gc`) |
| `anc deploy --artifact-id`, `--version` | `anc deploy --asset-id`, `--asset-version` (default: the JAR's Maven identity) |
| `anc dc push`, `publish` | unchanged names; add `--yes` in non-interactive scripts |

Library: `getAppMetrics`, `getPerformanceMetrics`, `getWorkerMetrics` and `getCrossEnvMetrics` become
`getMetrics`; `getMemoryMetrics` becomes `getRuntimeMetrics`; `getTimeSeries` and `getMemoryTimeSeries`
become `getTimeSeries(scope, signal, granularity)`. `MonitoringApi.search` throws `AmqlQueryError`
instead of returning `[]`. `DesignCenterApi.updateFile` and `publishToExchange` are removed in favour of
`DesignCenterWorkflow`.

## 0.14.0 - 2026-10-03

### Changed

- Refresh compatible production dependencies to resolve the audited HTTP/schema/parser findings without major upgrades.

- Application publication/deployment MCP tools default to embedded Maven artifact ID and version
  instead of guessing from a display filename or choosing a default version. Explicit Exchange
  coordinate mappings remain supported; absent or ambiguous metadata requires both values.
- Publication previews include the artifact SHA-256. Supplying `expectedSha256` on confirmation
  rejects changed bytes, and the API rechecks the exact buffer before upload. Preview-first and
  authentication behavior remain unchanged.

### Migration from 0.13.x

- Review application publication/deployment coordinates before confirming: omitted artifact IDs and
  versions now come from embedded Maven metadata, not the display filename or a default version.
- For intentional Exchange mappings, continue supplying explicit artifact ID and version. Supply both
  when embedded metadata is absent or ambiguous; rebuild the JAR when its metadata is malformed.
- Confirm a publication with the preview's `expectedSha256` to reject changes to the reviewed bytes.

## 0.13.0 — Secure Onboarding and Documentation

### Added

- A task-oriented documentation experience with a redesigned home page, beginner-friendly setup path,
  exact Connected App configuration, administrator handoff, credential rotation, troubleshooting, and
  copyable CLI, MCP, Bash, PowerShell, and JavaScript examples.
- Self-contained OAuth callback pages for success and failure states, with responsive light/dark design,
  escaped dynamic content, no external assets, and restrictive browser security headers.
- Documentation validation for release pins, credential-shaped literals, synthetic sample names, example
  syntax, and library dependency alignment.

### Security

- OAuth callbacks are bound to the one-time state that initiated login. Missing or mismatched callbacks
  are rejected without ending the valid login attempt.
- The callback listener accepts only HTTP loopback hosts, and callback responses disable caching,
  referrers, framing, script execution, and content-type sniffing.
- Interactive configuration masks the Client Secret and preserves an existing secret when the prompt is
  left blank.

### Changed

- Node.js 22 is now the minimum supported runtime; Node.js 24 LTS is recommended and CI covers Node 22,
  24, and 26.
- Authentication documentation now matches the implemented user Authorization Code flow and its
  `full offline_access` request. Client ID and Secret alone are explicitly not presented as headless CI
  authentication.
- Documentation navigation, typography, color contrast, responsive behavior, logo, and light/dark themes
  were rebuilt for faster scanning by MuleSoft developers who do not routinely use Node.js.
- Profile and deployment guidance now distinguishes commands that accept `--profile`, MCP dry runs, and
  CLI operations that apply immediately outside production.
- The repository code-review skill now encodes the authentication, credential, mutation-safety,
  documentation, and release invariants that reviewers must preserve, without mandatory ceremony.
- Tag-driven releases now run static, formatting, and documentation validation before npm publication.

## 0.12.0 — API Design Workflows

### Added

- Single-use, 10-minute previews for Design Center project creation, multi-file synchronization, and Exchange publication.
- Conflict-safe batch sync with exact project resolution, path guards, one branch lock, hash rechecks, post-save verification, and no delete/move/rename behavior.
- Branch listing and API Governance plan/conformance reads.
- Post-publication Exchange artifact hash verification.

### Changed

- Project names no longer use partial matching. Supply an exact name or project ID.
- Direct `publish_to_exchange` remains available for compatibility but is marked legacy; new workflows use approval-bound publication previews.

## 0.11.1 — Dependency Security

### Security

- Refreshed production dependency resolutions for patched releases of Axios, Hono and its Node
  adapter, Express middleware, schema validation, redirect handling, URI parsing, and related
  transitive packages. `npm audit --omit=dev --audit-level=moderate` reports no production findings.
- Updated Vitest and its coverage provider to the maintained Node 20-compatible major release; the
  complete dependency tree now audits clean.
- Added the production audit to CI and the release workflow so a future vulnerable runtime lockfile
  cannot be published silently.

### Operations

- Release completion now proposes the exact new pin to the `mule-skills` compatibility hub through a
  reviewable repository-dispatch pull request.

## 0.11.0 — Documented

Documentation release. No CLI, MCP, or API behavior changed.

### Added

- **A published documentation site** at <https://avinava.github.io/anypoint-connect/>, built with MkDocs
  Material and deployed by GitHub Actions. The README was 715 lines and the only documentation target,
  which made setup, the tool catalog, and the safety model compete for the same space. Eleven pages now:
  getting started, profiles, access readiness, CLI reference, MCP setup, tool catalog, safety model,
  deploying a JAR, library API, troubleshooting, and architecture. CI builds the site with `--strict`,
  so a broken cross-link or an orphaned page fails a pull request.
- **`docs/readiness.md`, naming the six access states.** Being unconfigured, unauthenticated, pointed at
  an environment you cannot see, and missing a scope are four different problems with four different
  fixes, and they all present as "it does not work". The states are named the same way the
  [`mule-skills`](https://avinava.github.io/mule-skills/anypoint-access/) workflows name them, so the
  server's errors and an agent's readiness gate describe the same situation with the same words.
- **`docs/troubleshooting.md`** covering the failure modes that look like defects: a redirect-URI
  mismatch stalling the browser flow, an exported environment variable silently outranking the selected
  profile, a 403 on an unprovisioned service being correct behavior, and a dry run that appeared to do
  nothing because it was supposed to.
- **MCP setup for every host.** Only a generic `mcpServers` block existed, with Claude Desktop, Gemini,
  and Cursor mentioned in prose. Claude Code, Codex, VS Code, and Copilot CLI are now documented
  explicitly, along with which wrapping key each one wants.
- An ecosystem page and README section placing this tool alongside `mule-build`, `mule-lint`, and
  `mule-skills`, and stating the boundary: this is the only one that authenticates, and a complete
  release crosses two of them.

### Fixed

- **`LICENSE` did not exist.** It was listed in `package.json` `files`, so npm silently omitted it, and
  the README badge linked to `blob/master/LICENSE` — a missing file on a branch that is also not the
  default. The file is now present and the badge points at `main`.
- **The tool catalog was missing `compare_environments`**, which is registered and referenced by the
  `pre-deploy-check` prompt: 55 documented against 56 registered.
- `engines.node` claimed `>=18.0.0` while CI has only ever tested 20, 22, and 24. Corrected to
  `>=20.0.0` rather than leaving an untested claim in the manifest.

### Changed

- `package.json` homepage points at the documentation site.
- CI actions moved to `actions/checkout@v7` and `actions/setup-node@v7`.
- The site build excludes `PLAN-*.md`, so the gitignored planning note containing real organization
  identifiers cannot be published by a local build either.

## 0.10.0 — Bound Application Deletion

### Added

- **`delete_app` MCP tool.** Application deletion is dry-run by default and requires a second call
  bound to the exact deployment ID. Production deletion also requires a separate acknowledgement.
- **`anc apps delete` CLI command.** The CLI uses the same deployment-ID confirmation and
  production guard as MCP.

### Safety

- Deletion removes only the CloudHub deployment. Exchange artifacts and other Anypoint resources
  are left untouched, and the preview recommends `stop_app` when configuration should be retained.
- Post-delete verification bypasses cached deployment lists, detects a replacement deployment with
  the same name, and reports when CloudHub accepts deletion but absence is not yet observable.

## 0.9.1 — Safe Application Updates

### Fixed

- **Application settings can be updated in place.** `update_app_settings` now sends only the
  application-properties configuration instead of replaying an incomplete deployment returned by
  the list endpoint. Existing plain properties and masked secure-property entries are preserved.
- **Lifecycle changes no longer replay deployment infrastructure.** Start and stop operations now
  PATCH only the requested desired state.
- **Application reads use the correct response shape.** Status, resources, replica counts and
  states, timestamps, environment comparisons, and CLI output now hydrate full deployment detail
  when the list endpoint returns summaries.
- **Artifact updates resolve current coordinates from deployment detail.** Version-only updates no
  longer depend on fields absent from list responses.
- **Rollback resolves deployment history correctly.** Deployment-spec IDs are no longer mistaken
  for artifact versions; the tool selects a complete historical artifact reference and skips
  lifecycle-only history entries.

### Internal

- Added separate types for deployment summaries, details, specs, and replica states.
- Added regression coverage for narrow PATCH bodies, secure-property preservation, detail
  hydration, and rollback selection.

## 0.9.0 — Safe Deploy

### Fixed

- **Redeploys no longer clobber a running app.** Updating an existing CloudHub 2.0 deployment (via
  `deploy_app` or the `deploy` CLI command) previously sent a fully defaulted payload, so any field
  the caller omitted was overwritten with a hardcoded default — silently downgrading the Mule runtime
  and relocating the app out of its target/space. Both surfaces now PATCH **only** the artifact
  reference on an existing app, preserving runtime, target, replicas, resources, and settings.
- **`vcores` is no longer a silent no-op.** The value is now written to the deployment on the create
  path (it was accepted and dropped before), in both the MCP tool and the CLI.

### Added

- **`publish_app_jar`** — upload a locally built application JAR to Exchange as a deployable asset
  (Exchange v2 multipart publication API). This was the missing first step for deploying a freshly
  built artifact.
- **`deploy_jar`** — publish a JAR and deploy it in one call: creates the app, or safely updates only
  the artifact ref if it already exists.
- **`update_app_artifact`** — the safe production redeploy: change only the artifact version, with an
  optional wait for the deployment to settle.
- **`rollback_app`** — revert an app to a previous version (the last successful version by default).
- **`get_deployment_spec`** — full current deployment spec (artifact ref, runtime, target kind,
  vCores, per-replica states) for a look-before-you-leap check.
- **Dry-run safety for deploy tools.** All mutating deploy tools are dry-run by default: without
  `confirm: true` they return a preview of exactly what would change and modify nothing.

### Internal

- Extracted a shared `src/safety/deployment` module (payload builder + safe artifact-update merge)
  used by both the MCP tools and the CLI, so the payload logic has a single source of truth.
- Consolidated the duplicated artifact-ref and resources type shapes into shared `ArtifactRef` and
  `DeploymentResources` types.
- Added `HttpClient.postMultipart` for artifact uploads.
