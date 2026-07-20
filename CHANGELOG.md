# Changelog

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
