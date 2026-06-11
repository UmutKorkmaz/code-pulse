declare module '@modelcontextprotocol/sdk/server/index.js' {
    export class Server {
        constructor(info: { name: string; version: string }, config: { capabilities: Record<string, unknown> });
        setRequestHandler(schema: unknown, handler: (request: never) => Promise<unknown>): void;
        connect(transport: unknown): Promise<void>;
    }
}

declare module '@modelcontextprotocol/sdk/server/stdio.js' {
    export class StdioServerTransport {
        constructor();
    }
}

declare module '@modelcontextprotocol/sdk/types.js' {
    export const ListToolsRequestSchema: unknown;
    export const CallToolRequestSchema: unknown;
}