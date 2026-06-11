import * as assert from 'assert';
import * as http from 'http';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { AddressInfo } from 'net';
import * as vscode from 'vscode';
import { ApiServer } from '../../src/api/ApiServer';
import { TimeTracker } from '../../src/tracker/TimeTracker';
import { DatabaseManager } from '../../src/storage/DatabaseManager';
import { ConfigManager } from '../../src/utils/ConfigManager';

const TEST_TOKEN = 'test-api-token-123';

interface HttpResult {
    status: number;
    headers: http.IncomingHttpHeaders;
    body: any;
}

function httpGet(
    port: number,
    requestPath: string,
    headers: http.OutgoingHttpHeaders = {}
): Promise<HttpResult> {
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                hostname: '127.0.0.1',
                port,
                path: requestPath,
                method: 'GET',
                headers
            },
            res => {
                let raw = '';
                res.on('data', chunk => {
                    raw += chunk.toString();
                });
                res.on('end', () => {
                    try {
                        resolve({
                            status: res.statusCode || 0,
                            headers: res.headers,
                            body: JSON.parse(raw)
                        });
                    } catch (error) {
                        reject(error);
                    }
                });
            }
        );

        req.on('error', reject);
        req.end();
    });
}

function makeConfigManager(values: { [key: string]: unknown }): ConfigManager {
    return {
        get: <T>(key: string, defaultValue?: T): T =>
            key in values ? (values[key] as T) : (defaultValue as T)
    } as unknown as ConfigManager;
}

const timeTrackerStub = {
    getCurrentSession: () => null,
    getTodaysStats: async () => ({}),
    getWeeklyStats: async () => []
} as unknown as TimeTracker;

const databaseManagerStub = {
    getSessionsByDateRange: async () => [{ duration: 60000 }, { duration: 30000 }],
    getTotalTimeByProject: async () => ({ 'code-pulse': 90000 }),
    getTotalTimeByLanguage: async () => ({ typescript: 90000 }),
    getActivitiesByDateRange: async () => [],
    exportAllData: async () => ({ sessions: [] })
} as unknown as DatabaseManager;

function getPort(server: ApiServer): number {
    const address = (server as any).server.address() as AddressInfo;
    return address.port;
}

