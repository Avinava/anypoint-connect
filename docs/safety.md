# Safety model

This tool can delete a production deployment. The safeguards below exist because an AI agent, a
copy-pasted command, and a tired engineer all make the same class of mistake: acting on something other
than what they inspected.

## Dry run by default

Every mutating MCP tool returns a preview when called without `confirm: true`, and changes nothing. The
preview describes exactly what would happen — current version, target version, replica counts, the
environment. Applying requires a second call.

```jsonc
// preview: shows the change, modifies nothing
update_app_artifact({ "appName": "example-api", "environment": "Production", "version": "1.0.0" })

// apply
update_app_artifact({ "appName": "example-api", "environment": "Production", "version": "1.0.0", "confirm": true })
```

The CLI equivalent is a typed confirmation for production operations, and `--force` for unattended use.
An agent asking to mutate something has to say so twice; a pipeline says so once, explicitly.

## Redeploys change the artifact and nothing else

For an existing application, `deploy_jar`, `deploy_app`, and `update_app_artifact` all PATCH only the
artifact reference. Runtime version, target and private space, replica count, vCores, and application
settings are preserved and re-sent as they were.

That is a deliberate constraint, not an implementation detail. It means a redeploy cannot silently
downgrade a runtime, move an app to another space, or reset replica count to a default — the failure mode
where a routine version bump quietly halves capacity. Infrastructure changes on an existing app are
rejected; create a new deployment or use the dedicated scale and settings tools.

## Settings updates are narrow

`update_app_settings` PATCHes only the application-properties configuration. Existing plain properties
and protected-property placeholders are merged into the request, so a partial update cannot blank out
values it did not mention. Artifact coordinates, desired state, runtime, target, replicas, and other
configuration services are left untouched.

## Deletion is bound to a deployment ID

An application name is not a stable identifier: delete and recreate an app, and the name points at a
different deployment. So `delete_app` requires two calls:

1. Call it without `confirm`. You get the current deployment ID and a full preview.
2. Call it again with `confirm: true` and that exact `expectedDeploymentId`.

Production additionally requires `confirmProduction: true`. If the deployment changed between the two
calls, the ID no longer matches and the operation fails closed rather than deleting something nobody
looked at.

Deletion removes the deployment only. The Exchange artifact and unrelated Anypoint resources survive. When
the deployment configuration must remain available, use `stop_app` instead.

## Production detection

Environment classification drives the extra prompts: production deploys require typing a confirmation
phrase, production deletes require a separate acknowledgement, and production restarts and scales prompt
before acting. Add `--force` in CI when the operation is intended and reviewed.

## Reading is safe; establishing readiness is safe

Nothing in the read path mutates. Confirming access with `whoami` and `list_environments` is safe to run
at any time, which is why it is the right first step rather than a data call that might fail for an
unrelated reason. See [Access readiness](readiness.md).

A readiness probe is never approval to deploy. An agent that has confirmed access has confirmed access,
nothing more.

## Design Center previews are hash-bound

Design Center creation, multi-file synchronization, and Exchange publication use opaque, process-local
preview tokens. Each token expires after ten minutes, can be consumed once, and binds the exact
organization, project, branch, inputs, and hashes that were inspected.

File sync never deletes, moves, or renames content and refuses managed `exchange_modules` paths. Apply
acquires one branch lock, rereads every target after locking, aborts the whole batch on any hash conflict,
saves all changed files in one request, and verifies the saved content. Publication has a separate preview
and checks the main source again before publishing, then downloads the Exchange artifact and verifies its
published checksum.

The older one-file update and direct publication tools remain for compatibility. New automated workflows
should use the token-bound tools.

## What the safeguards do not cover

- **Scope.** If the Connected App can deploy, the tool can deploy. Grant a read-only identity when that is
  what you want; the confirmation prompts are a guard against mistakes, not a substitute for permissions.
- **Correctness of the artifact.** A confirmed deploy of a broken JAR is a successful deploy.
- **Data you export.** Downloaded logs and metrics are production data once they are on your disk. Keep
  them out of repositories and redact identifiers before sharing.
