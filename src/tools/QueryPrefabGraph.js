/**
 * QueryPrefabGraph - MCP tool for prefab graph extraction
 */

import * as fs from 'fs';
import * as path from 'path';
import { BaseTool } from './BaseTool.js';
import { SceneMinifier } from '../core/SceneMinifier.js';

export class QueryPrefabGraph extends BaseTool {
    get name() {
        return 'query_prefab_graph';
    }

    get description() {
        return 'Get a minified, LLM-friendly node graph from a Cocos Creator prefab file. ' +
               'Same compression as query_scene_graph but for .prefab files.';
    }

    get inputSchema() {
        return {
            type: 'object',
            properties: {
                prefabPath: {
                    type: 'string',
                    description: "Path to prefab file relative to project root (e.g., 'assets/Prefabs/Player.prefab')"
                },
                format: {
                    type: 'string',
                    enum: ['text', 'json'],
                    description: "Output format: 'text' for readable hierarchy, 'json' for structured data",
                    default: 'text'
                },
                detailed: {
                    type: 'boolean',
                    description: 'When true, expands reference arrays to show individual names and extracts properties from built-in cc.* components',
                    default: false
                }
            },
            required: ['prefabPath']
        };
    }

    async execute(args, projectRoot) {
        const prefabPath = path.resolve(projectRoot, args.prefabPath);

        if (!fs.existsSync(prefabPath)) {
            return this.error(`Prefab file not found: ${prefabPath}`);
        }

        try {
            const minifier = new SceneMinifier(prefabPath, projectRoot, {
                detailed: args.detailed
            });
            const graph = minifier.minify();

            if (!graph) {
                return this.error('Could not parse prefab');
            }

            const format = args.format || 'text';
            const output = format === 'json'
                ? minifier.toJson(graph)
                : `# Prefab: ${path.basename(args.prefabPath)}\n\n${minifier.toText(graph)}`;

            return this.success(output);
        } catch (err) {
            return this.error(err.message);
        }
    }
}
