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
        return 'Find nodes in a Cocos Creator scene by name pattern (regex supported) and/or ' +
               'by component: a cc.* type ("cc.Camera") or a custom script name ' +
               '("PlayerController") — components mounted on prefab instances match too. ' +
               'Each match shows its full root-anchored path — reuse it verbatim as the ' +
               '`node` argument of inspect_node/get_node_bounds/apply_edits — and its #N ' +
               'nodeId (inspect_node only). ' +
               'Args: {scenePath (required), pattern? , component?} — at least one of ' +
               'pattern/component.';
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
                },
                component: {
                    type: 'string',
                    description: 'Only nodes carrying this component: cc.* type or custom script name (mounted components on prefab instances match too)'
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
        if (args.pattern === undefined && args.component === undefined) {
            return this.error('Pass "pattern" (name regex) and/or "component" (cc.* type or script name)');
        }

        try {
            const minifier = new SceneMinifier(scenePath, projectRoot);
            const matches = minifier.findNodes(args.pattern ?? null, args.component ?? null);

            // Pattern-only keeps the historical header shape (main-branch
            // clients); component adds its clause explicitly
            const criteria = args.component === undefined
                ? `"${args.pattern}"`
                : args.pattern === undefined
                    ? `component = ${args.component}`
                    : `name ~ "${args.pattern}", component = ${args.component}`;
            let output = `# Nodes matching ${criteria}\n\n` +
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
