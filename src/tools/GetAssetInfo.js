/**
 * GetAssetInfo - MCP tool for inspecting a single asset
 *
 * Sprite: rect/trim/rawSize/9-slice borders. Model: sub-assets + mesh AABB.
 * Prefab: structure summary. Material: effect + defines.
 * Terrain: size/blocks/vertex grid/height range + the layer palette.
 */

import * as fs from 'fs';
import * as path from 'path';
import { BaseTool } from './BaseTool.js';
import { AssetIndex } from '../core/AssetIndex.js';
import { AssetInspector } from '../core/AssetInspector.js';
import { resolveBuiltin } from '../core/builtins.js';
import { renderTerrainWarnings, terrainWarningElision } from '../utils/terrainBin.js';

export class GetAssetInfo extends BaseTool {
    get name() {
        return 'get_asset_info';
    }

    get description() {
        return 'Get detailed info about a Cocos Creator asset by path or UUID (full, compressed, ' +
               'or "<uuid>@<subId>" sub-asset form). Sprites: rect/trim/raw size/9-slice borders. ' +
               'Models (fbx/glb): meshes with AABB and size, materials, prefab sub-asset. ' +
               'Prefabs: structure summary. Materials: effect and defines. ' +
               'Terrain (.terrain): size in metres, blocks, vertex grid, weight/light map ' +
               'sizes, height range and the layer palette with resolved textures. ' +
               'Args: {asset (required), format?: "text"|"json"}.';
    }

    get inputSchema() {
        return {
            type: 'object',
            properties: {
                asset: {
                    type: 'string',
                    description: "Asset path relative to project root (e.g. 'assets/Art/Models/Coin.fbx') or UUID"
                },
                format: {
                    type: 'string',
                    enum: ['text', 'json'],
                    description: 'Output format',
                    default: 'text'
                }
            },
            required: ['asset']
        };
    }

