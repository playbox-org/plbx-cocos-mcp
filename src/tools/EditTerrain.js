/**
 * EditTerrain - MCP tool: batch semantic edits on an existing .terrain binary
 *
 * The `apply_edits` of terrain assets. A `.terrain` is a raw native binary, not a
 * SceneDocument, so it gets its own tool: operations are applied to the parsed data in
 * memory, every format invariant is re-checked, and only a fully valid result is written
 * (atomically, temp + rename). Any failing op writes nothing at all.
 *
 * All coordinates are LOCAL METRES (x = width, z = depth, heights = Y); a terrain is anchored
 * at its node origin and the shader applies only the node's world position.
 */

import * as fs from 'fs';
import * as path from 'path';
import { BaseTool } from './BaseTool.js';
import { AssetIndex } from '../core/AssetIndex.js';
import { applyTerrainOperations } from '../document/terrainOps.js';
import { realpathOrSelf, isInsideAssets } from '../utils/assetPaths.js';
import { writeFileAtomic } from '../utils/fsAtomic.js';
import { terrainCard } from './terrainCard.js';
import {
    readTerrain,
    readTerrainInfo,
    terrainInfoFromData,
    validateTerrainData,
    writeTerrain,
    payloadLength,
    TERRAIN_HEIGHT_FMIN,
    TERRAIN_HEIGHT_FMAX,
} from '../utils/terrainBin.js';

