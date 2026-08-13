/**
 * FindAssetReferences - MCP tool: reverse lookup "who uses this asset?"
 *
 * Resolves the asset (project path / UUID / compressed / "uuid@subId" /
 * engine builtin), then scans the project's serialized asset files for
 * `__uuid__` occurrences. Scenes and prefabs get deep attribution
 * (file → node path → component.property); other JSON assets (.mtl, .anim,
 * .animgraph) are reported at file level; `.terrain` binaries are parsed
 * structurally and report the layer that holds the id. Also answers "what is
 * this UUID" when it belongs to no project asset: engine builtin vs
 * likely-broken ref.
 */

import * as fs from 'fs';
import * as path from 'path';
import { BaseTool } from './BaseTool.js';
import { AssetIndex } from '../core/AssetIndex.js';
import { resolveBuiltin } from '../core/builtins.js';
import { SceneDocument, isRef } from '../document/SceneDocument.js';
import { splitSubAssetRef, isFullUuid, isCompressedUuid, decompressUuid, compressUuid } from '../utils/uuid.js';
import { readTerrainLayout } from '../utils/terrainBin.js';

/** Files that may hold __uuid__ references */
const DEEP_EXTENSIONS = ['.scene', '.prefab'];
const SHALLOW_EXTENSIONS = ['.mtl', '.material', '.anim', '.animgraph', '.effect'];
/**
 * Native binaries that carry asset ids OUTSIDE any JSON graph. A `.terrain`
 * keeps each layer's detail/normal map as a plain ASCII `<uuid>@<subId>` string
 * in its layer table, so a utf-8 read plus `includes()` WOULD in fact find the
 * bytes — the reason for a dedicated branch is not visibility but honesty:
 * these files are parsed structurally so a hit can name the layer and the
 * property it sits in, and so that 100+ KB of heights and weights is never
 * decoded as text just to produce a bare occurrence count.
 */
const BINARY_EXTENSIONS = ['.terrain'];

/**
 * Output cap on the skipped list. One entry carries a full errno message with an absolute path
 * (~230 chars), so a read-protected subtree under `assets/` would print one per file; the
 * section header keeps the true total either way.
 */
const MAX_SKIPPED_LINES = 20;

export class FindAssetReferences extends BaseTool {
    get name() {
        return 'find_asset_references';
    }

    get description() {
        return 'Find every place an asset is referenced across the project\'s serialized files. ' +
               'Scenes/prefabs report file → node path → component.property; materials/anims ' +
               'report at file level; .terrain binaries report the layer and map slot holding ' +
               'the id. Also identifies unknown UUIDs: project asset, engine ' +
               'built-in, or a likely broken reference. ' +
               'Args: {asset (required: path, UUID, compressed UUID or "uuid@subId"), ' +
               'folder? (limit the scan to a subfolder of assets/)}.';
    }

    get aliases() {
        return { uuid: 'asset' };
    }

    get inputSchema() {
        return {
            type: 'object',
            properties: {
                asset: {
                    type: 'string',
                    description: 'Asset to look up: project path, full/compressed UUID or "uuid@subId"'
                },
                folder: {
                    type: 'string',
                    description: 'Only scan files under this folder (relative to project root or assets/)'
                }
            },
            required: ['asset']
        };
    }