    async execute(args, projectRoot) {
        try {
            const index = AssetIndex.shared(projectRoot);
            const inspector = new AssetInspector(projectRoot, index);
            const info = inspector.inspect(args.asset);

            if (!info) {
                const builtin = resolveBuiltin(args.asset);
                if (builtin) {
                    if (args?.format === 'json') {
                        return this.success(JSON.stringify(
                            { builtin: true, engine: builtin.engine, ...builtin.entry }, null, 2));
                    }
                    return this.success(this.#formatBuiltin(builtin));
                }
                const notImported = this.#unimportedFile(args.asset, projectRoot);
                if (notImported) {
                    return this.error(
                        `"${notImported}" exists on disk but has no .meta — the editor has not ` +
                        'imported it yet. Run create_asset_meta to generate one offline (works for ' +
                        'scripts, images, audio, .mtl/.anim/... — models .fbx/.glb/.gltf still need ' +
                        'one editor open), then retry.'
                    );
                }
                return this.error(
                    `Asset not found: ${args.asset}. ` +
                    'Use list_assets to browse available assets ' +
                    '(not an engine built-in either — the reference may be broken).'
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

    /**
     * Path-form ref that resolves to a real file without a .meta means the
     * asset is on disk but the editor has not imported it yet.
     * @returns {string|null} Project-relative path when that is the case
     */
    #unimportedFile(ref, projectRoot) {
        if (!ref.includes('/') && !ref.includes('.')) return null; // UUID-ish, not a path
        const candidates = [ref, `assets/${ref}`];
        for (const rel of candidates) {
            const abs = path.resolve(projectRoot, rel);
            if (fs.existsSync(abs) && fs.statSync(abs).isFile() && !fs.existsSync(`${abs}.meta`)) {
                return rel.replaceAll('\\', '/');
            }
        }
        return null;
    }

    /** Card for an engine built-in (db://internal) — not a project asset */
    #formatBuiltin({ entry, subAsset, engine }) {
        const lines = [
            `# Engine built-in: db://internal/${entry.path}`,
            '',
            'This asset ships INSIDE Cocos Creator (the editor\'s internal db), not in the',
            'project — referencing it is normal, there is nothing to fix.',
            '',
            `UUID: ${entry.uuid}`,
            `Type: ${entry.importer}`,
            `Engine: ${engine}`
        ];
        if (subAsset) {
            lines.push('', `## Referenced sub-asset`,
                `- ${subAsset.importer}: ${subAsset.name || subAsset.id} (${entry.uuid}@${subAsset.id})`);
        } else if (entry.subAssets?.length) {
            lines.push('', `## Sub-assets (${entry.subAssets.length})`);
            for (const s of entry.subAssets) {
                lines.push(`- ${s.importer}: ${s.name || s.id} (${entry.uuid}@${s.id})`);
            }
        }
        return lines.join('\n');
    }

    #formatText(info) {
        const lines = [`# ${info.path}`, ''];
        lines.push(`UUID: ${info.uuid}`);
        lines.push(`Type: ${info.importer}`);

        if (info.compressedUuid) {
            lines.push(`Compressed UUID: ${info.compressedUuid}`);
        }

        if (info.spriteFrame) this.#formatSpriteFrame(lines, info.spriteFrame);
        if (info.meshes) this.#formatModel(lines, info);
        if (info.rootName !== undefined) this.#formatPrefab(lines, info);
        if (info.effect) this.#formatMaterial(lines, info);
        if (info.terrain) this.#formatTerrain(lines, info.terrain);

        if (info.subAssets?.length && !info.meshes) {
            lines.push('');
            lines.push('## Sub-assets');
            for (const s of info.subAssets) {
                lines.push(`- ${s.importer}: ${s.uuid}`);
            }
        }

        return lines.join('\n');
    }

    #formatSpriteFrame(lines, sf) {
        lines.push('');
        lines.push('## SpriteFrame');
        lines.push(`UUID: ${sf.uuid}`);
        lines.push(`Rect: ${sf.rect.width}x${sf.rect.height} at (${sf.rect.x}, ${sf.rect.y})`);
        lines.push(`Raw size: ${sf.rawSize.width}x${sf.rawSize.height}`);
        lines.push(`Offset: (${sf.offset.x}, ${sf.offset.y})`);
        if (sf.isSliced) {
            const b = sf.borders;
            lines.push(`9-slice borders: top=${b.top} bottom=${b.bottom} left=${b.left} right=${b.right} → SLICED candidate`);
        } else {
            lines.push('9-slice borders: none');
        }
    }

    #formatModel(lines, info) {
        lines.push('');
        lines.push(`## Meshes (${info.meshes.length})`);
        for (const m of info.meshes) {
            lines.push(`- ${m.name} (${m.uuid})`);
            if (m.aabb) {
                const s = m.aabb.size;
                const fmt = v => Number(v.toFixed(4));
                lines.push(`  size: ${fmt(s.x)} x ${fmt(s.y)} x ${fmt(s.z)} ` +
                           `(min ${fmt(m.aabb.min.x)},${fmt(m.aabb.min.y)},${fmt(m.aabb.min.z)} / ` +
                           `max ${fmt(m.aabb.max.x)},${fmt(m.aabb.max.y)},${fmt(m.aabb.max.z)}) [${m.aabbSource}]`);
            } else {
                lines.push('  size: unknown (no compiled mesh in library/, no glb fallback)');
            }
        }

        if (info.materials.length > 0) {
            lines.push('');
            lines.push('## Materials');
            info.materials.forEach(m => lines.push(`- ${m.name} (${m.uuid})`));
        }
        if (info.animations.length > 0) {
            lines.push('');
            lines.push('## Animations');
            info.animations.forEach(a => lines.push(`- ${a.name} (${a.uuid})`));
        }
        if (info.modelPrefab) {
            lines.push('');
            lines.push(`Model prefab sub-asset: ${info.modelPrefab}`);
        }
    }

