/**
 * Tests for LogsApi.tailEvents: what a followed log must never lose, repeat or hide.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LogsApi, type TailEvent } from '../../src/api/LogsApi.js';

const download = vi.fn();
const get = vi.fn();
const ch2 = { findByName: vi.fn(), getDeployment: vi.fn(), getDeploymentSpecs: vi.fn() };

const REPLICA = 'orders-sapi-abc';
const NOW = Date.parse('2026-11-01T12:00:00.000Z');
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const line = (offsetMs: number, body: string, level = 'INFO') =>
    `${iso(offsetMs)} ${level} [${REPLICA}] org.sample.Logger event:00000000-0000-0000-0000-000000000000 [main] - ${body}`;
const file = (...lines: string[]) => Buffer.from(lines.join('\n') + '\n');

/** Pull events until `count` have arrived, then stop the stream. */
async function collect(
    stream: AsyncGenerator<TailEvent>,
    controller: AbortController,
    until: (e: TailEvent[]) => boolean,
) {
    const events: TailEvent[] = [];
    for await (const event of stream) {
        events.push(event);
        if (until(events)) controller.abort();
    }
    return events;
}

const recordsOf = (events: TailEvent[]) =>
    events.flatMap((e) => (e.type === 'records' ? e.entries.map((x) => x.message) : []));