    async execute(args, projectRoot) {
        try {
            const assetIndex = AssetIndex.shared(projectRoot);
            const target = identifyTarget(args.asset, assetIndex);
            if (!target) {
                return this.error(
                    `"${args.asset}" is not a project asset, not an engine built-in, and not ` +
                    'UUID-shaped — nothing to search for. Pass a path, UUID or "uuid@subId".'
                );
            }

            const roots = scanRoots(projectRoot, args.folder);
            if (roots.length === 0) {
                return this.error(`Folder not found: ${args.folder}`);
            }

            const scriptNames = assetIndex.scriptClassNames();
            const needle = target.needle;
            const deep = [];
            const shallow = [];
            const binary = [];
            const unreadable = [];
            let scanned = 0;
            const relPath = (p) => path.relative(projectRoot, p).replaceAll(path.sep, '/');
            // A directory we cannot list is the same kind of gap as a file we cannot read
            const unlistable = (dir, err) => unreadable.push({
                file: `${relPath(dir)}/`, reason: `unlistable directory — ${err.message}`
            });

            for (const root of roots) {
                for (const file of walkFiles(root, unlistable)) {
                    const ext = path.extname(file).toLowerCase();
                    const isDeep = DEEP_EXTENSIONS.includes(ext);
                    // A script is referenced only as a component's __type__, which no
                    // binary asset can hold — skip the structural pass for script targets.
                    const isBinary = !target.scriptType && BINARY_EXTENSIONS.includes(ext);
                    if (!isDeep && !isBinary && !SHALLOW_EXTENSIONS.includes(ext)) continue;
                    const rel = relPath(file);
                    if (isBinary) {
                        // Structural pass — the utf-8 read and its substring pre-filter
                        // below are skipped entirely for binaries (see BINARY_EXTENSIONS).
                        const { hits, reason } = terrainHits(file, target);
                        if (reason) {
                            // Never searched: counting it as scanned would claim coverage we lack
                            unreadable.push({ file: rel, reason });
                            continue;
                        }
                        scanned++;
                        if (hits.length > 0) binary.push({ file: rel, hits });
                        continue;
                    }
                    // Text assets get the same treatment as an unparsable binary: one
                    // chmod-000 or truncated scene must not abort the whole query.
                    const read = readText(file);
                    if (read.reason) {
                        unreadable.push({ file: rel, reason: read.reason });
                        continue;
                    }
                    // Scripts are referenced only as a component's __type__
                    // (compressed uuid), never via __uuid__ — search that form.
                    const contentNeedle = target.scriptType ?? needle;
                    if (read.content.includes(contentNeedle)) {
                        if (isDeep) {
                            // Reuse the content already read for the pre-filter — no
                            // second disk read of the same (potentially 1MB+) file.
                            const { hits, reason } = deepHits(read.content, file, target, scriptNames);
                            if (reason) {
                                unreadable.push({ file: rel, reason });
                                continue;
                            }
                            deep.push({ file: rel, hits });
                        } else {
                            shallow.push({ file: rel, count: countOccurrences(read.content, contentNeedle) });
                        }
                    }
                    scanned++;
                }
            }

            return this.success(render(args, target, deep, shallow, binary, scanned, unreadable));
        } catch (err) {
            return this.error(err.message);
        }
    }
}

/**
 * What are we searching for? Returns {label, kind, needle, uuid, subId}.
 * needle = the raw substring to look for in serialized files (full dashed
 * uuid — sub-asset refs serialize as "<uuid>@<subId>").
 */
function identifyTarget(ref, assetIndex) {
    const resolved = assetIndex.resolve(ref);
    if (resolved) {
        const { entry, subAsset } = resolved;
        // A script is referenced by its compressed uuid in component __type__,
        // not by __uuid__ — carry the compressed form as the search key.
        const isScript = !subAsset &&
            (entry.importer === 'typescript' || entry.importer === 'javascript');
        return {
            kind: 'project',
            label: subAsset ? `${entry.path}@${subAsset.id}` : entry.path,
            uuid: entry.uuid,
            subId: subAsset?.id ?? null,
            needle: subAsset ? `${entry.uuid}@${subAsset.id}` : entry.uuid,
            scriptType: isScript ? compressUuid(entry.uuid) : null
        };
    }
    const builtin = resolveBuiltin(ref);
    if (builtin) {
        const { entry, subAsset } = builtin;
        return {
            kind: 'builtin',
            label: `db://internal/${entry.path}${subAsset ? `@${subAsset.id}` : ''}`,
            uuid: entry.uuid,
            subId: subAsset?.id ?? null,
            needle: subAsset ? `${entry.uuid}@${subAsset.id}` : entry.uuid,
            scriptType: null
        };
    }
    const { uuid, subId } = splitSubAssetRef(ref);
    if (isFullUuid(uuid)) {
        return { kind: 'unknown', label: ref, uuid, subId, needle: subId ? `${uuid}@${subId}` : uuid, scriptType: null };
    }
    if (isCompressedUuid(uuid)) {
        const full = decompressUuid(uuid);
        if (full) {
            return { kind: 'unknown', label: ref, uuid: full, subId, needle: subId ? `${full}@${subId}` : full, scriptType: null };
        }
    }
    return null;
}

