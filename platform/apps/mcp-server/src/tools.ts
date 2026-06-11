import { createDaemonClient } from '@codepulse/client';

export interface McpToolDefinition {
    name: string;
    description: string;
    inputSchema: {
        type: 'object';
        properties: Record<string, unknown>;
        required?: string[];
        additionalProperties?: boolean;
    };
}

export const TOOL_DEFINITIONS: McpToolDefinition[] = [
    {
        name: 'get_today_tokens',
        description: 'Return today\'s AI token usage aggregates from the Code Pulse daemon.',
        inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false
        }
    },
    {
        name: 'get_ai_sessions',
        description: 'Return recent AI-attributed coding sessions from the Code Pulse daemon.',
        inputSchema: {
            type: 'object',
            properties: {
                limit: {
                    type: 'number',
                    description: 'Maximum number of sessions to return (default: 50)'
                }
            },
            additionalProperties: false
        }
    },
    {
        name: 'get_daemon_status',
        description: 'Return Code Pulse daemon status, version, uptime, and connected clients.',
        inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false
        }
    }
];

export interface ToolCallResult {
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
}

export async function callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolCallResult> {
    const client = createDaemonClient();

    try {
        switch (name) {
            case 'get_today_tokens': {
                const tokens = await client.getTodayTokens();
                return textResult({
                    daemonUrl: client.getBaseUrl(),
                    day: new Date().toISOString().slice(0, 10),
                    tokens
                });
            }

            case 'get_ai_sessions': {
                const limit = typeof args.limit === 'number' ? args.limit : 50;
                const sessions = await client.getAiSessions(limit);
                return textResult({
                    daemonUrl: client.getBaseUrl(),
                    ...sessions
                });
            }

            case 'get_daemon_status': {
                const [status, health, ping] = await Promise.all([
                    client.getStatus(),
                    client.getHealth(),
                    client.ping()
                ]);

                return textResult({
                    daemonUrl: client.getBaseUrl(),
                    status,
                    health,
                    ping
                });
            }

            default:
                return errorResult(`Unknown tool: ${name}`);
        }
    } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
    }
}

function textResult(value: unknown): ToolCallResult {
    return {
        content: [
            {
                type: 'text',
                text: JSON.stringify(value, null, 2)
            }
        ]
    };
}

function errorResult(message: string): ToolCallResult {
    return {
        isError: true,
        content: [
            {
                type: 'text',
                text: message
            }
        ]
    };
}