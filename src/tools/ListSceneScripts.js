/**
 * ListSceneScripts - MCP tool for listing scripts in scene
 *
 * SOLID: S - Single tool, single purpose
 */

import * as fs from 'fs';
import * as path from 'path';
import { BaseTool } from './BaseTool.js';
import { SceneMinifier } from '../core/SceneMinifier.js';

export class ListSceneScripts extends BaseTool {
    get name() {
        return 'list_scene_scripts';
    }

    get description() {
        return 'List all custom TypeScript scripts used in a Cocos Creator scene. ' +
               'Args: {scenePath (required)}.';
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
            const scripts = minifier.getScripts();

            const output = `# Scripts in ${path.basename(args.scenePath)}\n\n` +
                          `Total: ${scripts.length}\n\n` +
                          scripts.map(s => `- ${s}`).join('\n');

            return this.success(output);
        } catch (err) {
            return this.error(err.message);
        }
    }
}