/**
 * Does a serialized id refer to the target? A target WITH a sub-asset id must
 * match exactly; a bare target (an image path, say) also matches any of its
 * sub-assets, which is how `<uuid>@6c48a` texture refs are found.
 */
function matchesTarget(uuid, target) {
    return target.subId
        ? uuid === target.needle
        : uuid === target.uuid || uuid.startsWith(`${target.uuid}@`);
}

/**
 * Structural hits inside a `.terrain`: the layer table's `detailMapId` /
 * `normalMapId`, which are ASCII `<uuid>@<subId>` strings and therefore invisible
 * to the JSON walk every other asset kind goes through.
 * @returns {{hits: Array<object>, reason: string|null}} `reason` = the file was never
 *   searched, so the answer is incomplete and says so (it is NOT counted as scanned)
 */
function terrainHits(file, target) {
    let data;
    try {
        // layout only: the palette sits behind the payload, but nothing here decodes it
        data = readTerrainLayout(file);
    } catch (err) {
        return { hits: [], reason: `unreadable .terrain binary — ${err.message}` };
    }
    if (!data) {
        return { hits: [], reason: 'not a recognized .terrain (unknown version magic)' };
    }

    const hits = [];
    data.layers.forEach((layer, i) => {
        for (const [property, id] of [['detailMap', layer.detailMapId], ['normalMap', layer.normalMapId]]) {
            if (id && matchesTarget(id, target)) {
                hits.push({ layer: i, slot: layer.slot, property, uuid: id });
            }
        }
    });
    return { hits, reason: null };
}

/**
 * Read a serialized text asset — same `reason` contract as `terrainHits`: set means the
 * file was never searched, so it is NOT counted as scanned and the answer is a lower bound.
 * @returns {{content: string|null, reason: string|null}}
 */
function readText(file) {
    try {
        return { content: fs.readFileSync(file, 'utf-8'), reason: null };
    } catch (err) {
        return { content: null, reason: `unreadable file — ${err.message}` };
    }
}

/**
 * Deep attribution guarded like the read: a scene whose JSON is truncated holds the needle
 * (the pre-filter said so) but cannot be walked, which is an incomplete answer, not a failed one.
 * @returns {{hits: Array<object>, reason: string|null}}
 */
function deepHits(content, file, target, scriptNames) {
    try {
        return { hits: attributeMatches(content, file, target, scriptNames), reason: null };
    } catch (err) {
        return { hits: [], reason: `unparsable ${path.extname(file)} — ${err.message}` };
    }
}

/** Count non-overlapping occurrences of `needle` without allocating a split array */
function countOccurrences(content, needle) {
    if (!needle) return 0;
    let count = 0;
    let from = 0;
    for (;;) {
        const at = content.indexOf(needle, from);
        if (at === -1) return count;
        count++;
        from = at + needle.length;
    }
}

