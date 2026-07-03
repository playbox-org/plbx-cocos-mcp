/**
 * TextFormatter - Human-readable text output
 *
 * SOLID: S - Only formats to text
 * SOLID: L - Substitutable for any Formatter
 */

import { Formatter } from './Formatter.js';

export class TextFormatter extends Formatter {
    #indentStr = '  ';
    #activeMarker = '●';
    #inactiveMarker = '○';
    #enabledMarker = '◆';
    #disabledMarker = '◇';

    /**
     * Configure formatting options
     */
    configure(options = {}) {
        if (options.indent !== undefined) this.#indentStr = options.indent;
        return this;
    }

    /**
     * Format scene graph to readable text
     * @param {object} node
     * @param {number} indent
     * @returns {string}
     */
    format(node, indent = 0) {
        const lines = [];
        const prefix = this.#indentStr.repeat(indent);
        const marker = node.active ? this.#activeMarker : this.#inactiveMarker;

        // Node header
        let header = `${prefix}${marker} ${node.name}`;
        if (node.pos) header += ` @(${node.pos.join(',')})`;
        if (node.prefab) header += node.prefabSource ? ` [P→${node.prefabSource}]` : ' [P]';
        lines.push(header);

        // Components
        if (node.components) {
            for (const comp of node.components) {
                lines.push(this.#formatComponent(comp, prefix));
            }
        }

        // Children (recursive)
        if (node.children) {
            for (const child of node.children) {
                lines.push(this.format(child, indent + 1));
            }
        }

        // Trimmed indicator
        if (node.trimmed) {
            const childPrefix = this.#indentStr.repeat(indent + 1);
            lines.push(`${childPrefix}[+${node.trimmed.nodes} hidden nodes, depth ${node.trimmed.depth}]`);
        }

        return lines.join('\n');
    }

    #formatComponent(comp, prefix) {
        const enabled = comp.enabled ? this.#enabledMarker : this.#disabledMarker;
        let line = `${prefix}  ${enabled} ${comp.type}`;

        // Add properties
        if (comp.props && Object.keys(comp.props).length > 0) {
            const propStr = Object.entries(comp.props)
                .slice(0, 4)
                .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
                .join(' ');
            line += ` {${propStr}}`;
        }

        // Add text for labels
        if (comp.text) {
            line += ` "${comp.text}"`;
        }

        return line;
    }
}
