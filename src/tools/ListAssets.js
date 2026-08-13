/**
 * ListAssets - MCP tool for cataloging project assets
 *
 * Filterable directory of assets/ with path + name + UUID output,
 * so the assistant can find asset references without reading meta files.
 */

import { BaseTool } from './BaseTool.js';
import { AssetIndex } from '../core/AssetIndex.js';
import { compressUuid } from '../utils/uuid.js';

const MAX_RESULTS = 300;

// Per-format uuid default, the schema's `uuid` description states it: grouped drops the uuid,
// while an explicit flat/text call keeps the pre-grouped contract
const DEFAULT_UUID_FORM = {
    __proto__: null, // user-sourced key (list_assets format): no Object.prototype hits
    grouped: 'none', flat: 'full', text: 'full'
};

// a full uuid is 25 o200k tokens, its compressed form 16, the path it sits next to 5
function uuidSuffix(entry, form) {
    if (form === 'full') return ` ${entry.uuid}`;
    if (form === 'compressed') return ` ${compressUuid(entry.uuid)}`;
    return '';
}

function folderOf(assetPath) {
    const cut = assetPath.lastIndexOf('/');
    return cut < 0 ? '.' : assetPath.slice(0, cut);
}

// (folder, name), never the full path: "Mesh/sub/a.png" sorts between "Mesh/a.png"
// and "Mesh/z.png" as a string, which splits the folder into two headers
function byFolderThenName(a, b) {
    return folderOf(a.path).localeCompare(folderOf(b.path)) || a.name.localeCompare(b.name);
}

export class ListAssets extends BaseTool {
    get name() {
        return 'list_assets';
    }

    get description() {
        return 'List assets of a Cocos Creator project with optional filters. ' +
               'Paths are accepted wherever a UUID is, so the default shape prints no uuid — ask for it with uuid:"compressed"/"full". ' +
               'Use format:"summary" for "what is in this project" (counts per type and folder, no enumeration). ' +
               'Types: sprite, image, model, prefab, scene, material, script, audio, font, animation, ' +
               'effect, terrain, directory (or a raw importer name like fbx, gltf, typescript). ' +
               'Note: sprite frames are sub-assets of images — type "sprite" lists images that carry one. ' +
               'Args: {type?, folder?, pattern?, format?, uuid?} — these are the only keys.';
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
                    description: "Asset type filter: sprite, image, model, prefab, scene, material, script, audio, font, animation, effect, terrain, directory, or a raw importer name"
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
                    enum: ['grouped', 'summary', 'flat', 'text', 'json'],
                    description: "Output format: 'grouped' (default, folder headers + leaf names), 'summary' (counts per type/folder only), 'flat'/'text' (one full path per line), 'json'",
                    default: 'grouped'
                },
                uuid: {
                    // no `default`: it is per-format (see the description), and one value here
                    // would be a lie for the other formats
                    type: 'string',
                    enum: ['none', 'compressed', 'full'],
                    description: "Include the asset UUID per row: 'none' (paths resolve everywhere a uuid does), 'compressed' (the form scene files store), 'full'. Defaults per format: grouped='none', flat='full', text='full' (an explicit flat call keeps its pre-grouped contract); 'summary' has no rows and 'json' always carries the full uuid"
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

            // AssetIndex scans depth-first and never sorts; ordering here (before the
            // MAX_RESULTS slice, so truncation is deterministic too) keeps a folder's
            // rows under ONE grouped header and every shape reproducible (slice: the
            // filtered list may still be the index's own array)
            const matches = index.list({
                type: args?.type,
                folder: args?.folder,
                pattern: args?.pattern
            }).slice().sort(byFolderThenName);

            if (matches.length === 0) {
                return this.success(this.#explainEmpty(index, args));
            }

            const format = args?.format ?? 'grouped';

            if (format === 'json') {
                const shown = matches.slice(0, MAX_RESULTS);
                const items = shown.map(e => ({
                    path: e.path,
                    name: e.name,
                    uuid: e.uuid,
                    importer: e.importer
                }));
                return this.success(JSON.stringify({
                    total: matches.length,
                    truncated: matches.length - shown.length,
                    items
                }, null, 2));
            }

            if (format === 'summary') {
                return this.success(this.#renderSummary(matches, args));
            }

            const uuidForm = args?.uuid ?? DEFAULT_UUID_FORM[format];
            return this.success(format === 'grouped'
                ? this.#renderGrouped(matches, uuidForm)
                : this.#renderFlat(matches, uuidForm));
        } catch (err) {
            return this.error(err.message);
        }
    }

    /**
     * Folder hoisted out of every row and the type hoisted when it is uniform:
     * on a real listing the repeated prefix and tag are ~35% of the tokens, and
     * the uuid — off unless asked for — is another 60%.
     */
    #renderGrouped(matches, uuidForm) {
        const shown = matches.slice(0, MAX_RESULTS);
        const types = new Set(shown.map(e => e.importer));
        const uniform = types.size === 1 ? [...types][0] : null;

        const lines = [`# Assets (${matches.length})${uniform ? ` — all [${uniform}]` : ''}`];
        let dir = null;
        for (const e of shown) {
            const folder = folderOf(e.path);
            if (folder !== dir) {
                lines.push('', `${folder}/`);
                dir = folder;
            }
            const tag = uniform ? '' : ` [${e.importer}]`;
            lines.push(`  ${e.name}${tag}${uuidSuffix(e, uuidForm)}`);
        }
        this.#appendTail(lines, matches, shown, uuidForm);
        return lines.join('\n');
    }

    #renderFlat(matches, uuidForm) {
        const shown = matches.slice(0, MAX_RESULTS);
        const lines = [`# Assets (${matches.length})`, ''];
        for (const e of shown) {
            lines.push(`- ${e.path} [${e.importer}]${uuidSuffix(e, uuidForm)}`);
        }
        this.#appendTail(lines, matches, shown, uuidForm);
        return lines.join('\n');
    }

