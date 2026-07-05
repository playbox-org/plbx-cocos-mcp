/**
 * ListAssets - MCP tool for cataloging project assets
 *
 * Filterable directory of assets/ with path + name + UUID output,
 * so the assistant can find asset references without reading meta files.
 */

import { BaseTool } from './BaseTool.js';
import { AssetIndex } from '../core/AssetIndex.js';

const MAX_RESULTS = 300;

export class ListAssets extends BaseTool {
    get name() {
        return 'list_assets';
    }

    get description() {
        return 'List assets of a Cocos Creator project with optional filters. ' +
               'Returns path, name and UUID for each asset. ' +
               'Types: sprite, image, model, prefab, scene, material, script, audio, font, animation ' +
               '(or a raw importer name like fbx, gltf, typescript). ' +
               'Args: {type?, folder?, pattern?, format?} — these are the only filter keys.';
    }

    get aliases() {
        return { query: 'pattern' };
    }

    get inputSchema() {
        return {
            type: 'object',
            properties: {
                type: {
                    type: 'string',
                    description: "Asset type filter: sprite, image, model, prefab, scene, material, script, audio, font, animation, or a raw importer name"
                },
                folder: {
                    type: 'string',
                    description: "Folder filter, e.g. 'assets/Art/Models' or 'Prefabs'"
                },
                pattern: {
                    type: 'string',
                    description: "File name wildcard, e.g. '*.png' or 'Zombie*'"
                },
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
            const index = new AssetIndex(projectRoot);
            const matches = index.list({
                type: args?.type,
                folder: args?.folder,
                pattern: args?.pattern
            });

            if (matches.length === 0) {
                return this.success('No assets match the given filters.');
            }

            const shown = matches.slice(0, MAX_RESULTS);
            const truncated = matches.length - shown.length;

            if (args?.format === 'json') {
                const items = shown.map(e => ({
                    path: e.path,
                    name: e.name,
                    uuid: e.uuid,
                    importer: e.importer
                }));
                return this.success(JSON.stringify({ total: matches.length, truncated, items }, null, 2));
            }

            const lines = [`# Assets (${matches.length})`, ''];
            for (const e of shown) {
                lines.push(`- ${e.path} [${e.importer}] ${e.uuid}`);
            }
            if (truncated > 0) {
                lines.push('');
                lines.push(`... ${truncated} more. Narrow with type/folder/pattern filters.`);
            }

            return this.success(lines.join('\n'));
        } catch (err) {
            return this.error(err.message);
        }
    }
}
