# Safety model

This toolkit can publish artifacts, redeploy applications, and delete a production deployment. The
safeguards below exist because a scripted call, a copy-pasted command, and a tired engineer all make the
same class of mistake: acting on something other than what they inspected.

The guards live in shared code (`src/safety/` and `src/workflows/`), so the CLI and the MCP server apply
the same rules. Direct library calls do not pass through them; see the [library guide](library.md).

## How each kind of change is guarded

| Kind of change | MCP | CLI |
| --- | --- | --- |
| Publish a JAR, create or redeploy an app, change the artifact, roll back | Dry-run preview unless `confirm: true` (`publish_app_jar`, `deploy_jar`, `deploy_app`, `update_app_artifact`, `rollback_app`) | `anc deploy` prints the plan; `--dry-run` stops there; production asks for a typed phrase unless `--force` |
| Delete a deployment | Preview, then `confirm: true` plus the exact `expectedDeploymentId`; production also needs `confirmProduction: true` (`delete_app`) | `anc apps delete` is a dry run until `--confirm <deployment-id>`; production also needs `--allow-production` |
| Design Center project creation, file sync, Exchange publication | A `preview_*` tool returns a single-use token; the paired write tool consumes it | `anc dc push` and `anc dc publish` preview, then ask; `--yes` skips the question |
| Restart, scale, stop, start, application settings | Applied on call (`restart_app`, `scale_app`, `stop_app`, `start_app`, `update_app_settings`) | `anc apps restart` and `anc apps scale` prompt for production unless `--force` |
| Object Store writes, MQ publish, project-profile binding | Applied on call (`put_store_value`, `delete_store_value`, `publish_mq_message`, `set_project_profile`) | — |
| Everything else | Read-only | Read-only |

The [tool catalog](tools.md) marks every tool as read or write. Tools that are applied on call still
validate their input, and the settings tools preserve everything they were not asked to change, but there
is no preview step. Ask for them explicitly, and grant a read-only Anypoint identity when no change should
be possible at all.

## Dry run by default

Application deployment tools return a preview when called without `confirm: true`, and change nothing.
The preview states the current version, the target version, the replica count, and the environment.
Applying requires a second call.

```jsonc
// preview: shows the change, modifies nothing
update_app_artifact({ "appName": "sample-orders-api", "environment": "Sandbox", "version": "1.3.0" })

// apply
update_app_artifact({ "appName": "sample-orders-api", "environment": "Sandbox", "version": "1.3.0", "confirm": true })
```

MCP runs over stdio, where there is no interactive prompt, so the second call is the confirmation. The
CLI uses a typed confirmation for production instead, and `--force` for reviewed, unattended use.

## Redeploys change the artifact and nothing else

For an existing application, `anc deploy`, `deploy_jar`, `deploy_app`, `update_app_artifact`, and
`rollback_app` PATCH only the artifact reference (`application.ref`). The runtime version, target and
private space, replica count, vCores, and application settings stay as they are on the server.

That is a deliberate constraint. A redeploy cannot silently downgrade a runtime, move an app to another
space, or reset the replica count to a default, which is how a routine version bump quietly halves
capacity. Create-only settings (runtime, region, vCores, replicas, JVM arguments, properties) are rejected
when the application already exists. Use the scale and settings tools, or create a new deployment, to
change infrastructure.

New applications get a full create payload from one builder, with the defaults in one place (runtime
4.8.0, region `cloudhub-us-east-2`, 0.1 vCores, one replica unless specified). vCores are validated
against the allowed sizes.

## Publishing a JAR

`anc deploy`, `deploy_jar`, and `publish_app_jar` share one workflow:

1. **Inspect the JAR.** The file must exist, be non-empty, and end in `.jar`. Its embedded Maven
   metadata (`META-INF/maven/<group>/<artifact>/pom.properties`) supplies the default asset ID and
   version. Missing, duplicated, mismatched, or ambiguous metadata is an error. Identity is never guessed
   from the file name, and the version never defaults to `1.0.0`. Supply `assetId` and `assetVersion`
   (CLI: `--asset-id`, `--asset-version`) to choose the coordinates explicitly.
2. **Bind the bytes.** The preview returns the JAR's SHA-256 as `expectedSha256`. Passing it back with
   `confirm: true` makes the upload fail if the file changed since the preview. The same digest is
   checked against the exact buffer that is uploaded.