describe('LogsApi.tailEvents', () => {
    let api: LogsApi;
    beforeEach(() => {
        vi.resetAllMocks();
        vi.useRealTimers();
        api = new LogsApi({ download, get } as any, ch2 as any);
        // These tests cover the full-file read: the incremental endpoint is unavailable.
        get.mockRejectedValue({ response: { status: 405 } });
        ch2.findByName.mockResolvedValue({ id: 'dep-1', name: 'orders-sapi' });
        ch2.getDeployment.mockResolvedValue({ id: 'dep-1', desiredVersion: 'spec-2', lastSuccessfulVersion: 'spec-1' });
        ch2.getDeploymentSpecs.mockResolvedValue([{ version: 'spec-2' }, { version: 'spec-1' }]);
        vi.spyOn(Date, 'now').mockReturnValue(NOW);
    });

    const tail = (controller: AbortController, options: Record<string, unknown> = {}) =>
        api.tailEvents('org-1', 'env-1', 'orders-sapi', { intervalMs: 1, signal: controller.signal, ...options });

    it('keeps every record that shares a timestamp, including identical lines, and repeats none', async () => {
        const controller = new AbortController();
        const first = file(line(-5000, 'a'), line(-1000, 'same'), line(-1000, 'same'), line(-1000, 'other'));
        // The next read re-sends everything and adds a third identical line and a newer one.
        const second = file(
            line(-5000, 'a'),
            line(-1000, 'same'),
            line(-1000, 'same'),
            line(-1000, 'other'),
            line(-1000, 'same'),
            line(-500, 'newer'),
        );
        download.mockResolvedValueOnce(first).mockResolvedValue(second);

        const events = await collect(tail(controller), controller, (e) => recordsOf(e).length >= 6);

        expect(recordsOf(events)).toEqual(['a', 'same', 'same', 'other', 'same', 'newer']);
    });

    it('advances past records a presentation filter hides, and still shows later matches', async () => {
        const controller = new AbortController();
        download
            .mockResolvedValueOnce(file(line(-3000, 'noise', 'INFO')))
            .mockResolvedValue(file(line(-3000, 'noise', 'INFO'), line(-2000, 'boom', 'ERROR')));

        const events = await collect(tail(controller, { level: 'ERROR' }), controller, (e) => recordsOf(e).length >= 1);

        expect(recordsOf(events)).toEqual(['boom']);
    });

    it('announces the spec it follows and when the followed spec changes', async () => {
        const controller = new AbortController();
        ch2.getDeployment
            // The first poll resolves the spec twice: once for the incremental attempt, once for the file read.
            .mockResolvedValueOnce({ id: 'dep-1', desiredVersion: 'spec-1' })
            .mockResolvedValueOnce({ id: 'dep-1', desiredVersion: 'spec-1' })
            .mockResolvedValue({ id: 'dep-1', desiredVersion: 'spec-2' });
        download.mockResolvedValueOnce(file(line(-4000, 'from one'))).mockResolvedValue(file(line(-2000, 'from two')));

        const events = await collect(tail(controller), controller, (e) => recordsOf(e).length >= 2);

        const changes = events.filter((e) => e.type === 'specChange');
        expect(changes).toEqual([
            { type: 'specChange', from: null, to: 'spec-1' },
            { type: 'specChange', from: 'spec-1', to: 'spec-2' },
        ]);
        expect(recordsOf(events)).toEqual(['from one', 'from two']);
    });

    it('pins an exact spec: reads only that spec, never the desired one', async () => {
        const controller = new AbortController();
        download.mockResolvedValue(file(line(-2000, 'pinned line')));

        const events = await collect(
            tail(controller, { specId: 'spec-1' }),
            controller,
            (e) => recordsOf(e).length >= 1,
        );

        expect(recordsOf(events)).toEqual(['pinned line']);
        const urls = download.mock.calls.map((c) => c[0] as string);
        expect(urls.every((u) => u.includes('/specs/spec-1/'))).toBe(true);
        expect(events.find((e) => e.type === 'specChange')).toEqual({ type: 'specChange', from: null, to: 'spec-1' });
    });

    it('refuses a spec that does not belong to the deployment, before reading any log', async () => {
        const controller = new AbortController();
        await expect(collect(tail(controller, { specId: 'spec-other' }), controller, () => false)).rejects.toThrow(
            /does not belong/,
        );
        expect(download).not.toHaveBeenCalled();
    });

    it('errors, rather than substituting another spec, when a pinned spec has no log file', async () => {
        const controller = new AbortController();
        download.mockRejectedValue({ response: { status: 404 } });
        await expect(collect(tail(controller, { specId: 'spec-1' }), controller, () => false)).rejects.toThrow(
            /no log file/,
        );
    });

    it('reports a read error as an event and keeps following', async () => {
        const controller = new AbortController();
        download.mockRejectedValueOnce(new Error('temporary outage')).mockResolvedValue(file(line(-1000, 'recovered')));

        const events = await collect(tail(controller), controller, (e) => recordsOf(e).length >= 1);

        expect(events.find((e) => e.type === 'error')).toMatchObject({
            message: expect.stringContaining('temporary outage'),
        });
        expect(recordsOf(events)).toEqual(['recovered']);
    });

    it('stops promptly when cancelled during the wait, without another read', async () => {
        const controller = new AbortController();
        download.mockResolvedValue(file(line(-1000, 'x')));
        const stream = api.tailEvents('org-1', 'env-1', 'orders-sapi', {
            intervalMs: 60_000,
            signal: controller.signal,
        });
        const started = process.hrtime.bigint();
        const events: TailEvent[] = [];
        setTimeout(() => controller.abort(), 20);
        for await (const event of stream) events.push(event);
        const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
        expect(elapsedMs).toBeLessThan(2000);
        expect(download).toHaveBeenCalledTimes(1);
    });

    it('says so when the file window no longer reaches back to the last record seen', async () => {
        const controller = new AbortController();
        const filler = 'x'.repeat(2000);
        const many = (from: number) => Array.from({ length: 400 }, (_, i) => line(from + i, `${filler}-${from + i}`));
        download
            .mockResolvedValueOnce(file(line(-2000, 'early')))
            // A burst bigger than the window arrived between two reads: the older part is out of reach.
            .mockResolvedValue(file(...many(-1000)));

        const events = await collect(tail(controller), controller, (e) => e.some((x) => x.type === 'gap'));

        expect(events.some((e) => e.type === 'gap')).toBe(true);
    });
});

/**
 * The incremental read, modelled on the structured endpoint as observed: 10 records per request
 * whatever `limit` says, oldest first, `startTime` inclusive, each record with a stable docId.
 */