function scanRoots(projectRoot, folder) {
    if (!folder) {
        const assets = path.join(projectRoot, 'assets');
        return fs.existsSync(assets) ? [assets] : [];
    }
    const normalized = folder.replaceAll('\\', '/').replace(/\/$/, '');
    const root = path.resolve(projectRoot);
    for (const candidate of [normalized, `assets/${normalized}`]) {
        const abs = path.resolve(projectRoot, candidate);
        // Stay inside the project: exact root or a real subdirectory, never a
        // prefix-sharing sibling ("/a/game-backup" vs "/a/game").
        if ((abs === root || abs.startsWith(root + path.sep)) && fs.existsSync(abs)) return [abs];
    }
    return [];
}

/** `onUnlistable(dir, err)`: a directory we cannot read is reported, never thrown — the
 *  files under it are simply not searched (same lower-bound contract as an unreadable file) */
function* walkFiles(dir, onUnlistable) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
        onUnlistable(dir, err);
        return;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) yield* walkFiles(full, onUnlistable);
        else yield full;
    }
}

/**
 * Deep attribution inside a scene/prefab: every value {__uuid__} matching
 * the target becomes "node path ▸ Component .property". Values inside
 * standalone objects (override values, CurveRanges, material arrays) climb
 * to their owning component/node through reverse references.
 */
function attributeMatches(content, filePath, target, scriptNames) {
    const doc = SceneDocument.fromContent(content, filePath);
    const matches = [];

    // A script reference is a component of that type — attribute it to the
    // owning node directly (no property path, no uuid value).
    if (target.scriptType) {
        const cls = scriptNames.get(target.scriptType);
        const name = cls ? `${cls} (script)` : target.scriptType;
        doc.objects.forEach((obj) => {
            if (obj?.__type__ === target.scriptType && isRef(obj.node)) {
                const node = doc.nodePath(obj.node.__id__) ?? `#${obj.node.__id__}`;
                matches.push({ node, component: name, property: null, uuid: null });
            }
        });
        return matches;
    }

    // Single pass collects both the __uuid__ matches AND the first-wins reverse
    // reference map used to climb out of value objects — walking the full graph
    // once instead of twice. `_parent` refs are excluded from `owners` so a
    // child never climbs to its parent (they point child → parent).
    const owners = new Map();
    doc.objects.forEach((obj, idx) => {
        const walk = (value, trail, underParent) => {
            if (value === null || typeof value !== 'object') return;
            if (isRef(value)) {
                if (!underParent && !owners.has(value.__id__)) {
                    owners.set(value.__id__, { fromIdx: idx, trail });
                }
                return;
            }
            if (typeof value.__uuid__ === 'string') {
                if (matchesTarget(value.__uuid__, target)) {
                    matches.push({ idx, trail, uuid: value.__uuid__ });
                }
                return;
            }
            if (Array.isArray(value)) {
                value.forEach((v, i) => walk(v, `${trail}[${i}]`, underParent));
                return;
            }
            for (const key of Object.keys(value)) {
                if (key === '__id__') continue;
                walk(value[key], trail ? `${trail}.${key}` : key, key === '_parent');
            }
        };
        walk(obj, '', false);
    });
    if (matches.length === 0) return [];

    return matches.map(m => {
        const where = climbToOwner(doc, m.idx, m.trail, owners, scriptNames);
        return { ...where, uuid: m.uuid };
    });
}

function climbToOwner(doc, idx, trail, owners, scriptNames) {
    let cur = idx;
    let property = trail;
    for (let guard = 0; guard < 32; guard++) {
        const obj = doc.getObject(cur);
        if (!obj) break;
        if (doc.isNode(obj)) {
            return { node: doc.nodePath(cur) ?? `#${cur}`, component: null, property };
        }
        if (isRef(obj.node)) {
            const nodePath = doc.nodePath(obj.node.__id__) ?? `#${obj.node.__id__}`;
            const cls = scriptNames.get(obj.__type__);
            const type = cls ? `${cls} (script)` : obj.__type__;
            return { node: nodePath, component: type, property };
        }
        const up = owners.get(cur);
        if (!up) {
            return { node: null, component: obj.__type__ ?? '?', property };
        }
        property = up.trail + (property ? ` → ${property}` : '');
        cur = up.fromIdx;
    }
    return { node: null, component: '?', property };
}