    /**
     * Counts instead of rows: the "what is in this project" question used to force
     * an enumeration of every asset, which costs ~75x this on a real project.
     */
    #renderSummary(matches, args) {
        const byType = new Map();
        const byFolder = new Map();
        for (const e of matches) {
            byType.set(e.importer, (byType.get(e.importer) ?? 0) + 1);
            // bucket by DIRECTORY, never by path segments — a root-level asset would
            // otherwise contribute its own file name as a folder
            const bucket = folderOf(e.path).split('/').slice(0, 3).join('/');
            byFolder.set(bucket, (byFolder.get(bucket) ?? 0) + 1);
        }
        // an inventory that reads as complete must not drop buckets silently — the
        // count of the omitted ones, never a second enumeration
        const rank = (m, limit) => {
            const ranked = [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
            const row = ranked.slice(0, limit).map(([k, n]) => `${k} ${n}`).join(', ');
            const dropped = ranked.length - limit;
            return dropped > 0 ? `${row}, ... ${dropped} more` : row;
        };

        const filters = ['type', 'folder', 'pattern']
            .filter(k => args?.[k])
            .map(k => `${k}="${args[k]}"`)
            .join(' ');

        return [
            `# Assets (${matches.length})${filters ? ` — filters: ${filters}` : ''}`,
            '',
            `by type: ${rank(byType, 24)}`,
            `by folder: ${rank(byFolder, 16)}`,
            '',
            'Enumerate a slice with type/folder/pattern; add uuid:"compressed" when you need ids.'
        ].join('\n');
    }

    #appendTail(lines, matches, shown, uuidForm) {
        const truncated = matches.length - shown.length;
        if (truncated > 0) {
            lines.push('', `... ${truncated} more. Narrow with type/folder/pattern, or format:"summary" for counts only.`);
        }
        if (uuidForm === 'none') {
            lines.push('', 'uuid omitted — paths resolve wherever a uuid does; add uuid:"compressed" if you need ids.');
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
