import * as crypto from 'crypto';

function anonymizeValue(value: string, prefix: string): string {
    const hash = crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
    return `${prefix}-${hash}`;
}

export function sanitizeProjectName(projectName: string, anonymizeData: boolean): string {
    if (!projectName) {
        return 'unknown';
    }

    return anonymizeData ? anonymizeValue(projectName, 'project') : projectName;
}

export function sanitizeFilePath(
    filePath: string,
    trackFilenames: boolean,
    anonymizeData: boolean
): string {
    if (!filePath) {
        return 'untitled';
    }

    if (!trackFilenames) {
        return 'hidden';
    }

    return anonymizeData ? anonymizeValue(filePath, 'file') : filePath;
}