describe('LogsApi.tailEvents incremental transport', () => {
    let api: LogsApi;
    let store: Array<{ docId: string; timestamp: number; message: string; logLevel: string }>;
    const record = (id: number, offsetMs: number, message = `m${id}`, logLevel = 'INFO') => ({
        docId: String(1000 + id),
        timestamp: NOW + offsetMs,
        message,
        replicaId: REPLICA,
        logLevel,
        context: { logger: 'org.sample.Logger' },
    });

    /** A fake platform over `store`: the 10 oldest records from startTime, inclusive. */
    const serve = async (_url: string, config: { params: { startTime: number; endTime: number } }) =>
        store
            .filter((r) => r.timestamp >= config.params.startTime && r.timestamp <= config.params.endTime)
            .sort((a, b) => a.timestamp - b.timestamp || Number(a.docId) - Number(b.docId))
            .slice(0, 10);

    beforeEach(() => {
        vi.resetAllMocks();
        vi.spyOn(Date, 'now').mockReturnValue(NOW);
        api = new LogsApi({ download, get } as any, ch2 as any);
        ch2.findByName.mockResolvedValue({ id: 'dep-1', name: 'orders-sapi' });
        ch2.getDeployment.mockResolvedValue({ id: 'dep-1', desiredVersion: 'spec-2', lastSuccessfulVersion: 'spec-1' });
        ch2.getDeploymentSpecs.mockResolvedValue([{ version: 'spec-2' }, { version: 'spec-1' }]);
        store = [];
        get.mockImplementation(serve);
    });

    const run = (controller: AbortController, until: (e: TailEvent[]) => boolean, options = {}) =>
        collect(
            api.tailEvents('org-1', 'env-1', 'orders-sapi', { intervalMs: 1, signal: controller.signal, ...options }),
            controller,
            until,
        );

    it('reads only records after the last one seen, never the file', async () => {
        store = [record(1, -5000), record(2, -4000)];
        const controller = new AbortController();
        let polls = 0;
        get.mockImplementation(async (url: string, config: any) => {
            if (++polls === 2) store.push(record(3, -100));
            return serve(url, config);
        });

        const events = await run(controller, (e) => recordsOf(e).length >= 3);

        expect(recordsOf(events)).toEqual(['m1', 'm2', 'm3']);
        expect(download).not.toHaveBeenCalled();
        const starts = get.mock.calls.map((c) => c[1].params.startTime);
        expect(starts[0]).toBe(NOW - 30_000);
        expect(starts.at(-1)).toBeGreaterThanOrEqual(NOW - 4000); // later reads start at the last record, not 30s back
        expect(events[0]).toEqual({ type: 'transport', mode: 'incremental' });
    });

    it('sends epoch milliseconds, ascending, with the organization and environment headers', async () => {
        store = [record(1, -1000)];
        const controller = new AbortController();
        await run(controller, (e) => recordsOf(e).length >= 1);
        const [url, config] = get.mock.calls[0];
        expect(url).toContain('/deployments/dep-1/specs/spec-2/logs');
        expect(Number.isInteger(config.params.startTime)).toBe(true);
        expect(Number.isInteger(config.params.endTime)).toBe(true);
        expect(config.params.descending).toBe(false);
        expect(config.headers).toEqual({ 'X-ANYPNT-ORG-ID': 'org-1', 'X-ANYPNT-ENV-ID': 'env-1' });
    });

    it('drains a backlog across pages of 10 without waiting between them, losing and repeating nothing', async () => {
        store = Array.from({ length: 37 }, (_, i) => record(i, -20_000 + i * 10));
        const controller = new AbortController();

        const events = await run(controller, (e) => recordsOf(e).length >= 37);

        expect(recordsOf(events)).toEqual(store.map((r) => r.message));
        expect(new Set(recordsOf(events)).size).toBe(37);
    });

    it('keeps records that share a millisecond with the last one, by docId, and repeats none', async () => {
        // Seven records at one millisecond straddle a page edge, then two more arrive at that same millisecond.
        store = [record(1, -3000), ...Array.from({ length: 9 }, (_, i) => record(10 + i, -2000, `same${i}`))];
        const controller = new AbortController();
        let polls = 0;
        get.mockImplementation(async (url: string, config: any) => {
            if (++polls === 3) store.push(record(30, -2000, 'late-same-ms'));
            return serve(url, config);
        });

        const events = await run(controller, (e) => recordsOf(e).includes('late-same-ms'));

        const messages = recordsOf(events);
        expect(messages.filter((m) => m.startsWith('same'))).toHaveLength(9);
        expect(messages.filter((m) => m === 'late-same-ms')).toHaveLength(1);
        expect(new Set(messages).size).toBe(messages.length);
    });

    it('says so, and does not hang, when more than a page of records share one millisecond', async () => {
        store = Array.from({ length: 14 }, (_, i) => record(i, -2000, `tie${i}`));
        const controller = new AbortController();

        const events = await run(controller, (e) => e.some((x) => x.type === 'gap'));

        expect(events.some((e) => e.type === 'gap')).toBe(true);
        expect(recordsOf(events).length).toBeGreaterThanOrEqual(10);
    });

    it('maps the platform record to a log entry, and a presentation filter does not move the position', async () => {
        store = [
            { ...record(1, -3000, 'quiet'), logLevel: 'INFO' },
            { ...record(2, -2000, 'boom\n  at org.sample.Thing', 'ERROR'), docId: '1002' },
        ];
        const controller = new AbortController();

        const events = await run(controller, (e) => recordsOf(e).length >= 1, { level: 'ERROR' });

        const shown = events.find((e) => e.type === 'records');
        expect(shown).toMatchObject({
            entries: [
                {
                    priority: 'ERROR',
                    instanceId: REPLICA,
                    loggerName: 'org.sample.Logger',
                    message: 'boom\n  at org.sample.Thing',
                },
            ],
        });
        expect(recordsOf(events)).toEqual(['boom\n  at org.sample.Thing']);
    });

    it('pins an exact spec on the incremental endpoint too', async () => {
        store = [record(1, -1000)];
        const controller = new AbortController();
        await run(controller, (e) => recordsOf(e).length >= 1, { specId: 'spec-1' });
        expect(get.mock.calls.every((c) => (c[0] as string).includes('/specs/spec-1/logs'))).toBe(true);
    });

    it('follows the last successful spec while the desired one has no records, and says so', async () => {
        const bySpec: Record<string, typeof store> = { 'spec-2': [], 'spec-1': [record(1, -1000, 'old gen')] };
        get.mockImplementation(async (url: string, config: any) => {
            const spec = /specs\/([^/]+)\/logs/.exec(url)![1];
            store = bySpec[spec];
            return serve(url, config);
        });
        const controller = new AbortController();

        const events = await run(controller, (e) => recordsOf(e).length >= 1);

        expect(events.find((e) => e.type === 'specChange')).toEqual({
            type: 'specChange',
            from: null,
            to: 'spec-1',
            fallbackFromSpecId: 'spec-2',
        });
        expect(recordsOf(events)).toEqual(['old gen']);
    });

    it.each([
        ['an unsupported status', () => get.mockRejectedValue({ response: { status: 405 } })],
        ['an unexpected shape', () => get.mockResolvedValue({ not: 'a list' })],
    ])('falls back to the full file, labelled, on %s', async (_label, breakEndpoint) => {
        breakEndpoint();
        download.mockResolvedValue(file(line(-1000, 'from file')));
        const controller = new AbortController();

        const events = await run(controller, (e) => recordsOf(e).length >= 1);

        expect(events[0]).toMatchObject({ type: 'transport', mode: 'file' });
        expect(recordsOf(events)).toEqual(['from file']);
    });

    it('does not mistake a server error for an unsupported endpoint: it reports it and keeps following', async () => {
        get.mockRejectedValueOnce({ response: { status: 503 }, message: 'unavailable' }).mockImplementation(serve);
        store = [record(1, -1000)];
        const controller = new AbortController();

        const events = await run(controller, (e) => recordsOf(e).length >= 1);

        expect(events.find((e) => e.type === 'error')).toBeDefined();
        expect(events.some((e) => e.type === 'transport' && e.mode === 'file')).toBe(false);
        expect(download).not.toHaveBeenCalled();
        expect(recordsOf(events)).toEqual(['m1']);
    });
});

