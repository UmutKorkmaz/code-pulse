import * as assert from 'assert';
import * as vscode from 'vscode';
import { AiExtensionDetector, ExtensionLike } from '../../src/detectors/AiExtensionDetector';
import { AiDetectionForwarder } from '../../src/detectors/TerminalAiDetector';
import { DaemonEnvelope } from '../../src/client/DaemonClient';
import { Logger } from '../../src/utils/Logger';

interface EvidenceShape {
    type: string;
    timestamp: string;
    hash: string;
}

function makeExtension(
    id: string,
    isActive: boolean,
    displayName?: string,
    version = '1.2.3'
): ExtensionLike {
    return { id, isActive, packageJSON: { displayName, version } };
}

suite('AiExtensionDetector Test Suite', () => {
    let logger: Logger;
    let forwarded: DaemonEnvelope[] = [];
    let daemonMode = true;
    let forwarder: AiDetectionForwarder;
    let changeEmitter: vscode.EventEmitter<void>;
    let extensions: ExtensionLike[] = [];

    suiteSetup(() => {
        logger = new Logger(__dirname, 'debug');
    });

    suiteTeardown(() => {
        logger.dispose();
    });

    setup(() => {
        forwarded = [];
        daemonMode = true;
        extensions = [];
        forwarder = {
            isDaemonMode: () => daemonMode,
            ingest: async events => {
                forwarded.push(...events);
            }
        };
        changeEmitter = new vscode.EventEmitter<void>();
    });

    teardown(() => {
        changeEmitter.dispose();
    });

    function makeDetector(): AiExtensionDetector {
        return new AiExtensionDetector(forwarder, logger, {
            getExtensions: () => extensions,
            onDidChange: changeEmitter.event
        });
    }

    function forwardedTools(): string[] {
        return forwarded.map(envelope => envelope.payload.tool as string);
    }

    test('Should inventory known AI extensions and forward only the active ones', () => {
        extensions = [
            makeExtension('Anthropic.claude-code', true, 'Claude Code', '2.0.1'),
            makeExtension('GitHub.copilot', false, 'GitHub Copilot'),
            makeExtension('some.random-extension', true, 'Random')
        ];

        const detector = makeDetector();
        detector.start();

        const inventory = detector.getInventory();
        assert.strictEqual(inventory.length, 2, 'Only known AI extensions belong in the inventory');

        const claude = inventory.find(item => item.tool === 'Claude Code');
        assert.ok(claude, 'Claude Code must be inventoried');
        assert.strictEqual(claude?.id, 'Anthropic.claude-code');
        assert.strictEqual(claude?.displayName, 'Claude Code');
        assert.strictEqual(claude?.version, '2.0.1');
        assert.strictEqual(claude?.isActive, true);

        const copilot = inventory.find(item => item.tool === 'GitHub Copilot');
        assert.ok(copilot, 'Inactive known extensions are inventoried too');
        assert.strictEqual(copilot?.isActive, false);

        assert.deepStrictEqual(forwardedTools(), ['Claude Code'], 'Only active matches are forwarded');
        const envelope = forwarded[0];
        assert.strictEqual(envelope.type, 'ai.tool.detected');
        assert.strictEqual(envelope.src, 'vscode');

        const evidence = envelope.payload.evidence as EvidenceShape[];
        assert.strictEqual(evidence.length, 1);
        assert.strictEqual(evidence[0].type, 'extension_report');
        assert.ok(evidence[0].hash.length > 0);

        detector.dispose();
    });

    test('Should forward activation transitions on onDidChange without duplicates', () => {
        const copilot = makeExtension('GitHub.copilot', false, 'GitHub Copilot');
        extensions = [makeExtension('Anthropic.claude-code', true, 'Claude Code'), copilot];

        const detector = makeDetector();
        detector.start();
        assert.deepStrictEqual(forwardedTools(), ['Claude Code']);

        // Copilot activates later — onDidChange rescans and forwards only the transition.
        extensions = [
            makeExtension('Anthropic.claude-code', true, 'Claude Code'),
            makeExtension('GitHub.copilot', true, 'GitHub Copilot')
        ];
        changeEmitter.fire();

        assert.deepStrictEqual(
            forwardedTools(),
            ['Claude Code', 'GitHub Copilot'],
            'Already-reported active extensions must not be re-forwarded'
        );

        // A further unrelated change re-forwards nothing.
        changeEmitter.fire();
        assert.strictEqual(forwarded.length, 2);

        detector.dispose();
    });

    test('Should map copilot-chat to its own tool before the broader copilot match', () => {
        extensions = [makeExtension('GitHub.copilot-chat', true, 'GitHub Copilot Chat')];

        const detector = makeDetector();
        detector.start();

        const inventory = detector.getInventory();
        assert.strictEqual(inventory.length, 1);
        assert.strictEqual(inventory[0].tool, 'GitHub Copilot Chat');
        assert.deepStrictEqual(forwardedTools(), ['GitHub Copilot Chat']);

        detector.dispose();
    });

    test('Should keep the inventory without forwarding while daemon is unreachable', () => {
        daemonMode = false;
        extensions = [makeExtension('Anthropic.claude-code', true, 'Claude Code')];

        const detector = makeDetector();
        detector.start();

        assert.strictEqual(forwarded.length, 0, 'No envelopes while the daemon is in fallback mode');
        assert.strictEqual(detector.getInventory().length, 1, 'Inventory must still populate');

        detector.dispose();
    });

    test('Should clear inventory and stop scanning on dispose', () => {
        extensions = [makeExtension('Anthropic.claude-code', true, 'Claude Code')];

        const detector = makeDetector();
        detector.start();
        assert.strictEqual(detector.getInventory().length, 1);

        detector.dispose();
        assert.deepStrictEqual(detector.getInventory(), [], 'Inventory must be cleared on dispose');

        const countAfterDispose = forwarded.length;
        changeEmitter.fire();
        detector.scanNow();

        assert.strictEqual(forwarded.length, countAfterDispose, 'No scans may run after dispose');
        assert.deepStrictEqual(detector.getInventory(), []);
    });
});
