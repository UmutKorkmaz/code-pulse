import * as assert from 'assert';
import * as vscode from 'vscode';
import {
    AiDetectionForwarder,
    TerminalAiDetector,
    TERMINAL_DETECTION_CONFIDENCE,
    TERMINAL_DETECTION_DEBOUNCE_MS
} from '../../src/detectors/TerminalAiDetector';
import { DaemonEnvelope } from '../../src/client/DaemonClient';
import { Logger } from '../../src/utils/Logger';

interface EvidenceShape {
    type: string;
    timestamp: string;
    hash: string;
}

function makeTerminal(pid: number | undefined, name = 'zsh'): vscode.Terminal {
    return { name, processId: Promise.resolve(pid) } as unknown as vscode.Terminal;
}

// pid ppid comm — claude runs as a grandchild of the terminal shell (pid 100).
const PS_FIXTURE = [
    '    1     0 /sbin/launchd',
    '  100     1 /bin/zsh',
    '  150   100 node',
    '  200   150 /Users/dev/.local/bin/claude',
    '  300     1 /usr/bin/top',
    '  400   100 vim'
].join('\n');

suite('TerminalAiDetector Test Suite', () => {
    let logger: Logger;
    let forwarded: DaemonEnvelope[] = [];
    let daemonMode = true;
    let forwarder: AiDetectionForwarder;
    let openEmitter: vscode.EventEmitter<vscode.Terminal>;
    let closeEmitter: vscode.EventEmitter<vscode.Terminal>;

    suiteSetup(() => {
        logger = new Logger(__dirname, 'debug');
    });

    suiteTeardown(() => {
        logger.dispose();
    });

    setup(() => {
        forwarded = [];
        daemonMode = true;
        forwarder = {
            isDaemonMode: () => daemonMode,
            ingest: async events => {
                forwarded.push(...events);
            }
        };
        openEmitter = new vscode.EventEmitter<vscode.Terminal>();
        closeEmitter = new vscode.EventEmitter<vscode.Terminal>();
    });

    teardown(() => {
        openEmitter.dispose();
        closeEmitter.dispose();
    });

    function makeDetector(
        options: {
            terminals?: vscode.Terminal[];
            psOutput?: string;
            psError?: boolean;
            detectionDebounceMs?: number;
        } = {}
    ): TerminalAiDetector {
        const terminals = options.terminals ?? [makeTerminal(100)];

        return new TerminalAiDetector(forwarder, logger, {
            // Long interval so the timer never fires during a test — scans are driven manually.
            intervalMs: 600000,
            // Debounce disabled by default so multi-scan tests observe every
            // forward; the debounce tests opt in explicitly.
            detectionDebounceMs: options.detectionDebounceMs ?? 0,
            listTerminals: () => terminals,
            onDidOpenTerminal: openEmitter.event,
            onDidCloseTerminal: closeEmitter.event,
            runPs: async () => {
                if (options.psError) {
                    throw new Error('ps unavailable (stub)');
                }

                return options.psOutput ?? PS_FIXTURE;
            }
        });
    }

    async function settle(ticks = 5): Promise<void> {
        for (let i = 0; i < ticks; i++) {
            await new Promise(resolve => setImmediate(resolve));
        }
    }

    test('Should detect an AI CLI under a terminal and forward ai.tool.detected', async () => {
        const detector = makeDetector();
        await detector.scanNow();

        assert.strictEqual(forwarded.length, 1, 'Exactly one detection envelope expected');
        const envelope = forwarded[0];
        assert.strictEqual(envelope.type, 'ai.tool.detected');
        assert.strictEqual(envelope.src, 'vscode');
        assert.strictEqual(envelope.v, 1);
        assert.strictEqual(envelope.payload.type, 'ai.tool.detected');
        assert.strictEqual(envelope.payload.tool, 'Claude Code');
        assert.strictEqual(envelope.payload.confidence, TERMINAL_DETECTION_CONFIDENCE);

        const evidence = envelope.payload.evidence as EvidenceShape[];
        assert.strictEqual(evidence.length, 1);
        assert.strictEqual(evidence[0].type, 'terminal');
        assert.ok(evidence[0].hash.length > 0, 'Evidence must carry a content hash');
        assert.ok(evidence[0].timestamp.length > 0, 'Evidence must carry a timestamp');

        const running = detector.getRunningTools();
        assert.deepStrictEqual(
            running.map(state => state.tool),
            ['Claude Code'],
            'Local running-state map must track the detected tool'
        );

        detector.dispose();
    });

    test('Should forward the canonical registry scanner id and tool for a claude process', async () => {
        // The fixture's matched basename is 'claude' — the envelope must carry
        // the registry-catalog identity (scn.claude-code / 'Claude Code') so
        // the daemon merges terminal evidence into the same session as its
        // own process/log detections instead of double-counting the tool.
        const detector = makeDetector();
        await detector.scanNow();

        assert.strictEqual(forwarded.length, 1, 'Exactly one detection envelope expected');
        assert.strictEqual(forwarded[0].payload.scannerId, 'scn.claude-code');
        assert.strictEqual(forwarded[0].payload.tool, 'Claude Code');

        detector.dispose();
    });

    test('Should ignore AI processes that are not descendants of a terminal', async () => {
        // claude (pid 900) hangs off launchd, not the terminal shell.
        const psOutput = ['  100     1 /bin/zsh', '  900     1 claude'].join('\n');
        const detector = makeDetector({ psOutput });

        await detector.scanNow();

        assert.strictEqual(forwarded.length, 0, 'Out-of-terminal processes must not be forwarded');
        assert.deepStrictEqual(detector.getRunningTools(), []);

        detector.dispose();
    });

    test('Should no-op when ps fails', async () => {
        const detector = makeDetector({ psError: true });

        await detector.scanNow();

        assert.strictEqual(forwarded.length, 0, 'A failed ps must not forward anything');
        assert.deepStrictEqual(detector.getRunningTools(), []);

        detector.dispose();
    });

    test('Should keep local running state without forwarding while daemon is unreachable', async () => {
        daemonMode = false;
        const detector = makeDetector();

        await detector.scanNow();

        assert.strictEqual(forwarded.length, 0, 'No envelopes while the daemon is in fallback mode');
        assert.deepStrictEqual(
            detector.getRunningTools().map(state => state.tool),
            ['Claude Code'],
            'Local state must still update so the dashboard works daemon-absent'
        );

        detector.dispose();
    });

    test('Should not match a process that merely contains an AI CLI name', async () => {
        const psOutput = ['  100     1 /bin/zsh', '  210   100 myclaudetool', '  211   100 claudette'].join('\n');
        const detector = makeDetector({ psOutput });

        await detector.scanNow();

        assert.strictEqual(forwarded.length, 0, 'Substring-named processes must not spoof a detection');
        assert.deepStrictEqual(detector.getRunningTools(), []);

        detector.dispose();
    });

    test('Should match a boundary-delimited CLI basename like claude-1.2', async () => {
        const psOutput = ['  100     1 /bin/zsh', '  220   100 /usr/local/bin/claude-1.2'].join('\n');
        const detector = makeDetector({ psOutput });

        await detector.scanNow();

        assert.strictEqual(forwarded.length, 1, 'A versioned CLI basename must still match');
        assert.strictEqual(forwarded[0].payload.tool, 'Claude Code');
        assert.strictEqual(forwarded[0].payload.scannerId, 'scn.claude-code');

        detector.dispose();
    });

    test('Should forward once for two polls within the debounce window', async () => {
        const detector = makeDetector({ detectionDebounceMs: TERMINAL_DETECTION_DEBOUNCE_MS });

        await detector.scanNow();
        const firstSeenAt = detector.getRunningTools()[0]?.lastSeenAt;
        assert.ok(firstSeenAt !== undefined, 'First poll must record local running state');

        // Real-clock gap so the second poll's lastSeen is observably newer.
        await new Promise(resolve => setTimeout(resolve, 10));
        await detector.scanNow();

        assert.strictEqual(forwarded.length, 1, 'Second poll within the debounce window must not re-forward');
        const secondSeenAt = detector.getRunningTools()[0]?.lastSeenAt;
        assert.ok(
            secondSeenAt !== undefined && secondSeenAt > firstSeenAt,
            'lastSeen must stay fresh on every poll even when forwarding is debounced'
        );

        detector.dispose();
    });

    test('Should re-forward once the debounce window has elapsed', async () => {
        const detector = makeDetector({ detectionDebounceMs: 20 });

        await detector.scanNow();
        await new Promise(resolve => setTimeout(resolve, 30));
        await detector.scanNow();

        assert.strictEqual(forwarded.length, 2, 'A poll past the debounce window must forward again');

        detector.dispose();
    });

    test('Should rescan when a terminal opens', async () => {
        const detector = makeDetector();
        detector.start();
        await settle();

        const initialCount = forwarded.length;
        assert.ok(initialCount >= 1, 'start() must run an initial scan');

        openEmitter.fire(makeTerminal(100));
        await settle();

        assert.ok(forwarded.length > initialCount, 'Opening a terminal must trigger a rescan');

        detector.dispose();
    });

    test('Should clear timer, listeners, and state on dispose', async () => {
        const detector = makeDetector();
        detector.start();
        await settle();
        assert.ok(forwarded.length >= 1, 'Initial scan should have detected claude');

        detector.dispose();

        assert.strictEqual((detector as any).scanTimer, undefined, 'Interval timer must be cleared');
        assert.deepStrictEqual(detector.getRunningTools(), [], 'Running state must be cleared');

        const countAfterDispose = forwarded.length;
        openEmitter.fire(makeTerminal(100));
        await settle();
        await detector.scanNow();

        assert.strictEqual(forwarded.length, countAfterDispose, 'No scans may run after dispose');
    });
});
