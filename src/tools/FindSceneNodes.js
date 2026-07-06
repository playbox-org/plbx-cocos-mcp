/**
 * FindSceneNodes - MCP tool for finding nodes by pattern
 *
 * SOLID: S - Single tool, single purpose
 */

import * as fs from 'fs';
import * as path from 'path';
import { BaseTool } from './BaseTool.js';
import { SceneMinifier } from '../core/SceneMinifier.js';

export class FindSceneNodes extends BaseTool {
    get name() {
        return 'find_scene_nodes';
    }

    get description() {
        return 'Find nodes in a Cocos Creator scene by name pattern (regex supported). ' +
               'Each match shows its full root-anchored path — reuse it verbatim as the ' +
               '`node` argument of inspect_node/get_node_bounds/apply_edits — and its #N ' +
               'nodeId (inspect_node only). ' +
               'Args: {scenePath (required), pattern (required)}.';
    }

    get aliases() {
        return { filePath: 'scenePath' };
    }

    get inputSchema() {
        return {
            type: 'object',
            properties: {
                scenePath: {
                    type: 'string',
                    description: 'Path to scene file relative to project root'
                },
                pattern: {
                    type: 'string',
                    description: 'Name pattern to search for (regex supported)'
                }
            },
            required: ['scenePath', 'pattern']
        };
    }

    async execute(args, projectRoot) {
        const scenePath = path.resolve(projectRoot, args.scenePath);

        if (!fs.existsSync(scenePath)) {
            return this.error(`Scene file not found: ${scenePath}`);
        }

        try {
            const minifier = new SceneMinifier(scenePath, projectRoot);
            const matches = minifier.findNodes(args.pattern);

            let output = `# Nodes matching "${args.pattern}"\n\n` +
                         `Found: ${matches.length}\n\n` +
                         matches.map(m =>
                             `- ${m.active ? '●' : '○'} ${m.path ?? m.name} #${m.id} [${m.components.join(', ')}]`
                         ).join('\n');

            if (matches.length > 0) {
                output += '\n\nPaths are root-anchored `node` addresses for inspect_node / ' +
                          'get_node_bounds / apply_edits; #N is the nodeId for inspect_node only.';
            }

            return this.success(output);
        } catch (err) {
            return this.error(err.message);
        }
    }
}
