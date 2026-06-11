/**
 * Provider implementations for each supported cloud backend.
 * Each provider uploads/downloads a single JSON snapshot file.
 */

import axios, { AxiosError, AxiosInstance, InternalAxiosRequestConfig } from 'axios';
import * as vscode from 'vscode';
import { SyncProvider, SyncSnapshot, SyncResult } from './SyncProvider';

const SNAPSHOT_FILENAME = 'codepulse-sync.json';

const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

interface RedirectRetryConfig extends InternalAxiosRequestConfig {
    codepulseRedirectRetried?: boolean;
}

/**
 * Credentialed sync requests keep maxRedirects: 0 so tokens and basic auth can never
 * follow a redirect to another host. Ordinary SAME-ORIGIN redirects (trailing-slash
 * 301s on Nextcloud/Apache, load-balancer 307s) are re-issued once with credentials;
 * anything cross-origin fails with an actionable error instead of a generic axios one.
 */
export function attachSameOriginRedirectRetry(client: AxiosInstance): void {
    client.interceptors.response.use(undefined, (error: unknown) => {
        const response = (error as AxiosError).response;
        const config = (error as AxiosError).config as RedirectRetryConfig | undefined;

        if (!response || !config || !REDIRECT_STATUS_CODES.has(response.status) || config.codepulseRedirectRetried) {
            return Promise.reject(error);
        }

        const location = response.headers?.location;
        if (!location || typeof location !== 'string') {
            return Promise.reject(error);
        }

        let requestUrl: URL;
        let targetUrl: URL;
        try {
            requestUrl = new URL(config.url || '', config.baseURL || undefined);
            targetUrl = new URL(location, requestUrl);
        } catch {
            return Promise.reject(error);
        }

        if (targetUrl.origin !== requestUrl.origin) {
            return Promise.reject(
                new Error(
                    `Sync server redirected to ${targetUrl.origin}; ` +
                        'update your Code Pulse sync URL to the final address.'
                )
            );
        }

        const retryConfig: RedirectRetryConfig = {
            ...config,
            url: targetUrl.toString(),
            baseURL: undefined,
            params: undefined,
            codepulseRedirectRetried: true
        };

        return client.request(retryConfig);
    });
}

function ok(snapshot?: SyncSnapshot): SyncResult {
    return { success: true, snapshot };
}

function fail(error: unknown): SyncResult {
    return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
    };
}

/* -------------------- Custom REST (self-hosted) -------------------- */
export class CustomRestProvider implements SyncProvider {
    readonly name = 'Custom REST';
    private client: AxiosInstance;

    constructor(apiUrl: string, apiKey: string, timeout = 30000) {
        this.client = axios.create({
            baseURL: apiUrl,
            timeout,
            maxRedirects: 0,
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'User-Agent': 'CodePulse/1.0.0'
            }
        });
        attachSameOriginRedirectRetry(this.client);
    }

    async upload(snapshot: SyncSnapshot): Promise<SyncResult> {
        try {
            await this.client.put('/snapshot', snapshot);
            return ok();
        } catch (e) {
            return fail(e);
        }
    }

    async download(): Promise<SyncResult> {
        try {
            const resp = await this.client.get<SyncSnapshot>('/snapshot');
            return ok(resp.data);
        } catch (e) {
            if ((e as { response?: { status: number } })?.response?.status === 404) return ok();
            return fail(e);
        }
    }

    async test(): Promise<SyncResult> {
        try {
            await this.client.get('/health');
            return ok();
        } catch (e) {
            return fail(e);
        }
    }
}

/* -------------------- WebDAV (NextCloud, ownCloud, Box) -------------------- */
export class WebDavProvider implements SyncProvider {
    readonly name = 'WebDAV';
    private client: AxiosInstance;
    private path: string;

    constructor(baseUrl: string, username: string, password: string, path = SNAPSHOT_FILENAME, timeout = 30000) {
        this.path = path;
        this.client = axios.create({
            baseURL: baseUrl.replace(/\/$/, ''),
            timeout,
            maxRedirects: 0,
            auth: { username, password },
            headers: { 'Content-Type': 'application/json' }
        });
        attachSameOriginRedirectRetry(this.client);
    }

    async upload(snapshot: SyncSnapshot): Promise<SyncResult> {
        try {
            await this.client.put(`/${this.path}`, JSON.stringify(snapshot));
            return ok();
        } catch (e) {
            return fail(e);
        }
    }

    async download(): Promise<SyncResult> {
        try {
            const resp = await this.client.get<SyncSnapshot>(`/${this.path}`);
            return ok(resp.data);
        } catch (e) {
            if ((e as { response?: { status: number } })?.response?.status === 404) return ok();
            return fail(e);
        }
    }

    async test(): Promise<SyncResult> {
        try {
            // PROPFIND is the canonical WebDAV reachability check, but HEAD on root works everywhere
            await this.client.head('/');
            return ok();
        } catch (e) {
            return fail(e);
        }
    }
}

/* -------------------- GitHub Gist (zero-config via VS Code auth) -------------------- */
export class GitHubGistProvider implements SyncProvider {
    readonly name = 'GitHub Gist';
    private gistId?: string;
    private token?: string;
    private client: AxiosInstance;

