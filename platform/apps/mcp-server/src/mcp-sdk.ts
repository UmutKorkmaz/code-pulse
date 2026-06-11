import { TOOL_DEFINITIONS, callTool } from './tools.js';

export async function tryStartSdkServer(): Promise<boolean> {
    try {
        const [{ Server }, { StdioServerTransport }, { CallToolRequestSchema, ListToolsRequestSchema }] =
            await Promise.all([
                import('@modelcontextprotocol/sdk/server/index.js'),
                import('@modelcontextprotocol/sdk/server/stdio.js'),
                import('@modelcontextprotocol/sdk/types.js')
            ]);

        const server = new Server(
            {
                name: 'codepulse-mcp',
                version: '0.1.0'
            },
            {
                capabilities: {
                    tools: {}
                }
            }
        );

        server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: TOOL_DEFINITIONS.map(tool => ({
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema
            }))
        }));

        server.setRequestHandler(CallToolRequestSchema, async (request: {
            params: { name: string; arguments?: Record<string, unknown> };
        }) => {
            const result = await callTool(request.params.name, request.params.arguments ?? {});
            return {
                content: result.content,
                isError: result.isError
            };
        });

        const transport = new StdioServerTransport();
        await server.connect(transport);
        return true;
    } catch {
        return false;
    }
}