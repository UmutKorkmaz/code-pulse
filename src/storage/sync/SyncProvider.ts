/**
 * SyncProvider — cross-platform cloud storage abstraction for Code Pulse.
 *
 * All providers implement the same contract: upload/download a JSON snapshot.
 * This lets users continue sessions across devices via any of:
 *   - Custom REST endpoint (self-hosted)
 *   - WebDAV (NextCloud, ownCloud, Box, Yandex.Disk)
 *   - GitHub Gist (uses built-in VS Code auth, zero setup)
 *   - Google Drive (personal access token)
 *   - OneDrive (Microsoft Graph token)
 *   - Dropbox (personal access token)
 */

export interface SyncSnapshot {
    version: string;
    deviceId: string;
    updatedAt: string;
    sessions: unknown[];
    activities: unknown[];
    segments: unknown[];
    dailyRollups: unknown[];
}

export interface SyncResult {
    success: boolean;
    snapshot?: SyncSnapshot;
    error?: string;
}

export interface SyncProvider {
    readonly name: string;
    /** Push a snapshot to the remote store. */
    upload(snapshot: SyncSnapshot): Promise<SyncResult>;
    /** Pull the latest snapshot from the remote store. Returns undefined if nothing stored yet. */
    download(): Promise<SyncResult>;
    /** Verify that credentials work and the remote is reachable. */
    test(): Promise<SyncResult>;
}

export type ProviderKind = 'custom' | 'webdav' | 'github-gist' | 'google-drive' | 'onedrive' | 'dropbox';
