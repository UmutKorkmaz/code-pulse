import * as http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import type { AnyEnvelope } from '@codepulse/protocol';
import type { MetricsRegistry } from '../metrics';
import { isLoopbackHost, resolveAllowedOrigin, timingSafeEqualString } from '../http/cors';

export type EnvelopeListener = (envelope: AnyEnvelope) => void;

export class WsBroadcaster {
    private server: WebSocketServer | null = null;
    private readonly clients = new Set<WebSocket>();
    private readonly listeners = new Set<EnvelopeListener>();

    constructor(
        private readonly port: number,
        private readonly host: string,
        private readonly metrics: MetricsRegistry,
        private readonly authToken: string
    ) {}

    async start(): Promise<void> {
        if (this.server) {
            return;
        }

        await new Promise<void>((resolve, reject) => {
            const server = new WebSocketServer({ host: this.host, port: this.port, noServer: false }, () =>
                resolve()
            );
            server.on('error', reject);
            server.on('connection', (socket, request) => this.handleConnection(socket, request));
            this.server = server;
        });

        this.metrics.setGauge('codepulse_ws_clients_connected', 0);
    }

    async stop(): Promise<void> {
        for (const client of this.clients) {
            client.close();
        }
        this.clients.clear();
        this.metrics.setGauge('codepulse_ws_clients_connected', 0);

        if (!this.server) {
            return;
        }

        await new Promise<void>((resolve, reject) => {
            this.server!.close(error => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve();
            });
        });

        this.server = null;
    }

    onEnvelope(listener: EnvelopeListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    broadcast(envelope: AnyEnvelope): void {
        const payload = JSON.stringify(envelope);

        for (const client of this.clients) {
            if (client.readyState === WebSocket.OPEN) {
                client.send(payload);
            }
        }

        this.metrics.increment('codepulse_ws_messages_broadcast_total');
        for (const listener of this.listeners) {
            listener(envelope);
        }
    }

    getConnectedClients(): number {
        return this.clients.size;
    }

    private handleConnection(socket: WebSocket, request: http.IncomingMessage): void {
        // DNS-rebinding defense: reject upgrades whose Host header is not loopback.
        if (!isLoopbackHost(request)) {
            socket.close(4403, 'Forbidden host');
            this.metrics.increment('codepulse_ws_host_rejected_total');
            return;
        }

        const url = new URL(request.url ?? '/', `http://${this.host}:${this.port}`);
        const token =
            url.searchParams.get('token') ??
            (typeof request.headers.authorization === 'string' &&
            request.headers.authorization.startsWith('Bearer ')
                ? request.headers.authorization.slice(7).trim()
                : null);

        if (!token || !timingSafeEqualString(token, this.authToken)) {
            socket.close(4401, 'Unauthorized');
            this.metrics.increment('codepulse_ws_auth_rejected_total');
            return;
        }

        const origin = request.headers.origin;
        if (origin && !resolveAllowedOrigin(request)) {
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