describe('LogsApi.tailEvents incremental transport: review regressions', () => {
    let api: LogsApi;
    beforeEach(() => {
        vi.resetAllMocks();
        vi.spyOn(Date, 'now').mockReturnValue(NOW);
        api = new LogsApi({ download, get } as any, ch2 as any);
        ch2.findByName.mockResolvedValue({ id: 'dep-1', name: 'orders-sapi' });
        ch2.getDeployment.mockResolvedValue({ id: 'dep-1', desiredVersion: 'spec-2', lastSuccessfulVersion: 'spec-1' });
        ch2.getDeploymentSpecs.mockResolvedValue([{ version: 'spec-2' }, { version: 'spec-1' }]);
    });
    const row = (id: number, offsetMs: number, message: string | null = `m${id}`) => ({
        docId: String(5000 + id),
        timestamp: NOW + offsetMs,
        message,
        replicaId: REPLICA,
        logLevel: 'INFO',
    });
    const page = (rows: unknown[], start: number) =>
        (rows as Array<{ timestamp: number }>)
            .filter((r) => r.timestamp >= start)
            .sort((a, b) => a.timestamp - b.timestamp)
            .slice(0, 10);
    const run = (controller: AbortController, until: (e: TailEvent[]) => boolean) =>
        collect(
            api.tailEvents('org-1', 'env-1', 'orders-sapi', { intervalMs: 1, signal: controller.signal }),
            controller,
            until,
        );

    it('treats a 404 as "no records yet", keeps the incremental read, and uses it once records appear', async () => {
        const rows = [row(1, -500)];
        let calls = 0;
        get.mockImplementation(async (_u: string, c: any) => {
            if (++calls <= 2) throw { response: { status: 404 } };
            return page(rows, c.params.startTime);
        });
        const controller = new AbortController();

        const events = await run(controller, (e) => recordsOf(e).length >= 1);

        expect(recordsOf(events)).toEqual(['m1']);
        expect(download).not.toHaveBeenCalled();
        expect(events.some((e) => e.type === 'transport' && e.mode === 'file')).toBe(false);
    });

    it('does not fall back to the file because one record has no message', async () => {
        get.mockImplementation(async (_u: string, c: any) => page([row(1, -500, null)], c.params.startTime));
        const controller = new AbortController();

        const events = await run(controller, (e) => recordsOf(e).length >= 1);

        expect(recordsOf(events)).toEqual(['']);
        expect(download).not.toHaveBeenCalled();
    });

    it('reports a tie of more than a page once, not on every poll', async () => {
        const rows = Array.from({ length: 14 }, (_, i) => row(i, -2000, `tie${i}`));
        get.mockImplementation(async (_u: string, c: any) => page(rows, c.params.startTime));
        const controller = new AbortController();
        let reads = 0;
        const events: TailEvent[] = [];
        for await (const e of api.tailEvents('org-1', 'env-1', 'orders-sapi', {
            intervalMs: 1,
            signal: controller.signal,
        })) {
            events.push(e);
            if (e.type === 'gap' && ++reads >= 1) setTimeout(() => controller.abort(), 40);
        }
        expect(events.filter((e) => e.type === 'gap')).toHaveLength(1);
    });

    it('skips ahead, and says so, when it cannot keep up with a busy log', async () => {
        // A record every millisecond, so every read ends at the page cap. Each request takes a second of wall
        // time, so the position falls further behind the clock with every read.
        let calls = 0;
        vi.spyOn(Date, 'now').mockImplementation(() => NOW + calls * 1000);
        get.mockImplementation(async (_u: string, c: any) => {
            calls++;
            return Array.from({ length: 10 }, (_, i) => row(c.params.startTime + i, c.params.startTime + i - NOW));
        });
        const controller = new AbortController();

        const events = await run(controller, (e) => e.some((x) => x.type === 'gap'));

        const gap = events.find((e) => e.type === 'gap');
        expect(gap).toMatchObject({ message: expect.stringContaining('fell more than 120 seconds behind') });
    });
});
