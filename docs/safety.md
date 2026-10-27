# Safety model

This toolkit can publish artifacts, redeploy applications, and delete a production deployment. The
safeguards below exist because a scripted call, a copy-pasted command, and a tired engineer all make the
same class of mistake: acting on something other than what they inspected.

The guards live in shared code (`src/safety/` and `src/workflows/`), so the CLI and the MCP server apply
the same rules. Direct library calls do not pass through them; see the [library guide](library.md).

## How each kind of change is guarded

| Kind of change | MCP | CLI |
| --- | --- | --- |
| Publish a JAR; create, update, redeploy or roll back an app; change runtime, settings or update strategy; restart, scale, stop, start | Preview unless `confirm: true`; production also needs `confirmProduction: true` (`publish_app_jar`, `deploy_jar`, `deploy_app`, `update_app`, `update_app_artifact`, `rollback_app`, `update_app_settings`, `restart_app`, `scale_app`, `stop_app`, `start_app`) | `anc deploy`, `anc apps update`, `anc apps settings set` and `anc apps restart` print the plan; `--dry-run` stops there; production asks for a typed phrase unless `--force` |
| Delete a deployment | Preview, then `confirm: true` plus the exact `expectedDeploymentId`; production also needs `confirmProduction: true` (`delete_app`) | `anc apps delete` is a dry run until `--confirm <deployment-id>`; production also needs `--allow-production` |
| Design Center project creation, file sync, Exchange publication | A `preview_*` tool returns a single-use token; the paired write tool consumes it | `anc dc push` and `anc dc publish` preview, then ask; `--yes` skips the question |
| API smoke test with a method other than GET, HEAD or OPTIONS | Preview unless `confirm: true`; production also needs `confirmProduction: true` (`smoke_test_api`) | `anc api smoke` asks unless `--yes`; production needs `--allow-production` |
| Object Store writes, MQ publish, project-profile binding | Applied on call (`put_store_value`, `delete_store_value`, `publish_mq_message`, `set_project_profile` with `profile` only) | — |
| Production pre-approval, unmarked-artifact allowance | `set_production_preapproval` and `set_unmarked_artifact_allowance` preview unless `confirm: true`; stored only in the user-level `~/.anypoint-connect/production-approvals.json` | Same file |
| Local files: `download_logs` `outputFile`, `get_client_application` `writeCredentialsTo` | Written only inside the project root; an existing file needs `overwrite` | Same rule for `anc api client-app --write-credentials` |
| Everything else | Read-only | Read-only |

The [tool catalog](tools.md) marks every tool as read or write. Grant a read-only Anypoint identity when
no change should be possible at all.

## Preview by default, and a second flag for production

Every tool that changes an application returns a preview when called without `confirm: true`, and changes
nothing. The preview lists each field that would change, the settings diff by key, the runtime check, the
ordered steps, and any warnings or blockers. Applying requires a second call. In a production environment
the second call also needs `confirmProduction: true`; without it the call is refused and nothing changes.

```jsonc
// preview: shows the change, modifies nothing
update_app({ "appName": "orders-sapi", "environment": "Sandbox", "version": "1.3.0" })

// apply
update_app({ "appName": "orders-sapi", "environment": "Sandbox", "version": "1.3.0", "confirm": true })

// production needs both flags
update_app({ "appName": "orders-sapi", "environment": "Production", "version": "1.3.0", "confirm": true, "confirmProduction": true })
```

MCP runs over stdio, where there is no interactive prompt, so the second call is the confirmation. The
CLI uses a typed confirmation for production instead, and `--force` for reviewed, unattended use.

## Changes to an existing app are one explicit update

For an existing application, `anc deploy`, `anc apps update`, `deploy_jar`, `deploy_app`, `update_app`,
`update_app_artifact`, `update_app_settings` and `rollback_app` all build one plan and send one PATCH. It
carries only what you asked to change: the artifact reference, the runtime, the application properties,
the update strategy. The platform therefore creates one new spec, not one per field.

- **Nothing else moves.** The target and private space, replica count, vCores, JVM arguments and
  untouched settings stay as they are on the server. When the runtime or update strategy changes, the live
  target settings are restated exactly as read, with only those two fields changed.
- **Create-only settings are refused.** Region, vCores, replicas and JVM arguments apply only to a new
  app. They are refused when the application already exists, instead of being silently ignored. Use
  `scale_app` to change replicas.

### Runtime checks before any write

