/**
 * Alerts CLI Commands
 * anc alerts list [--env <name>] [--app <name>] [--api-instance <id>] [--name <text>] [--status <s>] [--source <s>] [--reveal] [--json]
 * anc alerts get <id> [--reveal] [--json]
 * anc alerts create --env <name> --name <name> (--app <name> | --api-instance <id>) --metric <id> --operator <op>
 *                   --threshold <n> --duration <minutes> --severity <0-2> (--email <addr>... --subject <s> | --slack-channel <id>)
 *                   --message <text> [--enabled] [--allow-duplicate] [--dry-run] [--force]
 * anc alerts update <id> [--name] [--severity] [--operator] [--threshold] [--duration] [--dry-run] [--force]
 * anc alerts enable|disable <id> [--dry-run] [--force]
 * anc alerts delete <id> [--confirm <name>] [--allow-production]
 *
 * Same workflows as the MCP alert tools (src/workflows/alerts.ts). Uses an undocumented API.
 */

import { Command } from 'commander';
import { log } from '../utils/logger.js';
import { errorMessage } from '../utils/errors.js';
import { printTable } from '../utils/formatter.js';
import { ALERT_METRIC_IDS, ALERT_OPERATORS, type AlertMetricId, type AlertOperator } from '../api/AlertsApi.js';
import { confirmProductionWrite, isProductionEnv } from '../safety/guards.js';
import { checkPreapproval } from '../safety/preapproval.js';
import {
    CHANGE_IN_PROGRESS,
    alertEnvironment,
    executeDeleteAlert,
    executeUpdateAlert,
    normalizeAlert,
    normalizeRuntimeManagerAlert,
    planCreateAlert,
    planUpdateAlert,
    previewPayload,
    readAlertForDelete,
    targetsApp,
    type AlertPatch,
    type NotificationInput,
} from '../workflows/alerts.js';
import { createClient } from './shared.js';

const collect = (value: string, previous: string[] = []) => [...previous, value];
const list = (value: string) =>
    value
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);

function number(name: string) {
    return (value: string) => {
        const n = Number(value);
        if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
        return n;
    };
}

function oneOf<T extends string>(name: string, values: readonly T[]) {
    return (value: string): T => {
        if (!values.includes(value as T)) throw new Error(`${name} must be one of ${values.join(', ')}`);
        return value as T;
    };
}

type AlertRow = ReturnType<typeof normalizeAlert> | ReturnType<typeof normalizeRuntimeManagerAlert>;

function printAlerts(alerts: AlertRow[]): void {
    printTable(
        ['ID', 'Source', 'Name', 'Enabled', 'Status', 'Target', 'Condition', 'Recipients'],
        alerts.map((a) => [
            String(a.id ?? '-'),
            a.source,
            String(a.name ?? '-'),
            a.enabled === undefined ? '-' : String(a.enabled),
            String(a.status ?? '-'),
            String(a.entity?.name ?? '-'),
            'operator' in a.condition && a.condition.operator
                ? `${a.condition.metric} ${a.condition.operator} ${a.condition.threshold}${a.condition.unit === 'percent' ? '%' : ''} for ${a.condition.windowMinutes}m`
                : 'event' in a.condition
                  ? `event ${a.condition.event ?? '-'}`
                  : '-',
            String(a.recipientCount),
        ]),
    );
}

/** --email/--subject, --slack-channel/--slack-carrier and --message, shared by create and update. */
function addNotificationOptions(command: Command): Command {
    return command
        .option('--email <address>', 'Email recipient (repeatable)', collect)
        .option('--subject <text>', 'Email subject')
        .option('--slack-channel <id>', 'Slack channel ID')
        .option('--slack-carrier <id>', 'Slack connection ID')
        .option('--message <text>', 'Notification message');
}

/** The notifications the options describe, or undefined when none are given. */
function notificationsFromOptions(opts: {
    email?: string[];
    subject?: string;
    slackChannel?: string;
    slackCarrier?: string;
    message?: string;
}): NotificationInput[] | undefined {
    const notifications: NotificationInput[] = [];
    if (opts.email?.length) {
        notifications.push({
            type: 'EMAIL',
            recipients: opts.email,
            subject: opts.subject ?? '',
            message: opts.message ?? '',
        });
    }
    if (opts.slackChannel) {
        notifications.push({
            type: 'SLACK',
            channelId: opts.slackChannel,
            ...(opts.slackCarrier ? { carrierId: opts.slackCarrier } : {}),
            message: opts.message ?? '',
        });
    }
    return notifications.length ? notifications : undefined;
}

