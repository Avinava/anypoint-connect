/**
 * Regression fixture: a CloudHub 2.0 log file captured right after an application start.
 *
 * Start-up output is dominated by multi-line blocks: the "Started app" banner, Mule error
 * reports whose `Message`/`Error type` lines carry no timestamp, and Java stack traces.
 * Only the first line of each block has the `<ts> <LEVEL> [<replica>] ...` prefix.
 *
 * The previous LogsApi parser treated every unprefixed line as its own INFO entry stamped
 * with the fetch time, so:
 *  - a level filter dropped the error text (it was INFO), and search found nothing;
 *  - the unprefixed lines sorted ahead of every real line and filled `limit`.
 */

export const STARTUP_APP = 'orders-sapi';
export const STARTUP_REPLICA = 'orders-sapi-6d5f7c9b8-abcde';
const NO_EVENT = '00000000-0000-0000-0000-000000000000';

function header(ts: string, level: string, logger: string, thread: string, body: string, event = NO_EVENT): string {
    return `${ts} ${level} [${STARTUP_REPLICA}] ${logger} event:${event} ${thread} - ${body}`;
}

/** Older lines from before the restart: plain one-line INFO entries. */
export const STARTUP_HISTORY = Array.from({ length: 30 }, (_, i) =>
    header(
        `2026-10-26T09:${String(i).padStart(2, '0')}:00.000Z`,
        'INFO',
        'org.mule.runtime.core.internal.processor.LoggerMessageProcessor',
        `[MuleRuntime].uber.01: [${STARTUP_APP}].poll-flow.CPU_LITE @00000001`,
        `Polled 0 orders (batch ${i})`,
    ),
);

export const STARTUP_BANNER_TS = '2026-10-26T10:00:05.000Z';
export const STARTUP_ERROR_TS = '2026-10-26T10:00:07.000Z';
export const STARTUP_LAST_TS = '2026-10-26T10:00:09.000Z';

export const STARTUP_LOG = [
    ...STARTUP_HISTORY,
    header(
        '2026-10-26T10:00:00.000Z',
        'INFO',
        'org.mule.runtime.module.launcher.MuleContainer',
        'WrapperListener_start_runner',
        'Mule Runtime starting',
    ),
    header(
        STARTUP_BANNER_TS,
        'INFO',
        'org.mule.runtime.module.deployment.internal.DefaultArchiveDeployer',
        'WrapperListener_start_runner',
        '',
    ),
    '**********************************************************************',
    `* Started app '${STARTUP_APP}'                                       *`,
    '* Application plugins:                                               *',
    '*  - HTTP : 1.10.0                                                   *',
    '**********************************************************************',
    header(
        STARTUP_ERROR_TS,
        'ERROR',
        'org.mule.runtime.core.internal.exception.OnErrorPropagateHandler',
        `[MuleRuntime].uber.03: [${STARTUP_APP}].token-flow.BLOCKING @00000003`,
        '',
        'c0ffee00-0000-4000-8000-000000000042',
    ),
    '********************************************************************************',
    "Message               : HTTP POST on resource 'https://auth.example.invalid/token' failed: Connection refused.",
    'Error type            : HTTP:CONNECTIVITY',
    `Element               : token-flow/processors/0 @ ${STARTUP_APP}:token.xml:20 (Request token)`,
    '********************************************************************************',
    '    at org.mule.extension.http.internal.request.HttpRequester.doRequest(HttpRequester.java:120)',
    '    Caused by: java.net.ConnectException: Connection refused',
    header(
        '2026-10-26T10:00:08.000Z',
        'WARN',
        'com.example.orders.TokenCache',
        `[MuleRuntime].uber.04: [${STARTUP_APP}].token-flow.CPU_LITE @00000004`,
        'Token cache empty, retrying in 30s',
    ),
    header(
        STARTUP_LAST_TS,
        'INFO',
        'org.mule.runtime.core.internal.logging.LogUtil',
        'WrapperListener_start_runner',
        'Mule is up and kicking',
    ),
    // A header without the logger/thread segment, as some platform lines are written.
    `2026-10-26T10:00:09.500Z INFO [${STARTUP_REPLICA}] Replica ready`,
].join('\n');
