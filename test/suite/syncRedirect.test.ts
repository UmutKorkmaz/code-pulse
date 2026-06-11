import * as assert from 'assert';
import * as http from 'http';
import { AddressInfo } from 'net';
import axios, { AxiosInstance } from 'axios';
import { attachSameOriginRedirectRetry } from '../../src/storage/sync/providers';

suite('Sync Same-Origin Redirect Retry Test Suite', () => {
    let server: http.Server;
    let baseUrl: string;
    let authHeaders: Array<string | undefined> = [];

    suiteSetup(async () => {
        server = http.createServer((req, res) => {
            authHeaders.push(req.headers.authorization);

            if (req.url === '/snapshot') {
                // Trailing-slash style same-origin 301 (Nextcloud/Apache behavior).
                res.writeHead(301, { Location: '/snapshot/' });
                res.end();
                return;
            }

            if (req.url === '/snapshot/') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
                return;
            }

            if (req.url === '/cross-origin') {
                res.writeHead(302, { Location: 'https://elsewhere.example.com/snapshot' });
                res.end();
                return;
            }

            if (req.url === '/loop') {
                // A server that keeps redirecting to itself must not retry forever.
                res.writeHead(302, { Location: '/loop' });
                res.end();
                return;
            }

            res.writeHead(404);
            res.end();
        });

        // Ephemeral port only — never bind fixed daemon ports in tests.
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${address.port}`;
    });

    suiteTeardown(async () => {
        await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
    });

    setup(() => {
        authHeaders = [];
    });

    function makeClient(): AxiosInstance {
        const client = axios.create({
            baseURL: baseUrl,
            timeout: 5000,
            maxRedirects: 0,
            headers: { Authorization: 'Bearer test-token' }
        });
        attachSameOriginRedirectRetry(client);
        return client;
    }

    test('Re-issues a same-origin redirect once with credentials', async () => {
        const client = makeClient();
        const resp = await client.get('/snapshot');

        assert.deepStrictEqual(resp.data, { ok: true });
        assert.strictEqual(authHeaders.length, 2, 'Original request plus exactly one retry');
        assert.ok(
            authHeaders.every(header => header === 'Bearer test-token'),
            'Credentials must be kept on the same-origin retry'
        );
    });

    test('Cross-origin redirects fail with an actionable error', async () => {
        const client = makeClient();

        await assert.rejects(
            client.get('/cross-origin'),
            (error: Error) =>
                error.message ===
                'Sync server redirected to https://elsewhere.example.com; ' +
                    'update your Code Pulse sync URL to the final address.'
        );

        assert.strictEqual(authHeaders.length, 1, 'Credentials must never be sent to another origin');
    });

    test('Same-origin redirect loops stop after a single retry', async () => {
        const client = makeClient();

        await assert.rejects(client.get('/loop'));
        assert.strictEqual(authHeaders.length, 2, 'Only one redirect retry is allowed');
    });
});
