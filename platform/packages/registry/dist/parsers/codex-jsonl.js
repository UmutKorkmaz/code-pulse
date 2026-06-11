"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.codexJsonlParser = void 0;
exports.createCodexJsonlParser = createCodexJsonlParser;
const utils_1 = require("./utils");
const PARSER_ID = 'codex-jsonl-v1';
function extractCodexUsage(record, tokenFields) {
    const usageSources = [];
    if (record.usage && typeof record.usage === 'object') {
        usageSources.push(record.usage);
    }
    if (record.response && typeof record.response === 'object') {
        const responseUsage = record.response.usage;
        if (responseUsage && typeof responseUsage === 'object') {
            usageSources.push(responseUsage);
        }
    }
    if (record.rollout && typeof record.rollout === 'object') {
        const rolloutUsage = record.rollout.usage;
        if (rolloutUsage && typeof rolloutUsage === 'object') {
            usageSources.push(rolloutUsage);
        }
    }
    for (const source of usageSources) {
        const usage = (0, utils_1.extractUsage)(source, tokenFields, false);
        if (usage) {
            return usage;
        }
    }
    return (0, utils_1.extractUsage)(record, tokenFields, false);
}
function createCodexJsonlParser(tokenFields) {
    return {
        id: PARSER_ID,
        parseLine(line) {
            const record = (0, utils_1.parseJsonLine)(line);
            if (!record) {
                return null;
            }
            const eventType = (0, utils_1.pickString)(record, ['type', 'event_type', 'eventType']);
            const sessionId = (0, utils_1.pickString)(record, [
                'session_id',
                'sessionId',
                ...(record.session_meta && typeof record.session_meta === 'object'
                    ? ['session_meta.session_id', 'session_meta.id']
                    : []),
            ]);
            const nestedSessionId = record.session_meta && typeof record.session_meta === 'object'
                ? (0, utils_1.pickString)(record.session_meta, [
                    'session_id',
                    'id',
                ])
                : undefined;
            const toolName = (0, utils_1.pickString)(record, ['tool_name', 'toolName', 'command']);
            const tokens = extractCodexUsage(record, tokenFields);
            if (eventType === 'session_meta' ||
                eventType === 'rollout' ||
                sessionId ||
                nestedSessionId ||
                tokens) {
                return {
                    parserId: PARSER_ID,
                    lineHash: (0, utils_1.hashContent)(line),
                    timestamp: (0, utils_1.resolveTimestamp)(record),
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
        parseChunk(text) {
            return text
                .split('\n')
                .map((line) => this.parseLine(line))
                .filter((event) => event !== null);
        },
    };
}
exports.codexJsonlParser = createCodexJsonlParser();
//# sourceMappingURL=codex-jsonl.js.map