    #formatPrefab(lines, info) {
        lines.push('');
        lines.push('## Prefab summary');
        lines.push(`Root: ${info.rootName}`);
        lines.push(`Nodes: ${info.nodeCount}, nested prefab instances: ${info.prefabInstances}`);
        if (info.rootComponents.length > 0) {
            lines.push(`Root components: ${info.rootComponents.join(', ')}`);
        }
        const comps = Object.entries(info.components)
            .map(([name, count]) => count > 1 ? `${name} x${count}` : name)
            .join(', ');
        lines.push(`Components: ${comps || 'none'}`);
        if (info.topLevelChildren.length > 0) {
            lines.push(`Top-level children: ${info.topLevelChildren.join(', ')}`);
        }
    }

    /**
     * Terrain card. `t` is AssetInspector's terrain block (readTerrainInfo plus
     * resolved layer texture names and the warning entries that resolution adds) —
     * or `{error}`, which #formatText does not render on its own, so it is printed here.
     */
    #formatTerrain(lines, t) {
        const fmt = v => Number(v.toFixed(4));
        lines.push('');
        lines.push('## Terrain');
        if (t.error) {
            lines.push(`Error: ${t.error}`);
            return;
        }

        const [w, d] = t.size;
        const [bc0, bc1] = t.blockCount;
        lines.push(`Size: ${fmt(w)} x ${fmt(d)} m (X x Z), anchored at the node origin ` +
                   '(the shader applies node position only — rotation/scale are ignored)');
        lines.push(`Blocks: ${bc0} x ${bc1} of 32x32 tiles, tileSize ${fmt(t.tileSize)} m`);
        lines.push(`Vertex grid: ${t.vertexCount[0]} x ${t.vertexCount[1]}`);
        // weightMapSize is a per-SIDE texel count; query_terrain spells it the same way
        lines.push(`Weight map: ${t.weightMapSize} x ${t.weightMapSize} per block ` +
                   `(${t.weightMapTexels[0]} x ${t.weightMapTexels[1]} texels total)`);
        lines.push(`Light map size: ${t.lightMapSize}`);
        if (t.heightMin === null) {
            lines.push('Height range: no height data');
        } else if (t.isFlat) {
            lines.push(`Height range: flat at ${fmt(t.heightMin)} m`);
        } else {
            lines.push(`Height range: ${fmt(t.heightMin)} .. ${fmt(t.heightMax)} m ` +
                       `(mean ${fmt(t.heightMean)} m)`);
        }
        lines.push(`Format: ${t.versionLabel}, payload ${t.payloadLength} B of ${t.fileSize} B ` +
                   `(${t.padding} B pow-2 padding)`);
        if (t.isDefaultSentinel) {
            lines.push('Note: empty default terrain — the editor created it but nothing has been ' +
                       'sculpted or saved yet, so heights/weights/layers are all class defaults.');
        }

        lines.push('');
        lines.push(`## Terrain layers (${t.layers.length})`);
        if (t.layers.length === 0) {
            lines.push('- none (blocks render the effect fallback until a layer is painted)');
        }
        const usage = new Map((t.layerUsage ?? []).map(u => [u.slot, u]));
        for (const layer of t.layers) {
            const detail = layer.detailMapName ?? layer.detailMapId ?? '(none)';
            const normal = layer.normalMapId
                ? `, normal ${layer.normalMapName ?? layer.normalMapId}`
                : '';
            const u = usage.get(layer.slot);
            const used = u
                ? `used by ${u.blocks.length} block(s), coverage ${(u.coverage * 100).toFixed(1)}%`
                : 'unused (no block assigns this slot)';
            lines.push(`- slot ${layer.slot}: ${detail}${normal}`);
            lines.push(`  tileSize ${fmt(layer.tileSize)}, roughness ${fmt(layer.roughness)}, ` +
                       `metallic ${fmt(layer.metallic)}, ${used}`);
        }

        // Through the shared renderer, so this card aggregates, caps and elides exactly like
        // query_terrain/edit_terrain — a 16-layer palette of dead textures was 16 lines here
        // against their one. `total` counts real problems, so the header stays truthful.
        const { lines: warnings, total, elided } = renderTerrainWarnings(t);
        if (total) {
            lines.push('');
            lines.push(`## Terrain warnings (${total})`);
            for (const warning of warnings) lines.push(`- ${warning}`);
            // A continuation line, never a bullet: the header above counts real problems
            if (elided) lines.push(terrainWarningElision(elided, total, 'warning'));
        }
    }

    #formatMaterial(lines, info) {
        lines.push('');
        lines.push('## Material');
        lines.push(`Effect: ${info.effect.name ?? info.effect.uuid ?? 'unknown'}`);
        lines.push(`Technique: ${info.technique}`);
        const active = Object.entries(info.defines)
            .filter(([, v]) => v)
            .map(([k, v]) => v === true ? k : `${k}=${v}`);
        lines.push(`Defines: ${active.join(', ') || 'none'}`);
    }
}
