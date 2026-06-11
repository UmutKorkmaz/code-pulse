"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createGenericNdjsonParser = exports.genericNdjsonParser = exports.createCodexJsonlParser = exports.codexJsonlParser = exports.createClaudeJsonlParser = exports.claudeJsonlParser = void 0;
exports.getParser = getParser;
exports.registerParser = registerParser;
exports.listParsers = listParsers;
exports.resolveParser = resolveParser;
const claude_jsonl_1 = require("./claude-jsonl");
Object.defineProperty(exports, "claudeJsonlParser", { enumerable: true, get: function () { return claude_jsonl_1.claudeJsonlParser; } });
Object.defineProperty(exports, "createClaudeJsonlParser", { enumerable: true, get: function () { return claude_jsonl_1.createClaudeJsonlParser; } });
const codex_jsonl_1 = require("./codex-jsonl");
Object.defineProperty(exports, "codexJsonlParser", { enumerable: true, get: function () { return codex_jsonl_1.codexJsonlParser; } });
Object.defineProperty(exports, "createCodexJsonlParser", { enumerable: true, get: function () { return codex_jsonl_1.createCodexJsonlParser; } });
const generic_ndjson_1 = require("./generic-ndjson");
Object.defineProperty(exports, "createGenericNdjsonParser", { enumerable: true, get: function () { return generic_ndjson_1.createGenericNdjsonParser; } });
Object.defineProperty(exports, "genericNdjsonParser", { enumerable: true, get: function () { return generic_ndjson_1.genericNdjsonParser; } });
const parserRegistry = new Map([
    [claude_jsonl_1.claudeJsonlParser.id, claude_jsonl_1.claudeJsonlParser],
    ['claude-jsonl-v1', claude_jsonl_1.claudeJsonlParser],
    [codex_jsonl_1.codexJsonlParser.id, codex_jsonl_1.codexJsonlParser],
    [generic_ndjson_1.genericNdjsonParser.id, generic_ndjson_1.genericNdjsonParser],
]);
function getParser(parserId) {
    return parserRegistry.get(parserId);
}
function registerParser(parser) {
    parserRegistry.set(parser.id, parser);
}
function listParsers() {
    return Array.from(parserRegistry.values());
}
function resolveParser(parserId, tokenFields) {
    const existing = parserRegistry.get(parserId);
    if (existing) {
        return existing;
    }
    if (parserId.startsWith('claude-jsonl')) {
        const parser = (0, claude_jsonl_1.createClaudeJsonlParser)(tokenFields);
        parserRegistry.set(parserId, parser);
        return parser;
    }
    if (parserId.startsWith('codex-jsonl')) {
        const parser = (0, codex_jsonl_1.createCodexJsonlParser)(tokenFields);
        parserRegistry.set(parserId, parser);
        return parser;
    }
    const generic = (0, generic_ndjson_1.createGenericNdjsonParser)(parserId);
    parserRegistry.set(parserId, generic);
    return generic;
}
//# sourceMappingURL=index.js.map