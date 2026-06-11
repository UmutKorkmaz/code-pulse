import * as assert from 'assert';
import { suite, test } from 'mocha';
import {
  ENVELOPE_VERSION,
  MAX_FRAME_BYTES,
  validateEnvelope,
  validateFrameSize,
} from '@codepulse/protocol';

function validAiTokensEnvelope(overrides: Record<string, unknown> = {}) {
  const payload = {
    type: 'ai.tokens',
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      isEstimated: false,
      model: 'claude-sonnet-4-20250514',
    },
    ...(overrides.payload as object | undefined),
  };

  return {
    v: ENVELOPE_VERSION,
    id: '01JTEST00000000000000000001',
    ts: 1717920000000,
    src: 'daemon',
    type: 'ai.tokens',
    payload,
    ...overrides,
  };
}

suite('protocol validateEnvelope', () => {
  test('accepts a valid ai.tokens envelope', () => {
    const result = validateEnvelope(validAiTokensEnvelope());

    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.strictEqual(result.value.v, ENVELOPE_VERSION);
      assert.strictEqual(result.value.type, 'ai.tokens');
      assert.strictEqual(result.value.payload.type, 'ai.tokens');
      assert.strictEqual(result.value.payload.usage.inputTokens, 100);
    }
  });

  test('rejects non-object input', () => {
    const result = validateEnvelope(null);

    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.includes('envelope must be an object'));
    }
  });

  test('rejects wrong envelope version', () => {
    const result = validateEnvelope(validAiTokensEnvelope({ v: 99 }));

    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.some((error) => error.includes('envelope.v must be')));
    }
  });

  test('rejects empty envelope id', () => {
    const result = validateEnvelope(validAiTokensEnvelope({ id: '   ' }));

    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.includes('envelope.id must be a non-empty string'));
    }
  });

  test('rejects invalid envelope source', () => {
    const result = validateEnvelope(validAiTokensEnvelope({ src: 'mobile' }));

    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.some((error) => error.includes('envelope.src must be one of')));
    }
  });

  test('rejects when envelope.type does not match payload.type', () => {
    const result = validateEnvelope(
      validAiTokensEnvelope({
        type: 'ai.session.started',
      }),
    );

    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.includes('envelope.type must match payload.type'));
    }
  });

  test('rejects invalid payload usage fields', () => {
    const result = validateEnvelope(
      validAiTokensEnvelope({
        payload: {
          type: 'ai.tokens',
          usage: {
            inputTokens: -1,
            outputTokens: 50,
            totalTokens: 49,
            isEstimated: false,
          },
        },
      }),
    );

    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.ok(
        result.errors.some((error) =>
          error.includes('payload.usage.inputTokens must be a non-negative number'),
        ),
      );
    }
  });
});

suite('protocol validateFrameSize', () => {
  test('accepts frames within the ingest limit', () => {
    const result = validateFrameSize(MAX_FRAME_BYTES);

    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.strictEqual(result.value, MAX_FRAME_BYTES);
    }
  });

  test('rejects frames larger than the ingest limit', () => {
    const result = validateFrameSize(MAX_FRAME_BYTES + 1);

    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.ok(
        result.errors.some((error) =>
          error.includes(`frame exceeds maximum size of ${MAX_FRAME_BYTES} bytes`),
        ),
      );
    }
  });
});