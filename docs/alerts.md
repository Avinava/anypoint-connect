# Alerts

Anypoint Monitoring alerts watch one metric on one CloudHub 2.0 app or API instance and notify by email or
Slack. The MCP tools and `anc alerts` list, read, create, change, enable, disable and delete them.

!!! warning "Undocumented API"

    These tools call the observability API that the Monitoring UI uses
    (`/observability/api/v1/organizations/{orgId}/alerts`). It is not publicly documented and can change
    without notice. When an organization or token cannot reach it (HTTP 404 or 403), the tools report the
    family as unsupported instead of returning "no alerts". Runtime Manager event alerts
    (`/armui/api/v1/alerts`) are read only, and their shape is read best effort.

## Read

```jsonc
list_alerts({ "environment": "Sandbox", "entityType": "application" })
get_alert({ "id": "<alert id>" })
get_api_alerts({ "apiName": "orders-api", "environment": "Sandbox" })   // API Manager and Monitoring alerts
```

Every alert is normalized to:

| Field | Meaning |
| --- | --- |
| `id`, `source` | Alert ID; `monitoring` or `runtime-manager` |
| `name`, `enabled`, `severity` | As stored. Names are not unique |
| `status` | `PENDING` (being provisioned or deleted), `ACTIVE`, `DELETED` |
| `state` | `OK` or `ALERTING` |
| `entity` | `type` (`application`, `api`, `server`), `name`, `deploymentType` (`CLOUDHUB`, `CLOUDHUB2`, `RTF`, `HYBRID`), `environment` |
| `condition` | `metric`, `operator`, `threshold` and `unit` (percent for cpu and memory), `windowMinutes` |
| `recipientCount`, `recipientDomains`, `slackChannels` | Recipients are masked to a count and domains. `revealRecipients: true` (CLI `--reveal`) shows them |

Deleted alerts are hidden unless `status: "DELETED"` is asked for.

## Metrics

| Metric | Target | Unit | Aggregation |
| --- | --- | --- | --- |
| `cpu_utilization`, `memory_utilization` | app | percent | average |
| `thread_count` | app | count | average |
| `message_count`, `message_error_count` | app | count | sum |
| `message_response_time` | app | ms | average |
| `api_request_count` | API instance | count | sum |
| `api_response_time` | API instance | ms | average |
| `api_response_code_count` | API instance | count | sum; needs `apiFilters.responseCodes` |
| `api_policy_violation_count` | API instance | count | sum; needs `apiFilters.policies` |

Give a percent threshold as a percentage (`90`); it is stored as a fraction (`0.9`). Counts are whole
numbers. `durationMinutes` (1 to 60) is how long the condition must hold.

## Create

```jsonc
create_alert({
  "environment": "Sandbox",
  "name": "orders cpu",
  "target": { "app": "orders-sapi" },
  "metric": "cpu_utilization",
  "operator": "GREATER_THAN",
  "threshold": 90,
  "durationMinutes": 10,
  "severity": 1,
  "notifications": [
    { "type": "EMAIL", "recipients": ["ops@example.com"], "subject": "CPU high", "message": "CPU is high" }
  ]
})
```

- The target is resolved from CloudHub 2.0 (`{ "app": ... }`) or API Manager (`{ "apiInstanceId": ... }`).
- Notifications are explicit. There are no default recipients, and at least one is required.
- The alert is created disabled unless `enabled: true`.
- The preview shows the exact payload and recipients, and warns when a recipient is outside your own
  email domain (your address is never shown).
- An alert with the same name on the same target is refused, with its `existingId`, unless
  `allowDuplicate: true`.
- A new alert is `PENDING` until the platform provisions it.

## Change, enable, disable, delete

- `update_alert({ id, patch })` changes `name`, `severity`, `enabled`, `operator`, `threshold`,
  `durationMinutes` or `notifications` (replaced as a whole). The platform needs the full alert, so the tool
  reads it, merges the patch and sends it whole. Metric and target cannot change; create a new alert.
- `set_alert_enabled({ id, enabled })` switches an alert on or off.
- A `PENDING` alert cannot be changed; the tool refuses with a retry-later message.
- `delete_alert({ id, expectedName })` is bound like `delete_app`: preview first, then `confirm: true` with
  the name from the preview. Deletion is asynchronous. The result reports `accepted` and `status`; it says
  deleted only when the alert is gone or `DELETED`, never while it is `PENDING`.

## Safety

Every write previews by default and needs `confirm: true`. The alert's own environment decides whether
production confirmation applies: `confirmProduction: true`, or a user-level
[pre-approval](safety.md#production-pre-approval). `"all-mutating"` covers `create_alert`, `update_alert`
and `set_alert_enabled`; `delete_alert` is covered only when named.

## CLI

```bash
anc alerts list --env Sandbox
anc alerts get <id> --reveal
anc alerts create -e Sandbox --name "orders cpu" --app orders-sapi --metric cpu_utilization \
  --operator GREATER_THAN --threshold 90 --duration 10 --severity 1 \
  --email ops@example.com --subject "CPU high" --message "CPU is high" --dry-run
anc alerts update <id> --threshold 95
anc alerts disable <id>
anc alerts delete <id> --confirm "orders cpu"
```

Production writes ask for the typed phrase unless `--force` or a pre-approval covers them;
`anc alerts delete` in production needs `--allow-production` or a pre-approval that names `delete_alert`.
