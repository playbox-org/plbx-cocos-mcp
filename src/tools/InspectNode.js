/**
 * InspectNode - MCP tool for drilling into a specific node's subtree
 *
 * Complements query_scene_graph: that tool gives a filtered overview,
 * this tool gives full unfiltered detail for a single node.
 */

import * as fs from 'fs';
import * as path from 'path';
import { BaseTool } from './BaseTool.js';
import { SceneMinifier } from '../core/SceneMinifier.js';
import { TextFormatter } from '../formatters/TextFormatter.js';
import { JsonFormatter } from '../formatters/JsonFormatter.js';

export class InspectNode extends BaseTool {
    get name() {
        return 'inspect_node';
    }

    get description() {
        return 'Drill into a specific node in a Cocos Creator scene or prefab. ' +
               'Returns the full unfiltered subtree with all properties. ' +
               'Use nodeId (from #N in detailed mode) for precision, or nodeName to search.';
    }

    get inputSchema() {
        return {
            type: 'object',
            properties: {
                filePath: {
                    type: 'string',
                    description: "Path to .scene or .prefab file relative to project root"
                },
                nodeId: {
                    type: 'number',
                    description: "Node index from #N suffix in detailed mode output (e.g., 42 from '→Player#42')"
                },
                nodeName: {
                    type: 'string',
                    description: "Node name to search for. If multiple matches, returns a disambiguation list."
                },
                format: {
                    type: 'string',
                    enum: ['text', 'json'],
                    description: "Output format",
                    default: 'text'
                }
            },
            required: ['filePath']
        };
    }

    async execute(args, projectRoot) {
        const filePath = path.resolve(projectRoot, args.filePath);

        if (!fs.existsSync(filePath)) {
            return this.error(`File not found: ${filePath}`);
        }

        if (args.nodeId === undefined && !args.nodeName) {
            return this.error('Either nodeId or nodeName is required');
        }

        try {
            const minifier = new SceneMinifier(filePath, projectRoot);

            // Direct id lookup
            if (args.nodeId !== undefined) {
                return this.#inspectById(minifier, args);
            }

            // Name search with disambiguation
            return this.#inspectByName(minifier, args);
        } catch (err) {
            return this.error(err.message);
        }
    }

    #inspectById(minifier, args) {
        const graph = minifier.inspectNode(args.nodeId);

        if (!graph) {
            return this.error(`Node #${args.nodeId} not found or has no content`);
        }

        return this.#formatResult(graph, args.nodeId, args.format);
    }

    #inspectByName(minifier, args) {
        const matches = minifier.resolveNodeId(args.nodeName);

        if (matches.length === 0) {
            return this.error(`No node named "${args.nodeName}" found`);
        }

        // Multiple matches — return disambiguation list
        if (matches.length > 1) {
            const list = matches.map(m =>
                `- ${m.name}#${m.id} (${m.path || 'root'})`
            ).join('\n');

            return this.success(
                `# Multiple nodes named "${args.nodeName}"\n\n` +
                `Found: ${matches.length}\n\n` +
                `${list}\n\n` +
                `Use nodeId parameter to inspect a specific one.`
            );
        }

        // Single match — inspect directly
        const graph = minifier.inspectNode(matches[0].id);

        if (!graph) {
            return this.error(`Node "${args.nodeName}"#${matches[0].id} has no content`);
        }

        return this.#formatResult(graph, matches[0].id, args.format);
    }

    #formatResult(graph, nodeId, format) {
        if (format === 'json') {
            const formatter = new JsonFormatter().configure({ pretty: true });
            return this.success(formatter.format(graph));
        }

        const formatter = new TextFormatter();
        return this.success(`# Node: ${graph.name}#${nodeId}\n\n${formatter.format(graph)}`);
    }
}
