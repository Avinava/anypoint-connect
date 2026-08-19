# Changelog

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
