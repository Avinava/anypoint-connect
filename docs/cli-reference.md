# CLI reference

The binary is `anc`. Most operational commands take `--env <name>`. Authentication and configuration
commands accept `--profile <name>`; operational commands resolve the profile from `ANYPOINT_PROFILE`, a
project binding, or `default` as described in [Profiles](profiles.md).

## Configuration and authentication

```bash
anc config init                      # interactive credential setup
anc config init --profile org-a
anc config show                      # resolved config, secrets masked
anc config set defaultEnv Production
anc config profiles                  # list profiles
anc config path                      # where files are stored
anc config use org-a                 # bind this directory to a profile

anc auth login                       # OAuth in a browser
anc auth login --profile org-a
anc auth status                       # confirm the current session
anc auth logout                       # clear stored tokens
```

## Applications

```bash
anc apps list --env Sandbox
anc apps status sample-orders-api --env Sandbox
anc apps restart sample-orders-api --env Production            # production confirmation prompt
anc apps scale sample-orders-api --env Sandbox --replicas 2
anc apps scale sample-orders-api --env Production --replicas 3 --force
```

Deletion is a bound two-step operation, because an app name is not a stable identifier for the thing you
inspected:

```bash
anc apps delete sample-orders-api --env Sandbox                 # dry run; prints the deployment ID
anc apps delete sample-orders-api --env Sandbox --confirm <DEPLOYMENT_ID>

# production requires an explicit acknowledgement as well
anc apps delete sample-orders-api --env Production --confirm <DEPLOYMENT_ID> --allow-production
```

If the deployment was recreated between the two calls, the deployment ID no longer matches and the
operation fails rather than deleting something you never looked at. See the
[safety model](safety.md).

## Deploy

```bash
# standard deploy
anc deploy target/sample-orders-api-1.3.0-mule-application.jar \
  --app sample-orders-api --env Sandbox --runtime 4.8.0

# production deploy triggers a typed confirmation
anc deploy target/sample-orders-api.jar --app sample-orders-api --env Production
#   ⚠️  PRODUCTION DEPLOYMENT
#   App:         sample-orders-api
#   Environment: Production
#   Current:     v1.1.0 (APPLIED, 2 replicas)
#   New Version: v1.2.0
#   Type 'deploy to production' to confirm: _

# unattended
anc deploy app.jar --app sample-orders-api --env Production --force
```

## Logs

```bash
# stream
anc logs tail sample-orders-api --env Sandbox
anc logs tail sample-orders-api --env Sandbox --level ERROR --search "TimeoutException"

# download a range
anc logs download sample-orders-api --env Sandbox --from 24h
anc logs download sample-orders-api --env Production --from 7d --level ERROR
anc logs download sample-orders-api --env Production \
  --from "2026-02-01T00:00:00Z" --to "2026-02-14T00:00:00Z" --output prod-logs.log
```

Search with the least sensitive term that identifies the flow. Downloaded logs are production data —
keep them out of repositories.

## Monitoring

```bash
anc monitor view --env Sandbox                       # metrics table, last 24h
anc monitor view --env Production --app sample-orders-api --from 7d
anc monitor perf --env Production                    # percentiles
anc monitor memory --env Production --app sample-orders-api     # JVM heap and GC
anc monitor memory-trend --env Production --app sample-orders-api --granularity 1h
anc monitor workers --env Production --app sample-orders-api    # per-replica
anc monitor compare                                  # across environments

anc monitor download --env Production --from 30d --format json
anc monitor download --env Sandbox --from 7d --format csv --output metrics.csv
```

Percentiles are unstable at low request counts; read them together with the request count rather than on
their own.

## Exchange

```bash
anc exchange search "order" --type rest-api --limit 10
anc exchange info sample-orders-api-spec
anc exchange info organization-id/sample-orders-api-spec --version 1.2.0
anc exchange download-spec sample-orders-api-spec -o spec.json
```

## API Manager

```bash
anc api list --env Production
anc api policies "order-api" --env Production
anc api policies 18888853 --env Production
anc api sla-tiers "order-api" --env Production
```

## Design Center

```bash
anc dc list
anc dc files sample-orders-api-spec --branch develop

# pull a spec file, auto-decoding JSON-encoded content
anc dc pull sample-orders-api-spec api.raml -o local-spec.raml

# push, matching the local filename to the remote path
anc dc push sample-orders-api-spec local-spec.raml --message "Add new endpoint"
anc dc push sample-orders-api-spec local-spec.raml --path api.raml

# publish to Exchange
anc dc publish sample-orders-api-spec --version 1.2.0 --classifier raml
anc dc publish sample-orders-api-spec --version 2.0.0 --classifier oas3 --api-version v2
```

## When a command fails

The error message names the state you are in rather than a generic failure. Match it against
[Access readiness](readiness.md) before changing anything: being unconfigured, unauthenticated, pointed
at an invisible environment, and missing a scope are four different problems.
