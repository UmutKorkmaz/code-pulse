"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const assert_1 = __importDefault(require("assert"));
// Compiled daemon scanner modules — import via relative path to dist for tests
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ProcessWatcher } = require('../../../apps/daemon/dist/scanner/process-watcher.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { parseEtimeSeconds, parseProcessTable } = require('../../../apps/daemon/dist/scanner/processes.js');
const MANIFEST = {
    id: 'scn.claude',
    version: '1.0.0',
    displayName: 'claude-code',
    publisher: 'test',
    trust: 'official',
    capabilities: ['process'],
    processPatterns: ['claude'],
    signature: 'sig',
    bundleHash: 'hash'
};
/**
 * Harness around one ProcessWatcher: a controllable process list, a stub
 * registry host that scores like the manifest scanner (pattern present →
 * 0.4, else 0), and collectors for lifecycle events. Polls are driven
 * manually via the private poll() — the interval timer never starts.
 */
function createHarness(options = {}) {
    let processEntries = [];
    const started = [];
    const ended = [];
    const detected = [];
    const watcher = new ProcessWatcher({
        registryHost: {
            scan: async (_scannerId, ctx) => {
                const matches = ctx.processes.some(name => name.toLowerCase().includes('claude'));
                return {
                    tool: 'claude-code',
                    confidence: matches ? 0.4 : 0,
                    evidence: matches
                        ? [
                            {
                                type: 'process',
                                timestamp: new Date().toISOString(),
                                hash: 'evidence-hash'
                            }
                        ]
                        : []
                };
            }
        },
        metrics: { increment: () => undefined },
        isEnabled: () => true,
        listProcesses: async () => processEntries
    }, {
        pollIntervalMs: 60000,
        detectionDebounceMs: 0,
        presenceGracePolls: options.presenceGracePolls
    });
    watcher.on('session-started', (event) => started.push(event));
    watcher.on('session-ended', (event) => ended.push(event));
    watcher.on('detected', (event) => detected.push(event));
    return {
        watcher,
        started,
        ended,
        detected,
        setProcesses(entries) {
            processEntries = entries;
        },
        async pollOnce() {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await watcher.poll([MANIFEST]);
        }
    };
}
const CLAUDE_PROCESS = { pid: 4242, comm: 'claude', etimeSeconds: 3600 };
const OTHER_PROCESS = { pid: 1, comm: 'launchd', etimeSeconds: 90000 };
describe('ProcessWatcher presence lifecycle', () => {
    it('emits session-started once on first appearance, backdated via etime', async () => {
        const harness = createHarness();
        harness.setProcesses([OTHER_PROCESS, CLAUDE_PROCESS]);
        const beforeMs = Date.now();
        await harness.pollOnce();
        await harness.pollOnce();
        assert_1.default.strictEqual(harness.started.length, 1);
        const event = harness.started[0];
        assert_1.default.strictEqual(event.scannerId, 'scn.claude');
        assert_1.default.strictEqual(event.tool, 'claude-code');
        assert_1.default.strictEqual(event.confidence, 0.4);
        assert_1.default.ok(event.sessionId);
        // startedAt ≈ now - etime (3600s); allow slack for test execution.
        const startedAtMs = Date.parse(event.startedAt);
        assert_1.default.ok(Math.abs(startedAtMs - (beforeMs - 3600000)) < 5000);
        assert_1.default.strictEqual(harness.ended.length, 0);
    });
    it('does not start a session below the confidence threshold', async () => {
        const harness = createHarness();
        harness.setProcesses([OTHER_PROCESS]);
        await harness.pollOnce();
        assert_1.default.strictEqual(harness.started.length, 0);
        assert_1.default.strictEqual(harness.detected.length, 0);
    });
    it('survives a one-poll flap without ending or restarting the session', async () => {
        const harness = createHarness();
        harness.setProcesses([CLAUDE_PROCESS]);
        await harness.pollOnce();
        // Absent for ONE poll (inside the 2-poll grace), then back.
        harness.setProcesses([OTHER_PROCESS]);
        await harness.pollOnce();
        harness.setProcesses([CLAUDE_PROCESS]);
        await harness.pollOnce();
        // Another single-poll gap later must also stay quiet.
        harness.setProcesses([]);
        await harness.pollOnce();
        harness.setProcesses([CLAUDE_PROCESS]);
        await harness.pollOnce();
        assert_1.default.strictEqual(harness.started.length, 1);
        assert_1.default.strictEqual(harness.ended.length, 0);
    });
    it('emits session-ended after 2 consecutive absent polls', async () => {
        const harness = createHarness();
        harness.setProcesses([CLAUDE_PROCESS]);
        await harness.pollOnce();
        harness.setProcesses([OTHER_PROCESS]);
        await harness.pollOnce();
        assert_1.default.strictEqual(harness.ended.length, 0);
        await harness.pollOnce();
        assert_1.default.strictEqual(harness.ended.length, 1);
        const event = harness.ended[0];
        assert_1.default.strictEqual(event.sessionId, harness.started[0].sessionId);
        assert_1.default.strictEqual(event.tool, 'claude-code');
        assert_1.default.ok(event.endedAt);
        // Stays ended — further absent polls emit nothing new.
        await harness.pollOnce();
        assert_1.default.strictEqual(harness.ended.length, 1);
    });
    it('opens a NEW session (fresh id) when the tool reappears after ending', async () => {
        const harness = createHarness();
        harness.setProcesses([CLAUDE_PROCESS]);
        await harness.pollOnce();
        harness.setProcesses([]);
        await harness.pollOnce();
        await harness.pollOnce();
        assert_1.default.strictEqual(harness.ended.length, 1);
        harness.setProcesses([CLAUDE_PROCESS]);
        await harness.pollOnce();
        assert_1.default.strictEqual(harness.started.length, 2);
        assert_1.default.notStrictEqual(harness.started[1].sessionId, harness.started[0].sessionId);
    });
    it('keeps emitting debounce-gated detected events while present', async () => {
        const harness = createHarness();
        harness.setProcesses([CLAUDE_PROCESS]);
        await harness.pollOnce();
        await harness.pollOnce();
        // detectionDebounceMs=0 → every present poll re-emits.
        assert_1.default.strictEqual(harness.detected.length, 2);
        assert_1.default.strictEqual(harness.started.length, 1);
    });
});
describe('parseEtimeSeconds', () => {
    it('parses mm:ss', () => {
        assert_1.default.strictEqual(parseEtimeSeconds('05:30'), 330);
    });
    it('parses hh:mm:ss', () => {
        assert_1.default.strictEqual(parseEtimeSeconds('1:02:03'), 3723);
    });
    it('parses dd-hh:mm:ss', () => {
        assert_1.default.strictEqual(parseEtimeSeconds('2-11:30:00'), 2 * 86400 + 11 * 3600 + 30 * 60);
    });
    it('returns 0 for unparseable values', () => {
        assert_1.default.strictEqual(parseEtimeSeconds('garbage'), 0);
        assert_1.default.strictEqual(parseEtimeSeconds(''), 0);
    });
});
describe('parseProcessTable', () => {
    it('parses pid/etime/comm rows, keeping spaces in comm', () => {
        const stdout = [
            '  4242 1:00:00 claude',
            '     1 10-00:00:00 /sbin/launchd',
            '   777 02:15 /Applications/Visual Studio Code.app/Contents/MacOS/Electron',
            'not-a-row'
        ].join('\n');
        const entries = parseProcessTable(stdout);
        assert_1.default.deepStrictEqual(entries, [
            { pid: 4242, comm: 'claude', etimeSeconds: 3600 },
            { pid: 1, comm: '/sbin/launchd', etimeSeconds: 864000 },
            {
                pid: 777,
                comm: '/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
                etimeSeconds: 135
            }
        ]);
    });
});
