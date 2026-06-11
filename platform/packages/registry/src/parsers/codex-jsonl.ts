import type { ParsedLogEvent, Parser, TokenFieldsConfig } from '../types';
import {
  extractUsage,
  hashContent,
  parseJsonLine,
  pickString,
  resolveTimestamp,
} from './utils';

const PARSER_ID = 'codex-jsonl-v1';

interface CodexJsonlRecord extends Record<string, unknown> {
  type?: string;
  session_id?: string;
  session_meta?: Record<string, unknown>;
  rollout?: Record<string, unknown>;
  response?: Record<string, unknown>;
  usage?: Record<string, unknown>;
}

function extractCodexUsage(
  record: CodexJsonlRecord,
  tokenFields?: TokenFieldsConfig
): ReturnType<typeof extractUsage> {
  const usageSources: Record<string, unknown>[] = [];

  if (record.usage && typeof record.usage === 'object') {
    usageSources.push(record.usage);
  }

  if (record.response && typeof record.response === 'object') {
    const responseUsage = record.response.usage;
    if (responseUsage && typeof responseUsage === 'object') {
      usageSources.push(responseUsage as Record<string, unknown>);
    }
  }

  if (record.rollout && typeof record.rollout === 'object') {
    const rolloutUsage = record.rollout.usage;
    if (rolloutUsage && typeof rolloutUsage === 'object') {
      usageSources.push(rolloutUsage as Record<string, unknown>);
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

export function createCodexJsonlParser(tokenFields?: TokenFieldsConfig): Parser {
  return {
    id: PARSER_ID,
    parseLine(line: string): ParsedLogEvent | null {
      const record = parseJsonLine<CodexJsonlRecord>(line);
      if (!record) {
        return null;
      }

      const eventType = pickString(record, ['type', 'event_type', 'eventType']);
      const sessionId = pickString(record, [
        'session_id',
        'sessionId',
        ...(record.session_meta && typeof record.session_meta === 'object'
          ? ['session_meta.session_id', 'session_meta.id']
          : []),
      ]);

      const nestedSessionId =
        record.session_meta && typeof record.session_meta === 'object'
          ? pickString(record.session_meta as Record<string, unknown>, [
              'session_id',
              'id',
            ])
          : undefined;

      const toolName = pickString(record, ['tool_name', 'toolName', 'command']);
      const tokens = extractCodexUsage(record, tokenFields);

      if (
        eventType === 'session_meta' ||
        eventType === 'rollout' ||
        sessionId ||
        nestedSessionId ||
        tokens
      ) {
        return {
          parserId: PARSER_ID,
          lineHash: hashContent(line),
          timestamp: resolveTimestamp(record),
          sessionId: sessionId ?? nestedSessionId,
          eventType: eventType ?? (record.session_meta ? 'session_meta' : undefined),
          toolName,
          tokens,
          metadata: {
            type: eventType,
            hasRollout: Boolean(record.rollout),
            hasSessionMeta: Boolean(record.session_meta),
          },
        };
      }

      return null;
    },
    parseChunk(text: string): ParsedLogEvent[] {
      return text
        .split('\n')
        .map((line) => this.parseLine(line))
        .filter((event): event is ParsedLogEvent => event !== null);
    },
  };
}

export const codexJsonlParser = createCodexJsonlParser();