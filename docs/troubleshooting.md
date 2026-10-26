# Troubleshooting

Start with `anc auth status`. Most problems are one of the six [access states](readiness.md), and the
error text names which one.

## Setup and authentication

| Symptom | Cause and fix |
| --- | --- |
| `Anypoint Connect is not configured` | No credentials for the active profile. Run `anc config init`, or export `ANYPOINT_CLIENT_ID` and `ANYPOINT_CLIENT_SECRET`. Logging in cannot help yet |
| `Not authenticated. Run: anc auth login` | Credentials exist, no usable token. Log in |
| `Token expired and no refresh token` | The stored session cannot be renewed. `anc auth login` again |
| `Token refresh failed` | The refresh token was revoked, or the Connected App changed. Log in again; if it recurs, check whether the app was rotated in Access Management |
| The browser never returns | The Connected App's redirect URI does not match `http://localhost:3000/api/callback`, or port 3000 is occupied |
| The callback says it could not be verified | The returned OAuth state did not match the login started by this CLI process. Close the tab and run `anc auth login` again; no code was accepted |
| Commands hit the wrong organization | An exported `ANYPOINT_PROFILE` or credential variable outranks the profile you expected. `anc config show` reports the active profile and how it was resolved; `env \| grep ANYPOINT_` shows overrides. See [Profiles](profiles.md) |

## Environments and permissions

| Symptom | Cause and fix |
| --- | --- |
| `Environment "X" not found. Available: …` | Misspelling, or you are in a different organization or business group. Compare against the printed list before assuming a permission problem |
| A 403 on one operation while others work | The Connected App lacks that scope. Grant it in Access Management and log in again |
| MQ or Object Store tools fail consistently | The subscription may not include the feature. Check `get_entitlements` — a 403 on an unprovisioned service is correct behavior |
| Audit log returns nothing | The `View Audit Logs` scope is optional and often ungranted. Grant it, or accept the gap |

## Logs and metrics

