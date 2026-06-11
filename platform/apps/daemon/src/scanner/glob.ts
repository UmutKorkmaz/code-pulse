import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { expandHome } from '@codepulse/core';

const DEFAULT_MAX_FILES = 48;
/** Generous traversal bound so newest-by-mtime selection sees every candidate. */
const MAX_WALK_MATCHES = 10_000;

type TruncateCallback = (droppedCount: number) => void;

export function expandLogGlob(
    pattern: string,
    maxFiles = DEFAULT_MAX_FILES,
    onTruncate?: TruncateCallback
): string[] {
    const normalized = expandHome(pattern);
    const starIndex = normalized.indexOf('*');

    if (starIndex === -1) {
        return fsSync.existsSync(normalized) ? [normalized] : [];
    }

    const { baseDir, relativePattern } = splitPattern(normalized, starIndex);

    if (!fsSync.existsSync(baseDir)) {
        return [];
    }

    const matches: string[] = [];
    walkGlobSync(baseDir, relativePattern.split('/'), matches, MAX_WALK_MATCHES);
    return selectNewestFilesSync(matches, maxFiles, onTruncate);
}

export async function expandLogGlobAsync(
    pattern: string,
    maxFiles = DEFAULT_MAX_FILES,
    onTruncate?: TruncateCallback
): Promise<string[]> {
    const normalized = expandHome(pattern);
    const starIndex = normalized.indexOf('*');

    if (starIndex === -1) {
        try {
            await fs.access(normalized);
            return [normalized];
        } catch {
            return [];
        }
    }

    const { baseDir, relativePattern } = splitPattern(normalized, starIndex);

    try {
        await fs.access(baseDir);
    } catch {
        return [];
    }

    const matches: string[] = [];
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
function splitPattern(
    normalized: string,
    starIndex: number
): { baseDir: string; relativePattern: string } {
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
function selectNewestFilesSync(
    matches: string[],
    maxFiles: number,
    onTruncate?: TruncateCallback
): string[] {
    if (matches.length <= maxFiles) {
        return [...matches].sort();
    }

    const withMtime = matches.map(filePath => {
        try {
            return { filePath, mtimeMs: fsSync.statSync(filePath).mtimeMs };
        } catch {
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

async function selectNewestFilesAsync(
    matches: string[],
    maxFiles: number,
    onTruncate?: TruncateCallback
): Promise<string[]> {
    if (matches.length <= maxFiles) {
        return [...matches].sort();
    }

    const withMtime = await Promise.all(
        matches.map(async filePath => {
            try {
                const stat = await fs.stat(filePath);
                return { filePath, mtimeMs: stat.mtimeMs };
            } catch {
                return { filePath, mtimeMs: 0 };
            }
        })
    );
    withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);
    onTruncate?.(matches.length - maxFiles);
    return withMtime
        .slice(0, maxFiles)
        .map(entry => entry.filePath)
        .sort();
}

/** @deprecated Prefer expandLogGlobAsync — sync walk blocks the event loop. */
function walkGlobSync(
    currentDir: string,
    segments: string[],
    matches: string[],
    maxFiles: number
): void {
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
        let entries: fsSync.Dirent[];
        try {
            entries = fsSync.readdirSync(currentDir, { withFileTypes: true });
        } catch {
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

    let entries: fsSync.Dirent[];
    try {
        entries = fsSync.readdirSync(currentDir, { withFileTypes: true });
    } catch {
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

async function walkGlobAsync(
    currentDir: string,
    segments: string[],
    matches: string[],
    maxFiles: number
): Promise<void> {
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
        let entries: fsSync.Dirent[];
        try {
            entries = await fs.readdir(currentDir, { withFileTypes: true });
        } catch {
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

    let entries: fsSync.Dirent[];
    try {
        entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
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

function collectFilesRecursiveSync(dir: string, matches: string[], maxFiles: number): void {
    let entries: fsSync.Dirent[];
    try {
        entries = fsSync.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }

    for (const entry of entries) {
        if (matches.length >= maxFiles) {
            return;
        }
        const nextPath = path.join(dir, entry.name);
        if (entry.isFile()) {
            matches.push(nextPath);
        } else if (entry.isDirectory()) {
            collectFilesRecursiveSync(nextPath, matches, maxFiles);
        }
    }
}

async function collectFilesRecursiveAsync(
    dir: string,
    matches: string[],
    maxFiles: number
): Promise<void> {
    let entries: fsSync.Dirent[];
    try {
        entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
        return;
    }

    for (const entry of entries) {
        if (matches.length >= maxFiles) {
            return;
        }
        const nextPath = path.join(dir, entry.name);
        if (entry.isFile()) {
            matches.push(nextPath);
        } else if (entry.isDirectory()) {
            await collectFilesRecursiveAsync(nextPath, matches, maxFiles);
            await yieldEventLoop();
        }
    }
}

function matchSegment(segment: string, name: string): boolean {
    if (segment === '*') {
        return true;
    }
    if (segment.includes('*')) {
        const regex = new RegExp(
            `^${segment.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`
        );
        return regex.test(name);
    }
    return segment === name;
}

function yieldEventLoop(): Promise<void> {
    return new Promise(resolve => setImmediate(resolve));
}
