"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.genericNdjsonParser = void 0;
exports.createGenericNdjsonParser = createGenericNdjsonParser;
const utils_1 = require("./utils");
const PARSER_ID = 'generic-ndjson-v1';
const SESSION_KEYS = ['session_id', 'sessionId', 'conversation_id', 'thread_id'];
const EVENT_KEYS = ['type', 'event_type', 'eventType', 'kind'];
const TOOL_KEYS = ['tool_name', 'toolName', 'tool', 'command'];
function createGenericNdjsonParser(parserId = PARSER_ID) {
    return {
        id: parserId,
        parseLine(line) {
            const record = (0, utils_1.parseJsonLine)(line);
            if (!record) {
                return null;
            }
            const sessionId = (0, utils_1.pickString)(record, SESSION_KEYS);
            const eventType = (0, utils_1.pickString)(record, EVENT_KEYS);
            const toolName = (0, utils_1.pickString)(record, TOOL_KEYS);
            const tokens = (0, utils_1.extractUsage)(record, undefined, true);
            const filePathHash = (0, utils_1.pickString)(record, [
                'file_path_hash',
                'filePathHash',
                'path_hash',
            ]);
            if (!sessionId && !eventType && !toolName && !tokens && !filePathHash) {
                return null;
            }
            return {
                parserId,
                lineHash: (0, utils_1.hashContent)(line),
                timestamp: (0, utils_1.resolveTimestamp)(record),
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
        parseChunk(text) {
            return text
                .split('\n')
                .map((line) => this.parseLine(line))
                .filter((event) => event !== null);
        },
    };
}
exports.genericNdjsonParser = createGenericNdjsonParser();
//# sourceMappingURL=generic-ndjson.js.map