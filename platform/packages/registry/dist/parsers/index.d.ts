import { claudeJsonlParser, createClaudeJsonlParser } from './claude-jsonl';
import { codexJsonlParser, createCodexJsonlParser } from './codex-jsonl';
import { createGenericNdjsonParser, genericNdjsonParser } from './generic-ndjson';
import type { Parser, TokenFieldsConfig } from '../types';
export declare function getParser(parserId: string): Parser | undefined;
export declare function registerParser(parser: Parser): void;
export declare function listParsers(): Parser[];
export declare function resolveParser(parserId: string, tokenFields?: TokenFieldsConfig): Parser;
export { claudeJsonlParser, createClaudeJsonlParser, codexJsonlParser, createCodexJsonlParser, genericNdjsonParser, createGenericNdjsonParser, };
//# sourceMappingURL=index.d.ts.map