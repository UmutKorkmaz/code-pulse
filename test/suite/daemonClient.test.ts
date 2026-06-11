import * as assert from 'assert';
import { DaemonClient, DaemonEnvelope } from '../../src/client/DaemonClient';
import { ConfigManager } from '../../src/utils/ConfigManager';
import { Logger } from '../../src/utils/Logger';
import { CodingSession } from '../../src/tracker/TimeTracker';

interface RecordedRequest {
    method: string;
    pathname: string;
    body?: { events?: DaemonEnvelope[] };
}

function makeSession(overrides: Partial<CodingSession> = {}): CodingSession {
    return {
        id: 'session-1',
        startTime: new Date('2026-06-10T08:00:00.000Z'),
        duration: 5 * 60 * 1000,
        idleDuration: 0,
        project: 'code-pulse',
        language: 'typescript',
        file: 'src/extension.ts',
        branch: 'main',
        isActive: true,
        heartbeats: 3,
        keystrokes: 120,
        linesAdded: 10,
        linesRemoved: 2,
        tags: [],
        ...overrides
    };
}

suite('DaemonClient Test Suite', () => {
    let logger: Logger;
    let configManager: ConfigManager;
    let client: DaemonClient;
    let requests: RecordedRequest[] = [];
    let failPost = false;
    let failHealth = false;

    suiteSetup(() => {
        logger = new Logger(__dirname, 'debug');
        configManager = new ConfigManager();
        configManager.isDaemonEnabled = () => true;
    });

    suiteTeardown(() => {
        if (logger) {
            logger.dispose();
        }
    });

    setup(async () => {
        requests = [];
        failPost = false;
        failHealth = false;

        client = new DaemonClient(configManager, logger);

        // Stub the HTTP layer — no real socket is ever opened and no real ports are hit.
        (client as any).request = async (
            method: 'GET' | 'POST',
            pathname: string,
            body?: Record<string, unknown>
        ) => {
            requests.push({ method, pathname, body: body as RecordedRequest['body'] });

            if (pathname === '/v1/health') {
                if (failHealth) {
                    throw new Error('daemon health check failed (stub)');
                }

                return { success: true, data: { status: 'ok' }, timestamp: new Date().toISOString() };
            }

            if (pathname === '/v1/events/ingest') {
                if (failPost) {
                    throw new Error('daemon ingest failed (stub)');
                }

                const events = (body?.events as DaemonEnvelope[]) || [];
                return { success: true, data: { accepted: events.length }, timestamp: new Date().toISOString() };
            }

            throw new Error(`Unexpected daemon request: ${method} ${pathname}`);
        };

        await client.connect();
        assert.strictEqual(client.isDaemonMode(), true, 'Client should connect via the stubbed health check');
    });

    teardown(async () => {
        client.stopForwarding();
        failPost = false;
        await client.disconnect();
    });

    function ingestRequests(): RecordedRequest[] {
        return requests.filter(request => request.pathname === '/v1/events/ingest');
    }

    function ingestedEvents(): DaemonEnvelope[] {
        return ingestRequests().flatMap(request => request.body?.events || []);
    }

    async function forwardTick(): Promise<void> {
        await (client as any).forwardCurrentSession();
    }

    async function settlePendingIngest(): Promise<void> {
        await new Promise(resolve => setImmediate(resolve));
    }

    test('Should not re-send identical session state on subsequent ticks', async () => {
        const base = makeSession();
        // Long interval so the timer never fires during the test — ticks are driven manually.
        client.startForwarding(() => ({ ...base }), 600000);

        await forwardTick();
        await forwardTick();
        await forwardTick();

        assert.strictEqual(ingestRequests().length, 1, 'Identical session state must be forwarded only once');
        const events = ingestedEvents();
        assert.strictEqual(events.length, 1);
        assert.strictEqual(events[0].type, 'session.updated');
        assert.strictEqual(events[0].src, 'vscode');

        // A real change to the session produces a new envelope.
        base.keystrokes += 25;
        await forwardTick();

        assert.strictEqual(ingestRequests().length, 2, 'A changed fingerprint must trigger a new forward');
    });

    test('Should forward durations in seconds per the daemon protocol contract', async () => {
        // TimeTracker accumulates ms; the wire contract (protocol CodingSession) is seconds.
        const session = makeSession({
            id: 'session-units-1',
            duration: 30 * 60 * 1000, // 30 minutes in ms
            idleDuration: 90 * 1000 // 90 seconds in ms
        });

        client.startForwarding(() => ({ ...session }), 600000);
        await forwardTick();

        const events = ingestedEvents();
        assert.strictEqual(events.length, 1);

        const payloadSession = events[0].payload.session as { duration: number; idleDuration: number };
        assert.strictEqual(payloadSession.duration, 30 * 60, 'duration must be forwarded in seconds, not ms');
        assert.strictEqual(payloadSession.idleDuration, 90, 'idleDuration must be forwarded in seconds, not ms');
    });

    test('Should emit a final session.ended envelope when notified of session end', async () => {
        const session = makeSession({ id: 'session-ended-1' });

        client.notifySessionEnded({ ...session, endTime: new Date() });
        await settlePendingIngest();

        const events = ingestedEvents();
        assert.strictEqual(events.length, 1);
        assert.strictEqual(events[0].type, 'session.ended');
        assert.strictEqual(events[0].v, 1);

        const payloadSession = events[0].payload.session as { id: string; isActive: boolean };
        assert.strictEqual(payloadSession.id, 'session-ended-1');
        assert.strictEqual(payloadSession.isActive, false);

        // The same ended session must not be emitted twice.
        client.notifySessionEnded({ ...session, endTime: new Date() });
        await settlePendingIngest();
        assert.strictEqual(ingestedEvents().length, 1);
    });

    test('Should emit session.ended when the provider stops returning a session', async () => {
        const base = makeSession({ id: 'session-provider-1' });
        let current: CodingSession | null = { ...base };
        client.startForwarding(() => current, 600000);

        await forwardTick();
        assert.strictEqual(ingestedEvents()[0].type, 'session.updated');

        // Session ends between ticks without an explicit notifySessionEnded call.
        current = null;
        await forwardTick();
        await settlePendingIngest();

        const events = ingestedEvents();
        assert.strictEqual(events.length, 2);
        assert.strictEqual(events[1].type, 'session.ended');

        const payloadSession = events[1].payload.session as { id: string; isActive: boolean };
        assert.strictEqual(payloadSession.id, 'session-provider-1');
        assert.strictEqual(payloadSession.isActive, false);

        // Further empty ticks do not re-emit the ended envelope.
        await forwardTick();
        await settlePendingIngest();
        assert.strictEqual(ingestedEvents().length, 2);
    });

    test('Should fall back after a failed POST and resume forwarding when health succeeds', async () => {
        const base = makeSession({ id: 'session-reconnect-1' });
        client.startForwarding(() => ({ ...base }), 600000);

        // The first forward fails — the client must buffer the event and drop to fallback mode.
        failPost = true;
        await forwardTick();

        assert.strictEqual(client.isFallbackMode(), true, 'Failed POST should switch the client to fallback mode');
        assert.strictEqual((client as any).pendingEvents.length, 1, 'Failed event should be buffered');

        // While in fallback, ticks do not attempt any POSTs.
        const attemptsWhileDown = ingestRequests().length;
        base.keystrokes += 10;
        await forwardTick();
        assert.strictEqual(ingestRequests().length, attemptsWhileDown, 'No POSTs should happen while in fallback');

        // Health succeeds again — the reconnect probe re-enables daemon mode and flushes the buffer.
        failPost = false;
        await (client as any).probeReconnect();

        assert.strictEqual(client.isDaemonMode(), true, 'Successful health check should restore daemon mode');

        const flushRequest = ingestRequests()[ingestRequests().length - 1];
        const flushedSession = (flushRequest.body?.events || [])[0].payload.session as { id: string };
        assert.strictEqual(flushedSession.id, 'session-reconnect-1', 'Buffered event should be flushed on reconnect');

        // Forwarding is live again: the changed session is posted on the next tick.
        const attemptsAfterReconnect = ingestRequests().length;
        await forwardTick();

        assert.strictEqual(ingestRequests().length, attemptsAfterReconnect + 1, 'Forwarding should resume after reconnect');
        const resumedEvents = ingestRequests()[ingestRequests().length - 1].body?.events || [];
        assert.strictEqual(resumedEvents[0].type, 'session.updated');
    });

    test('Should arm the reconnect probe after a failed initial connect and notify on recovery', async () => {
        // Reset to a clean disconnected client — simulates the daemon not running at activation.
        await client.disconnect();

        failHealth = true;
        const connected = await client.connect();

        assert.strictEqual(connected, false, 'Initial connect must report failure when health is down');
        assert.strictEqual(client.isFallbackMode(), true);
        assert.ok((client as any).reconnectTimer, 'A failed initial connect must arm the reconnect probe');

        let reconnectedCalls = 0;
        client.setReconnectedHandler(() => {
            reconnectedCalls += 1;
        });

        // The daemon comes up later — the probe restores daemon mode and notifies the extension.
        failHealth = false;
        await (client as any).probeReconnect();

        assert.strictEqual(client.isDaemonMode(), true, 'Probe must restore daemon mode once health succeeds');
        assert.strictEqual(reconnectedCalls, 1, 'Reconnect must invoke the registered handler');
        assert.strictEqual((client as any).reconnectTimer, undefined, 'Probe should disarm after reconnecting');
    });

    test('refreshConnection should not throw when health passes but the flush POST fails', async () => {
        const base = makeSession({ id: 'session-flush-fail-1' });
        client.startForwarding(() => ({ ...base }), 600000);

        // Drop to fallback with one buffered event.
        failPost = true;
        await forwardTick();
        assert.strictEqual(client.isFallbackMode(), true);
        assert.strictEqual((client as any).pendingEvents.length, 1, 'Failed event should be buffered');

        // Health is back but ingest still fails — a settings change must not throw out of the handler.
        await client.refreshConnection();

        assert.strictEqual(
            (client as any).pendingEvents.length,
            1,
            'A failed flush must re-queue the buffered event instead of throwing'
        );
    });
});
