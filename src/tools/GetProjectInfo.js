/**
 * GetProjectInfo - MCP tool for reading Cocos Creator project configuration
 *
 * Engine version, design resolution, layers, physics setup — the facts an
 * assistant needs before placing or scaling anything in a scene.
 */

import * as fs from 'fs';
import * as path from 'path';
import { BaseTool } from './BaseTool.js';
import { ProjectInfoReader } from '../core/ProjectInfoReader.js';
import { AssetIndex } from '../core/AssetIndex.js';

export class GetProjectInfo extends BaseTool {
    get name() {
        return 'get_project_info';
    }

    get description() {
        return 'Get Cocos Creator project configuration: engine version, design resolution, ' +
               'custom layers, physics engine and collision groups, enabled engine modules (2D/3D), ' +
               'plus a self-check of the resolved project root (assets/ and library/ present, how ' +
               'many assets are indexed) — the one place that says out loud whether the server is ' +
               'pointed at the project you are editing. ' +
               'Call this first when starting work on a project. Args: {format?: "text"|"json"}.';
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
            const root = selfCheck(projectRoot);

            if (!info.engineVersion && !info.designResolution) {
                return this.error(
                    `No Cocos Creator project found at ${projectRoot}. ` +
                    'Check the COCOS_PROJECT_ROOT environment variable.' +
                    (root.hasAssets
                        ? ''
                        : ` There is no assets/ directory under that path either, so this is ` +
                          'almost certainly the wrong root.')
                );
            }

            if (args?.format === 'json') {
                return this.success(JSON.stringify({ ...info, root }, null, 2));
            }

            return this.success(this.#formatText(info, root));
        } catch (err) {
            return this.error(err.message);
        }
    }

    #formatText(info, root) {
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

        lines.push('', '## Project root');
        lines.push(`Resolved root: ${root.projectRoot} (COCOS_PROJECT_ROOT, else the server's cwd)`);
        lines.push(
            root.hasAssets
                ? `assets/: ${root.assetCount} asset(s) indexed` +
                  (root.assetCount === 0
                      ? ' — an empty assets/ means every UUID will fail to resolve'
                      : '')
                : 'assets/: MISSING — is COCOS_PROJECT_ROOT set to the project you are editing? ' +
                  'Read tools DEGRADE QUIETLY on the wrong root (UUIDs print raw, every mesh AABB ' +
                  'comes back "unavailable", validate_document invents broken-reference warnings), ' +
                  'while the assets/-scoped writers refuse loudly'
        );
        lines.push(
            root.hasLibrary
                ? 'library/: present (mesh AABBs and model-prefab reads work)'
                : 'library/: MISSING — open the project in the editor once to import it; ' +
                  'without it mesh AABBs (get_node_bounds, compute_fit_scale) and model-derived ' +
                  'prefab reads are unavailable, silently'
        );

        return lines.join('\n');
    }
}

/**
 * Whether the resolved root really is the project being edited — a mismatch fails asymmetrically
 * (writers refuse loudly, read tools degrade quietly), so it has to be said out loud.
 */
function selfCheck(projectRoot) {
    const exists = (rel) => {
        try {
            return fs.statSync(path.join(projectRoot, rel)).isDirectory();
        } catch {
            return false;
        }
    };
    const hasAssets = exists('assets');
    let assetCount = 0;
    if (hasAssets) {
        try {
            // Directories carry a .meta too
            assetCount = AssetIndex.shared(projectRoot).entries
                .filter(e => e.importer !== 'directory').length;
        } catch {
            assetCount = 0;
        }
    }
    return { projectRoot, hasAssets, hasLibrary: exists('library'), assetCount };
}