const OPS_DOC = `Operations (applied in order, all-or-nothing — nothing is written if any of them fails):
- set_info {tileSize?, blockCount?: [x,z], weightMapSize?, lightMapSize?} — resize/rescale, overlap-preserving exactly like the editor (Terrain.rebuild): heights keep the overlapping vertex rect and new area becomes 0 m; each new block starts with no layers; weights are copied per block, or resampled when weightMapSize changes, and new blocks reset to (255,0,0,0). Omitted fields keep their value. weightMapSize must be a power of two in 4..1024 (the editor panel offers 128/256/512/1024; smaller powers of two are accepted for tiny test terrains). Any resize invalidates a baked lightmap — the editor clears the bake on any rebuild too. Engine quirk reproduced: when the TOTAL weight-map texel count is unchanged (e.g. [2,2] at 64 -> [1,1] at 128) the weights are not re-mapped at all
- set_layer {slot, detailMap?, normalMap?, tileSize?, roughness?, metallic?} — add or update one palette entry. The palette is dense: slot < layer count updates, slot === layer count appends (detailMap required then), anything higher is an error. detailMap/normalMap take a project path, a UUID or "uuid@subId" (a bare image resolves to its texture sub-asset); normalMap: null clears it. tileSize here is METRES PER TEXTURE REPEAT for this layer, not the terrain's tile size
- remove_layer {slot} — delete a palette entry: unassigned in every block, the block's remaining channels left-packed (weights moved along and renormalized), and the palette re-indexed (higher slots shift down — re-read the card afterwards)
- set_heights {region?, value?} | {region?, rows?} | {region?, heightmap?} (+ falloff?, profile?, clamp?) — flatten to "value" metres, set from inline "rows" (2D array of metres, rows[j][i], x fastest), or sample a heightmap: {source: "Art/hills.png"|"Art/hills.raw", min?: 0, max: 20, width?, height?, bitDepth?} (grayscale 8/16-bit .png or headerless 16-bit .raw; rows/images are resampled onto the region's vertex grid)
- adjust_heights {region?, delta, falloff?, profile?, clamp?} — raise (+) or lower (-) by delta metres. With no falloff this is a flat-topped rectangle with vertical sides; falloff (metres) tapers the delta to 0 AT the region border, which is what makes a smooth hill/depression a single op
- smooth_heights {region?, iterations?: 1, falloff?, profile?, clamp?} — 3x3 box blur. Vertices outside the region are read but never written (no crease at the border); outside the terrain the edge vertex is reused. The blur runs unmasked and the mask blends its result against the original, so falloff keeps its meaning
- paint_layer {layer, region?, weight, falloff?, profile?} — write layer "layer" (a palette slot) at "weight" (0..1) over the region's weight texels, rescaling the other channels so each texel still sums to 255, and assigning the slot into each touched block's 4 blend slots automatically (error if all 4 are taken by other layers). weight 0 ERASES this layer at those texels (the other assigned channels take the full 255) — that is the local undo, NOT remove_layer, which deletes the palette entry everywhere and re-indexes the higher slots. Two warts, both reported: painting weight 0 into a block that did not assign the layer still assigns it (leaving a slot with zero coverage), and in a block where this is the ONLY assigned layer the requested weight is ignored and 255 stored — the engine draws such a block flat and ignores its weight map, so any other value would become a dark patch as soon as a second layer arrives
- set_block_layers {block: [x,z]|"all", layers: [slots…]} — low-level: set which palette slots a block blends (block is a BLOCK index pair, 0-based, same order as blockCount — [x,z], the second component walks along Z; up to 4, order = weight channels R,G,B,A, -1 pads, must stay left-packed). No weight is PAINTED — paint_layer is what fills them in — but a channel losing its layer is zeroed and the block's remaining channels rescaled back to a sum of 255, so the block does not render darkened and no stale weight resurfaces if that channel gains a layer again

region {x?: 0, z?: 0, width?, depth?, shape?} is LOCAL METRES; omitted entirely = the whole terrain, omitted width/depth = out to the far edge. Height vertices sit every tileSize metres and weight texels every blockSize/(weightMapSize-1) metres, so a region snaps to whichever of those it contains. Weight texels are per block (each block owns a full weightMapSize^2 grid whose first and last texel sit ON its edges), so a region ending exactly on a block seam also paints the neighbouring block's edge texels — and gets that layer assigned there.
shape: "rect" (default) | "ellipse" | "band". A "band" follows an ISO-CONTOUR of the height field instead of a coordinate box — the shape a maintenance edit needs, because what it must meet is an existing edge (a waterline, a plateau rim, a cliff foot, a shoreline to paint sand along): region: {shape: "band", contour: <height m>, inner: -1, outer: 2} plus optional x/z/width/depth as a bounding box. inner/outer are SIGNED distances from the contour, negative on the HIGH side (above the contour height) and positive on the low side, so -1..2 means "from 1 m above the contour to 2 m below it". query_terrain {contourAt: <height>} shows where that contour actually runs before you commit to it.
falloff (metres) + profile ("linear" | "smooth" | "cosine") are the SAME on every region-taking op: the factor is 0 AT the region border and reaches 1 exactly falloff metres inside it, so a transition band can never be centred on the mask edge — the mistake that leaves half the amplitude standing where the mask stops, i.e. a step, every time. A falloff wider than the region's half-extent never reaches the requested amplitude anywhere (reported). Height ops also MEASURE the amplitude left at the mask border and report it as a step when it exceeds what the ramp itself explains.
clamp ("none" | "raise-only" | "lower-only") on the height ops composes the result as max(existing, target) / min(existing, target): the edit becomes idempotent at its edges and preserves anything already higher/lower, including terrain an over-large mask reaches into. Use it for "fill this hollow" / "cut this ridge" instead of an unconditional write.
Heights are stored in 1/128 m steps and must lie in [${TERRAIN_HEIGHT_FMIN}, ${TERRAIN_HEIGHT_FMAX}] m: an explicit out-of-range set_heights "value" is REJECTED (a typo should not silently become a cliff), while rows/heightmap samples and adjust_heights results are clamped into range and the count is reported.
An empty "Create > Terrain" file (the 2 KB sentinel) is materialized into real buffers before the first op, exactly like the editor's first save.
Read it back with query_terrain (heightAt/weightAt/exportHeights) — every write here has a matching read there. Editing a terrain that already has content: derive the edge you must meet with query_terrain {contourAt}, capture a baseline with exportHeights {sampleCount: "vertex"} over a region LARGER than the planned edit (set_heights {rows} is absolute and there is no revert, so iteration needs it), and afterwards re-run contourAt plus {slope} to prove the blend is continuous and introduced no crease.
Two standing hazards: never edit a .terrain while the editor has it open in its Terrain panel (the panel holds the whole terrain in memory and its next save overwrites the file wholesale, silently discarding the edit), and library/ keeps the pre-edit import until the editor re-imports on next focus (mtime-driven, automatic — this tool never touches library/ or the .meta).`;

export class EditTerrain extends BaseTool {
    get name() {
        return 'edit_terrain';
    }

