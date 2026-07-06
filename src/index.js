#!/usr/bin/env node
/**
 * PLBX Cocos MCP Server
 *
 * Entry point for MCP server.
 * Provides tools for AI coding assistants to understand Cocos Creator scenes.
 */

import { createRequire } from 'module';
import { McpServer } from './server/McpServer.js';
import { createTools } from './tools/index.js';

const PROJECT_ROOT = process.env.COCOS_PROJECT_ROOT || process.cwd();
const VERSION = createRequire(import.meta.url)('../package.json').version;

async function main() {
    const server = new McpServer('plbx-cocos-mcp', VERSION, PROJECT_ROOT);

    // Register all tools
    server.registerTools(createTools());

    // Start server
    await server.start();
}

main().catch(console.error);
