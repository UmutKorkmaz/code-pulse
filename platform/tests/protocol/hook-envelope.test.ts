import * as assert from 'assert';
import * as crypto from 'crypto';
import { suite, test } from 'mocha';
import { validateEnvelope } from '@codepulse/protocol';

function sha256(text: string): string {
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

suite('hook forwarder envelope integration', () => {
  test('accepts the exact envelope shape forward.sh emits', () => {
    const envelope = buildForwarderEnvelope();

    const result = validateEnvelope(envelope);

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
        assert.deepStrictEqual(
          result.value.payload.evidence.map((item) => item.type),
          ['hook_event', 'hook_event'],
        );
      }
    }
  });

  test('rejects the envelope when an evidence item uses an unknown type', () => {
    const envelope = buildForwarderEnvelope();
    envelope.payload.evidence[1].type = 'hook';

    const result = validateEnvelope(envelope);

    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.ok(
        result.errors.some((error) =>
          error.includes('payload.evidence[1].type must be one of'),
        ),
      );
    }
  });
});