suite('ApiServer Test Suite', () => {
    suite('Configured token, localhost-only bind', () => {
        let apiServer: ApiServer;
        let port: number;

        suiteSetup(async () => {
            const configManager = makeConfigManager({
                // Port 0 makes the OS assign an ephemeral port — never collides with real services.
                'localServer.port': 0,
                // Localhost-only bind: auth must STILL be enforced (the DB is sensitive).
                'localServer.allowExternalConnections': false,
                'localServer.apiToken': TEST_TOKEN
            });

            apiServer = new ApiServer(timeTrackerStub, databaseManagerStub, configManager);
            await apiServer.start();
            port = getPort(apiServer);
            assert.ok(port > 0, 'Server should be bound to an ephemeral port');
        });

        suiteTeardown(async () => {
            if (apiServer) {
                await apiServer.stop();
            }
        });

        test('Rejects requests without a token with 401 even on localhost binds', async () => {
            const result = await httpGet(port, '/health');

            assert.strictEqual(result.status, 401);
            assert.strictEqual(result.headers['www-authenticate'], 'Bearer');
            assert.strictEqual(result.body.success, false);
            assert.ok(String(result.body.error).includes('Unauthorized'));
            assert.strictEqual(typeof result.body.timestamp, 'string');
        });

        test('Rejects requests with an invalid bearer token with 401', async () => {
            const result = await httpGet(port, '/health', {
                Authorization: 'Bearer not-the-right-token'
            });

            assert.strictEqual(result.status, 401);
            assert.strictEqual(result.body.success, false);
        });

        test('Rejects a token of the wrong length with 401 (timing-safe path)', async () => {
            const result = await httpGet(port, '/health', {
                Authorization: 'Bearer x'
            });

            assert.strictEqual(result.status, 401);
            assert.strictEqual(result.body.success, false);
        });

        test('Accepts requests with a valid Authorization bearer token', async () => {
            const result = await httpGet(port, '/health', {
                Authorization: `Bearer ${TEST_TOKEN}`
            });

            assert.strictEqual(result.status, 200);
            assert.strictEqual(result.body.success, true);
            assert.strictEqual(result.body.data.status, 'healthy');
            assert.strictEqual(result.body.data.tracking, false);
        });

        test('Accepts the token via the token query parameter', async () => {
            const result = await httpGet(port, `/health?token=${TEST_TOKEN}`);

            assert.strictEqual(result.status, 200);
            assert.strictEqual(result.body.success, true);
        });

        test('Returns the response envelope shape for /stats', async () => {
            const result = await httpGet(port, '/stats?days=7', {
                Authorization: `Bearer ${TEST_TOKEN}`
            });

            assert.strictEqual(result.status, 200);

            // Envelope shape: { success, data, timestamp } with no error on success.
            assert.strictEqual(result.body.success, true);
            assert.strictEqual(result.body.error, undefined);
            assert.strictEqual(typeof result.body.timestamp, 'string');
            assert.ok(!Number.isNaN(Date.parse(result.body.timestamp)), 'timestamp should be ISO parseable');

            // Data payload built from the stubbed DatabaseManager.
            assert.strictEqual(result.body.data.sessions, 2);
            assert.strictEqual(result.body.data.totalTime, 90000);
            assert.strictEqual(result.body.data.projects, 1);
            assert.strictEqual(result.body.data.languages, 1);
            assert.deepStrictEqual(result.body.data.projectStats, { 'code-pulse': 90000 });
            assert.deepStrictEqual(result.body.data.languageStats, { typescript: 90000 });
            assert.strictEqual(typeof result.body.data.dateRange.start, 'string');
            assert.strictEqual(typeof result.body.data.dateRange.end, 'string');
        });

        test('Rejects a non-loopback Host header with 403 (DNS-rebinding defense)', async () => {
            const result = await httpGet(port, '/health', {
                Host: 'evil.example.com',
                Authorization: `Bearer ${TEST_TOKEN}`
            });

            assert.strictEqual(result.status, 403);
            assert.strictEqual(result.body.success, false);
            assert.ok(String(result.body.error).includes('Forbidden host'));
        });

        test('Exposes the active token via getActiveToken()', () => {
            assert.strictEqual(apiServer.getActiveToken(), TEST_TOKEN);
        });
    });

    suite('Auto-generated persisted token', () => {
        let storageDir: string;

        suiteSetup(() => {
            storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codepulse-apitoken-'));
        });

        suiteTeardown(() => {
            fs.rmSync(storageDir, { recursive: true, force: true });
        });

        test('Generates, persists, and reuses a token when none is configured', () => {
            // No configured token: a random one is generated and written to disk.
            const configManager = makeConfigManager({ 'localServer.apiToken': '' });
            const first = new ApiServer(timeTrackerStub, databaseManagerStub, configManager, storageDir);
            const token = first.getActiveToken();

            assert.ok(token.length > 0, 'A token should be generated');
            assert.ok(fs.existsSync(path.join(storageDir, 'api-token')), 'Token file should be persisted');

            // A fresh server using the same storage path reuses the same token.
            const second = new ApiServer(timeTrackerStub, databaseManagerStub, configManager, storageDir);
            assert.strictEqual(second.getActiveToken(), token, 'Token should be reused across instances');
        });

        test('Enforces the auto-generated token on every request', async () => {
            const configManager = makeConfigManager({
                'localServer.port': 0,
                'localServer.allowExternalConnections': false,
                'localServer.apiToken': ''
            });
            const apiServer = new ApiServer(timeTrackerStub, databaseManagerStub, configManager, storageDir);
            await apiServer.start();
            const port = getPort(apiServer);

            try {
                const unauthorized = await httpGet(port, '/health');
                assert.strictEqual(unauthorized.status, 401);

                const authorized = await httpGet(port, '/health', {
                    Authorization: `Bearer ${apiServer.getActiveToken()}`
                });
                assert.strictEqual(authorized.status, 200);
                assert.strictEqual(authorized.body.success, true);
            } finally {
                await apiServer.stop();
            }
        });
    });

    test('Registers the copyApiToken command', async () => {
        const extension = vscode.extensions.getExtension('umutkorkmaz.code-pulse');
        assert.ok(extension);
        if (!extension.isActive) {
            await extension.activate();
        }

        const commands = await vscode.commands.getCommands(true);
        assert.ok(
            commands.includes('codepulse.copyApiToken'),
            'codepulse.copyApiToken should be registered'
        );
    });
});
