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
const mocha_1 = require("mocha");
const protocol_1 = require("@codepulse/protocol");
function validAiTokensEnvelope(overrides = {}) {
    const payload = {
        type: 'ai.tokens',
        usage: {
            inputTokens: 100,
            outputTokens: 50,
            totalTokens: 150,
            isEstimated: false,
            model: 'claude-sonnet-4-20250514',
        },
        ...overrides.payload,
    };
    return {
        v: protocol_1.ENVELOPE_VERSION,
        id: '01JTEST00000000000000000001',
        ts: 1717920000000,
        src: 'daemon',
        type: 'ai.tokens',
        payload,
        ...overrides,
    };
}
(0, mocha_1.suite)('protocol validateEnvelope', () => {
    (0, mocha_1.test)('accepts a valid ai.tokens envelope', () => {
        const result = (0, protocol_1.validateEnvelope)(validAiTokensEnvelope());
        assert.strictEqual(result.ok, true);
        if (result.ok) {
            assert.strictEqual(result.value.v, protocol_1.ENVELOPE_VERSION);
            assert.strictEqual(result.value.type, 'ai.tokens');
            assert.strictEqual(result.value.payload.type, 'ai.tokens');
            assert.strictEqual(result.value.payload.usage.inputTokens, 100);
        }
    });
    (0, mocha_1.test)('rejects non-object input', () => {
        const result = (0, protocol_1.validateEnvelope)(null);
        assert.strictEqual(result.ok, false);
        if (!result.ok) {
            assert.ok(result.errors.includes('envelope must be an object'));
        }
    });
    (0, mocha_1.test)('rejects wrong envelope version', () => {
        const result = (0, protocol_1.validateEnvelope)(validAiTokensEnvelope({ v: 99 }));
        assert.strictEqual(result.ok, false);
        if (!result.ok) {
            assert.ok(result.errors.some((error) => error.includes('envelope.v must be')));
        }
    });
    (0, mocha_1.test)('rejects empty envelope id', () => {
        const result = (0, protocol_1.validateEnvelope)(validAiTokensEnvelope({ id: '   ' }));
        assert.strictEqual(result.ok, false);
        if (!result.ok) {
            assert.ok(result.errors.includes('envelope.id must be a non-empty string'));
        }
    });
    (0, mocha_1.test)('rejects invalid envelope source', () => {
        const result = (0, protocol_1.validateEnvelope)(validAiTokensEnvelope({ src: 'mobile' }));
        assert.strictEqual(result.ok, false);
        if (!result.ok) {
            assert.ok(result.errors.some((error) => error.includes('envelope.src must be one of')));
        }
    });
    (0, mocha_1.test)('rejects when envelope.type does not match payload.type', () => {
        const result = (0, protocol_1.validateEnvelope)(validAiTokensEnvelope({
            type: 'ai.session.started',
        }));
        assert.strictEqual(result.ok, false);
        if (!result.ok) {
            assert.ok(result.errors.includes('envelope.type must match payload.type'));
        }
    });
    (0, mocha_1.test)('rejects invalid payload usage fields', () => {
        const result = (0, protocol_1.validateEnvelope)(validAiTokensEnvelope({
            payload: {
                type: 'ai.tokens',
                usage: {
                    inputTokens: -1,
                    outputTokens: 50,
                    totalTokens: 49,
                    isEstimated: false,
                },
            },
        }));
        assert.strictEqual(result.ok, false);
        if (!result.ok) {
            assert.ok(result.errors.some((error) => error.includes('payload.usage.inputTokens must be a non-negative number')));
        }
    });
});
(0, mocha_1.suite)('protocol validateFrameSize', () => {
    (0, mocha_1.test)('accepts frames within the ingest limit', () => {
        const result = (0, protocol_1.validateFrameSize)(protocol_1.MAX_FRAME_BYTES);
        assert.strictEqual(result.ok, true);
        if (result.ok) {
            assert.strictEqual(result.value, protocol_1.MAX_FRAME_BYTES);
        }
    });
    (0, mocha_1.test)('rejects frames larger than the ingest limit', () => {
        const result = (0, protocol_1.validateFrameSize)(protocol_1.MAX_FRAME_BYTES + 1);
        assert.strictEqual(result.ok, false);
        if (!result.ok) {
            assert.ok(result.errors.some((error) => error.includes(`frame exceeds maximum size of ${protocol_1.MAX_FRAME_BYTES} bytes`)));
        }
    });
});
