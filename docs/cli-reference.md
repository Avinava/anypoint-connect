# CLI reference

The binary is `anc`. Run `anc <command> --help` for the same information on the terminal.

Authentication and configuration commands accept `-p, --profile <name>`. Operational commands resolve
the profile from `ANYPOINT_PROFILE`, a project binding (`.anypoint-connect.json`), or `default`, as
described in [Profiles](profiles.md). Environments are accepted by name or ID.

Times (`--from`, `--to`) accept a relative duration ending now (`30m`, `6h`, `7d`) or an ISO 8601
timestamp (`2026-02-01T00:00:00Z`).

## Command summary

| Command | Purpose |
| --- | --- |
| `anc config init \| show \| set \| path \| profiles \| use` | Credentials, profiles, and project binding |
| `anc auth login \| logout \| status` | Browser authorization and session state |
| `anc apps list \| status \| update \| settings get\|set \| restart \| stop \| start \| scale \| compare \| delete` | CloudHub 2.0 applications |
| `anc deploy <jar>` | Publish a JAR to Exchange and deploy it |
| `anc runtimes list` | Mule runtime versions a target accepts |
| `anc logs tail \| search \| download \| credentials` | Application logs |
| `anc monitor summary \| runtime \| trend \| query \| download` | Anypoint Monitoring metrics |
| `anc alerts list \| get \| create \| update \| enable \| disable \| delete` | Anypoint Monitoring alerts; see [Alerts](alerts.md) |
| `anc exchange search \| info \| download-spec` | Exchange assets |
| `anc api list \| policies \| sla-tiers \| alerts \| contracts \| client-app \| smoke` | API Manager |
| `anc design-center` (alias `anc dc`) `list \| files \| pull \| push \| publish` | Design Center |
| `anc mcp` | Start the MCP server over stdio |

## config

| Command | Arguments and options |
| --- | --- |
| `anc config init` | Interactive setup of Client ID, Client Secret (masked), callback URL, base URL, default environment. `-p, --profile <name>` |
| `anc config show` | Saved configuration with the secret masked, and how the profile was resolved. `-p, --profile <name>` |
| `anc config set <key> <value>` | Set one value. Keys: `clientId`, `clientSecret`, `callbackUrl`, `baseUrl`, `defaultEnv`. `-p, --profile <name>` |
| `anc config path` | Print the configuration directory. `-p, --profile <name>` |
| `anc config profiles` | List configured profiles |
| `anc config use <profile>` | Bind the current directory to a profile (writes `.anypoint-connect.json`) |

```bash
anc config init
anc config init --profile org-a
anc config show
anc config set defaultEnv Sandbox
anc config use org-a
```

Enter the Client Secret through `anc config init`, not `anc config set`, so it stays out of shell history.

## auth

| Command | Options |
| --- | --- |
| `anc auth login` | Opens the browser and stores encrypted tokens. `-p, --profile <name>` |
| `anc auth status` | Shows authentication state, token expiry, and whether it can refresh. `-p, --profile <name>` |
| `anc auth logout` | Clears stored tokens; keeps the Client ID and Secret. `-p, --profile <name>` |

## apps