A runtime change is checked against the Mule versions the app's target offers (`list_runtime_versions`).
A version the target does not offer is refused in the preview, with the nearest supported versions. If the
app's current runtime has been retired, any change that creates a new spec would be rejected by the
platform with `Runtime Version not supported`, so the preview refuses it up front and names a version to
pass as `runtime`. When the runtime catalog cannot be read, the preview says so and the change is not
blocked.

### In place, or stop then start

`mode: "inPlace"` (the default) applies the change with the app's update strategy. With the usual
`rolling` strategy, old and new replicas run side by side for a short time. For an app with streaming,
subscription or polling listeners, that means both generations process the same events.

`mode: "stopStart"` (CLI: `--stop-start`) avoids the overlap:

1. Stop the app and wait until every replica is down.
2. Apply the change and start the app, in one update.
3. Wait until every replica runs the new spec.

If the stop does not complete, nothing is applied. If a later step fails after the stop, the error says
the app is still stopped. `updateStrategy: "recreate"` sets the platform strategy that replaces replicas
instead of overlapping them, and it persists for later deployments.

Measured on a CloudHub 2.0 shared region with one and two replicas, as the gap between the old
generation's last log line and the new generation's first:

| Rollout | Gap |
| --- | --- |
| Rolling | old and new overlap, about 7 s with one replica and 32 s with two |
| `recreate` | no overlap, about 110 s without either generation running |
| `stopStart` | no overlap, about 57 s without either generation running |

Both avoid overlap. `stopStart` has the shorter outage and needs nothing persisted; `recreate` also
covers changes made outside this tool. Scaling up under a rolling strategy can replace the existing
replica too, with a short overlap.

`restart_app` and `anc apps restart` are a stop-then-start with no other change. Expect a short outage.

### Waiting and status

A stopped app that is starting briefly reports `FAILED` before it reports `APPLYING`. The status tools and
every wait read deployment, application and replica state together. They report a phase: `RUNNING`,
`STARTING`, `UPDATING`, `DEGRADED`, `FAILED`, `STOPPING` or `STOPPED`.

- **`FAILED` is confirmed, not transient.** It is reported only when the failure persists past a 90-second
  start-up grace window, with the replica's reason when one is given.
- **A wait ends on the new spec.** A wait finishes when every replica runs the new spec, or the change
  fails, or the timeout passes. A status left over from the previous spec never counts as done.
- **Following a change.** `update_app` waits by default. The other tools take `wait: true`, and
  `get_app_status` takes `wait: true` to follow a change made elsewhere.

New applications get a full create payload from one builder, with the defaults in one place (runtime
4.8.0, region `cloudhub-us-east-2`, 0.1 vCores, one replica unless specified). vCores are validated
against the allowed sizes.

## Publishing a JAR

`anc deploy`, `deploy_jar`, and `publish_app_jar` share one workflow:

1. **Inspect the JAR and choose coordinates.** The file must exist, be non-empty, and end in `.jar`. The
   coordinates come from, in order:
   1. explicit `assetId` and `assetVersion` (CLI: `--asset-id`, `--asset-version`);
   2. the project's naming convention in `.anypoint-connect.json` (see [Profiles](profiles.md#naming-conventions));
   3. the JAR's embedded Maven metadata (`META-INF/maven/<group>/<artifact>/pom.properties`).

   The preview says which rule chose each value. Missing, duplicated, mismatched, or ambiguous metadata
   is an error. Identity is never guessed from the file name, and the version is only fixed (for example
   `1.0.0`) when a convention says so. The pattern of the asset the app runs today is detected and
   reported in the preview and by `suggest_asset_name`, but it is never applied by itself.
2. **Bind the bytes.** The preview returns the JAR's SHA-256 as `expectedSha256`. Passing it back with
   `confirm: true` makes the upload fail if the file changed since the preview. The same digest is
   checked against the exact buffer that is uploaded.
3. **Publish.** The JAR goes to Exchange as a `mule-application` asset in the organization's group (or
   `groupId` / `--group-id`). The call returns only after Exchange reports the asset as published.
   Publishing a version that already exists may be rejected by Exchange.
4. **Deploy.** A new app is created. An existing app gets one update with the new artifact plus any
   runtime or settings change you asked for. The runtime check runs before step 3, so a refused change
   publishes nothing.

`deploy_jar` does all four in one confirmed call. `publish_app_jar` stops after step 3 and returns the
coordinates to use with `deploy_app` (new app) or `update_app_artifact` (existing app). Nothing is
uploaded by a preview.

### Build markers gate production

mule-build 3.2.0 and later write `META-INF/mule-build/build-info.json` into every jar:

```json
{ "schemaVersion": 1, "tool": "mule-build", "toolVersion": "3.2.0", "stripped": false, "productionDeployable": true }
```