    constructor(gistId?: string) {
        this.gistId = gistId;
        this.client = axios.create({
            baseURL: 'https://api.github.com',
            maxRedirects: 0,
            timeout: 30000,
            headers: {
                Accept: 'application/vnd.github+json',
                'User-Agent': 'CodePulse/1.0.0'
            }
        });
        attachSameOriginRedirectRetry(this.client);
    }

    private async getToken(): Promise<string> {
        if (this.token) return this.token;
        const session = await vscode.authentication.getSession('github', ['gist'], { createIfNone: true });
        this.token = session.accessToken;
        return this.token;
    }

    private async request<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T> {
        const token = await this.getToken();
        const resp = await this.client.request<T>({
            method,
            url: path,
            data: body,
            headers: { Authorization: `Bearer ${token}` }
        });
        return resp.data;
    }

    async upload(snapshot: SyncSnapshot): Promise<SyncResult> {
        try {
            const content = JSON.stringify(snapshot, null, 2);
            const files = { [SNAPSHOT_FILENAME]: { content } };

            if (this.gistId) {
                await this.request('PATCH', `/gists/${this.gistId}`, { files });
            } else {
                const created = await this.request<{ id: string }>('POST', '/gists', {
                    description: 'Code Pulse sync snapshot',
                    public: false,
                    files
                });
                this.gistId = created.id;
            }
            return ok();
        } catch (e) {
            return fail(e);
        }
    }

    async download(): Promise<SyncResult> {
        if (!this.gistId) return ok(); // nothing uploaded yet
        try {
            const gist = await this.request<{ files: Record<string, { content: string }> }>(
                'GET',
                `/gists/${this.gistId}`
            );
            const file = gist.files[SNAPSHOT_FILENAME];
            if (!file) return ok();
            return ok(JSON.parse(file.content) as SyncSnapshot);
        } catch (e) {
            return fail(e);
        }
    }

    async test(): Promise<SyncResult> {
        try {
            await this.request('GET', '/user');
            return ok();
        } catch (e) {
            return fail(e);
        }
    }

    getGistId(): string | undefined {
        return this.gistId;
    }
}

/* -------------------- Google Drive (personal OAuth token) -------------------- */
export class GoogleDriveProvider implements SyncProvider {
    readonly name = 'Google Drive';
    private token: string;
    private fileId?: string;

    constructor(accessToken: string, fileId?: string) {
        this.token = accessToken;
        this.fileId = fileId;
    }

    private get headers() {
        return {
            Authorization: `Bearer ${this.token}`,
            'User-Agent': 'CodePulse/1.0.0'
        };
    }

    async upload(snapshot: SyncSnapshot): Promise<SyncResult> {
        try {
            const body = JSON.stringify(snapshot);
            if (this.fileId) {
                await axios.patch(
                    `https://www.googleapis.com/upload/drive/v3/files/${this.fileId}?uploadType=media`,
                    body,
                    {
                        headers: { ...this.headers, 'Content-Type': 'application/json' },
                        maxRedirects: 0,
                        timeout: 30000
                    }
                );
            } else {
                const boundary = '-------codepulse-' + Date.now();
                const metadata = JSON.stringify({ name: SNAPSHOT_FILENAME, mimeType: 'application/json' });
                const multipart =
                    `--${boundary}\r\n` +
                    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
                    `${metadata}\r\n` +
                    `--${boundary}\r\n` +
                    `Content-Type: application/json\r\n\r\n` +
                    `${body}\r\n` +
                    `--${boundary}--`;
                const resp = await axios.post<{ id: string }>(
                    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
                    multipart,
                    {
                        headers: { ...this.headers, 'Content-Type': `multipart/related; boundary=${boundary}` },
                        maxRedirects: 0,
                        timeout: 30000
                    }
                );
                this.fileId = resp.data.id;
            }
            return ok();
        } catch (e) {
            return fail(e);
        }
    }

    async download(): Promise<SyncResult> {
        try {
            if (!this.fileId) {
                // Search for existing snapshot file
                const list = await axios.get<{ files: Array<{ id: string }> }>(
                    `https://www.googleapis.com/drive/v3/files?q=name%3D%27${encodeURIComponent(
                        SNAPSHOT_FILENAME
                    )}%27&spaces=drive`,
                    { headers: this.headers, maxRedirects: 0, timeout: 30000 }
                );
                if (list.data.files.length === 0) return ok();
                this.fileId = list.data.files[0].id;
            }
            const resp = await axios.get<SyncSnapshot>(
                `https://www.googleapis.com/drive/v3/files/${this.fileId}?alt=media`,
                { headers: this.headers, maxRedirects: 0, timeout: 30000 }
            );
            return ok(resp.data);
        } catch (e) {
            return fail(e);
        }
    }

    async test(): Promise<SyncResult> {
        try {
            await axios.get('https://www.googleapis.com/drive/v3/about?fields=user', {
                headers: this.headers,
                maxRedirects: 0,
                timeout: 30000
            });
            return ok();
        } catch (e) {
            return fail(e);
        }
    }

