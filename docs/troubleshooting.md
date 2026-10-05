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
| An error appears in the caller but not the dependency | Log level, handled errors, or retention — not proof the dependency is healthy. Widen the window or lower the level before concluding anything |
| Percentiles look implausible | Low request counts make percentiles unstable. Read them with the request count |
| Memory looks like a leak | A heap sawtooth is normal collection. Check `get_runtime_metrics` (`anc monitor runtime`): the old-generation peak against its limit, and old-generation GC count and time. Then chart `get_metrics_timeseries` with `signal: "memory"` at `1h` over several days; a baseline that keeps rising is the leak signal. See [Monitoring](monitoring.md#reading-memory) |
| Metrics are empty but the app is running | The query ran and found nothing: the window predates the deployment, the app name does not match exactly, the environment is wrong, or the app received no HTTP traffic. Widen the window or drop the app filter |
| A metrics call returns an error | The query did not run. The message is the platform's own: a syntax error or unknown attribute in raw AMQL, a 403 when the user lacks Monitoring access, or a timeout on a very large window. It is never reported as empty data. See [Monitoring](monitoring.md#empty-results-and-errors) |
| `oldGenPeakRatio` is `null` | The old-generation pool reports no limit (unbounded), or no old-generation pool was reported. Read `oldGenUsedPeak` and the `pools` list instead |

## Deployments

| Symptom | Cause and fix |
| --- | --- |
| An MCP deployment changed nothing | The call was a preview. MCP deployment tools require `confirm: true`. The CLI behaves differently: non-production deploys apply unless `--dry-run` is given, while production requires the typed confirmation or `--force`. See [Safety model](safety.md) |
| An infrastructure change was rejected | Redeploys of an existing app change the artifact only, by design: `anc deploy` rejects `--runtime`, `--replicas`, `--vcores`, and `--region`, and `deploy_jar` rejects the same settings, for an existing app. Use the scale or settings tools, or create a new deployment |
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
