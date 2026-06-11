import { createHash } from 'crypto';

import type { ParsedTokenUsage } from '../types';

export function hashContent(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function parseJsonLine<T extends Record<string, unknown>>(
  line: string
): T | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as T;
  } catch {
    return null;
  }
}

export function pickNumber(
  source: Record<string, unknown>,
  keys: string[]
): number | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

export function pickString(
  source: Record<string, unknown>,
  keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

export function extractUsage(
  source: Record<string, unknown>,
  fieldMap?: {
    input?: string;
    output?: string;
    cacheRead?: string;
    cacheWrite?: string;
    reasoning?: string;
    model?: string;
  },
  isEstimated = false
): ParsedTokenUsage | undefined {
  const inputKey = fieldMap?.input ?? 'input_tokens';
  const outputKey = fieldMap?.output ?? 'output_tokens';
  const cacheReadKey = fieldMap?.cacheRead ?? 'cache_read_input_tokens';
  const cacheWriteKey = fieldMap?.cacheWrite ?? 'cache_creation_input_tokens';
  const reasoningKey = fieldMap?.reasoning ?? 'reasoning_tokens';
  const modelKey = fieldMap?.model ?? 'model';

  const inputTokens = pickNumber(source, [inputKey, 'inputTokens', 'input']);
  const outputTokens = pickNumber(source, [outputKey, 'outputTokens', 'output']);
  const cacheReadTokens = pickNumber(source, [cacheReadKey, 'cacheReadTokens']);
  const cacheWriteTokens = pickNumber(source, [cacheWriteKey, 'cacheWriteTokens']);
  const reasoningTokens = pickNumber(source, [reasoningKey, 'reasoningTokens']);
  const model = pickString(source, [modelKey, 'model_name', 'modelName']);

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cacheReadTokens === undefined &&
    cacheWriteTokens === undefined &&
    reasoningTokens === undefined
  ) {
    return undefined;
  }

  const totalTokens =
    (inputTokens ?? 0) +
    (outputTokens ?? 0) +
    (cacheReadTokens ?? 0) +
    (cacheWriteTokens ?? 0) +
    (reasoningTokens ?? 0);

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    totalTokens,
    model,
    isEstimated,
  };
}

export function resolveTimestamp(
  source: Record<string, unknown>,
  fallback?: string
): string {
  const candidates = [
    source.timestamp,
    source.ts,
    source.created_at,
    source.createdAt,
    source.occurred_at,
    source.occurredAt,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      // Finite values beyond the valid Date range (±8.64e15 ms) yield an
      // Invalid Date whose toISOString() throws a RangeError — validate
      // before formatting and fall through to the next candidate otherwise.
      const parsed = new Date(candidate);
      if (Number.isFinite(parsed.getTime())) {
        return parsed.toISOString();
      }
    }
  }

  return fallback ?? new Date().toISOString();
}