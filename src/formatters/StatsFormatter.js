/**
 * StatsFormatter - Statistics output
 *
 * SOLID: S - Only formats statistics
 * SOLID: L - Substitutable for any Formatter
 */

import { Formatter } from './Formatter.js';

export class StatsFormatter extends Formatter {
    /**
     * Format scene statistics
     * @param {object} stats
     * @returns {string}
     */
    format(stats) {
        let output = '\n─── Stats ───\n';
        output += `Nodes: ${stats.nodeCount}\n`;
        output += `Scripts: ${stats.scripts.size}\n`;

        if (stats.scripts.size > 0) {
            output += '\nCustom Scripts:\n';
            for (const script of Array.from(stats.scripts).sort()) {
                output += `  • ${script}\n`;
            }
        }

        output += '\nBuiltin Components:\n';
        const sorted = Array.from(stats.builtins.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 15);

        for (const [type, count] of sorted) {
            output += `  • ${type.replace('cc.', '')}: ${count}\n`;
        }

        return output;
    }
}
