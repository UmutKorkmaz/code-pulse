import * as vscode from 'vscode';
import { Logger } from '../utils/Logger';
import { AiDetectionForwarder, buildAiToolDetectedEnvelope } from './TerminalAiDetector';

/** Detection-strategy §4.5 confidence weight for extension-report evidence. */
export const EXTENSION_DETECTION_CONFIDENCE = 0.2;

/**
 * Known AI extension id substrings, matched case-insensitively against the
 * `publisher.name` extension id. Order matters: more specific entries first
 * (copilot-chat before copilot).
 *
 * `tool` is the canonical tool name and MUST match the registry-catalog
 * manifest `displayName` (and TerminalAiDetector's AI_CLI_TOOLS) wherever a
 * CLI counterpart exists, so an extension-sourced detection merges into the
 * same daemon session and the same unified-panel row as the process/terminal
 * sources instead of creating a duplicate. `scannerId` is the manifest `id`
 * when one exists; extension-only tools (Copilot has no CLI) omit it.
 */
export const KNOWN_AI_EXTENSIONS: readonly { idSubstring: string; tool: string; scannerId?: string }[] = [
    { idSubstring: 'anthropic.claude-code', tool: 'Claude Code', scannerId: 'scn.claude-code' },
    { idSubstring: 'github.copilot-chat', tool: 'GitHub Copilot Chat' }, // extension-only, no CLI manifest
    { idSubstring: 'github.copilot', tool: 'GitHub Copilot' }, // extension-only, no CLI manifest
    { idSubstring: 'saoudrizwan.claude-dev', tool: 'Cline', scannerId: 'scn.cline' }, // original publisher id
    { idSubstring: 'cline.cline', tool: 'Cline', scannerId: 'scn.cline' }, // current publisher id
    { idSubstring: 'openai.chatgpt', tool: 'OpenAI Codex', scannerId: 'scn.openai-codex' },
    { idSubstring: 'kilocode', tool: 'Kilo', scannerId: 'scn.kilo' },
    { idSubstring: 'anysphere', tool: 'Cursor', scannerId: 'scn.cursor-ide' } // Cursor-adjacent publishers
];

/** Structural subset of vscode.Extension used by the detector — test-injectable. */
export interface ExtensionLike {
    id: string;
    isActive: boolean;
    packageJSON?: { displayName?: string; version?: string };
}

export interface AiExtensionInfo {
    id: string;
    displayName: string;
    version: string;
    /** Canonical tool name the extension maps to (e.g. 'claude', 'copilot'). */
    tool: string;
    isActive: boolean;
}

export interface AiExtensionDetectorOptions {
    getExtensions?: () => readonly ExtensionLike[];
    onDidChange?: vscode.Event<void>;
}

/**
 * Scans the installed-extension inventory for known AI extensions on
 * activation and whenever `vscode.extensions.onDidChange` fires. Active
 * matches are forwarded as `ai.tool.detected` envelopes with
 * 'extension_report' evidence (once per activation transition); the full
 * inventory is exposed for the dashboard's AI extensions list.
 */
export class AiExtensionDetector implements vscode.Disposable {
    private readonly subscriptions: vscode.Disposable[] = [];
    private inventory: AiExtensionInfo[] = [];
    private readonly forwardedActiveIds = new Set<string>();
    private isDisposed = false;
    private readonly getExtensions: () => readonly ExtensionLike[];
    private readonly onDidChange: vscode.Event<void>;

    constructor(
        private readonly forwarder: AiDetectionForwarder,
        private readonly logger: Logger,
        options: AiExtensionDetectorOptions = {}
    ) {
        this.getExtensions = options.getExtensions ?? (() => vscode.extensions.all);
        this.onDidChange = options.onDidChange ?? vscode.extensions.onDidChange;
    }

    public start(): void {
        if (this.isDisposed || this.subscriptions.length > 0) {
            return;
        }

        this.subscriptions.push(this.onDidChange(() => this.scanNow()));
        this.scanNow();
    }

    /** Current AI extension inventory (id, displayName, version, isActive). */
    public getInventory(): AiExtensionInfo[] {
        return this.inventory.map(item => ({ ...item }));
    }

    public scanNow(): void {
        if (this.isDisposed) {
            return;
        }

        const nextInventory: AiExtensionInfo[] = [];
        const activeIds = new Set<string>();

        for (const extension of this.getExtensions()) {
            const known = matchKnownAiExtension(extension.id);
            if (!known) {
                continue;
            }

            const isActive = extension.isActive === true;
            nextInventory.push({
                id: extension.id,
                displayName: extension.packageJSON?.displayName || extension.id,
                version: extension.packageJSON?.version || 'unknown',
                tool: known.tool,
                isActive
            });

            if (isActive) {
                activeIds.add(extension.id);
                if (!this.forwardedActiveIds.has(extension.id)) {
                    this.forwardDetection(known.tool, extension.id, extension.packageJSON?.version, known.scannerId);
                }
            }
        }

        // Re-arm forwarding for extensions that deactivated so a later
        // re-activation is reported again instead of being swallowed.
        for (const id of Array.from(this.forwardedActiveIds)) {
            if (!activeIds.has(id)) {
                this.forwardedActiveIds.delete(id);
            }
        }
        for (const id of activeIds) {
            this.forwardedActiveIds.add(id);
        }

        this.inventory = nextInventory;
    }

    public dispose(): void {
        this.isDisposed = true;

        for (const subscription of this.subscriptions.splice(0)) {
            try {
                subscription.dispose();
            } catch {
                /* best-effort */
            }
        }

        this.inventory = [];
        this.forwardedActiveIds.clear();
    }

    private forwardDetection(tool: string, extensionId: string, version?: string, scannerId?: string): void {
        // Same gating rationale as TerminalAiDetector: never grow the fallback
        // buffer with periodic presence detections while the daemon is down.
        if (!this.forwarder.isDaemonMode()) {
            return;
        }

        const envelope = buildAiToolDetectedEnvelope(
            tool,
            'extension_report',
            EXTENSION_DETECTION_CONFIDENCE,
            `extension:${extensionId}:${version ?? 'unknown'}`,
            scannerId
        );

        void this.forwarder.ingest([envelope]).catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.warn(`Failed to forward AI extension detection (${extensionId}): ${message}`);
        });
    }
}

function matchKnownAiExtension(
    extensionId: string
): { idSubstring: string; tool: string; scannerId?: string } | undefined {
    const normalizedId = (extensionId || '').toLowerCase();
    if (!normalizedId) {
        return undefined;
    }

    return KNOWN_AI_EXTENSIONS.find(entry => normalizedId.includes(entry.idSubstring));
}
