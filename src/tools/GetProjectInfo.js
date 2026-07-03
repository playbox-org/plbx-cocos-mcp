/**
 * GetProjectInfo - MCP tool for reading Cocos Creator project configuration
 *
 * Engine version, design resolution, layers, physics setup — the facts an
 * assistant needs before placing or scaling anything in a scene.
 */

import { BaseTool } from './BaseTool.js';
import { ProjectInfoReader } from '../core/ProjectInfoReader.js';

export class GetProjectInfo extends BaseTool {
    get name() {
        return 'get_project_info';
    }

    get description() {
        return 'Get Cocos Creator project configuration: engine version, design resolution, ' +
               'custom layers, physics engine and collision groups, enabled engine modules (2D/3D). ' +
               'Call this first when starting work on a project.';
    }

    get inputSchema() {
        return {
            type: 'object',
            properties: {
                format: {
                    type: 'string',
                    enum: ['text', 'json'],
                    description: 'Output format',
                    default: 'text'
                }
            }
        };
    }

    async execute(args, projectRoot) {
        try {
            const info = new ProjectInfoReader(projectRoot).read();

            if (!info.engineVersion && !info.designResolution) {
                return this.error(
                    `No Cocos Creator project found at ${projectRoot}. ` +
                    'Check the COCOS_PROJECT_ROOT environment variable.'
                );
            }

            if (args?.format === 'json') {
                return this.success(JSON.stringify(info, null, 2));
            }

            return this.success(this.#formatText(info));
        } catch (err) {
            return this.error(err.message);
        }
    }

    #formatText(info) {
        const lines = ['# Project Info', ''];

        lines.push(`Project: ${info.projectName ?? 'unknown'}`);
        lines.push(`Engine: Cocos Creator ${info.engineVersion ?? 'unknown'}`);

        if (info.modules) {
            const dims = [info.modules.has3d && '3D', info.modules.has2d && '2D']
                .filter(Boolean).join(' + ');
            lines.push(`Modules: ${dims || 'unknown'}`);
        }

        const dr = info.designResolution;
        if (dr) {
            const fit = [dr.fitWidth && 'fitWidth', dr.fitHeight && 'fitHeight']
                .filter(Boolean).join(', ');
            lines.push(`Design resolution: ${dr.width}x${dr.height}${fit ? ` (${fit})` : ''}`);
        }

        lines.push('');
        lines.push('## Layers');
        if (info.layers.custom.length > 0) {
            for (const layer of info.layers.custom) {
                lines.push(`- ${layer.name} = ${layer.value} (bit ${Math.log2(layer.value)})`);
            }
        } else {
            lines.push('No custom layers (built-in only: DEFAULT, UI_2D, UI_3D, ...)');
        }

        const phys = info.physics;
        lines.push('');
        lines.push('## Physics');
        lines.push(`3D engine: ${phys.engine3d ?? 'disabled'}`);
        lines.push(`2D engine: ${phys.engine2d ?? 'disabled'}`);
        if (phys.gravity) {
            lines.push(`Gravity: (${phys.gravity.x}, ${phys.gravity.y}, ${phys.gravity.z})`);
        }
        const groups = phys.collisionGroups
            .map(g => `${g.index}:${g.name}`)
            .join(', ');
        lines.push(`Collision groups: ${groups}`);

        return lines.join('\n');
    }
}