    get description() {
        return 'Edit an existing Cocos Creator terrain asset (.terrain binary) through semantic ' +
               'operations: resize the block grid, sculpt heights (flatten/raise/lower/smooth/heightmap, ' +
               'shaped by rect/ellipse/contour-band regions with a tapering falloff and raise/lower-only ' +
               'clamps), manage the texture layer palette and paint layer weights. Applies the batch in memory, ' +
               're-checks every format invariant and writes atomically; nothing is written if any ' +
               'operation fails. Use dryRun to preview. All coordinates are LOCAL METRES (x = width, ' +
               'z = depth, heights = Y in metres); the terrain is anchored at its node origin and the ' +
               'shader uses only the node position — rotation/scale are ignored. Component fields ' +
               '(asset reference, shadows, PBR, normal maps, LOD) are scene data — use apply_edits. ' +
               'Args: {terrainPath (required; .terrain path or UUID), ops (required array), ' +
               'dryRun?: boolean}. ' + OPS_DOC;
    }

    get aliases() {
        return {
            filePath: 'terrainPath',
            path: 'terrainPath',
            asset: 'terrainPath',
            assetPath: 'terrainPath',
            uuid: 'terrainPath',
            operations: 'ops'
        };
    }

    get inputSchema() {
        return {
            type: 'object',
            properties: {
                terrainPath: {
                    type: 'string',
                    description: 'Path to the .terrain relative to project root (e.g. "assets/Maps/Ground.terrain") ' +
                                 'or its UUID. Must live inside the project\'s assets/ directory'
                },
                ops: {
                    type: 'array',
                    description: 'Operations to apply in order (see tool description for shapes). ' +
                                 'Also accepted as "operations"',
                    items: { type: 'object' },
                    minItems: 1
                },
                dryRun: {
                    type: 'boolean',
                    description: 'Preview: apply + validate in memory, report the resulting terrain, ' +
                                 'but do not write',
                    default: false
                }
            },
            required: ['terrainPath', 'ops']
        };
    }

    async execute(args, projectRoot) {
        const assetIndex = AssetIndex.shared(projectRoot);

        // Accept a UUID or any path form AssetIndex knows (same as query_terrain), falling
        // back to a plain project-relative path for a terrain that has no .meta yet.
        let filePath;
        let title;
        const resolved = assetIndex.resolve(args.terrainPath);
        if (resolved) {
            if (resolved.entry.importer !== 'terrain') {
                return this.error(
                    `"${args.terrainPath}" is not a terrain — its importer is ` +
                    `"${resolved.entry.importer}". Terrain heights/weights/layers live in a ` +
                    '.terrain asset; use apply_edits for scene/prefab files.'
                );
            }
            filePath = path.resolve(projectRoot, resolved.entry.path);
            title = resolved.entry.path;
        } else {
            filePath = path.resolve(projectRoot, args.terrainPath);
            title = args.terrainPath;
        }
        if (!filePath.endsWith('.terrain')) {
            return this.error('terrainPath must point at a .terrain file');
        }
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
            return this.error(
                `Terrain not found: ${args.terrainPath}. Use list_assets {type: "terrain"} to browse ` +
                'terrain assets, or build_terrain to create one.'
            );
        }
        // Containment is checked on RESOLVED paths (assetPaths.js): a symlink under assets/
        // pointing outside the project must not pass it and take the write with it. The file
        // exists by now, so plain realpath is enough here.
        const assetsRoot = realpathOrSelf(path.resolve(projectRoot, 'assets'));
        filePath = realpathOrSelf(filePath);
        if (!isInsideAssets(filePath, assetsRoot)) {
            return this.error(
                'terrainPath must be inside the project\'s assets/ directory — a .terrain outside ' +
                'assets/ is not an asset the editor can import.'
            );
        }

        let data;
        try {
            data = readTerrain(fs.readFileSync(filePath));
        } catch (err) {
            return this.error(`Cannot read ${title}: ${err.message}\n\nNothing was written.`);
        }
        if (!data) {
            return this.error(
                `${title} is not a Cocos Creator .terrain binary (unrecognized version magic in the ` +
                'first 4 bytes).\n\nNothing was written.'
            );
        }

        let results;
        let notes;
        try {
            ({ results, notes } = applyTerrainOperations(data, args.ops, { assetIndex, projectRoot }));
        } catch (err) {
            return this.error(`${err.message}\n\nNothing was written.`);
        }

