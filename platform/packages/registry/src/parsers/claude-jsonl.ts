import type { ParsedLogEvent, Parser, TokenFieldsConfig } from '../types';
import {
  extractUsage,
  hashContent,
  parseJsonLine,
  pickString,
  resolveTimestamp,
} from './utils';

const PARSER_ID = 'claude-jsonl-v2';

interface ClaudeJsonlRecord extends Record<string, unknown> {
  type?: string;
  session_id?: string;
  tool_name?: string;
  message?: Record<string, unknown>;
  usage?: Record<string, unknown>;
}

function extractNestedUsage(
  record: ClaudeJsonlRecord,
  tokenFields?: TokenFieldsConfig
): ReturnType<typeof extractUsage> {
  const usageSources: Record<string, unknown>[] = [];

  if (record.usage && typeof record.usage === 'object') {
    usageSources.push(record.usage);
  }

  if (record.message && typeof record.message === 'object') {
    const messageUsage = record.message.usage;
    if (messageUsage && typeof messageUsage === 'object') {
      usageSources.push(messageUsage as Record<string, unknown>);
    }
  }

  for (const source of usageSources) {
    const usage = extractUsage(source, tokenFields, false);
    if (usage) {
      return usage;
    }
  }

  return extractUsage(record, tokenFields, false);
}

export function createClaudeJsonlParser(
  tokenFields?: TokenFieldsConfig
): Parser {
  return {
    id: PARSER_ID,
    parseLine(line: string): ParsedLogEvent | null {
      const record = parseJsonLine<ClaudeJsonlRecord>(line);
      if (!record) {
        return null;
      }

      const eventType = pickString(record, ['type', 'event_type', 'eventType']);
      const sessionId = pickString(record, [
        'session_id',
        'sessionId',
        'conversation_id',
      ]);
      const toolName = pickString(record, ['tool_name', 'toolName', 'name']);
      const tokens = extractNestedUsage(record, tokenFields);

      if (!eventType && !sessionId && !tokens && !toolName) {
        return null;
      }

      return {
        parserId: PARSER_ID,
        lineHash: hashContent(line),
        timestamp: resolveTimestamp(record),
        sessionId,
        eventType,
        toolName,
        tokens,
        metadata: {
          type: eventType,
          hasUsage: Boolean(tokens),
        },
      };
    },
    parseChunk(text: string): ParsedLogEvent[] {
      return text
        .split('\n')
        .map((line) => this.parseLine(line))
        .filter((event): event is ParsedLogEvent => event !== null);
    },
  };
}

export const claudeJsonlParser = createClaudeJsonlParser();