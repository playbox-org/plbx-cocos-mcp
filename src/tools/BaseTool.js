/**
 * BaseTool - Base class for MCP tools
 *
 * SOLID: L - All tools can be used interchangeably via base interface
 * SOLID: O - New tools extend without modifying existing
 */

import { normalizeArgs } from './validateArgs.js';

export class BaseTool {
    /**
     * Tool name
     * @returns {string}
     */
    get name() {
        throw new Error('Subclass must implement name getter');
    }

    /**
     * Tool description for LLM
     * @returns {string}
     */
    get description() {
        throw new Error('Subclass must implement description getter');
    }

    /**
     * JSON Schema for input parameters
     * @returns {object}
     */
    get inputSchema() {
        throw new Error('Subclass must implement inputSchema getter');
    }

    /**
     * Accepted argument aliases: {aliasKey: canonicalKey}. Applied before
     * validation; the canonical key wins when both are present.
     * @returns {Record<string, string>}
     */
    get aliases() {
        return {};
    }

    /**
     * Execute the tool
     * @param {object} args - Tool arguments
     * @param {string} projectRoot - Project root path
     * @returns {Promise<{content: Array, isError?: boolean}>}
     */
    async execute(args, projectRoot) {
        throw new Error('Subclass must implement execute()');
    }

    /**
     * MCP entry point: normalize aliases and validate args against
     * inputSchema, then execute. Keeps execute() as the raw implementation
     * hook; a bad call gets a self-explanatory error instead of an internal
     * crash (e.g. path.resolve's "paths[1] ... Received undefined").
     * @param {object} args - Raw tool arguments
     * @param {string} projectRoot - Project root path
     * @returns {Promise<{content: Array, isError?: boolean}>}
     */
    async run(args, projectRoot) {
        const { args: normalized, error } = normalizeArgs(args ?? {}, this.inputSchema, this.aliases);
        if (error) {
            return this.error(error);
        }
        return this.execute(normalized, projectRoot);
    }

    /**
     * Create success response
     */
    success(text) {
        return { content: [{ type: 'text', text }] };
    }

    /**
     * Create error response
     */
    error(message) {
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
}