        // Belt and braces: writeTerrain validates too, but a failed invariant should read as
        // "the edits are invalid", not as a serializer error.
        let buffer;
        try {
            validateTerrainData(data);
            buffer = writeTerrain(data);
        } catch (err) {
            return this.error(
                `The edits produced an invalid terrain: ${err.message}\n\nNothing was written.`
            );
        }

        const dryRun = args.dryRun === true;
        if (!dryRun) {
            try {
                writeFileAtomic(filePath, buffer);
            } catch (err) {
                return this.error(`Cannot write ${title}: ${err.message}\n\nNothing was written.`);
            }
        }

        // Non-dryRun re-READS what landed on disk; dryRun renders the card from the data that
        // WOULD have been written (same renderer, same numbers).
        const info = dryRun
            ? terrainInfoFromData(data, {
                filePath,
                fileSize: buffer.length,
                payloadLength: payloadLength(data)
            })
            : readTerrainInfo(filePath);

        return this.success(this.#report({
            title, args, results, notes, info, dryRun, assetIndex, filePath
        }));
    }

    #report({ title, args, results, notes, info, dryRun, assetIndex, filePath }) {
        const lines = [];
        lines.push(dryRun
            ? `# DRY RUN — ${title} NOT modified`
            : `# Applied ${results.length} op(s) to ${title}`);
        lines.push('');
        // Per-op notes hang off their own op's line. They are what the op DID (an auto-assigned
        // channel, an ignored weight), not problems with the file — bucketing them under
        // "## Warnings" made success details read as failures and drowned the real warnings.
        results.forEach((r, i) => {
            lines.push(`${i + 1}. [${r.op}] ${r.summary}`);
            (r.notes ?? []).forEach((n) => lines.push(`   - ${n}`));
        });

        lines.push('', ...terrainCard(info, assetIndex));

        // A slot this batch appended and left unassigned gets the actionable form of
        // terrainBin's "defined but no block uses it" warning — derived from the FINAL state,
        // so a later paint_layer in the same batch silences it.
        const appended = new Set(results.map((r) => r.appendedSlot).filter((s) => s !== null && s !== undefined));
        const fileWarnings = (info?.warnings ?? []).map((w) => {
            const m = /^layer slot (\d+) is defined but no block uses it/.exec(w);
            return m && appended.has(Number(m[1]))
                ? `palette slot ${m[1]} exists now but no block references it yet, so it cannot ` +
                  'show up — assign it with paint_layer (which also fills in the weights) or ' +
                  'set_block_layers'
                : w;
        });
        // `## Warnings` is reserved for batch-level (file preparation) and file-level items, the
        // way apply_edits reserves it for validator output.
        const warnings = [...notes, ...fileWarnings];
        if (!fs.existsSync(`${filePath}.meta`)) {
            warnings.push(
                `${title} has no .meta, so it is not an addressable asset yet — no UUID, invisible to ` +
                'the asset index and unreferencable from a cc.Terrain component. Generate one with ' +
                `create_asset_meta {path: "${args.terrainPath}"} (the editor keeps a brought-along UUID ` +
                'on import). The edit itself was applied normally.'
            );
        }
        if (warnings.length) {
            lines.push('', `## Warnings (${warnings.length})`);
            warnings.forEach((w) => lines.push(`- ${w}`));
        }

        // Only emitted when there is something specific to say. The two standing hazards (the
        // editor's Terrain panel, the stale library/ import) live in the tool DESCRIPTION, paid
        // once per session instead of on every op of a multi-step sculpting run.
        const resized = results.find((r) => r.blockCountChanged);
        if (resized) {
            lines.push('', '## Next steps');
            lines.push(
                `- blockCount changed [${resized.blockCountFrom}] -> [${resized.blockCountTo}]: clear ` +
                '`_lightmapInfos` on every cc.Terrain component that uses this asset — ' +
                'apply_edits {op: "set_component_property", node: "<terrain node>", ' +
                'component: "cc.Terrain", property: "_lightmapInfos", value: []} — because the baked ' +
                'lightmap array is indexed by block and no longer matches the grid (the editor does ' +
                'the same on its own resize, then you re-bake). ' +
                'find_asset_references on this .terrain lists the scenes/prefabs to fix.'
            );
        }
        if (dryRun) {
            lines.push('', 'Re-run with dryRun: false to write.');
        }
        return lines.join('\n');
    }
}
