"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WsBroadcaster = void 0;
const ws_1 = require("ws");
const cors_1 = require("../http/cors");
class WsBroadcaster {
    port;
    host;
    metrics;
    authToken;
    server = null;
    clients = new Set();
    listeners = new Set();
    constructor(port, host, metrics, authToken) {
        this.port = port;
        this.host = host;
        this.metrics = metrics;
        this.authToken = authToken;
    }
    async start() {
        if (this.server) {
            return;
        }
        await new Promise((resolve, reject) => {
            const server = new ws_1.WebSocketServer({ host: this.host, port: this.port, noServer: false }, () => resolve());
            server.on('error', reject);
            server.on('connection', (socket, request) => this.handleConnection(socket, request));
            this.server = server;
        });
        this.metrics.setGauge('codepulse_ws_clients_connected', 0);
    }
    async stop() {
        for (const client of this.clients) {
            client.close();
        }
        this.clients.clear();
        this.metrics.setGauge('codepulse_ws_clients_connected', 0);
        if (!this.server) {
            return;
        }
        await new Promise((resolve, reject) => {
            this.server.close(error => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve();
            });
        });
        this.server = null;
    }
    onEnvelope(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    broadcast(envelope) {
        const payload = JSON.stringify(envelope);
        for (const client of this.clients) {
            if (client.readyState === ws_1.WebSocket.OPEN) {
                client.send(payload);
            }
        }
        this.metrics.increment('codepulse_ws_messages_broadcast_total');
        for (const listener of this.listeners) {
            listener(envelope);
        }
    }
    getConnectedClients() {
        return this.clients.size;
    }
    handleConnection(socket, request) {
        // DNS-rebinding defense: reject upgrades whose Host header is not loopback.
        if (!(0, cors_1.isLoopbackHost)(request)) {
            socket.close(4403, 'Forbidden host');
            this.metrics.increment('codepulse_ws_host_rejected_total');
            return;
        }
        const url = new URL(request.url ?? '/', `http://${this.host}:${this.port}`);
        const token = url.searchParams.get('token') ??
            (typeof request.headers.authorization === 'string' &&
                request.headers.authorization.startsWith('Bearer ')
                ? request.headers.authorization.slice(7).trim()
                : null);
        if (!token || !(0, cors_1.timingSafeEqualString)(token, this.authToken)) {
            socket.close(4401, 'Unauthorized');
            this.metrics.increment('codepulse_ws_auth_rejected_total');
            return;
        }
        const origin = request.headers.origin;
        if (origin && !(0, cors_1.resolveAllowedOrigin)(request)) {
            socket.close(4403, 'Forbidden origin');
            this.metrics.increment('codepulse_ws_origin_rejected_total');
            return;
        }
        this.clients.add(socket);
        this.metrics.setGauge('codepulse_ws_clients_connected', this.clients.size);
        this.metrics.increment('codepulse_ws_connections_total');
        socket.on('close', () => {
            this.clients.delete(socket);
            this.metrics.setGauge('codepulse_ws_clients_connected', this.clients.size);
        });
        socket.on('error', () => {
            this.clients.delete(socket);
            this.metrics.setGauge('codepulse_ws_clients_connected', this.clients.size);
        });
    }
}
exports.WsBroadcaster = WsBroadcaster;
//# sourceMappingURL=broadcaster.js.map