/**
 * FindAssetReferences - MCP tool: reverse lookup "who uses this asset?"
 *
 * Resolves the asset (project path / UUID / compressed / "uuid@subId" /
 * engine builtin), then scans the project's serialized asset files for
 * `__uuid__` occurrences. Scenes and prefabs get deep attribution
 * (file → node path → component.property); other JSON assets (.mtl, .anim,
 * .animgraph) are reported at file level. Also answers "what is this UUID"
 * when it belongs to no project asset: engine builtin vs likely-broken ref.
 */

import * as fs from 'fs';
import * as path from 'path';
import { BaseTool } from './BaseTool.js';
import { AssetIndex } from '../core/AssetIndex.js';
import { resolveBuiltin } from '../core/builtins.js';
import { SceneDocument, isRef } from '../document/SceneDocument.js';
import { splitSubAssetRef, isFullUuid, isCompressedUuid, decompressUuid, compressUuid } from '../utils/uuid.js';

/** Files that may hold __uuid__ references */
const DEEP_EXTENSIONS = ['.scene', '.prefab'];
const SHALLOW_EXTENSIONS = ['.mtl', '.material', '.anim', '.animgraph', '.effect'];

export class FindAssetReferences extends BaseTool {
    get name() {
        return 'find_asset_references';
    }

    get description() {
        return 'Find every place an asset is referenced across the project\'s serialized files. ' +
               'Scenes/prefabs report file → node path → component.property; materials/anims ' +
               'report at file level. Also identifies unknown UUIDs: project asset, engine ' +
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

            const scriptNames = new Map(assetIndex.list({ type: 'script' })
                .map(e => [compressUuid(e.uuid), `${e.name.replace(/\.[jt]s$/, '')} (script)`]));
            const needle = target.needle;
            const deep = [];
            const shallow = [];
            let scanned = 0;

            for (const root of roots) {
                for (const file of walkFiles(root)) {
                    const ext = path.extname(file).toLowerCase();
                    const isDeep = DEEP_EXTENSIONS.includes(ext);
                    if (!isDeep && !SHALLOW_EXTENSIONS.includes(ext)) continue;
                    scanned++;
                    const content = fs.readFileSync(file, 'utf-8');
                    if (!content.includes(needle)) continue;

                    const rel = path.relative(projectRoot, file).replaceAll(path.sep, '/');
                    if (isDeep) {
                        deep.push({
                            file: rel,
                            hits: attributeMatches(file, target, scriptNames)
                        });
                    } else {
                        const count = content.split(needle).length - 1;
                        shallow.push({ file: rel, count });
                    }
                }
            }

            return this.success(render(args, target, deep, shallow, scanned));
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
        return {
            kind: 'project',
            label: subAsset ? `${entry.path}@${subAsset.id}` : entry.path,
            uuid: entry.uuid,
            subId: subAsset?.id ?? null,
            needle: subAsset ? `${entry.uuid}@${subAsset.id}` : entry.uuid
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
            needle: subAsset ? `${entry.uuid}@${subAsset.id}` : entry.uuid
        };
    }
    const { uuid, subId } = splitSubAssetRef(ref);
    if (isFullUuid(uuid)) {
        return { kind: 'unknown', label: ref, uuid, subId, needle: subId ? `${uuid}@${subId}` : uuid };
    }
    if (isCompressedUuid(uuid)) {
        const full = decompressUuid(uuid);
        if (full) {
            return { kind: 'unknown', label: ref, uuid: full, subId, needle: subId ? `${full}@${subId}` : full };
        }
    }
    return null;
}

function scanRoots(projectRoot, folder) {
    if (!folder) {
        const assets = path.join(projectRoot, 'assets');
        return fs.existsSync(assets) ? [assets] : [];
    }
    const normalized = folder.replaceAll('\\', '/').replace(/\/$/, '');
    for (const candidate of [normalized, `assets/${normalized}`]) {
        const abs = path.resolve(projectRoot, candidate);
        if (abs.startsWith(path.resolve(projectRoot)) && fs.existsSync(abs)) return [abs];
    }
    return [];
}

function* walkFiles(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) yield* walkFiles(full);
        else yield full;
    }
}

/**
 * Deep attribution inside a scene/prefab: every value {__uuid__} matching
 * the target becomes "node path ▸ Component .property". Values inside
 * standalone objects (override values, CurveRanges, material arrays) climb
 * to their owning component/node through reverse references.
 */
function attributeMatches(filePath, target, scriptNames) {
    const doc = SceneDocument.load(filePath);
    const matches = [];
    doc.objects.forEach((obj, idx) => {
        const walk = (value, trail) => {
            if (value === null || typeof value !== 'object') return;
            if (typeof value.__uuid__ === 'string') {
                const hit = target.subId
                    ? value.__uuid__ === target.needle
                    : value.__uuid__ === target.uuid || value.__uuid__.startsWith(`${target.uuid}@`);
                if (hit) matches.push({ idx, trail, uuid: value.__uuid__ });
                return;
            }
            if (Array.isArray(value)) {
                value.forEach((v, i) => walk(v, `${trail}[${i}]`));
                return;
            }
            for (const key of Object.keys(value)) {
                if (key !== '__id__') walk(value[key], trail ? `${trail}.${key}` : key);
            }
        };
        walk(obj, '');
    });
    if (matches.length === 0) return [];

    // First-wins reverse reference map for climbing out of value objects
    const owners = new Map();
    doc.objects.forEach((obj, idx) => {
        const walk = (value, trail) => {
            if (value === null || typeof value !== 'object') return;
            if (isRef(value)) {
                if (!owners.has(value.__id__)) owners.set(value.__id__, { fromIdx: idx, trail });
                return;
            }
            if (Array.isArray(value)) {
                value.forEach((v, i) => walk(v, `${trail}[${i}]`));
                return;
            }
            for (const key of Object.keys(value)) {
                if (key !== '__id__' && key !== '_parent') {
                    walk(value[key], trail ? `${trail}.${key}` : key);
                }
            }
        };
        walk(obj, '');
    });

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
            const type = scriptNames.get(obj.__type__) ?? obj.__type__;
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

function render(args, target, deep, shallow, scanned) {
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
        shallow.reduce((n, s) => n + s.count, 0);
    lines.push('', `Found ${total} reference(s) in ${deep.length + shallow.length} file(s) ` +
        `(scanned ${scanned} serialized asset files${args.folder ? ` under ${args.folder}` : ''}).`);

    for (const d of deep) {
        lines.push('', `## ${d.file} (${d.hits.length})`);
        // Same-named siblings produce identical lines — aggregate with ×N
        const counts = new Map();
        for (const h of d.hits) {
            const where = h.node
                ? `${h.node}${h.component ? ` ▸ ${h.component}` : ''}`
                : `(${h.component})`;
            const subId = h.uuid.split('@')[1];
            const line = `- ${where} .${h.property}` +
                (h.uuid !== target.needle ? ` [${subId ? `sub-asset @${subId}` : h.uuid}]` : '');
            counts.set(line, (counts.get(line) ?? 0) + 1);
        }
        for (const [line, count] of counts) {
            lines.push(count > 1 ? `${line} (×${count})` : line);
        }
    }
    if (shallow.length > 0) {
        lines.push('', '## Other asset files (occurrence counts)');
        for (const s of shallow) {
            lines.push(`- ${s.file} (${s.count})`);
        }
    }
    if (total === 0) {
        lines.push('', 'No references — the asset is unused in serialized files ' +
            '(code may still load it dynamically by path/uuid).');
    }
    return lines.join('\n');
}
