import type { ParsedLogEvent, Parser } from '../types';
import {
  extractUsage,
  hashContent,
  parseJsonLine,
  pickString,
  resolveTimestamp,
} from './utils';

const PARSER_ID = 'generic-ndjson-v1';

const SESSION_KEYS = ['session_id', 'sessionId', 'conversation_id', 'thread_id'];
const EVENT_KEYS = ['type', 'event_type', 'eventType', 'kind'];
const TOOL_KEYS = ['tool_name', 'toolName', 'tool', 'command'];

export function createGenericNdjsonParser(parserId = PARSER_ID): Parser {
  return {
    id: parserId,
    parseLine(line: string): ParsedLogEvent | null {
      const record = parseJsonLine<Record<string, unknown>>(line);
      if (!record) {
        return null;
      }

      const sessionId = pickString(record, SESSION_KEYS);
      const eventType = pickString(record, EVENT_KEYS);
      const toolName = pickString(record, TOOL_KEYS);
      const tokens = extractUsage(record, undefined, true);

      const filePathHash = pickString(record, [
        'file_path_hash',
        'filePathHash',
        'path_hash',
      ]);

      if (!sessionId && !eventType && !toolName && !tokens && !filePathHash) {
        return null;
      }

      return {
        parserId,
        lineHash: hashContent(line),
        timestamp: resolveTimestamp(record),
        sessionId,
        eventType,
        toolName,
        tokens,
        filePathHash,
        metadata: {
          keys: Object.keys(record).slice(0, 16),
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

export const genericNdjsonParser = createGenericNdjsonParser();