3. **Publish.** The JAR goes to Exchange as a `mule-application` asset in the organization's group (or
   `groupId` / `--group-id`). The call returns only after Exchange reports the asset as published.
   Publishing a version that already exists may be rejected by Exchange.
4. **Deploy.** A new app is created; an existing app has only its artifact reference changed.

`deploy_jar` does all four in one confirmed call. `publish_app_jar` stops after step 3 and returns the
coordinates to use with `deploy_app` (new app) or `update_app_artifact` (existing app). Nothing is
uploaded by a preview.

Exchange calls the coordinate `assetId`; CloudHub 2.0 calls the same value `artifactId`. They are mapped
explicitly at the deploy boundary.

When a build tool has already verified the artifact, pass its artifact ID, version, and SHA-256 as
`assetId`, `assetVersion`, and `expectedSha256`. A successful build does not by itself authorize
publication or deployment; the preview and confirmation still apply.

## Rollback

`rollback_app` reverts to the newest historical artifact that differs from the current one, or to a
requested `toVersion`. It skips history entries that only changed lifecycle state, and like any redeploy
it changes the artifact reference only.

## Settings updates are narrow

`update_app_settings` PATCHes only the application-properties configuration. Existing plain properties
and protected-property placeholders are merged into the request, so a partial update cannot blank out
values it did not mention. Artifact coordinates, desired state, runtime, target, replicas, and other
configuration are left untouched. The update triggers a rolling restart. Start and stop change only the
desired state.

## Deletion is bound to a deployment ID

An application name is not a stable identifier: delete and recreate an app, and the name points at a
different deployment. So `delete_app` requires two calls:

1. Call it without `confirm`. You get the current deployment ID and a full preview.
2. Call it again with `confirm: true` and that exact `expectedDeploymentId`.

Production additionally requires `confirmProduction: true`. If the deployment changed between the two
calls, the ID no longer matches and the operation fails closed rather than deleting something nobody
looked at. The CLI follows the same flow with `anc apps delete`, `--confirm <deployment-id>`, and
`--allow-production`.

Deletion removes the deployment only. The Exchange artifact and unrelated Anypoint resources remain. Use
`stop_app` when the deployment configuration must stay available.

## Production detection

An environment is treated as production when the platform flags it as production or its name contains
`production` (or is `prod`). Classification drives the extra steps: production deploys, restarts, and
scales in the CLI require typing `deploy to production`, and production deletions require a separate
acknowledgement in both surfaces. Add `--force` in CI only when the operation is intended and reviewed.

## Design Center previews are token-bound

Design Center project creation, multi-file synchronization, and Exchange publication each come as a pair:
a `preview_*` tool and the write tool that consumes its token.

| Preview | Apply | What the token binds |
| --- | --- | --- |
| `preview_create_design_center_project` | `create_design_center_project` | Organization, exact project name, and classifier; the name collision is checked again on apply |
| `preview_sync_design_center_files` | `sync_design_center_files` | Project, branch, every file's content, and the remote content hashes seen at preview |
| `preview_publish_exchange_asset` | `publish_exchange_asset` | Project, branch, coordinates, classifier, main file, API version, and the main file's hash |

Tokens are opaque, process-local, single-use, and expire after ten minutes. A token issued by one server
process cannot be used by another.

File sync never deletes, moves, or renames content and refuses managed `exchange_modules` paths and unsafe
paths. Apply acquires one branch lock, rereads every target after locking, aborts the whole batch on any
hash conflict, saves all changed files in one request, and verifies the saved content.

Publication checks the main file again before publishing, publishes once, then downloads the Exchange
artifact and verifies its checksum. `anc dc push` and `anc dc publish` use the same workflow and show the
preview before asking for confirmation.

## Reading is safe; establishing readiness is safe

Nothing in the read path mutates. Confirming access with `whoami` and `list_environments` is safe at any
time, which is why it is the right first step rather than a data call that might fail for an unrelated
reason. See [Access readiness](readiness.md).

A readiness probe is never approval to deploy. Confirmed access means confirmed access, nothing more.

## What the safeguards do not cover

- **Scope.** If the authorizing user can deploy, the tool can deploy. Use a read-only Anypoint user when
  that is what you want; the confirmation steps guard against mistakes, not against permissions.
- **Correctness of the artifact.** A confirmed deploy of a broken JAR is a successful deploy.
- **Data you export.** Downloaded logs and metrics are production data once they are on your disk. Keep
  them out of repositories and remove identifiers before sharing.
