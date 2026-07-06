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
               'Note: sprite frames are sub-assets of images — type "sprite" lists images that carry one. ' +
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
                    description: "File name filter: substring ('Zombie'), or anchored wildcard when it contains * or ? ('*.png', 'Zombie*')"
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
            const index = AssetIndex.shared(projectRoot);

            if (args?.type && !index.isKnownType(args.type)) {
                return this.error(
                    `Unknown asset type "${args.type}". ` +
                    `Known types: ${AssetIndex.knownTypes.join(', ')}. ` +
                    `Importers in this project: ${index.importers().join(', ') || 'none'}. ` +
                    'Note: sprite frames are sub-assets of images — use type "sprite".'
                );
            }

            const matches = index.list({
                type: args?.type,
                folder: args?.folder,
                pattern: args?.pattern
            });

            if (matches.length === 0) {
                return this.success(this.#explainEmpty(index, args));
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

    /**
     * Re-apply the filters cumulatively to report which one produced the
     * empty result, so the caller can fix that filter instead of guessing.
     */
    #explainEmpty(index, args) {
        const stages = [
            ['type', { type: args?.type }],
            ['folder', { type: args?.type, folder: args?.folder }],
            ['pattern', { type: args?.type, folder: args?.folder, pattern: args?.pattern }]
        ].filter(([key]) => args?.[key]);

        const lines = ['No assets match the given filters.'];
        let prev = index.list({}).length;
        lines.push(`- no filters: ${prev} asset(s)`);

        for (const [key, filters] of stages) {
            const count = index.list(filters).length;
            lines.push(`- + ${key}="${args[key]}": ${count}`);
            if (count === 0) {
                lines.push(HINTS[key]);
                break;
            }
            prev = count;
        }

        return lines.join('\n');
    }
}

const HINTS = {
    type: 'The project has no assets of this type. Check importers with an unfiltered call, ' +
          'or remember sprite frames live inside "image" assets (type "sprite").',
    folder: 'Folder is a path prefix relative to the project root (or assets/), ' +
            'e.g. "assets/Art/Models" — check it against list_assets without folder.',
    pattern: 'Pattern matches the file name only: plain text = substring, ' +
             'with * or ? it must match the whole name ("Zombie*", "*.png"). ' +
             'Drop the pattern and scan the folder listing instead of guessing.'
};
