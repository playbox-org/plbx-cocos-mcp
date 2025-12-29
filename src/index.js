#!/usr/bin/env node
/**
 * PLBX Cocos MCP Server
 *
 * Entry point for MCP server.
 * Provides tools for AI coding assistants to understand Cocos Creator scenes.
 */

import { McpServer } from './server/McpServer.js';
import { createTools } from './tools/index.js';

const PROJECT_ROOT = process.env.COCOS_PROJECT_ROOT || process.cwd();
const VERSION = '1.0.0';

async function main() {
    const server = new McpServer('plbx-cocos-mcp', VERSION, PROJECT_ROOT);

    // Register all tools
    server.registerTools(createTools());

    // Start server
    await server.start();
}

main().catch(console.error);
