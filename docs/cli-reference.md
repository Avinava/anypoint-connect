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
| `anc apps list \| status \| restart \| scale \| delete` | CloudHub 2.0 applications |
| `anc deploy <jar>` | Publish a JAR to Exchange and deploy it |
| `anc logs tail \| download` | Application logs |
| `anc monitor summary \| runtime \| trend \| query \| download` | Anypoint Monitoring metrics |
| `anc exchange search \| info \| download-spec` | Exchange assets |
| `anc api list \| policies \| sla-tiers \| alerts` | API Manager |
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
| `anc apps status <appName>` | `-e, --env <name>` (required) |
| `anc apps restart <appName>` | `-e, --env <name>` (required), `--force` skips the production confirmation |
| `anc apps scale <appName>` | `-e, --env <name>` (required), `--replicas <n>` (required), `--force` |
| `anc apps delete <appName>` | `-e, --env <name>` (required), `--confirm <deploymentId>`, `--allow-production` |

```bash
anc apps list --env Sandbox
anc apps status sample-orders-api --env Sandbox
anc apps restart sample-orders-api --env Production            # asks for confirmation
anc apps scale sample-orders-api --env Sandbox --replicas 2
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

Publishes the JAR to Exchange, then creates the deployment, or for an existing app changes only its
artifact reference. The asset ID and version come from the JAR's embedded Maven metadata, never from the
file name.

| Option | Meaning |
| --- | --- |
| `-a, --app <name>` | Application name (required) |
| `-e, --env <name>` | Target environment (required) |
| `--asset-id <id>` | Exchange asset ID; default is the embedded Maven `artifactId` |
| `--asset-version <v>` | Exchange asset version; default is the embedded Maven `version` |
| `--group-id <id>` | Exchange group ID; default is the organization ID |
| `-r, --runtime <version>` | New app only. Mule runtime version (default 4.8.0) |
| `--replicas <n>` | New app only. Replica count (default 1) |
| `--vcores <size>` | New app only. One of 0.1, 0.2, 0.5, 1, 1.5, 2, 2.5, 3, 4 (default 0.1) |
| `--region <target>` | New app only. CloudHub 2.0 target (default `cloudhub-us-east-2`) |
| `--dry-run` | Print the plan (coordinates, SHA-256, create or update) and stop |
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

The new-app-only flags are rejected when the application already exists; use `anc apps scale` or the
settings tools instead. Without `--dry-run`, a non-production deploy is applied immediately after the
summary. See the [safety model](safety.md#publishing-a-jar).

## logs

| Command | Arguments and options |
| --- | --- |
| `anc logs tail <appName>` | `-e, --env <name>` (required), `-l, --level <level>` (ERROR, WARN, INFO, DEBUG), `-s, --search <text>` |
| `anc logs download <appName>` | `-e, --env <name>` (required), `--from <date>` (required), `--to <date>`, `-l, --level <level>`, `-o, --output <path>` |

```bash
anc logs tail sample-orders-api --env Sandbox --level ERROR --search "TimeoutException"
anc logs download sample-orders-api --env Sandbox --from 24h
anc logs download sample-orders-api --env Production \
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

```bash
anc api list --env Sandbox
anc api policies "sample-orders-api" --env Sandbox
anc api alerts "sample-orders-api" --env Sandbox
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