function render(args, target, deep, shallow, binary, scanned, unreadable) {
    const lines = [`# References to ${target.label}`, ''];
    switch (target.kind) {
        case 'project':
            lines.push(`Asset: project file "${target.label}" (uuid ${target.needle})`);
            break;
        case 'builtin':
            lines.push(`Asset: engine built-in ${target.label} (uuid ${target.needle}) — ` +
                'ships inside Cocos Creator, referencing it is normal.');
            break;
        default:
            lines.push(`⚠ ${target.needle} is NOT a project asset and NOT an engine built-in — ` +
                'any references below are likely broken.');
    }

    const total = deep.reduce((n, d) => n + d.hits.length, 0) +
        shallow.reduce((n, s) => n + s.count, 0) +
        binary.reduce((n, b) => n + b.hits.length, 0);
    const files = deep.length + shallow.length + binary.length;
    lines.push('', `Found ${total} reference(s) in ${files} file(s) ` +
        `(scanned ${scanned} serialized asset files${args.folder ? ` under ${args.folder}` : ''}` +
        `${unreadable.length ? `, ${unreadable.length} skipped` : ''}).`);

    if (unreadable.length > 0) {
        lines.push('', `## Skipped — not searched (${unreadable.length})`,
            'These could not be read or parsed, so the count above is a LOWER bound.');
        for (const u of unreadable.slice(0, MAX_SKIPPED_LINES)) {
            lines.push(`- ${u.file}: ${u.reason}`);
        }
        const elided = unreadable.length - MAX_SKIPPED_LINES;
        if (elided > 0) lines.push(`… and ${elided} more not shown — the header counts every one.`);
    }

    for (const d of deep) {
        lines.push('', `## ${d.file} (${d.hits.length})`);
        // Same-named siblings produce identical lines — aggregate with ×N
        const counts = new Map();
        for (const h of d.hits) {
            const where = h.node
                ? `${h.node}${h.component ? ` ▸ ${h.component}` : ''}`
                : `(${h.component})`;
            let line;
            if (h.property === null) {
                line = `- ${where} (attached component)`;
            } else {
                const subId = h.uuid.split('@')[1];
                line = `- ${where} .${h.property}` +
                    (h.uuid !== target.needle ? ` [${subId ? `sub-asset @${subId}` : h.uuid}]` : '');
            }
            counts.set(line, (counts.get(line) ?? 0) + 1);
        }
        for (const [line, count] of counts) {
            lines.push(count > 1 ? `${line} (×${count})` : line);
        }
    }
    for (const b of binary) {
        lines.push('', `## ${b.file} (${b.hits.length})`);
        for (const h of b.hits) {
            // The palette index a block references is `slot`; editor-written files
            // always keep it equal to the array position, so only mention it when
            // this file disagrees (see the terrainBin module header).
            const which = h.slot === h.layer ? `layer ${h.layer}` : `layer ${h.layer} (slot ${h.slot})`;
            const subId = h.uuid.split('@')[1];
            lines.push(`- terrain ${which} .${h.property}` +
                (h.uuid !== target.needle ? ` [${subId ? `sub-asset @${subId}` : h.uuid}]` : ''));
        }
    }
    if (shallow.length > 0) {
        lines.push('', '## Other asset files (occurrence counts)');
        for (const s of shallow) {
            lines.push(`- ${s.file} (${s.count})`);
        }
    }
    if (total === 0) {
        const scope = unreadable.length
            ? 'the serialized files that could be read (see Skipped above)'
            : 'serialized files';
        lines.push('', `No references — the asset is unused in ${scope} ` +
            '(code may still load it dynamically by path/uuid).');
    }
    return lines.join('\n');
}
