import { claudeJsonlParser, createClaudeJsonlParser } from './claude-jsonl';
import { codexJsonlParser, createCodexJsonlParser } from './codex-jsonl';
import { createGenericNdjsonParser, genericNdjsonParser } from './generic-ndjson';
import type { Parser, TokenFieldsConfig } from '../types';

const parserRegistry = new Map<string, Parser>([
  [claudeJsonlParser.id, claudeJsonlParser],
  ['claude-jsonl-v1', claudeJsonlParser],
  [codexJsonlParser.id, codexJsonlParser],
  [genericNdjsonParser.id, genericNdjsonParser],
]);

export function getParser(parserId: string): Parser | undefined {
  return parserRegistry.get(parserId);
}

export function registerParser(parser: Parser): void {
  parserRegistry.set(parser.id, parser);
}

export function listParsers(): Parser[] {
  return Array.from(parserRegistry.values());
}

export function resolveParser(
  parserId: string,
  tokenFields?: TokenFieldsConfig
): Parser {
  const existing = parserRegistry.get(parserId);
  if (existing) {
    return existing;
  }

  if (parserId.startsWith('claude-jsonl')) {
    const parser = createClaudeJsonlParser(tokenFields);
    parserRegistry.set(parserId, parser);
    return parser;
  }

  if (parserId.startsWith('codex-jsonl')) {
    const parser = createCodexJsonlParser(tokenFields);
    parserRegistry.set(parserId, parser);
    return parser;
  }

  const generic = createGenericNdjsonParser(parserId);
  parserRegistry.set(parserId, generic);
  return generic;
}

export {
  claudeJsonlParser,
  createClaudeJsonlParser,
  codexJsonlParser,
  createCodexJsonlParser,
  genericNdjsonParser,
  createGenericNdjsonParser,
};