| Command | Arguments and options |
| --- | --- |
| `anc apps list` | `-e, --env <name>` (required) |
| `anc apps status <appName>` | `-e, --env <name>` (required), `--wait` polls until the app settles or fails, `--timeout <seconds>` |
| `anc apps update <appName>` | `-e, --env <name>` (required), `--version`, `--artifact-id`, `--group-id`, `--jar <path>` (the change is refused unless this jar's SHA-256 equals the Exchange artifact being deployed; production changes always check the Exchange artifact's build marker), runtime flags, settings flags, rollout flags, `--dry-run`, `--force` |
| `anc apps settings get <appName>` | `-e, --env <name>` (required), `--reveal` shows secret-looking plain values |
| `anc apps settings set <appName>` | `-e, --env <name>` (required), settings flags, `--stop-start`, `--no-wait`, `--timeout`, `--dry-run`, `--force` |
| `anc apps restart <appName>` | `-e, --env <name>` (required); stops, waits, starts. `--no-wait`, `--timeout`, `--dry-run`, `--force` |
| `anc apps stop <appName>` / `anc apps start <appName>` | `-e, --env <name>` (required), `--wait`, `--timeout`, `--force` |
| `anc apps scale <appName>` | `-e, --env <name>` (required), `--replicas <n>` (required), `--force` |
| `anc apps compare <appName>` | `-e, --env <name>` (required), `--repo <path>` with `--ref <ref>` (default `HEAD`) and `--working-tree`, or `--jar <path>`. Exits 1 when they differ |
| `anc apps delete <appName>` | `-e, --env <name>` (required), `--confirm <deploymentId>`, `--allow-production` (not needed when a [pre-approval](safety.md#production-pre-approval) names `delete_app`) |

Shared flags:

| Group | Flags |
| --- | --- |
| Runtime | `-r, --runtime <version>` (e.g. `4.9.0`, or `4.9` for the newest patch), `--java <version>`, `--release-channel <channel>` |
| Settings | `--set key=value`, `--from-file <path[:keys]>`, `--secure-from-file <path[:keys]>`, `--secure-from-env property=ENV_VAR`, `--remove <key>`, `--remove-secure <key>`, `--move-to-secure <key>`; each repeatable. Secure values come only from files or environment variables |
| Rollout | `--stop-start` (stop, apply, start), `--update-strategy rolling\|recreate`, `--no-wait`, `--timeout <seconds>` |

```bash
anc apps list --env Sandbox
anc apps status orders-sapi --env Sandbox --wait
anc apps update orders-sapi --env Sandbox --version 1.4.0 --stop-start --dry-run
anc apps settings set orders-sapi --env Sandbox --secure-from-file config/sandbox.env:CRM_CLIENT_SECRET --dry-run
anc apps settings set orders-sapi --env Sandbox --move-to-secure db.password
anc apps restart orders-sapi --env Production            # asks for confirmation
anc apps scale orders-sapi --env Sandbox --replicas 2
anc apps compare orders-sapi --env Production --repo . --ref main --working-tree
```

Every change prints its plan first: changed fields, the settings diff by key (secure values never shown),
the runtime check and the steps. Commands that roll out a change wait for it by default and exit non-zero
when it does not settle.

## runtimes

| Command | Options |
| --- | --- |
| `anc runtimes list` | `-e, --env <name>` (required), `-a, --app <name>` uses the app's target and checks its current runtime, `--target <id>` |

```bash
anc runtimes list -e Sandbox --app orders-sapi
```

Deletion is a bound two-step operation, because an app name is not a stable identifier for what you
inspected:

```bash
anc apps delete sample-orders-api --env Sandbox                       # dry run; prints the deployment ID
anc apps delete sample-orders-api --env Sandbox --confirm <deployment-id>
anc apps delete sample-orders-api --env Production --confirm <deployment-id> --allow-production
```

If the deployment was recreated between the two calls, the ID no longer matches and nothing is deleted.

## deploy

```text
anc deploy <jarPath> --app <name> --env <name> [options]
```

Publishes the JAR to Exchange, then creates the deployment, or for an existing app applies the new
artifact, plus any runtime or settings change, as one update. The asset ID and version come from
`--asset-id`/`--asset-version`, then the project's [naming convention](profiles.md#naming-conventions),
then the JAR's embedded Maven metadata, never from the file name.

| Option | Meaning |
| --- | --- |
| `-a, --app <name>` | Application name (required) |
| `-e, --env <name>` | Target environment (required) |
| `--asset-id <id>` | Exchange asset ID; default is the naming convention, else the embedded Maven `artifactId` |
| `--asset-version <v>` | Exchange asset version; default is the naming convention, else the embedded Maven `version` |
| `--group-id <id>` | Exchange group ID; default is the organization ID |
| `-r, --runtime <version>`, `--java`, `--release-channel` | Runtime for a new app (default 4.8.0), or the runtime to move an existing app to |
| `--replicas <n>` | New app only. Replica count (default 1) |
| `--vcores <size>` | New app only. One of 0.1, 0.2, 0.5, 1, 1.5, 2, 2.5, 3, 4 (default 0.1) |
| `--region <target>` | New app only. CloudHub 2.0 target (default `cloudhub-us-east-2`) |
| Settings flags | As for `anc apps update` |
| `--stop-start`, `--update-strategy`, `--no-wait`, `--timeout` | As for `anc apps update` |
| `--dry-run` | Print the plan (coordinates and how they were chosen, SHA-256, the change) and stop |
| `--force` | Skip the production confirmation |

```bash
# see what would happen
anc deploy target/sample-orders-api-1.3.0-mule-application.jar \
  --app sample-orders-api --env Sandbox --dry-run

# create a new app with explicit infrastructure
anc deploy target/sample-orders-api-1.3.0-mule-application.jar \
  --app sample-orders-api --env Sandbox --runtime 4.8.0 --replicas 2 --vcores 0.2

# production: prints the summary, then asks you to type "deploy to production"
anc deploy target/sample-orders-api-1.3.0-mule-application.jar --app sample-orders-api --env Production
```

The new-app-only flags are rejected when the application already exists; use `anc apps scale` instead.
Without `--dry-run`, a non-production deploy is applied immediately after the summary. The command waits
for the rollout and exits non-zero when it fails or times out. See the
[safety model](safety.md#publishing-a-jar).

## logs

| Command | Arguments and options |
| --- | --- |
| `anc logs tail <appName>` | `-e, --env <name>` (required), `-l, --level <level>` (ERROR, WARN, INFO, DEBUG), `-s, --search <text>`, `--regex`, `--logger <name>` |
| `anc logs search <appName>` | `-e, --env <name>` (required), `-g, --grep <text>`, `--regex`, `--logger <name>`, `-l, --level <level>`, `--since <1h\|ISO>`, `--until <date>`, `-n, --limit <n>` (default 100, max 1000), `--previous-specs <n>` (max 10), `--json` |
| `anc logs download <appName>` | `-e, --env <name>` (required), `--from <date>` (required), `--to <date>`, `-l, --level <level>`, `-g, --grep <text>`, `--regex`, `--logger <name>`, `--summary`, `--bucket 5m\|15m\|1h`, `-o, --output <path>`, `--previous-specs <n>` (max 10) |
| `anc logs credentials <appName>` | `-e, --env <name>` (required), `--since <1h\|ISO>`, `--until <date>`, `--previous-specs <n>` (max 10), `--json`. Counts lines with session or bearer credential markers per marker, spec and replica; never prints lines or values. Exit code 2 when any marker is found |

Search covers the message, logger, thread, event ID, stack trace and logged payload. Multi-line entries
(error reports, banners, stack traces) stay together with their timestamp and level.

```bash
anc logs tail orders-sapi --env Sandbox --level ERROR --search "TimeoutException"
anc logs search orders-sapi --env Sandbox --grep "timeout" --since 2h
anc logs download orders-sapi --env Sandbox --from 48h --summary
anc logs download orders-sapi --env Production \
  --from "2026-02-01T00:00:00Z" --to "2026-02-02T00:00:00Z" --output orders.log
```

Downloaded logs are production data; keep them out of repositories.

## monitor

| Command | Arguments and options |
| --- | --- |
| `anc monitor summary` | `-e, --env <name>` (omit to compare every environment), `-a, --app <name>`, `--by app\|worker\|route` (default `app`), `--from`, `--to` |
| `anc monitor runtime` | `-e, --env <name>` (required), `-a, --app <name>`, `--from`, `--to` |
| `anc monitor trend` | `-e, --env <name>` (required), `-s, --signal traffic\|latency\|memory\|cpu\|gc` (default `traffic`), `-a, --app <name>`, `-g, --granularity 1m\|5m\|15m\|30m\|1h\|1d` (default `1h`), `--from`, `--to` |
| `anc monitor query <amql>` | `--limit <n>` (default 200, maximum 2000), `--offset <n>` |
| `anc monitor download` | `-e, --env <name>` (required), `--from <date>` (required), `--to`, `-o, --output <path>`, `-f, --format json\|csv` (default `json`) |

`--from` defaults to 24 hours ago and `--to` to now, except where marked required.

```bash
anc monitor summary --env Sandbox                                   # traffic, failures, p50–p99 per app
anc monitor summary --env Sandbox --app sample-orders-api --by worker
anc monitor summary --env Sandbox --app sample-orders-api --by route
anc monitor summary --app sample-orders-api                         # every environment side by side
anc monitor runtime --env Sandbox --app sample-orders-api           # heap, old gen vs limit, GC, CPU, RAM
anc monitor trend --env Sandbox --app sample-orders-api --signal memory -g 1h --from 7d
anc monitor trend --env Sandbox --app sample-orders-api --signal traffic -g 5m --from 3h
anc monitor query "$(cat failing-routes.amql)" --limit 500
anc monitor download --env Sandbox --from 7d --format csv --output metrics.csv
```

`anc monitor query` prints the rows as JSON. How to read every number, and the AMQL rules, are in
[Monitoring](monitoring.md).

## alerts

| Command | Arguments and options |
| --- | --- |
| `anc alerts list` | `-e, --env <name>` (needed for Runtime Manager alerts), `--app <name>`, `--api-instance <id>`, `--name <text>`, `--status PENDING\|ACTIVE\|DELETED`, `--source monitoring\|runtime-manager\|all` (default `all`), `--reveal`, `--json` |
| `anc alerts get <id>` | `--reveal`, `--json` |
| `anc alerts create` | `-e, --env <name>`, `--name`, `--app <name>` or `--api-instance <id>`, `--metric`, `--operator`, `--threshold`, `--duration <minutes>`, `--severity 0\|1\|2`, `--email <address>` (repeatable) with `--subject`, or `--slack-channel <id>` (`--slack-carrier <id>`), `--message`, `--response-codes`, `--policies`, `--enabled`, `--allow-duplicate`, `--dry-run`, `--force` |
| `anc alerts update <id>` | `--name`, `--severity`, `--operator`, `--threshold`, `--duration`, `--dry-run`, `--force` |
| `anc alerts enable <id>` / `anc alerts disable <id>` | `--dry-run`, `--force` |
| `anc alerts delete <id>` | `--confirm <name>` (dry run without it), `--allow-production` (not needed when a pre-approval names `delete_alert`) |

The API behind these commands is undocumented; see [Alerts](alerts.md).

## exchange

| Command | Arguments and options |
| --- | --- |
| `anc exchange search [query]` | `-t, --type <type>` (rest-api, app, connector, template, example, policy), `-l, --limit <n>` (default 20) |
| `anc exchange info <assetPath>` | `groupId/assetId` or `assetId`; `-v, --version <v>` |
| `anc exchange download-spec <assetPath>` | `-v, --version <v>`, `-o, --output <file>` |

```bash
anc exchange search "order" --type rest-api --limit 10
anc exchange info sample-orders-api-spec --version 1.2.0
anc exchange download-spec sample-orders-api-spec -o spec.json
```

## api

Every command takes `-e, --env <name>` (required). `<apiName>` is an API name or numeric instance ID;
an unknown API is reported as an error.

| Command | Purpose |
| --- | --- |
| `anc api list` | API instances in the environment |
| `anc api policies <apiName>` | Applied policies |
| `anc api sla-tiers <apiName>` | SLA tiers |
| `anc api alerts <apiName>` | Alerts configured for the API |
| `anc api contracts <apiName>` | Contracts: client application, tier and status |
| `anc api client-app <id>` | A client application, secret masked. `--write-credentials <file>` writes `CLIENT_ID`/`CLIENT_SECRET` to a mode-0600 file inside the project; `--overwrite` |
| `anc api smoke <apiName>` | Call the API with its client credentials: `--path` or `--url`, `-X, --method`, `--client-app <id>`, `-H, --header`, `-d, --data`, `--expect <status>`, `--timeout <ms>`. Methods other than GET ask unless `-y, --yes`; production needs `--allow-production` unless a pre-approval covers `smoke_test_api`. Exits 1 when the status does not match |

```bash
anc api list --env Sandbox
anc api policies "orders-sapi" --env Sandbox
anc api contracts "orders-sapi" --env Sandbox
anc api smoke "orders-sapi" --env Sandbox --path /api/health --expect 200
```

## design-center (alias dc)

| Command | Arguments and options |
| --- | --- |
| `anc dc list` | All projects |
| `anc dc files <project>` | `-b, --branch <branch>` (default `master`) |
| `anc dc pull <project> [filePath]` | `-b, --branch`, `-o, --output <file>`; omit `filePath` to list files |
| `anc dc push <project> <localFile>` | `-p, --path <path>` (remote path; default matches the local file name), `-b, --branch`, `-m, --message <msg>`, `-y, --yes` |
| `anc dc publish <project>` | `--version <version>` (required), `--api-version <v>` (default `v1`), `--name <name>`, `--asset-id <id>`, `--classifier raml\|raml-fragment\|oas\|oas3` (default `raml`), `--main <file>`, `-b, --branch`, `-y, --yes` |

```bash
anc dc files sample-orders-api-spec --branch develop
anc dc pull sample-orders-api-spec api.raml -o local-spec.raml
anc dc push sample-orders-api-spec local-spec.raml --path api.raml --message "Add order status endpoint"
anc dc publish sample-orders-api-spec --version 1.2.0 --classifier raml
```

`push` and `publish` show a preview first (the per-file action, or the Exchange coordinates, main file,
and source SHA-256) and ask for confirmation. `--yes` skips the question; it does not skip the conflict
checks or the post-write verification. In a non-interactive shell, pass `--yes` or the command stops.
`publish` defaults the asset ID and main file from the project's `exchange.json`.

## mcp

```bash
anc mcp
```

Starts the MCP server over stdio using the resolved profile. Configure it in a host as described in
[MCP server](mcp.md).

## When a command fails

The error message names the state you are in. Match it against [Access readiness](readiness.md) before
changing anything: being unconfigured, unauthenticated, pointed at an invisible environment, and missing a
permission are four different problems. [Troubleshooting](troubleshooting.md) covers the rest.
