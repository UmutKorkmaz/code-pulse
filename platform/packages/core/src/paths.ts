import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export function expandHome(inputPath: string): string {
    if (inputPath === '~') {
        return os.homedir();
    }
    if (inputPath.startsWith('~/') || inputPath.startsWith('~\\')) {
        return path.join(os.homedir(), inputPath.slice(2));
    }
    return inputPath;
}

export function defaultDataDir(): string {
    return path.join(os.homedir(), '.codepulse');
}

export function ensureDir(dirPath: string): void {
    fs.mkdirSync(dirPath, { recursive: true });
}

export function readTextFileIfExists(filePath: string): string | undefined {
    try {
        return fs.readFileSync(filePath, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return undefined;
        }
        throw error;
    }
}

export function writeTextFile(filePath: string, contents: string): void {
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, contents, 'utf8');
}