    getFileId(): string | undefined {
        return this.fileId;
    }
}

/* -------------------- OneDrive (Microsoft Graph) -------------------- */
export class OneDriveProvider implements SyncProvider {
    readonly name = 'OneDrive';
    private token: string;
    private filePath: string;

    constructor(accessToken: string, filePath = `/${SNAPSHOT_FILENAME}`) {
        this.token = accessToken;
        this.filePath = filePath.startsWith('/') ? filePath : `/${filePath}`;
    }

    private get headers() {
        return {
            Authorization: `Bearer ${this.token}`,
            'User-Agent': 'CodePulse/1.0.0'
        };
    }

    async upload(snapshot: SyncSnapshot): Promise<SyncResult> {
        try {
            await axios.put(
                `https://graph.microsoft.com/v1.0/me/drive/root:${this.filePath}:/content`,
                JSON.stringify(snapshot),
                {
                    headers: { ...this.headers, 'Content-Type': 'application/json' },
                    maxRedirects: 0,
                    timeout: 30000
                }
            );
            return ok();
        } catch (e) {
            return fail(e);
        }
    }

    async download(): Promise<SyncResult> {
        try {
            // Graph answers GET :/content with a 302 redirect to a pre-authenticated download URL.
            const redirect = await axios.get<SyncSnapshot>(
                `https://graph.microsoft.com/v1.0/me/drive/root:${this.filePath}:/content`,
                {
                    headers: this.headers,
                    maxRedirects: 0,
                    timeout: 30000,
                    validateStatus: status => (status >= 200 && status < 300) || status === 302
                }
            );

            if (redirect.status !== 302) {
                return ok(redirect.data);
            }

            const location = redirect.headers.location;
            if (!location || typeof location !== 'string') {
                return fail(new Error('OneDrive download redirect is missing the Location header'));
            }

            // Graph may answer with a relative Location header — resolve it against the Graph origin.
            const downloadUrl = new URL(location, 'https://graph.microsoft.com/').toString();

            // The download URL is pre-authenticated — do NOT send our bearer token to it.
            // Because no Authorization header is attached, a bounded redirect budget is safe
            // (SharePoint-backed tenants/CDNs can hop more than once).
            const resp = await axios.get<SyncSnapshot>(downloadUrl, {
                headers: { 'User-Agent': 'CodePulse/1.0.0' },
                maxRedirects: 3,
                timeout: 30000,
                transformResponse: [
                    (d: string) => {
                        try {
                            return JSON.parse(d);
                        } catch {
                            return d;
                        }
                    }
                ]
            });
            return ok(resp.data);
        } catch (e) {
            if ((e as { response?: { status: number } })?.response?.status === 404) return ok();
            return fail(e);
        }
    }

    async test(): Promise<SyncResult> {
        try {
            await axios.get('https://graph.microsoft.com/v1.0/me', { headers: this.headers, maxRedirects: 0, timeout: 30000 });
            return ok();
        } catch (e) {
            return fail(e);
        }
    }
}

/* -------------------- Dropbox -------------------- */
export class DropboxProvider implements SyncProvider {
    readonly name = 'Dropbox';
    private token: string;
    private filePath: string;

    constructor(accessToken: string, filePath = `/${SNAPSHOT_FILENAME}`) {
        this.token = accessToken;
        this.filePath = filePath.startsWith('/') ? filePath : `/${filePath}`;
    }

    async upload(snapshot: SyncSnapshot): Promise<SyncResult> {
        try {
            await axios.post('https://content.dropboxapi.com/2/files/upload', JSON.stringify(snapshot), {
                headers: {
                    Authorization: `Bearer ${this.token}`,
                    'Content-Type': 'application/octet-stream',
                    'Dropbox-API-Arg': JSON.stringify({
                        path: this.filePath,
                        mode: 'overwrite',
                        autorename: false,
                        mute: true
                    })
                },
                maxRedirects: 0,
                timeout: 30000
            });
            return ok();
        } catch (e) {
            return fail(e);
        }
    }

    async download(): Promise<SyncResult> {
        try {
            const resp = await axios.post<SyncSnapshot>('https://content.dropboxapi.com/2/files/download', '', {
                headers: {
                    Authorization: `Bearer ${this.token}`,
                    'Dropbox-API-Arg': JSON.stringify({ path: this.filePath })
                },
                maxRedirects: 0,
                timeout: 30000,
                transformResponse: [
                    (d: string) => {
                        try {
                            return JSON.parse(d);
                        } catch {
                            return d;
                        }
                    }
                ]
            });
            return ok(resp.data);
        } catch (e) {
            const err = e as { response?: { status: number } };
            if (err?.response?.status === 409) return ok(); // path/not_found
            return fail(e);
        }
    }

    async test(): Promise<SyncResult> {
        try {
            await axios.post('https://api.dropboxapi.com/2/users/get_current_account', null, {
                headers: { Authorization: `Bearer ${this.token}` },
                maxRedirects: 0,
                timeout: 30000
            });
            return ok();
        } catch (e) {
            return fail(e);
        }
    }
}
