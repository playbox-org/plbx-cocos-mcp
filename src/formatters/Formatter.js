/**
 * Formatter - Interface Segregation Principle
 *
 * SOLID: I - Defines minimal interface for formatters
 * SOLID: L - All formatters can be used interchangeably
 */

/**
 * @typedef {Object} MinifiedNode
 * @property {string} name
 * @property {boolean} active
 * @property {Array} [components]
 * @property {Array} [children]
 * @property {Array} [pos]
 * @property {boolean} [prefab]
 * @property {string} [prefabSource] - Source asset file name for collapsed prefab instances
 */

/**
 * Base formatter interface
 * @abstract
 */
export class Formatter {
    /**
     * Format a minified scene graph
     * @param {MinifiedNode} graph
     * @returns {string}
     */
    format(graph) {
        throw new Error('Subclass must implement format()');
    }
}