Which bytes are checked:

- **`deploy_jar`, `anc deploy`**: the local jar, which is then published bound to its SHA-256.
- **`deploy_app`, `update_app`, `update_app_artifact`, `rollback_app`, `anc apps update`**: for a
  production target, the artifact the change selects is downloaded from Exchange and its own marker is
  checked, whether or not a local jar is given. A download failure or an Exchange MD5 mismatch refuses
  the change.
- **`jarPath`** (CLI: `--jar`) on those tools binds the change to a local jar: its SHA-256 must equal the
  Exchange artifact's, in any environment, or the change is refused.
- **`publish_app_jar`**: the local jar, against `environment` when given; without it, only warnings.

Previews report `buildProvenance`, `artifactVerification` (`checked`, `ref`, `exchangeSha256`,
`localSha256`) and, for production, `provenancePolicy` (`unmarkedAllowed`, `source`, `expires`).

| Marker | Production target | Other target |
| --- | --- | --- |
| `schemaVersion` 1, `tool` `mule-build`, `stripped: false`, `productionDeployable: true` | allowed | allowed |
| `stripped: true`, `productionDeployable: false` | refused, no override | allowed, with a warning |
| another schema version or tool, `productionDeployable` not equal to `!stripped`, unreadable, incomplete | refused, no override | allowed, with a warning |
| absent (older builds, other pipelines) | refused as "build provenance unknown", unless an unmarked-artifact allowance covers the organization and environment | allowed, with a note |

Neither a pre-approval nor an allowance waives a refusal of a marked or invalid jar.

**Unmarked-artifact allowance.** For artifacts built by another pipeline, allow unmarked jars for one
organization and environment with `set_unmarked_artifact_allowance` (`environment`, `expires?`,
`thisProjectOnly?`, `clear?`, `confirm?`). It is stored in the same user-level file, under
`unmarkedArtifactAllowances`, with the same fields as a pre-approval except `tools`.

Changes made outside these tools, and direct library calls, are not checked.

Exchange calls the coordinate `assetId`; CloudHub 2.0 calls the same value `artifactId`. They are mapped
explicitly at the deploy boundary.

When a build tool has already verified the artifact, pass its artifact ID, version, and SHA-256 as
`assetId`, `assetVersion`, and `expectedSha256`. A successful build does not by itself authorize
publication or deployment; the preview and confirmation still apply.

## Rollback

`rollback_app` reverts to the newest historical artifact that differs from the current one, or to a
requested `toVersion`. It skips history entries that only changed lifecycle state. It changes the artifact
reference only, and accepts `mode: "stopStart"`.

## Settings and secrets

`update_app_settings` (and the settings inputs of `update_app`, `deploy_jar` and `deploy_app`) can add,
change, remove and move properties. Everything not mentioned is kept.

**Stored secrets are kept.** The platform stores secure property values encrypted and returns them masked
as `******`. Sending a key back as `******` keeps its stored value. Every change therefore resends the
untouched secure keys masked, which is how one secret can be added or rotated without wiping the others.
Sending `******` for a key that does not exist is refused.

**Removal works.** The platform replaces the property maps as a whole, so the tool sends the complete maps.
A key listed in `removeProperties` or `removeSecureProperties` is simply left out.

**Secret values never travel in the conversation.** Pass them by reference, as `securePropertiesFrom`
(CLI: `--secure-from-file`, `--secure-from-env`):

```jsonc
update_app_settings({
  "appName": "orders-sapi",
  "environment": "Sandbox",
  "securePropertiesFrom": [
    { "file": "config/sandbox.env", "keys": ["DB_PASSWORD"], "rename": { "DB_PASSWORD": "db.password" } },
    { "env": { "crm.client.secret": "CRM_CLIENT_SECRET" } }
  ]
})
```

The rules for a referenced source:

- **Where it is read.** The server reads the value. A file can be `.env`, `.properties` or a flat JSON
  object, and must sit inside the project root. That is the git top level of the server's working
  directory, or `ANYPOINT_CONNECT_PROJECT_ROOT` when set. Symlinks that leave the root are refused, and
  files are limited to 1 MB.
- **What errors show.** Errors name files and keys, never values.
- **What responses show.** Previews and results list secure keys only. Plain values are shown, except for
  keys that look like secrets (password, secret, token, key, credential), which are masked.
- **Scrubbing.** Every value read from a source, or given inline as a secure property, is scrubbed from
  previews, results and error messages. The CLI never takes a secure value as an argument, so it cannot
  end up in shell history.

