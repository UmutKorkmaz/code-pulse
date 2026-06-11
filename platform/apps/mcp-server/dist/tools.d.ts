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
export declare const TOOL_DEFINITIONS: McpToolDefinition[];
export interface ToolCallResult {
    content: Array<{
        type: 'text';
        text: string;
    }>;
    isError?: boolean;
}
export declare function callTool(name: string, args?: Record<string, unknown>): Promise<ToolCallResult>;
//# sourceMappingURL=tools.d.ts.map