# CloudHub 2.0 deployment tools — design notes

This note explains how the JAR-based deployment tooling works and why it is shaped the way it is.

## The problem it solves

CloudHub 2.0 deployments reference an artifact that already lives in Exchange. Before this tooling
there was no way to get a *locally built* JAR into Exchange from the MCP/CLI surface, and redeploying
an existing app was unsafe: the update path re-sent a fully defaulted deployment payload, so any field
the caller didn't specify was overwritten with a default — quietly downgrading the runtime and moving
the app out of its target/space.

## Publishing a JAR

The working upload path is the **Exchange v2 publication API**, not the Maven facade (which rejects
plain PUTs with `412`):

```
POST /exchange/api/v2/organizations/{org}/assets/{groupId}/{assetId}/{version}
Header: x-sync-publication: true
Multipart body:
  name        = <assetId>
  classifier  = mule-application
  files.mule-application.jar = @<jar>
```

`x-sync-publication` makes the call return only once the asset is fully published. Uploads use a
longer timeout than normal API calls (JARs are tens of MB). This is implemented in
`ExchangeApi.publishAppAsset`, backed by `HttpClient.postMultipart` (native `FormData`; the default
JSON content-type is cleared so the multipart boundary is set correctly).

## Deploying and the safety model

- **New app** → build a full create payload (runtime, target, replicas, vCores, public URL) from
  `src/safety/deployment.ts:buildCreatePayload`.
- **Existing app** → PATCH **only** `application.ref` via `CloudHub2Api.updateArtifactRef`. Runtime,
  target/space, replicas, resources, and settings are preserved by the server. This is the invariant
  that prevents accidental downgrades/relocations, and it is enforced by a regression test.

Both the MCP tools and the CLI `deploy` command call the same shared builder/merge helpers, so the
two surfaces cannot drift.

### Dry-run + confirm

MCP runs over stdio, where there is no interactive confirmation prompt. Instead, every mutating deploy
tool is **dry-run by default**: without `confirm: true` it returns a preview of exactly what would
change and does nothing. Re-calling with `confirm: true` applies. `deploy_jar`'s preview publishes
nothing either — publish happens only on confirm.

## Tools

| Tool | Kind | Purpose |
|------|------|---------|
| `get_deployment_spec` | read | Full current spec — the look-before-you-leap view |
| `publish_app_jar` | write | Upload a built JAR to Exchange |
| `update_app_artifact` | write | Safe redeploy — artifact ref only, optional wait |
| `rollback_app` | write | Revert to a previous version (last good by default) |
| `deploy_jar` | write | Publish + create-or-update in one call |
| `deploy_app` | write | Create new, or safe artifact-only redeploy of an existing app |

## Conventions & open points

- **Asset ID default:** the JAR filename without its `.jar` extension. Callers can override `assetId`.
- **`assetId` vs `artifactId`:** Exchange calls the coordinate `assetId`; CloudHub calls it
  `artifactId`. They carry the same value here and are mapped explicitly at the deploy boundary.
- **vCores:** written to `application.vCores` (the field CloudHub 2.0 surfaces and this tooling reads
  back in status), validated against the allowed size set.