| Symptom | Cause and fix |
| --- | --- |
| Fewer log entries than expected | Retention is shorter than the requested window, or the level filter excluded them. Compare the requested window with the earliest returned timestamp before drawing conclusions |
| Log search right after a start or deploy finds nothing | Before 0.16, text on continuation lines (error `Message` and `Error type` lines, start-up banners, stack traces, logged payloads) was split into separate entries, lost under a level filter and pushed out by the line limit. That is fixed. Logs are also kept per deployment spec: right after a change, the new spec's file can be missing or empty while replicas start, so the tools read the last successful spec and say so in a notice. Retry after a few minutes for the new replicas' lines. To read the generation an update replaced, pass `previousSpecs` (CLI `--previous-specs`) |
| `download_logs` output is too large | Use `mode: "summary"` for counts by level, logger and hour; narrow with `search`, `level`, `logger` or a shorter window; or set `outputFile` to write everything to a file inside the project. Lines beyond `maxLines` (default 2000) are cut with a notice giving the total |
| `outputFile` or `writeCredentialsTo` refused | The path must be inside the project root (the git top level, or `ANYPOINT_CONNECT_PROJECT_ROOT`), and an existing file needs `overwrite` |
| An error appears in the caller but not the dependency | Log level, handled errors, or retention — not proof the dependency is healthy. Widen the window or lower the level before concluding anything |
| Percentiles look implausible | Low request counts make percentiles unstable. Read them with the request count |
| Memory looks like a leak | A heap sawtooth is normal collection. Check `get_runtime_metrics` (`anc monitor runtime`): the old-generation peak against its limit, and old-generation GC count and time. Then chart `get_metrics_timeseries` with `signal: "memory"` at `1h` over several days; a baseline that keeps rising is the leak signal. See [Monitoring](monitoring.md#reading-memory) |
| Metrics are empty but the app is running | The query ran and found nothing: the window predates the deployment, the app name does not match exactly, the environment is wrong, or the app received no HTTP traffic. Widen the window or drop the app filter |
| A metrics call returns an error | The query did not run. The message is the platform's own: a syntax error or unknown attribute in raw AMQL, a 403 when the user lacks Monitoring access, or a timeout on a very large window. It is never reported as empty data. See [Monitoring](monitoring.md#empty-results-and-errors) |
| `oldGenPeakRatio` is `null` | The old-generation pool reports no limit (unbounded), or no old-generation pool was reported. Read `oldGenUsedPeak` and the `pools` list instead |

## Deployments

| Symptom | Cause and fix |
| --- | --- |
| An MCP change did nothing | The call was a preview. Every MCP write requires `confirm: true`, and production also `confirmProduction: true`. The CLI behaves differently: non-production changes apply unless `--dry-run` is given, while production requires the typed confirmation or `--force`. See [Safety model](safety.md) |
| An infrastructure change was rejected | Region, vCores, replicas and JVM arguments apply only to a new app. Use `scale_app` for replicas. Runtime, settings and update strategy can change on an existing app through `update_app` or `anc apps update` |
| `Runtime Version not supported for this target` | The app's runtime has been retired on its target, so any new spec is rejected. `list_runtime_versions` (or `anc runtimes list --app <name>`) shows what the target offers and the nearest versions; pass one as `runtime` to `update_app` or `update_app_artifact`. Since 0.16 the preview refuses this up front |
| Status shows `FAILED` right after starting an app | The platform briefly reports `FAILED` while a stopped app starts. `get_app_status` reports the phase `STARTING` until the failure persists past a 90-second grace window; use `wait: true` to follow it |
| Events processed twice during a deploy | A rolling update runs old and new replicas together, and listener-driven apps (streaming, subscriptions, polling) process events in both. Use `mode: "stopStart"` (CLI `--stop-start`), or set `updateStrategy: "recreate"` |
| A settings change was refused with `already exists as a plain property` | The key is plain today. Use `moveToSecure` to move its current value, or `removeProperties` plus the new secure value |
| A secret appears in `get_app_settings` | It is stored as a plain property. The tool masks it by default and lists it under `warnings`; fix it with `update_app_settings` `moveToSecure` |
| `securePropertiesFrom` refused the file | The path must be inside the project root (the git top level of the server's working directory, or `ANYPOINT_CONNECT_PROJECT_ROOT`), be a regular file, and be under 1 MB |
| `Embedded Maven identity is unavailable` | The JAR has no single, consistent `pom.properties`. Supply both the asset ID and version (`--asset-id` and `--asset-version`, or `assetId` and `assetVersion`) |
| Publication refused after a preview | The JAR's SHA-256 no longer matches `expectedSha256`: the file was rebuilt. Preview again and review the new digest |
| A Design Center push or publish was aborted | Someone changed the file or branch after the preview, or the token expired (ten minutes) or was already used. Preview again |
| `anc dc push` says the terminal is not interactive | It needs a confirmation. Review the preview, then rerun with `--yes` |
| `delete_app` fails with a deployment-ID mismatch | The deployment changed between your dry run and your confirmation. Re-run the dry run and use the new ID; this is the guard working |
| A production deploy refuses to proceed | Production requires an explicit acknowledgement. Provide it deliberately, or deploy to a lower environment first |
| Deploy succeeded but the app is unhealthy | A confirmed deploy of a broken artifact is still a successful deploy. Check `get_app_status`, then `analyze_errors` |

## MCP

| Symptom | Cause and fix |
| --- | --- |
| The server does not appear in the host | Wrong file or wrapping key for that host, or the host was not restarted. See [MCP setup](mcp.md#setup-by-host) |
| First call seems to hang | `npx` is downloading the package on a cold start. Point at a global `anc` install to avoid it |
| Every tool fails with an auth error | The server has no session. Run `anc auth login` in a terminal; the agent cannot and should not do it for you |
| The agent used the wrong environment | Environment is a parameter, not a default. Name it in the request |
| Tools resolve the wrong profile | The working directory is not the project you think. Check `get_project_profile` |

For field-by-field Connected App setup, storage, rotation, allowlists, and the limitations of environment
variables, see [Connected App and credentials](credentials.md).
