/**
 * McpServer - MCP protocol handler
 *
 * SOLID: S - Only handles MCP protocol
 * SOLID: D - Depends on tool abstractions
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    CallToolRequestSchema,
    ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';

export class McpServer {
    #server;
    #tools = new Map();
    #projectRoot;

    /**
     * @param {string} name - Server name
     * @param {string} version - Server version
     * @param {string} projectRoot - Project root path
     */
    constructor(name, version, projectRoot) {
        this.#projectRoot = projectRoot;
        this.#server = new Server(
            { name, version },
            { capabilities: { tools: {} } }
        );

        this.#setupHandlers();
    }

    /**
     * Register a tool
     * @param {BaseTool} tool
     */
    registerTool(tool) {
        this.#tools.set(tool.name, tool);
        return this;
    }

    /**
     * Register multiple tools
     * @param {BaseTool[]} tools
     */
    registerTools(tools) {
        tools.forEach(tool => this.registerTool(tool));
        return this;
    }

    #setupHandlers() {
        // List tools handler
        this.#server.setRequestHandler(ListToolsRequestSchema, async () => {
            const tools = Array.from(this.#tools.values()).map(tool => ({
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema
            }));

            return { tools };
        });

        // Call tool handler
        this.#server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name, arguments: args } = request.params;

            const tool = this.#tools.get(name);
            if (!tool) {
                return {
                    content: [{ type: 'text', text: `Unknown tool: ${name}` }],
                    isError: true
                };
            }

            try {
                return await tool.run(args ?? {}, this.#projectRoot);
            } catch (error) {
                return {
                    content: [{ type: 'text', text: `Error: ${error.message}` }],
                    isError: true
                };
            }
        });
    }

    /**
     * Start the server
     */
    async start() {
        const transport = new StdioServerTransport();
        await this.#server.connect(transport);
    }
}
