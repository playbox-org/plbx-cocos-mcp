/**
 * JsonFormatter - JSON output for programmatic use
 *
 * SOLID: S - Only formats to JSON
 * SOLID: L - Substitutable for any Formatter
 */

import { Formatter } from './Formatter.js';

export class JsonFormatter extends Formatter {
    #pretty = true;
    #indent = 2;

    /**
     * Configure formatting options
     */
    configure(options = {}) {
        if (options.pretty !== undefined) this.#pretty = options.pretty;
        if (options.indent !== undefined) this.#indent = options.indent;
        return this;
    }

    /**
     * Format scene graph to JSON
     * @param {object} graph
     * @returns {string}
     */
    format(graph) {
        if (this.#pretty) {
            return JSON.stringify(graph, null, this.#indent);
        }
        return JSON.stringify(graph);
    }
}
