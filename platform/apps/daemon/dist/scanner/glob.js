"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.expandLogGlob = expandLogGlob;
exports.expandLogGlobAsync = expandLogGlobAsync;
const fs = __importStar(require("fs/promises"));
const fsSync = __importStar(require("fs"));
const path = __importStar(require("path"));
const core_1 = require("@codepulse/core");
const DEFAULT_MAX_FILES = 48;
/** Generous traversal bound so newest-by-mtime selection sees every candidate. */
const MAX_WALK_MATCHES = 10_000;
function expandLogGlob(pattern, maxFiles = DEFAULT_MAX_FILES, onTruncate) {
    const normalized = (0, core_1.expandHome)(pattern);
    const starIndex = normalized.indexOf('*');
    if (starIndex === -1) {
        return fsSync.existsSync(normalized) ? [normalized] : [];
    }
    const { baseDir, relativePattern } = splitPattern(normalized, starIndex);
    if (!fsSync.existsSync(baseDir)) {
        return [];
    }
    const matches = [];
    walkGlobSync(baseDir, relativePattern.split('/'), matches, MAX_WALK_MATCHES);
    return selectNewestFilesSync(matches, maxFiles, onTruncate);
}
async function expandLogGlobAsync(pattern, maxFiles = DEFAULT_MAX_FILES, onTruncate) {
    const normalized = (0, core_1.expandHome)(pattern);
    const starIndex = normalized.indexOf('*');
    if (starIndex === -1) {
        try {
            await fs.access(normalized);
            return [normalized];
        }
        catch {
            return [];
        }
    }
    const { baseDir, relativePattern } = splitPattern(normalized, starIndex);
    try {
        await fs.access(baseDir);
    }
    catch {
        return [];
    }
    const matches = [];
    await walkGlobAsync(baseDir, relativePattern.split('/'), matches, MAX_WALK_MATCHES);
    return selectNewestFilesAsync(matches, maxFiles, onTruncate);
}
/**
 * Splits a glob into the literal directory before the first '*' and the
 * remaining relative pattern. The base dir is everything before the slash
 * preceding the first '*' — slicing at the slash itself (never path.dirname,
 * which strips a real directory segment from a string ending in '/'), so
 * 'dir/sessions/*.jsonl' anchors at 'dir/sessions', not 'dir'.
 */
function splitPattern(normalized, starIndex) {
    const slashBeforeStar = normalized.lastIndexOf('/', starIndex);
    if (slashBeforeStar === -1) {
        return { baseDir: '.', relativePattern: normalized };
    }
    return {
        baseDir: slashBeforeStar === 0 ? '/' : normalized.slice(0, slashBeforeStar),
        relativePattern: normalized.slice(slashBeforeStar + 1)
    };
}
/**
 * Keeps the newest `maxFiles` matches by mtime so freshly created session
 * files are never starved by readdir-order truncation during the walk.
 */
