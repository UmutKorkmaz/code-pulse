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
Object.defineProperty(exports, "__esModule", { value: true });
const assert = __importStar(require("assert"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const mocha_1 = require("mocha");
const registry_1 = require("@codepulse/registry");
const fixturesDir = path.join(process.cwd(), 'test', 'fixtures', 'ai-logs');
function readFixture(name) {
    return fs.readFileSync(path.join(fixturesDir, name), 'utf8');
}
(0, mocha_1.suite)('registry claude-jsonl parser', () => {
    (0, mocha_1.test)('parses claude-sample.jsonl fixture lines', () => {
        const events = registry_1.claudeJsonlParser.parseChunk(readFixture('claude-sample.jsonl'));
        assert.strictEqual(events.length, 3);
        assert.strictEqual(events[0].parserId, 'claude-jsonl-v2');
        assert.strictEqual(events[0].sessionId, 'sess-claude-001');
        assert.strictEqual(events[0].eventType, 'session_start');
        assert.strictEqual(events[0].timestamp, '2026-06-09T10:00:00.000Z');
        assert.strictEqual(events[1].eventType, 'tool_use');
        assert.strictEqual(events[1].toolName, 'Write');
        assert.strictEqual(events[2].eventType, 'assistant');
        assert.ok(events[2].tokens);
        assert.strictEqual(events[2].tokens?.inputTokens, 1200);
        assert.strictEqual(events[2].tokens?.outputTokens, 340);
        assert.strictEqual(events[2].tokens?.totalTokens, 1540);
        assert.strictEqual(events[2].tokens?.model, 'claude-sonnet-4-20250514');
        assert.strictEqual(events[2].metadata.hasUsage, true);
    });
    (0, mocha_1.test)('returns null for blank lines', () => {
        assert.strictEqual(registry_1.claudeJsonlParser.parseLine(''), null);
        assert.strictEqual(registry_1.claudeJsonlParser.parseLine('   '), null);
    });
});
(0, mocha_1.suite)('registry codex-jsonl parser', () => {
    (0, mocha_1.test)('parses codex-sample.jsonl fixture lines', () => {
        const events = registry_1.codexJsonlParser.parseChunk(readFixture('codex-sample.jsonl'));
        assert.strictEqual(events.length, 3);
        assert.strictEqual(events[0].parserId, 'codex-jsonl-v1');
        assert.strictEqual(events[0].sessionId, 'sess-codex-001');
        assert.strictEqual(events[0].eventType, 'session_meta');
        assert.strictEqual(events[0].metadata.hasSessionMeta, true);
        assert.strictEqual(events[1].eventType, 'rollout');
        assert.ok(events[1].tokens);
        assert.strictEqual(events[1].tokens?.inputTokens, 800);
        assert.strictEqual(events[1].tokens?.outputTokens, 200);
        assert.strictEqual(events[1].tokens?.model, 'gpt-4o');
        assert.strictEqual(events[1].metadata.hasRollout, true);
        assert.strictEqual(events[2].eventType, 'response');
        assert.ok(events[2].tokens);
        assert.strictEqual(events[2].tokens?.inputTokens, 950);
        assert.strictEqual(events[2].tokens?.outputTokens, 310);
        assert.strictEqual(events[2].tokens?.totalTokens, 1260);
    });
    (0, mocha_1.test)('returns null for invalid json', () => {
        assert.strictEqual(registry_1.codexJsonlParser.parseLine('not-json'), null);
    });
});
