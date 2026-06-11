import * as readline from 'node:readline';
import { TOOL_DEFINITIONS, callTool } from './tools.js';
const SERVER_INFO = {
    name: 'codepulse-mcp',
    version: '0.1.0'
};
const PROTOCOL_VERSION = '2024-11-05';
export async function startMinimalServer() {
    const rl = readline.createInterface({
        input: process.stdin,
        terminal: false
    });
    rl.on('line', async (line) => {
        const trimmed = line.trim();
        if (!trimmed) {
            return;
        }
        let request;
        try {
            request = JSON.parse(trimmed);
        }
        catch {
            writeResponse({
                jsonrpc: '2.0',
                id: null,
                error: {
                    code: -32700,
                    message: 'Parse error'
                }
            });
            return;
        }
        const response = await handleRequest(request);
        if (response) {
            writeResponse(response);
        }
    });
}
async function handleRequest(request) {
    const id = request.id ?? null;
    if (request.method === 'notifications/initialized') {
        return null;
    }
    if (!request.method) {
        return {
            jsonrpc: '2.0',
            id,
            error: {
                code: -32600,
                message: 'Invalid Request'
            }
        };
    }
    try {
        switch (request.method) {
            case 'initialize':
                return {
                    jsonrpc: '2.0',
                    id,
                    result: {
                        protocolVersion: PROTOCOL_VERSION,
                        capabilities: {
                            tools: {}
                        },
                        serverInfo: SERVER_INFO
                    }
                };
            case 'tools/list':
                return {
                    jsonrpc: '2.0',
                    id,
                    result: {
                        tools: TOOL_DEFINITIONS
                    }
                };
            case 'tools/call': {
                const params = (request.params ?? {});
                if (!params.name) {
                    return {
                        jsonrpc: '2.0',
                        id,
                        error: {
                            code: -32602,
                            message: 'Missing tool name'
                        }
                    };
                }
                const result = await callTool(params.name, params.arguments ?? {});
                return {
                    jsonrpc: '2.0',
                    id,
                    result
                };
            }
            case 'ping':
                return {
                    jsonrpc: '2.0',
                    id,
                    result: {}
                };
            default:
                return {
                    jsonrpc: '2.0',
                    id,
                    error: {
                        code: -32601,
                        message: `Method not found: ${request.method}`
                    }
                };
        }
    }
    catch (error) {
        return {
            jsonrpc: '2.0',
            id,
            error: {
                code: -32603,
                message: error instanceof Error ? error.message : String(error)
            }
        };
    }
}
function writeResponse(response) {
    process.stdout.write(`${JSON.stringify(response)}\n`);
}
//# sourceMappingURL=mcp-minimal.js.map