function selectNewestFilesSync(matches, maxFiles, onTruncate) {
    if (matches.length <= maxFiles) {
        return [...matches].sort();
    }
    const withMtime = matches.map(filePath => {
        try {
            return { filePath, mtimeMs: fsSync.statSync(filePath).mtimeMs };
        }
        catch {
            return { filePath, mtimeMs: 0 };
        }
    });
    withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);
    onTruncate?.(matches.length - maxFiles);
    return withMtime
        .slice(0, maxFiles)
        .map(entry => entry.filePath)
        .sort();
}
async function selectNewestFilesAsync(matches, maxFiles, onTruncate) {
    if (matches.length <= maxFiles) {
        return [...matches].sort();
    }
    const withMtime = await Promise.all(matches.map(async (filePath) => {
        try {
            const stat = await fs.stat(filePath);
            return { filePath, mtimeMs: stat.mtimeMs };
        }
        catch {
            return { filePath, mtimeMs: 0 };
        }
    }));
    withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);
    onTruncate?.(matches.length - maxFiles);
    return withMtime
        .slice(0, maxFiles)
        .map(entry => entry.filePath)
        .sort();
}
/** @deprecated Prefer expandLogGlobAsync — sync walk blocks the event loop. */
function walkGlobSync(currentDir, segments, matches, maxFiles) {
    if (segments.length === 0 || matches.length >= maxFiles) {
        return;
    }
    const [head, ...tail] = segments;
    if (head === '**') {
        if (tail.length === 0) {
            collectFilesRecursiveSync(currentDir, matches, maxFiles);
            return;
        }
        walkGlobSync(currentDir, tail, matches, maxFiles);
        let entries;
        try {
            entries = fsSync.readdirSync(currentDir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            if (!entry.isDirectory()) {
                continue;
            }
            walkGlobSync(path.join(currentDir, entry.name), ['**', ...tail], matches, maxFiles);
        }
        return;
    }
    let entries;
    try {
        entries = fsSync.readdirSync(currentDir, { withFileTypes: true });
    }
    catch {
        return;
    }
    for (const entry of entries) {
        if (!matchSegment(head, entry.name)) {
            continue;
        }
        const nextPath = path.join(currentDir, entry.name);
        if (tail.length === 0) {
            if (entry.isFile() && matches.length < maxFiles) {
                matches.push(nextPath);
            }
            continue;
        }
        if (entry.isDirectory()) {
            walkGlobSync(nextPath, tail, matches, maxFiles);
        }
    }
}
async function walkGlobAsync(currentDir, segments, matches, maxFiles) {
    if (segments.length === 0 || matches.length >= maxFiles) {
        return;
    }
    const [head, ...tail] = segments;
    if (head === '**') {
        if (tail.length === 0) {
            await collectFilesRecursiveAsync(currentDir, matches, maxFiles);
            return;
        }
        await walkGlobAsync(currentDir, tail, matches, maxFiles);
        let entries;
        try {
            entries = await fs.readdir(currentDir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            if (!entry.isDirectory()) {
                continue;
            }
            await walkGlobAsync(path.join(currentDir, entry.name), ['**', ...tail], matches, maxFiles);
            await yieldEventLoop();
        }
        return;
    }
    let entries;
    try {
        entries = await fs.readdir(currentDir, { withFileTypes: true });
    }
    catch {
        return;
    }
    for (const entry of entries) {
        if (!matchSegment(head, entry.name)) {
            continue;
        }
        const nextPath = path.join(currentDir, entry.name);
        if (tail.length === 0) {
            if (entry.isFile() && matches.length < maxFiles) {
                matches.push(nextPath);
            }
            continue;
        }
        if (entry.isDirectory()) {
            await walkGlobAsync(nextPath, tail, matches, maxFiles);
        }
    }
}
function collectFilesRecursiveSync(dir, matches, maxFiles) {
    let entries;
    try {
        entries = fsSync.readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return;
    }
    for (const entry of entries) {
        if (matches.length >= maxFiles) {
            return;
        }
        const nextPath = path.join(dir, entry.name);
        if (entry.isFile()) {
            matches.push(nextPath);
        }
        else if (entry.isDirectory()) {
            collectFilesRecursiveSync(nextPath, matches, maxFiles);
        }
    }
}
async function collectFilesRecursiveAsync(dir, matches, maxFiles) {
    let entries;
    try {
        entries = await fs.readdir(dir, { withFileTypes: true });
    }
    catch {
        return;
    }
    for (const entry of entries) {
        if (matches.length >= maxFiles) {
            return;
        }
        const nextPath = path.join(dir, entry.name);
        if (entry.isFile()) {
            matches.push(nextPath);
        }
        else if (entry.isDirectory()) {
            await collectFilesRecursiveAsync(nextPath, matches, maxFiles);
            await yieldEventLoop();
        }
    }
}
function matchSegment(segment, name) {
    if (segment === '*') {
        return true;
    }
    if (segment.includes('*')) {
        const regex = new RegExp(`^${segment.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
        return regex.test(name);
    }
    return segment === name;
}
function yieldEventLoop() {
    return new Promise(resolve => setImmediate(resolve));
}
//# sourceMappingURL=glob.js.map