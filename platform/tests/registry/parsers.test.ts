import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { suite, test } from 'mocha';

import { claudeJsonlParser, codexJsonlParser } from '@codepulse/registry';

const fixturesDir = path.join(process.cwd(), 'test', 'fixtures', 'ai-logs');

function readFixture(name: string): string {
  return fs.readFileSync(path.join(fixturesDir, name), 'utf8');
}

suite('registry claude-jsonl parser', () => {
  test('parses claude-sample.jsonl fixture lines', () => {
    const events = claudeJsonlParser.parseChunk(readFixture('claude-sample.jsonl'));

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

  test('returns null for blank lines', () => {
    assert.strictEqual(claudeJsonlParser.parseLine(''), null);
    assert.strictEqual(claudeJsonlParser.parseLine('   '), null);
  });
});

suite('registry codex-jsonl parser', () => {
  test('parses codex-sample.jsonl fixture lines', () => {
    const events = codexJsonlParser.parseChunk(readFixture('codex-sample.jsonl'));

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

  test('returns null for invalid json', () => {
    assert.strictEqual(codexJsonlParser.parseLine('not-json'), null);
  });
});