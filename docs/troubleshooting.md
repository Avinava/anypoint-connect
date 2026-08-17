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
| Commands hit the wrong organization | An exported `ANYPOINT_PROFILE` or environment variable outranks the profile you expected. `anc config show` reports the resolved source. See [Profiles](profiles.md) |

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
| Memory looks like a leak | A sawtooth is normal collection. A rising post-GC baseline is the signal; use `get_memory_timeseries` over a longer window |
| Metrics are empty but the app is running | Monitoring scope missing, or the window predates the deployment |

## Deployments

| Symptom | Cause and fix |
| --- | --- |
| Nothing happened when I deployed | The call was a dry run. Mutating tools require `confirm: true`; the CLI requires the typed confirmation or `--force`. See [Safety model](safety.md) |
| An infrastructure change was rejected | Redeploys of an existing app change the artifact only, by design. Use the scale or settings tools, or create a new deployment |
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
