"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const assert_1 = __importDefault(require("assert"));
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const nodePath = __importStar(require("path"));
const protocol_1 = require("@codepulse/protocol");
// Compiled daemon spool module — import via relative path to dist for tests
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SpoolTailer } = require('../../../apps/daemon/dist/spool/tailer.js');
/** Mirrors MAX_READ_BYTES_PER_POLL in spool/tailer.ts (max frame + 1). */
const READ_CAP_BYTES = 256 * 1024 + 1;
function tokensEnvelopeLine(id) {
    return JSON.stringify({
        v: protocol_1.ENVELOPE_VERSION,
        id,
        ts: 1717920000000,
        src: 'daemon',
        type: 'ai.tokens',
        payload: {
            type: 'ai.tokens',
            usage: {
                inputTokens: 100,
                outputTokens: 50,
                totalTokens: 150,
                isEstimated: false,
                model: 'model-a'
            }
        }
    });
}
/**
 * Drives one SpoolTailer through manual polls (no fs.watch / interval, so
 * each readNewData call is exactly one capped read) and collects every
 * emitted envelope id plus metric increments.
 */
function createHarness(tempDir) {
    const spoolPath = nodePath.join(tempDir, 'spool', 'events.ndjson');
    const cursorPath = nodePath.join(tempDir, 'spool', 'cursor.json');
    const counters = new Map();
    const emittedIds = [];
    const errors = [];
    const tailer = new SpoolTailer({ spoolPath, cursorPath }, {
        increment: (name, value = 1) => {
            counters.set(name, (counters.get(name) ?? 0) + value);
        }
    });
    tailer.on('error', (error) => errors.push(error));
    tailer.on('envelope', (envelope) => emittedIds.push(envelope.id));
    const internals = tailer;
    internals.running = true;
    internals.loadCursor();
    return {
        tailer,
        spoolPath,
        counters,
        emittedIds,
        errors,
        poll: () => internals.readNewData()
    };
}
describe('spool tailer chunked reads', () => {
    let tempDir = '';
    beforeEach(() => {
        tempDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'codepulse-spool-'));
    });
    afterEach(() => {
        if (tempDir) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });
    it('consumes a large backlog in capped chunks across polls without loss or duplication', async () => {
        // Arrange: a historical spool well past one read cap (~600 KiB).
        const harness = createHarness(tempDir);
        fs.mkdirSync(nodePath.dirname(harness.spoolPath), { recursive: true });
        const ids = Array.from({ length: 4000 }, (_, index) => `env-bulk-${index}`);
        fs.writeFileSync(harness.spoolPath, ids.map(id => `${tokensEnvelopeLine(id)}\n`).join(''));
        const spoolSize = fs.statSync(harness.spoolPath).size;
        assert_1.default.ok(spoolSize > 2 * READ_CAP_BYTES, 'fixture must span at least three capped reads');
        // Act: first poll consumes at most one capped chunk …
        await harness.poll();
        const offsetAfterFirstPoll = harness.tailer.getOffset();
        const emittedAfterFirstPoll = harness.emittedIds.length;
        // … and subsequent polls drain the remainder.
        let polls = 1;
        while (harness.tailer.getOffset() < spoolSize && polls < 32) {
            await harness.poll();
            polls += 1;
        }
        // Assert
        assert_1.default.deepStrictEqual(harness.errors, []);
        assert_1.default.ok(offsetAfterFirstPoll > 0);
        assert_1.default.ok(offsetAfterFirstPoll <= READ_CAP_BYTES, `first poll must stop at the read cap (consumed ${offsetAfterFirstPoll})`);
        assert_1.default.ok(emittedAfterFirstPoll < ids.length);
        assert_1.default.ok(polls >= 3, `backlog must take multiple polls (took ${polls})`);
        assert_1.default.strictEqual(harness.tailer.getOffset(), spoolSize);
        assert_1.default.deepStrictEqual(harness.emittedIds, ids);
    });
    it('skips an oversized unterminated line instead of stalling forever', async () => {
        // Arrange: a single garbage line larger than the read cap, followed
        // by a valid envelope.
        const harness = createHarness(tempDir);
        fs.mkdirSync(nodePath.dirname(harness.spoolPath), { recursive: true });
        const oversized = 'x'.repeat(300 * 1024);
        fs.writeFileSync(harness.spoolPath, `${oversized}\n${tokensEnvelopeLine('env-after-oversized')}\n`);
        const spoolSize = fs.statSync(harness.spoolPath).size;
        // Act
        let polls = 0;
        while (harness.tailer.getOffset() < spoolSize && polls < 8) {
            await harness.poll();
            polls += 1;
        }
        // Assert: the oversized line is dropped (it could never validate as
        // a frame anyway), the cursor reaches EOF, and the following valid
        // envelope still comes through.
        assert_1.default.deepStrictEqual(harness.errors, []);
        assert_1.default.strictEqual(harness.tailer.getOffset(), spoolSize);
        assert_1.default.deepStrictEqual(harness.emittedIds, ['env-after-oversized']);
        assert_1.default.ok((harness.counters.get('codepulse_spool_lines_dropped_total') ?? 0) >= 1);
    });
    it('leaves a partial trailing line unread until the writer completes it', async () => {
        // Arrange
        const harness = createHarness(tempDir);
        fs.mkdirSync(nodePath.dirname(harness.spoolPath), { recursive: true });
        const complete = tokensEnvelopeLine('env-complete');
        const partial = tokensEnvelopeLine('env-partial');
        fs.writeFileSync(harness.spoolPath, `${complete}\n${partial.slice(0, 20)}`);
        // Act
        await harness.poll();
        const offsetAfterPartial = harness.tailer.getOffset();
        fs.appendFileSync(harness.spoolPath, `${partial.slice(20)}\n`);
        await harness.poll();
        // Assert: cursor held at the partial line start, then consumed it
        // exactly once when completed — no loss, no duplication.
        assert_1.default.deepStrictEqual(harness.errors, []);
        assert_1.default.strictEqual(offsetAfterPartial, Buffer.byteLength(complete, 'utf8') + 1);
        assert_1.default.deepStrictEqual(harness.emittedIds, ['env-complete', 'env-partial']);
    });
});
