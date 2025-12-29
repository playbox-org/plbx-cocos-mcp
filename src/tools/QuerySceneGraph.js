/**
 * QuerySceneGraph - MCP tool for scene graph extraction
 *
 * SOLID: S - Single tool, single purpose
 */

import * as fs from 'fs';
import * as path from 'path';
import { BaseTool } from './BaseTool.js';
import { SceneMinifier } from '../core/SceneMinifier.js';

export class QuerySceneGraph extends BaseTool {
    get name() {
        return 'query_scene_graph';
    }

    get description() {
        return 'Get a minified, LLM-friendly scene graph from a Cocos Creator scene file. ' +
               'Converts ~700KB scene files to ~20KB semantic representations.';
    }

    get inputSchema() {
        return {
            type: 'object',
            properties: {
                scenePath: {
                    type: 'string',
                    description: "Path to scene file relative to project root (e.g., 'assets/Scenes/game.scene')"
                },
                format: {
                    type: 'string',
                    enum: ['text', 'json'],
                    description: "Output format: 'text' for readable hierarchy, 'json' for structured data",
                    default: 'text'
                }
            },
            required: ['scenePath']
        };
    }

    async execute(args, projectRoot) {
        const scenePath = path.resolve(projectRoot, args.scenePath);

        if (!fs.existsSync(scenePath)) {
            return this.error(`Scene file not found: ${scenePath}`);
        }

        try {
            const minifier = new SceneMinifier(scenePath, projectRoot);
            const graph = minifier.minify();

            if (!graph) {
                return this.error('Could not parse scene');
            }

            const format = args.format || 'text';
            const output = format === 'json'
                ? minifier.toJson(graph)
                : `# Scene: ${path.basename(args.scenePath)}\n\n${minifier.toText(graph)}`;

            return this.success(output);
        } catch (err) {
            return this.error(err.message);
        }
    }
}