function printChange(label: string, payload: unknown, warnings: string[] = []): void {
    log.header(label);
    console.log(JSON.stringify(payload, null, 2));
    for (const warning of warnings) log.warn(warning);
}

export function createAlertsCommand(): Command {
    const alerts = new Command('alerts').description('Anypoint Monitoring alerts (undocumented API)');

    alerts
        .command('list')
        .description('List alerts; recipients are masked unless --reveal')
        .option('-e, --env <name>', 'Environment name or ID (needed for Runtime Manager alerts)')
        .option('--app <name>', 'Only alerts on this application')
        .option('--api-instance <id>', 'Only alerts on this API instance')
        .option('--name <text>', 'Only alerts whose name contains this text')
        .option('--status <status>', 'PENDING or ACTIVE (deleted alerts never appear in the list)')
        .option('--source <source>', 'monitoring, runtime-manager or all', 'all')
        .option('--reveal', 'Show notification recipients')
        .option('--json', 'Print as JSON')
        .action(async (opts) => {
            try {
                const client = createClient();
                const orgId = await client.getDefaultOrgId();
                const env = opts.env ? await client.accessManagement.resolveEnvironment(orgId, opts.env) : undefined;
                const rows: AlertRow[] = [];
                if (opts.source !== 'runtime-manager') {
                    const needle = opts.name?.toLowerCase();
                    rows.push(
                        ...(await client.alerts.list(orgId, { environmentId: env?.id }))
                            .filter((a) => (opts.status ? a.alertStatus === opts.status : a.alertStatus !== 'DELETED'))
                            .filter((a) => !opts.app || a.entity?.appId === opts.app)
                            .filter((a) => !opts.apiInstance || String(a.entity?.apiInstanceId) === opts.apiInstance)
                            .filter((a) => !needle || a.name.toLowerCase().includes(needle))
                            .map((a) => normalizeAlert(a, { reveal: opts.reveal })),
                    );
                }
                if (opts.source !== 'monitoring' && env) {
                    const needle = opts.name?.toLowerCase();
                    rows.push(
                        ...(await client.alerts.listRuntimeManager(orgId, env.id))
                            .map((a) => normalizeRuntimeManagerAlert(a, { reveal: opts.reveal }))
                            .filter(
                                (a) =>
                                    !needle ||
                                    String(a.name ?? '')
                                        .toLowerCase()
                                        .includes(needle),
                            )
                            .filter((a) => !opts.app || targetsApp(a.entity.resources, opts.app)),
                    );
                }
                if (opts.json) {
                    console.log(JSON.stringify(rows, null, 2));
                    return;
                }
                if (rows.length === 0) {
                    log.warn('No alerts found');
                    return;
                }
                printAlerts(rows);
            } catch (error) {
                log.error(`Listing alerts failed: ${errorMessage(error)}`);
                process.exitCode = 1;
            }
        });

    alerts
        .command('get')
        .description('Show one alert')
        .argument('<id>', 'Alert ID')
        .option('--reveal', 'Show notification recipients')
        .option('--json', 'Print as JSON')
        .action(async (id: string, opts) => {
            try {
                const client = createClient();
                const orgId = await client.getDefaultOrgId();
                const alert = await client.alerts.get(orgId, id);
                if (!alert) {
                    log.error(`Alert ${id} not found`);
                    process.exitCode = 1;
                    return;
                }
                const view = normalizeAlert(alert, { reveal: opts.reveal });
                if (opts.json) console.log(JSON.stringify(view, null, 2));
                else printAlerts([view]);
            } catch (error) {
                log.error(`Reading the alert failed: ${errorMessage(error)}`);
                process.exitCode = 1;
            }
        });

    const create = alerts
        .command('create')
        .description('Create a metric alert on a CloudHub 2.0 app or an API instance (disabled unless --enabled)')
        .requiredOption('-e, --env <name>', 'Environment name or ID')
        .requiredOption('--name <name>', 'Alert name')
        .option('--app <name>', 'CloudHub 2.0 application name')
        .option('--api-instance <id>', 'API instance ID')
        .requiredOption('--metric <id>', `Metric: ${ALERT_METRIC_IDS.join(', ')}`, oneOf('--metric', ALERT_METRIC_IDS))
        .requiredOption(
            '--operator <op>',
            `Operator: ${ALERT_OPERATORS.join(', ')}`,
            oneOf('--operator', ALERT_OPERATORS),
        )
        .requiredOption(
            '--threshold <n>',
            'Threshold in the metric unit (percent for cpu and memory)',
            number('--threshold'),
        )
        .requiredOption('--duration <minutes>', 'Minutes the condition must hold', number('--duration'))
        .requiredOption('--severity <level>', 'Severity: 0-3 or LOW, MEDIUM, HIGH, CRITICAL');
    addNotificationOptions(create)
        .option('--response-codes <codes>', 'For api_response_code_count: comma-separated codes', list)
        .option('--policies <names>', 'For api_policy_violation_count: comma-separated policies', list)
        .option('--enabled', 'Enable on creation', false)
        .option('--allow-duplicate', 'Create even if the target has an alert with this name', false)
        .option('--dry-run', 'Show the payload, then stop', false)
        .option('--force', 'Skip the production confirmation prompt', false)
        .action(async (opts) => {
            try {
                if (Boolean(opts.app) === Boolean(opts.apiInstance))
                    throw new Error('Pass exactly one of --app or --api-instance');
                const notifications = notificationsFromOptions(opts) ?? [];
                const client = createClient();
                const plan = await planCreateAlert(
                    client,
                    {
                        environment: opts.env,
                        name: opts.name,
                        target: opts.app ? { app: opts.app } : { apiInstanceId: opts.apiInstance },
                        metric: opts.metric as AlertMetricId,
                        operator: opts.operator as AlertOperator,
                        threshold: opts.threshold,
                        durationMinutes: opts.duration,
                        severity: opts.severity,
                        enabled: opts.enabled,
                        notifications,
                        apiFilters: { responseCodes: opts.responseCodes, policies: opts.policies },
                    },
                    { enableHint: '`anc alerts enable <id>`' },
                );
                printChange(`Create alert in ${plan.env.name}`, previewPayload(plan.body), plan.warnings);
                if (plan.duplicate && !opts.allowDuplicate) {
                    log.error(
                        `An alert with this name already exists on the target: ${plan.duplicate.id}. Pass --allow-duplicate to create another.`,
                    );
                    process.exitCode = 1;
                    return;
                }
                if (opts.dryRun) {
                    log.info('Dry run: nothing was created.');
                    return;
                }
                if (!(await confirmProductionWrite(plan.env, plan.orgId, 'create_alert', opts.force))) {
                    log.warn('Cancelled');
                    return;
                }
                const created = await client.alerts.create(plan.orgId, plan.body);
                log.success(
                    `Created alert "${plan.body.name}"${created?.id ? ` (${created.id})` : ''}; it is PENDING until provisioned`,
                );
            } catch (error) {
                log.error(`Creating the alert failed: ${errorMessage(error)}`);
                process.exitCode = 1;
            }
        });

    async function runUpdate(id: string, patch: AlertPatch, tool: string, opts: { dryRun?: boolean; force?: boolean }) {
        try {
            const client = createClient();
            const plan = await planUpdateAlert(client, id, patch);
            if (plan.noop) {
                log.info('Nothing to change.');
                return;
            }
            log.header(`${plan.existing.name} in ${plan.env.name}`);
            for (const change of plan.changes)
                log.kv(
                    `  ${change.field}`,
                    `${JSON.stringify(change.from)} -> ${JSON.stringify(change.to)}${change.differs ? ` (changed: ${change.differs.join(', ')})` : ''}`,
                );
            if (opts.dryRun) {
                log.info('Dry run: nothing was changed.');
                return;
            }
            if (!(await confirmProductionWrite(plan.env, plan.orgId, tool, opts.force))) {
                log.warn('Cancelled');
                return;
            }
            const result = await executeUpdateAlert(client, plan);
            if (result.verified) log.success(result.message);
            else
                log.warn(
                    `${result.message.replace('get_alert or list_alerts', `anc alerts get ${id}`)} Status: ${result.status}`,
                );
        } catch (error) {
            log.error(`Updating the alert failed: ${errorMessage(error)}`);
            process.exitCode = 1;
        }
    }

    const update = alerts
        .command('update')
        .description(
            'Change an alert (read, merge, replace); metric and target cannot change. Notification options replace every notification',
        )
        .argument('<id>', 'Alert ID')
        .option('--name <name>', 'New name')
        .option('--severity <level>', 'Severity: 0-3 or LOW, MEDIUM, HIGH, CRITICAL')
        .option('--operator <op>', `Operator: ${ALERT_OPERATORS.join(', ')}`, oneOf('--operator', ALERT_OPERATORS))
        .option('--threshold <n>', 'Threshold in the metric unit', number('--threshold'))
        .option('--duration <minutes>', 'Minutes the condition must hold', number('--duration'));
    addNotificationOptions(update)
        .option('--dry-run', 'Show the change, then stop', false)
        .option('--force', 'Skip the production confirmation prompt', false)
        .action(async (id: string, opts) => {
            await runUpdate(
                id,
                {
                    name: opts.name,
                    severity: opts.severity,
                    operator: opts.operator,
                    threshold: opts.threshold,
                    durationMinutes: opts.duration,
                    notifications: notificationsFromOptions(opts),
                },
                'update_alert',
                opts,
            );
        });

    for (const [name, enabled] of [
        ['enable', true],
        ['disable', false],
    ] as const) {
        alerts
            .command(name)
            .description(`${name === 'enable' ? 'Enable' : 'Disable'} an alert`)
            .argument('<id>', 'Alert ID')
            .option('--dry-run', 'Show the change, then stop', false)
            .option('--force', 'Skip the production confirmation prompt', false)
            .action(async (id: string, opts) => {
                await runUpdate(id, { enabled }, 'set_alert_enabled', opts);
            });
    }

    alerts
        .command('delete')
        .description('Delete an alert (dry run unless --confirm matches its name)')
        .argument('<id>', 'Alert ID')
        .option('--confirm <name>', 'Delete only if the alert has this exact name')
        .option('--allow-production', 'Explicitly allow deletion in a production environment', false)
        .action(async (id: string, opts) => {
            try {
                const client = createClient();
                const orgId = await client.getDefaultOrgId();
                const alert = await readAlertForDelete(client, orgId, id);
                if (!alert) {
                    log.info(`Alert ${id} does not exist (any more)`);
                    return;
                }
                const env = await alertEnvironment(client, orgId, alert);
                const pending = alert.alertStatus === 'PENDING';
                if (!opts.confirm) {
                    log.header('Delete alert: dry run');
                    printAlerts([normalizeAlert(alert)]);
                    if (pending) log.warn(CHANGE_IN_PROGRESS);
                    log.info(
                        `Re-run with --confirm "${alert.name}"${isProductionEnv(env.name, env.isProduction) ? ' --allow-production' : ''}`,
                    );
                    return;
                }
                if (pending) {
                    log.error(CHANGE_IN_PROGRESS);
                    process.exitCode = 1;
                    return;
                }
                if (opts.confirm !== alert.name) {
                    log.error('Deletion refused: --confirm does not match the alert name.');
                    process.exitCode = 1;
                    return;
                }
                if (isProductionEnv(env.name, env.isProduction) && !opts.allowProduction) {
                    const decision = checkPreapproval({ orgId, env }, 'delete_alert');
                    if (!decision.productionPreapproved) {
                        log.error('Deletion refused: production requires --allow-production.');
                        process.exitCode = 1;
                        return;
                    }
                    log.warn(`Production deletion pre-approved (${decision.preapprovalSource})`);
                }
                const result = await executeDeleteAlert(client, orgId, alert);
                if (result.verifiedAbsent) log.success(result.message);
                else log.warn(`${result.message} Status: ${result.status}`);
            } catch (error) {
                log.error(`Deleting the alert failed: ${errorMessage(error)}`);
                process.exitCode = 1;
            }
        });

    return alerts;
}