**`moveToSecure` turns a plain property into a secure one** without the value leaving the server: the
current value is copied into the secure map and removed from the plain map in the same update. The app
keeps reading it as `${key}`. A platform secure property is a regular property to the application.
`${secure::key}` is for values encrypted in the application's own secure properties file, not for
these.

**`get_app_settings` flags secrets stored as plain text.** It masks secret-looking plain values by default
(`redact: false` shows them) and lists each one under `warnings` with the fix. It never returns secure
values.

**Applying a settings change restarts the app.** Use `mode: "stopStart"` for apps with streaming or
polling listeners.

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
`production` (or is `prod`). Classification drives the extra steps:

- **MCP:** every write in production needs `confirmProduction: true` in addition to `confirm: true`,
  unless a [pre-approval](#production-pre-approval) covers it.
- **Artifacts:** production takes only jars whose build marker says production deployable; see
  [Build markers gate production](#build-markers-gate-production).
- **CLI:** deploys, updates, settings changes, restarts, stops, starts and scales in production require
  typing `deploy to production`.
- **Deletions:** production deletions require a separate acknowledgement in both surfaces.

Add `--force` in CI only when the operation is intended and reviewed.

### Production pre-approval

You can approve production writes ahead of time. Approvals live only in the user-level store
`~/.anypoint-connect/production-approvals.json` (mode 0600), outside every repository, so a branch cannot
plant or widen one. Each entry is bound to a resolved organization ID and environment ID:

```json
{
  "productionPreapprovals": [
    {
      "orgId": "<organization id>",
      "environmentId": "<environment id>",
      "environmentName": "Production",
      "tools": ["update_app", "deploy_jar"],
      "expires": "2026-12-31T00:00:00Z",
      "projectPath": "/path/to/repo"
    }
  ]
}
```

- **`orgId`, `environmentId`**: matched exactly. Wildcards are refused. Another organization (other
  credentials or profile) never matches, so approvals do not carry across organizations.
- **`environmentName`**: display only; never matched.
- **`tools`**: MCP tool names, or `"all-mutating"`. Pre-approvable: `deploy_jar`, `deploy_app`,
  `update_app`, `update_app_artifact`, `rollback_app`, `update_app_settings`, `restart_app`, `scale_app`,
  `stop_app`, `start_app`, `smoke_test_api`, `delete_app`. `"all-mutating"` covers all of them except
  `delete_app`, which is covered only when named.
- **`expires`**: optional ISO 8601 date-time. From then on the entry is ignored.
- **`projectPath`**: optional project root; the entry then applies only to tools run in that project.

Write entries with `set_production_preapproval` (`environment`, `tools`, `expires?`, `thisProjectOnly?`,
`clear?`, `confirm?`). It resolves the environment to its IDs, refuses a non-production environment, and
previews until `confirm: true`. A `productionPreapproval` found in a project's `.anypoint-connect.json` is
ignored; `get_project_profile`, `whoami` and production previews report it as `ignoredProjectApproval` /
`preapprovalWarning`.

When an entry covers the organization, the environment and the tool, `confirmProduction: true` is not
required, and the CLI skips the typed phrase (or `--allow-production` for `anc apps delete`, which needs
`delete_app` named, and `anc api smoke`). The CLI matches its commands to the same names: `anc deploy` is
`deploy_jar`, `anc apps update` is `update_app`, `anc apps settings set` is `update_app_settings`,
`anc apps restart`, `stop`, `start` and `scale` are `restart_app`, `stop_app`, `start_app` and
`scale_app`, `anc apps delete` is `delete_app`, and `anc api smoke` is `smoke_test_api`.

Nothing else changes. Previews are still the default, `confirm: true` is still required, `expectedSha256`
and `expectedDeploymentId` are still checked, and build-marker refusals still apply. Production previews
and results carry `production: true`, `productionPreapproved` and, when it applied, `preapprovalSource` and
`preapprovalExpires`. `get_project_profile` and `whoami` show the entries.

## Secrets in output

- **API errors.** Error bodies the platform echoes back have secret-looking fields masked.
- **Client applications.** `get_client_application` shows a client secret as `******` plus its last four
  characters. `writeCredentialsTo` writes the full pair to a mode-0600 `.env` file inside the project
  root. That file can then feed `securePropertiesFrom` or your own scripts.
- **Smoke tests.** `smoke_test_api` resolves the client credentials on the server, sends them only over
  HTTPS or to the API's own endpoint, does not follow redirects, and scrubs them from its result and
  errors.

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
  them out of repositories and remove identifiers before sharing. `scan_logs_for_credentials` (CLI:
  `anc logs credentials`) counts lines that carry session or bearer credentials before you share, without
  returning the lines.
