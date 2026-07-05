/**
 * GetAssetInfo - MCP tool for inspecting a single asset
 *
 * Sprite: rect/trim/rawSize/9-slice borders. Model: sub-assets + mesh AABB.
 * Prefab: structure summary. Material: effect + defines.
 */

import * as fs from 'fs';
import * as path from 'path';
import { BaseTool } from './BaseTool.js';
import { AssetIndex } from '../core/AssetIndex.js';
import { AssetInspector } from '../core/AssetInspector.js';

export class GetAssetInfo extends BaseTool {
    get name() {
        return 'get_asset_info';
    }

    get description() {
        return 'Get detailed info about a Cocos Creator asset by path or UUID (full, compressed, ' +
               'or "<uuid>@<subId>" sub-asset form). Sprites: rect/trim/raw size/9-slice borders. ' +
               'Models (fbx/glb): meshes with AABB and size, materials, prefab sub-asset. ' +
               'Prefabs: structure summary. Materials: effect and defines. ' +
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
            const index = new AssetIndex(projectRoot);
            const inspector = new AssetInspector(projectRoot, index);
            const info = inspector.inspect(args.asset);

            if (!info) {
                const notImported = this.#unimportedFile(args.asset, projectRoot);
                if (notImported) {
                    return this.error(
                        `"${notImported}" exists on disk but has no .meta — the editor has not ` +
                        'imported it yet. Ask the user to open the project in Cocos Creator once, ' +
                        'then retry.'
                    );
                }
                return this.error(
                    `Asset not found: ${args.asset}. ` +
                    'Use list_assets to browse available assets.'
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
