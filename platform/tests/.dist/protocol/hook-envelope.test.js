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
const crypto = __importStar(require("crypto"));
const mocha_1 = require("mocha");
const protocol_1 = require("@codepulse/protocol");
function sha256(text) {
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}
/**
 * Mirrors the exact envelope shape hooks/forward.sh emits: uuid id, epoch-ms
 * ts, src "scanner", and an ai.tool.detected payload carrying two evidence
 * items — the raw-input content hash and the hook-event/tool-name hash, both
 * typed "hook_event".
 */
function buildForwarderEnvelope() {
    const rawInput = JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Write' });
    const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    return {
        v: 1,
        id: crypto.randomUUID(),
        ts: Date.now(),
        src: 'scanner',
        type: 'ai.tool.detected',
        payload: {
            type: 'ai.tool.detected',
            tool: 'Claude Code',
            confidence: 1.0,
            evidence: [
                {
                    type: 'hook_event',
                    timestamp,
                    hash: sha256(rawInput),
                },
                {
                    type: 'hook_event',
                    timestamp,
                    hash: sha256('PostToolUse:Write'),
                },
            ],
            scannerId: 'scn.claude-code',
        },
    };
}
(0, mocha_1.suite)('hook forwarder envelope integration', () => {
    (0, mocha_1.test)('accepts the exact envelope shape forward.sh emits', () => {
        const envelope = buildForwarderEnvelope();
        const result = (0, protocol_1.validateEnvelope)(envelope);
        assert.strictEqual(result.ok, true, JSON.stringify(!result.ok ? result.errors : []));
        if (result.ok) {
            assert.strictEqual(result.value.src, 'scanner');
            assert.strictEqual(result.value.type, 'ai.tool.detected');
            assert.strictEqual(result.value.payload.type, 'ai.tool.detected');
            if (result.value.payload.type === 'ai.tool.detected') {
                assert.strictEqual(result.value.payload.tool, 'Claude Code');
                assert.strictEqual(result.value.payload.confidence, 1.0);
                assert.strictEqual(result.value.payload.scannerId, 'scn.claude-code');
                assert.strictEqual(result.value.payload.evidence.length, 2);
                assert.deepStrictEqual(result.value.payload.evidence.map((item) => item.type), ['hook_event', 'hook_event']);
            }
        }
    });
    (0, mocha_1.test)('rejects the envelope when an evidence item uses an unknown type', () => {
        const envelope = buildForwarderEnvelope();
        envelope.payload.evidence[1].type = 'hook';
        const result = (0, protocol_1.validateEnvelope)(envelope);
        assert.strictEqual(result.ok, false);
        if (!result.ok) {
            assert.ok(result.errors.some((error) => error.includes('payload.evidence[1].type must be one of')));
        }
    });
});
