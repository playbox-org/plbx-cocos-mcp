/**
 * BaseTool - Base class for MCP tools
 *
 * SOLID: L - All tools can be used interchangeably via base interface
 * SOLID: O - New tools extend without modifying existing
 */

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
     * Execute the tool
     * @param {object} args - Tool arguments
     * @param {string} projectRoot - Project root path
     * @returns {Promise<{content: Array, isError?: boolean}>}
     */
    async execute(args, projectRoot) {
        throw new Error('Subclass must implement execute()');
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
