"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.claudeJsonlParser = void 0;
exports.createClaudeJsonlParser = createClaudeJsonlParser;
const utils_1 = require("./utils");
const PARSER_ID = 'claude-jsonl-v2';
function extractNestedUsage(record, tokenFields) {
    const usageSources = [];
    if (record.usage && typeof record.usage === 'object') {
        usageSources.push(record.usage);
    }
    if (record.message && typeof record.message === 'object') {
        const messageUsage = record.message.usage;
        if (messageUsage && typeof messageUsage === 'object') {
            usageSources.push(messageUsage);
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
function createClaudeJsonlParser(tokenFields) {
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
                'conversation_id',
            ]);
            const toolName = (0, utils_1.pickString)(record, ['tool_name', 'toolName', 'name']);
            const tokens = extractNestedUsage(record, tokenFields);
            if (!eventType && !sessionId && !tokens && !toolName) {
                return null;
            }
            return {
                parserId: PARSER_ID,
                lineHash: (0, utils_1.hashContent)(line),
                timestamp: (0, utils_1.resolveTimestamp)(record),
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
        parseChunk(text) {
            return text
                .split('\n')
                .map((line) => this.parseLine(line))
                .filter((event) => event !== null);
        },
    };
}
exports.claudeJsonlParser = createClaudeJsonlParser();
//# sourceMappingURL=claude-jsonl.js.map