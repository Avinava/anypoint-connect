# Tool catalog

65 MCP tools. A ⚠️ marks a mutating tool. Application tools use `confirm`; new Design Center workflows
use single-use preview tokens. See the [safety model](safety.md).

## Identity and organization

| Tool | Description |
| --- | --- |
| `whoami` | Authenticated user and organization context. Use it first to confirm access |
| `list_environments` | Environments visible to that identity |
| `get_entitlements` | Subscription: vCores, MQ, Object Store, API quotas. Check before using optional-feature tools |

## Applications

| Tool | Description |
| --- | --- |
| `list_apps` | Deployed apps with status, version, vCores, and replica count |
| `get_app_status` | Deployment status with resources, autoscaling, JVM, and replicas |
| `get_deployment_spec` | Full spec: artifact ref, runtime, target kind, vCores, replica states. Look before you leap |
| `get_app_resources` | Resource allocation across every app in an environment |
| `get_app_settings` | Application properties and secure property keys |
| `deploy_app` | ⚠️ Create a deployment, or safely redeploy an existing one. For an existing app, prefer `update_app_artifact` |
| `update_app_artifact` | ⚠️ Change only the artifact version, preserving runtime, target, replicas, and settings |
| `rollback_app` | ⚠️ Roll back to the newest distinct historical artifact, or a requested version |
| `update_app_settings` | ⚠️ Merge application properties, preserving protected values and infrastructure |
| `restart_app` | ⚠️ Rolling restart |
| `scale_app` | ⚠️ Scale replicas, 1 to 8 |
| `stop_app` | ⚠️ Stop without deleting the deployment |
| `start_app` | Start a stopped application |
| `delete_app` | ⚠️ Permanently delete a deployment. Dry run plus deployment-ID-bound confirmation |

## Logs and analysis

| Tool | Description |
| --- | --- |
| `get_logs` | Recent entries, with optional keyword search |
| `download_logs` | Logs for a time range |
| `analyze_errors` | Clustered error groups with before and after context windows |
| `get_log_patterns` | Recurring message templates with counts |
| `get_log_stats` | Health summary: error rate, spikes, noise percentage |

## Monitoring

| Tool | Description |
| --- | --- |
| `get_metrics` | Inbound and outbound request count and response time |
| `get_performance_metrics` | Percentiles: p50, p95, p99 |
| `get_metrics_timeseries` | Time series for trend analysis |
| `get_worker_metrics` | Per-replica performance |
| `get_memory_metrics` | JVM heap, GC statistics, thread counts |
| `get_memory_timeseries` | Memory over time, for leak investigation |
| `compare_env_performance` | Performance compared across environments |
| `raw_amql_query` | Freeform AMQL for ad-hoc analysis |

## Exchange

| Tool | Description |
| --- | --- |
| `search_exchange` | Search assets |
| `get_exchange_asset` | Versions, dependencies, instances, files |
| `download_api_spec` | Download a RAML or OAS specification |
| `compare_environments` | Deployment-by-deployment comparison of two environments, including whether versions match. Use it to catch drift before a promotion |
| `publish_app_jar` | ⚠️ Upload a locally built application JAR as a deployable Exchange asset |
| `deploy_jar` | ⚠️ Publish a JAR and deploy it in one call |

## API Manager

| Tool | Description |
| --- | --- |
| `list_api_instances` | Managed API instances with governance information |
| `get_api_policies` | Policies and SLA tiers for an API |
| `get_api_alerts` | Configured alerts for an API instance |

## Design Center

| Tool | Description |
| --- | --- |
| `list_design_center_projects` | API specification projects |
| `list_design_center_branches` | Branches for an exactly identified project |
| `get_design_center_files` | Files in a project |
| `read_design_center_file` | File content, with smart path resolution |
| `update_design_center_file` | ⚠️ Push an updated file (lock, save, unlock) |
| `preview_design_center_project_create` | Collision check and approval token; creates nothing |
| `create_design_center_project` | ⚠️ Consume a preview token and create the project |
| `preview_design_center_sync` | Hash-based create/update/unchanged plan; writes nothing |
| `sync_design_center_files` | ⚠️ Consume a preview token for conflict-safe batch sync |
| `preview_exchange_publication` | Bind coordinates, classifier, main file, and source hash; publishes nothing |
| `publish_previewed_exchange_asset` | ⚠️ Publish the bound source and verify the Exchange artifact hash |
| `explain_api_governance_plan` | Centralized governance rulesets for planned or published coordinates |
| `get_api_governance_conformance` | Centralized conformance for exact asset versions |
| `publish_to_exchange` | ⚠️ Legacy direct publication; prefer the previewed workflow |

## Audit log

| Tool | Description |
| --- | --- |
| `get_audit_log` | Platform changes: who did what, and when |

## Anypoint MQ

| Tool | Description |
| --- | --- |
| `list_queues` | Destinations in a region |
| `get_queue_stats` | Depth, in-flight, and throughput |
| `get_dlq_messages` | Browse dead-letter messages without consuming them |
| `publish_mq_message` | ⚠️ Publish a message, for testing, replay, or seeding |

## Object Store v2

| Tool | Description |
| --- | --- |
| `list_stores` | Object Stores in an environment |
| `get_store_keys` | Keys, paginated |
| `get_store_value` | Retrieve and format a value |
| `put_store_value` | ⚠️ Write or update a value |
| `delete_store_value` | ⚠️ Delete a key and its value |

## Profile

| Tool | Description |
| --- | --- |
| `get_project_profile` | Active profile, how it was resolved, and what else is available |
| `set_project_profile` | Bind a project directory to a named profile |

Switching profiles changes which organization every later call reaches. Treat it as an authorized
operation rather than a convenience — see [Profiles](profiles.md).

## Choosing between overlapping tools

| If you want to | Use | Not |
| --- | --- | --- |
| Update a running app to a new version | `update_app_artifact` | `deploy_app`, which is for creating deployments |
| Know what is deployed before changing it | `get_deployment_spec` | `list_apps`, which summarizes rather than details |
| Find out why an app is failing | `analyze_errors`, then `get_logs` with a narrow search | `get_logs` alone, which returns volume without structure |
| Check whether a release landed everywhere | `compare_environments` | Reading two `list_apps` results by eye |
| Take an app out of service temporarily | `stop_app` | `delete_app`, which discards the deployment configuration |
