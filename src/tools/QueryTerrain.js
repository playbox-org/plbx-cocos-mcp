/**
 * QueryTerrain - MCP tool: in-depth read of a `.terrain` binary asset
 *
 * `get_asset_info` answers "what is this asset"; this tool answers the
 * questions an agent has while EDITING terrain:
 *   - what does the palette look like, and which block uses which slot
 *   - how high is the ground at (x, z) — "does my prop sit on the terrain?"
 *   - which layer is painted at (x, z) — the verification counterpart of a
 *     future `paint_layer`
 *   - dump the height grid so a relative edit ("lower this hill") can be
 *     computed and diffed before/after
 *
 * All coordinates are LOCAL METRES: x along the terrain width, z along its
 * depth, heights in metres. Terrain geometry is anchored at the node origin
 * (local X in [0, width], Z in [0, depth]) and the terrain shader applies the
 * node's worldPosition only — node rotation and scale are ignored.
 *
 * Format knowledge lives entirely in `src/utils/terrainBin.js`; this file only
 * samples, aggregates per block and renders.
 */

import * as fs from 'fs';
import * as path from 'path';
import { BaseTool } from './BaseTool.js';
import { AssetIndex } from '../core/AssetIndex.js';
import {
    readTerrain,
    readTerrainInfo,
    heightAt,
    weightAt,
    exportHeights,
    heightToRaw,
    blockLayers,
    blockIndex,
    maxLayerIndex,
    weightMapDims,
    expectedCounts,
    terrainSize,
    TERRAIN_MAX_BLEND_LAYERS,
    TERRAIN_BLOCK_TILE_COMPLEXITY,
    TERRAIN_HEIGHT_FACTOR
} from '../utils/terrainBin.js';

/** Weight-map channel names, in `layerBuffer` slot order */
const CHANNELS = ['R', 'G', 'B', 'A'];

/**
 * Per-block table budget. Up to this many blocks the table is printed without
 * being asked; above it the caller must pass `blocks: true` (the summary line
 * says so), and even then the table stops at {@link BLOCK_TABLE_MAX_ROWS}.
 */
const BLOCK_TABLE_AUTO_LIMIT = 64;
const BLOCK_TABLE_MAX_ROWS = 1024;

/**
 * Height-grid budget. The DEFAULT resolution is the region's vertex grid (one
 * sample per tile corner) downsampled by the smallest POWER-OF-TWO stride that
 * keeps both axes at or below `GRID_DEFAULT_MAX_AXIS` samples — so a 1-block
 * terrain dumps at full 33x33 resolution while a 16x16-block one comes back as
 * a 33x33 overview instead of 513x513 = 263k numbers. Power-of-two strides keep
 * the sample spacing an exact multiple of the tile size (a block is 32 tiles),
 * which a plain `ceil` stride would not. An explicit `sampleCount` overrides
 * the rule, up to the hard caps below.
 */
const GRID_DEFAULT_MAX_AXIS = 65;
const GRID_MAX_AXIS = 513;
const GRID_MAX_CELLS = 65536;

/**
 * Point-sample budget. Every other output here is bounded; `heightAt`/`weightAt` were the
 * hole — 5000 points rendered an 868 KB report. "Sample the ground under all my props" is
 * exactly the loop an agent writes, so the cap routes it at `exportHeights` instead.
 */
const MAX_SAMPLE_POINTS = 256;

/** Report sections `sections` can select; the header and warnings are always rendered. */
const SECTIONS = ['geometry', 'layers', 'blocks', 'samples', 'notes'];

/** Argument problems raised inside execute() (the schema cannot express them) */
class ArgError extends Error {}

export class QueryTerrain extends BaseTool {
    get name() {
        return 'query_terrain';
    }

    get description() {
        return 'Inspect a Cocos Creator terrain asset (.terrain binary): geometry (size in metres, ' +
               'blocks, tile size, vertex grid, weight/light map sizes), height statistics, the layer ' +
               'palette with textures resolved to asset names, per-block layer/weight usage, and ' +
               'consistency warnings. Sampling: heightAt answers "is my prop on the ground?", weightAt ' +
               'answers "which layer is painted here?", exportHeights dumps the height grid for relative ' +
               'edits and before/after diffs. All coordinates are LOCAL METRES (x = width, z = depth, ' +
               'height = Y); terrain geometry starts at the node origin and the shader applies node ' +
               'worldPosition only (node rotation/scale are ignored). ' +
               'Args: {terrainPath (required; .terrain path or UUID — a bare asset NAME is not ' +
               `accepted), heightAt?: [[x,z],…] (max ${MAX_SAMPLE_POINTS} points), ` +
               `weightAt?: [[x,z],…] (max ${MAX_SAMPLE_POINTS} points), ` +
               'exportHeights?: {region?: {x,z,width,depth}, ' +
               'format?: "rows"|"raw16", sampleCount?: n|[cols,rows]}, blocks?: boolean, ' +
               `sections?: [${SECTIONS.map((s) => `"${s}"`).join('|')}] (text report only — pass ` +
               '["samples"] to skip the ~25-line geometry/palette/notes preamble when you are ' +
               'only sampling), format?: "text"|"json"}.';
    }

    get aliases() {
        return {
            filePath: 'terrainPath',
            path: 'terrainPath',
            asset: 'terrainPath',
            assetPath: 'terrainPath',
            uuid: 'terrainPath'
        };
    }

    get inputSchema() {
        return {
            type: 'object',
            properties: {
                terrainPath: {
                    type: 'string',
                    description: 'Path to the .terrain relative to project root (e.g. "assets/Maps/Terrain.terrain") ' +
                                 'or its UUID. Also reachable through the "path"/"asset"/"filePath"/"uuid" aliases; ' +
                                 'if both an alias and terrainPath are given, terrainPath wins'
                },
                heightAt: {
                    type: 'array',
                    items: { type: 'array', items: { type: 'number' } },
                    description: 'Points to sample the ground height at: [[x, z], …] in local metres ' +
                                 `(max ${MAX_SAMPLE_POINTS} points — use exportHeights for a bulk dump)`
                },
                weightAt: {
                    type: 'array',
                    items: { type: 'array', items: { type: 'number' } },
                    description: 'Points to sample the layer blend weights at: [[x, z], …] in local metres ' +
                                 `(max ${MAX_SAMPLE_POINTS} points)`
                },
                exportHeights: {
                    type: 'object',
                    description: 'Dump the height grid. {} = whole terrain at the default resolution. ' +
                                 'region?: {x, z, width, depth} in local metres; ' +
                                 'format?: "rows" (metres, default) | "raw16" (u16 as stored: metres = (raw - 32768) / 128); ' +
                                 'sampleCount?: n or [cols, rows] to override the resolution ' +
                                 `(max ${GRID_MAX_AXIS} per axis, ${GRID_MAX_CELLS} cells). ` +
                                 'By default the grid is the vertex resolution of the region, downsampled by a ' +
                                 `power-of-two stride so neither axis exceeds ${GRID_DEFAULT_MAX_AXIS} samples — ` +
                                 'ask for a region to get full resolution on a big terrain'
                },
                blocks: {
                    type: 'boolean',
                    description: `Per-block layer/weight table. Shown by default for up to ${BLOCK_TABLE_AUTO_LIMIT} blocks; ` +
                                 'true forces it on a bigger terrain, false suppresses it'
                },
                sections: {
                    type: 'array',
                    items: { type: 'string', enum: SECTIONS },
                    description: `Which parts of the TEXT report to render: ${SECTIONS.join(', ')} ` +
                                 '(default: all). The header line and any warnings are always shown, and ' +
                                 'dropping "geometry" still leaves a one-line size/units summary, so a ' +
                                 'sampling call can be ["samples"] without losing the coordinate frame. ' +
                                 'Ignored for format: "json"'
                },
                format: {
                    type: 'string',
                    enum: ['text', 'json'],
                    description: 'Output format of the report itself (not the height encoding — that is exportHeights.format)',
                    default: 'text'
                }
            },
            required: ['terrainPath']
        };
    }

    async execute(args, projectRoot) {
        try {
            const assetIndex = AssetIndex.shared(projectRoot);

            // Accept a UUID or any path form AssetIndex knows; fall back to a
            // plain file path for terrains outside the asset index (a fixture,
            // a file whose .meta has not been generated yet)
            let filePath;
            let title;
            let uuid = null;
            const resolved = assetIndex.resolve(args.terrainPath);
            if (resolved) {
                if (resolved.entry.importer !== 'terrain') {
                    return this.error(
                        `"${args.terrainPath}" is a ${resolved.entry.importer} asset, not a terrain`
                    );
                }
                filePath = path.resolve(projectRoot, resolved.entry.path);
                title = resolved.entry.path;
                uuid = resolved.entry.uuid;
            } else {
                filePath = path.resolve(projectRoot, args.terrainPath);
                title = args.terrainPath;
            }

            if (!fs.existsSync(filePath)) {
                return this.error(
                    `Terrain not found: ${args.terrainPath}. ` +
                    (nameLikeHint(args.terrainPath)
                        ?? 'Use list_assets {type: "terrain"} to browse terrain assets.')
                );
            }

            const data = readTerrain(fs.readFileSync(filePath));
            if (!data) {
                return this.error(
                    `${args.terrainPath} is not a Cocos Creator .terrain binary ` +
                    '(unrecognized version magic in the first 4 bytes)'
                );
            }
            // Same file, second pass: readTerrainInfo() owns the card + the
            // format-level warning list and takes a path, not a buffer.
            const info = readTerrainInfo(filePath);

            const sections = parseSections(args.sections);
            const model = buildModel({ title, uuid, data, info, assetIndex, args });

            if (args.format === 'json') {
                return this.success(JSON.stringify(model, null, 2));
            }
            return this.success(renderReport(model, sections));
        } catch (err) {
            // ArgError and structural terrainBin errors alike: the message is
            // written to be actionable on its own
            return this.error(err.message);
        }
    }
}

// --- Model ------------------------------------------------------------------

/**
 * Everything the renderers need, computed once. Deterministic ordering
 * throughout: layers by palette slot, blocks row-major, samples in input order,
 * format warnings before tool warnings.
 */
function buildModel({ title, uuid, data, info, assetIndex, args }) {
    const sentinel = Boolean(info.isDefaultSentinel);
    const warnings = [...info.warnings];

    const layers = info.layers.map((layer) => {
        const usage = info.layerUsage.find((u) => u.slot === layer.slot) ?? null;
        return {
            slot: layer.slot,
            tileSize: layer.tileSize,
            roughness: layer.roughness,
            metallic: layer.metallic,
            detailMapId: layer.detailMapId || null,
            detailMapName: layer.detailMapId ? (assetIndex.label(layer.detailMapId) ?? null) : null,
            normalMapId: layer.normalMapId || null,
            normalMapName: layer.normalMapId ? (assetIndex.label(layer.normalMapId) ?? null) : null,
            blocks: usage ? usage.blocks.length : 0,
            channels: usage ? [...usage.channels] : [],
            coverage: usage ? usage.coverage : null,
            meanWeight: usage ? usage.meanWeight : null
        };
    });

    // Texture ids the index cannot resolve — the layer renders as the effect's
    // fallback in the editor, so this is a silent-invisible class of bug.
    for (const layer of layers) {
        for (const [key, id, name] of [
            ['detailMap', layer.detailMapId, layer.detailMapName],
            ['normalMap', layer.normalMapId, layer.normalMapName]
        ]) {
            if (id && name === null) {
                warnings.push(
                    `layer slot ${layer.slot}: ${key} ${id} does not resolve to an asset in this ` +
                    'project (deleted texture, wrong sub-asset id, or a missing .meta) — the layer ' +
                    'will not render'
                );
            }
        }
    }

    // Cross-file pairing: the binary carries the maps, the scene component
    // carries the switches that make the engine sample them.
    const withNormalMap = layers.filter((l) => l.normalMapId).map((l) => l.slot);
    if (withNormalMap.length) {
        warnings.push(
            `layer slot(s) ${withNormalMap.join(', ')} carry normal maps, but the scene's cc.Terrain ` +
            'component would need `_useNormalmap: true` for the engine to sample them ' +
            '(apply_edits set_component_property) — otherwise they are dead weight in the binary'
        );
    }
    const withPbr = layers
        .filter((l) => l.roughness !== 1 || l.metallic !== 0)
        .map((l) => l.slot);
    if (withPbr.length) {
        warnings.push(
            `layer slot(s) ${withPbr.join(', ')} use non-default roughness/metallic, which only ` +
            'take effect with `_usePBR: true` on the scene\'s cc.Terrain component'
        );
    }

    const blockUsage = sentinel ? [] : computeBlockUsage(data);
    const showBlocks = args.blocks === undefined
        ? blockUsage.length > 0 && blockUsage.length <= BLOCK_TABLE_AUTO_LIMIT
        : Boolean(args.blocks) && blockUsage.length > 0;

    return {
        path: title,
        uuid,
        importer: 'terrain',
        file: {
            size: info.fileSize,
            payloadLength: info.payloadLength,
            padding: info.padding
        },
        terrain: {
            version: info.version,
            versionLabel: info.versionLabel,
            isDefaultSentinel: sentinel,
            tileSize: info.tileSize,
            rawTileSize: info.rawTileSize,
            blockCount: info.blockCount,
            blockSize: TERRAIN_BLOCK_TILE_COMPLEXITY * info.tileSize,
            size: info.size,
            vertexCount: info.vertexCount,
            weightMapSize: info.weightMapSize,
            weightMapTexels: info.weightMapTexels,
            lightMapSize: info.lightMapSize,
            heightCount: info.heightCount,
            weightCount: info.weightCount,
            normalCount: info.normalCount,
            height: {
                min: info.heightMin,
                max: info.heightMax,
                mean: info.heightMean,
                minRaw: info.heightMinRaw,
                maxRaw: info.heightMaxRaw,
                flat: info.isFlat,
                quantum: TERRAIN_HEIGHT_FACTOR
            }
        },
        layers,
        blocks: showBlocks ? blockUsage.slice(0, BLOCK_TABLE_MAX_ROWS) : null,
        // `budget` is worth a line ("the table exists, it just costs too much");
        // `requested` is the caller's own argument and must stay silent.
        blocksOmitted: showBlocks || blockUsage.length === 0
            ? null
            : (args.blocks === false ? 'requested' : 'budget'),
        blockCountTotal: blockUsage.length,
        blocksTruncated: showBlocks && blockUsage.length > BLOCK_TABLE_MAX_ROWS
            ? blockUsage.length - BLOCK_TABLE_MAX_ROWS
            : 0,
        heightSamples: args.heightAt === undefined
            ? null
            : sampleHeights(data, parsePoints(args.heightAt, 'heightAt'), sentinel),
        weightSamples: args.weightAt === undefined
            ? null
            : sampleWeights(data, parsePoints(args.weightAt, 'weightAt'), layers, sentinel),
        heightGrid: args.exportHeights === undefined
            ? null
            : buildHeightGrid(data, parseExportHeights(args.exportHeights), sentinel),
        warnings
    };
}

/**
 * Per-block, per-channel weight usage. `readTerrainInfo().layerUsage`
 * aggregates the same numbers PER PALETTE SLOT across all blocks; the terrain
 * ops work per block, so the table needs the split-out form.
 *
 * Bounded by the same guard `computeLayerUsage` uses (terrainBin.js): without a
 * `layerBuffer` matching the declared geometry the `bc0 * bc1` loop would run on
 * an unbounded file-declared block count.
 */
function computeBlockUsage(data) {
    const [bc0, bc1] = data.blockCount;
    const wms = data.weightMapSize;
    const [uWC] = weightMapDims(data);
    const expected = expectedCounts(data.blockCount, wms);
    if ((data.layerBuffer?.length ?? 0) !== expected.layerBuffer) return [];
    const haveWeights = data.weights && data.weights.length === expected.weights;
    const texels = wms * wms;
    const blockSize = TERRAIN_BLOCK_TILE_COMPLEXITY * data.tileSize;

    const out = [];
    for (let by = 0; by < bc1; by++) {
        for (let bx = 0; bx < bc0; bx++) {
            const slots = blockLayers(data, bx, by);
            const channels = [];
            for (let k = 0; k < TERRAIN_MAX_BLEND_LAYERS; k++) {
                if (slots[k] < 0) {
                    channels.push({ channel: k, slot: -1, coverage: null, meanWeight: null });
                    continue;
                }
                let nonZero = 0;
                let sum = 0;
                if (haveWeights) {
                    for (let j = 0; j < wms; j++) {
                        const row = (by * wms + j) * uWC + bx * wms;
                        for (let i = 0; i < wms; i++) {
                            const w = data.weights[(row + i) * 4 + k];
                            if (w !== 0) { nonZero++; sum += w; }
                        }
                    }
                }
                channels.push({
                    channel: k,
                    slot: slots[k],
                    coverage: haveWeights ? nonZero / texels : null,
                    meanWeight: haveWeights ? sum / (255 * texels) : null
                });
            }
            out.push({
                block: [bx, by],
                index: blockIndex(bx, by, data.blockCount),
                origin: [bx * blockSize, by * blockSize],
                slots,
                channels,
                ignoresWeights: maxLayerIndex(slots) === 0
            });
        }
    }
    return out;
}

function sampleHeights(data, points, sentinel) {
    const [sw, sh] = terrainSize(data);
    return points.map(([x, z]) => {
        const height = sentinel ? null : heightAt(data, x, z);
        const inside = x >= 0 && z >= 0 && x <= sw && z <= sh;
        let reason = null;
        if (height === null) {
            reason = sentinel ? 'empty default terrain — no height data yet' : 'outside the terrain';
        } else if (!inside) {
            // getHeightAt tolerates up to one tile past the far edge and
            // extrapolates the last cell flat (terrain.ts:1884-1889)
            reason = 'past the far edge — the engine extrapolates the last tile';
        }
        return { x, z, height, inside, reason };
    });
}

function sampleWeights(data, points, layers, sentinel) {
    const bySlot = new Map(layers.map((l) => [l.slot, l]));
    return points.map(([x, z]) => {
        const w = sentinel ? null : weightAt(data, x, z);
        if (!w) {
            return {
                x,
                z,
                weights: null,
                reason: sentinel ? 'empty default terrain — no weight data yet' : 'outside the terrain'
            };
        }
        return {
            x,
            z,
            block: w.block,
            texel: w.texel,
            weights: w.weights,
            channels: w.layers.map((slot, k) => ({
                channel: k,
                slot,
                layer: slot >= 0 ? layerName(bySlot.get(slot), slot) : null,
                weight: w.weights[k]
            })),
            dominantLayer: w.dominantLayer,
            dominantLayerName: w.dominantLayer === null
                ? null
                : layerName(bySlot.get(w.dominantLayer), w.dominantLayer),
            dominantWeight: w.dominantWeight,
            blockIgnoresWeights: w.blockIgnoresWeights,
            reason: null
        };
    });
}

function layerName(layer, slot) {
    if (!layer) return `slot ${slot} (no layer record)`;
    return layer.detailMapName ?? layer.detailMapId ?? `slot ${slot} (no texture)`;
}

function buildHeightGrid(data, spec, sentinel) {
    const [sw, sh] = terrainSize(data);
    // An omitted width/depth means "from x/z to the far edge", not "the whole
    // terrain shifted by x/z" — otherwise {region: {x: 20}} would dump a strip
    // that is half outside the terrain.
    const region = {
        x: spec.region?.x ?? 0,
        z: spec.region?.z ?? 0,
        width: spec.region?.width ?? Math.max(0, sw - (spec.region?.x ?? 0)),
        depth: spec.region?.depth ?? Math.max(0, sh - (spec.region?.z ?? 0))
    };
    for (const [key, extent, axis] of [['width', region.width, sw], ['depth', region.depth, sh]]) {
        if (extent <= 0) {
            throw new ArgError(
                `exportHeights.region: ${key} defaults to the distance from ${key === 'width' ? 'x' : 'z'} ` +
                `to the far edge, which is ${extent} m here (the terrain is ${axis} m on that axis) — ` +
                `give an explicit ${key}`
            );
        }
    }

    if (sentinel) {
        return {
            region,
            samples: [0, 0],
            spacing: [null, null],
            stride: null,
            downsampled: false,
            format: spec.format,
            rows: [],
            note: 'empty default terrain — no height data to dump yet'
        };
    }

    // Default: the region's vertex grid, downsampled by one uniform integer
    // stride so neither axis exceeds GRID_DEFAULT_MAX_AXIS samples.
    let cols;
    let rowCount;
    let stride = 1;
    if (spec.sampleCount === null) {
        const fullX = Math.max(2, Math.round(region.width / data.tileSize) + 1);
        const fullZ = Math.max(2, Math.round(region.depth / data.tileSize) + 1);
        const need = Math.max(1, Math.ceil(Math.max(fullX - 1, fullZ - 1) / (GRID_DEFAULT_MAX_AXIS - 1)));
        while (stride < need) stride *= 2;
        cols = Math.max(2, Math.floor((fullX - 1) / stride) + 1);
        rowCount = Math.max(2, Math.floor((fullZ - 1) / stride) + 1);
        if (cols * rowCount > GRID_MAX_CELLS) {
            throw new ArgError(
                `exportHeights: the default resolution would be ${cols}x${rowCount} samples — ` +
                'pass a smaller region or an explicit sampleCount'
            );
        }
    } else {
        [cols, rowCount] = spec.sampleCount;
    }

    const rowsMetres = exportHeights(data, region, [cols, rowCount]);
    const rows = spec.format === 'raw16'
        ? rowsMetres.map((row) => row.map((v) => (v === null ? null : heightToRaw(v, true))))
        : rowsMetres;

    return {
        region,
        samples: [cols, rowCount],
        spacing: [
            cols > 1 ? region.width / (cols - 1) : null,
            rowCount > 1 ? region.depth / (rowCount - 1) : null
        ],
        stride,
        downsampled: spec.sampleCount === null && stride > 1,
        format: spec.format,
        rows,
        note: null
    };
}

// --- Argument parsing (what inputSchema cannot express) ---------------------

/**
 * `inspect_node` prints an asset NAME for `cc.Terrain.__asset` (`Terrain.terrain`), which
 * is not a path and not a UUID — the most likely way to arrive here empty-handed. Say so
 * instead of leaving the agent to guess.
 */
function nameLikeHint(ref) {
    const looksLikeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(@\w+)?$/i.test(ref);
    if (looksLikeUuid || ref.includes('/') || ref.includes('\\')) return null;
    return 'That looks like an asset NAME (what inspect_node prints for cc.Terrain\'s __asset), ' +
           'not a project-relative path or a UUID — run ' +
           `list_assets {type: "terrain", pattern: "${ref}"} to get the project-relative path.`;
}

/** `sections` → a Set of the report sections to render (default: all of them) */
function parseSections(raw) {
    if (raw === undefined || raw === null) return new Set(SECTIONS);
    if (!Array.isArray(raw)) {
        throw new ArgError(`sections must be an array of ${SECTIONS.join(' / ')}`);
    }
    const out = new Set();
    for (const name of raw) {
        if (!SECTIONS.includes(name)) {
            throw new ArgError(
                `sections: unknown section ${JSON.stringify(name) ?? String(name)} — ` +
                `valid sections are ${SECTIONS.join(', ')}`
            );
        }
        out.add(name);
    }
    if (out.size === 0) {
        throw new ArgError(`sections must name at least one of ${SECTIONS.join(', ')}`);
    }
    return out;
}

function parsePoints(raw, key) {
    if (!Array.isArray(raw)) {
        throw new ArgError(`${key} must be an array of [x, z] pairs in local metres`);
    }
    if (raw.length > MAX_SAMPLE_POINTS) {
        throw new ArgError(
            `${key} has ${raw.length} points, over the ${MAX_SAMPLE_POINTS}-point limit — ` +
            'use exportHeights {region, sampleCount} for a bulk dump, or split the call'
        );
    }
    return raw.map((p, i) => {
        if (!Array.isArray(p) || p.length !== 2
            || !p.every((v) => typeof v === 'number' && Number.isFinite(v))) {
            throw new ArgError(
                `${key}[${i}] must be a pair of finite numbers [x, z] in local metres, ` +
                `got ${JSON.stringify(p) ?? String(p)}`
            );
        }
        return [p[0], p[1]];
    });
}

const REGION_KEYS = ['x', 'z', 'width', 'depth'];
const EXPORT_KEYS = ['region', 'format', 'sampleCount'];

function parseExportHeights(raw) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new ArgError(
            'exportHeights must be an object — {} for the whole terrain, or ' +
            '{region: {x, z, width, depth}, format: "rows"|"raw16", sampleCount: n|[cols, rows]}'
        );
    }
    for (const key of Object.keys(raw)) {
        if (!EXPORT_KEYS.includes(key)) {
            throw new ArgError(
                `exportHeights: unknown key "${key}" — valid keys are ${EXPORT_KEYS.join(', ')}`
            );
        }
    }

    let region = null;
    if (raw.region !== undefined && raw.region !== null) {
        if (typeof raw.region !== 'object' || Array.isArray(raw.region)) {
            throw new ArgError('exportHeights.region must be an object {x, z, width, depth} in local metres');
        }
        for (const key of Object.keys(raw.region)) {
            if (!REGION_KEYS.includes(key)) {
                throw new ArgError(
                    `exportHeights.region: unknown key "${key}" — valid keys are ${REGION_KEYS.join(', ')} ` +
                    '(local metres; x/z default to 0, width/depth to the whole terrain)'
                );
            }
        }
        region = {};
        for (const key of REGION_KEYS) {
            const v = raw.region[key];
            if (v === undefined) continue;
            if (typeof v !== 'number' || !Number.isFinite(v)) {
                throw new ArgError(`exportHeights.region.${key} must be a finite number of metres, got ${JSON.stringify(v)}`);
            }
            region[key] = v;
        }
        for (const key of ['width', 'depth']) {
            if (region[key] !== undefined && region[key] <= 0) {
                throw new ArgError(`exportHeights.region.${key} must be > 0 metres, got ${region[key]}`);
            }
        }
    }

    const format = raw.format ?? 'rows';
    if (format !== 'rows' && format !== 'raw16') {
        throw new ArgError(`exportHeights.format must be "rows" or "raw16", got ${JSON.stringify(raw.format)}`);
    }

    let sampleCount = null;
    if (raw.sampleCount !== undefined && raw.sampleCount !== null) {
        const pair = Array.isArray(raw.sampleCount)
            ? raw.sampleCount
            : [raw.sampleCount, raw.sampleCount];
        if (pair.length !== 2) {
            throw new ArgError('exportHeights.sampleCount must be a number or a [cols, rows] pair');
        }
        for (const n of pair) {
            if (!Number.isInteger(n) || n < 2 || n > GRID_MAX_AXIS) {
                throw new ArgError(
                    `exportHeights.sampleCount must be an integer in 2..${GRID_MAX_AXIS} per axis, ` +
                    `got ${JSON.stringify(n)}`
                );
            }
        }
        if (pair[0] * pair[1] > GRID_MAX_CELLS) {
            throw new ArgError(
                `exportHeights.sampleCount ${pair[0]}x${pair[1]} = ${pair[0] * pair[1]} samples exceeds ` +
                `${GRID_MAX_CELLS} — dump a smaller region instead`
            );
        }
        sampleCount = [pair[0], pair[1]];
    }

    return { region, format, sampleCount };
}

// --- Rendering ---------------------------------------------------------------

/** Trim trailing zeros without scientific notation surprises; `n/a` for null */
function fmt(v, digits = 4) {
    if (v === null || v === undefined || Number.isNaN(v)) return 'n/a';
    return String(Number(v.toFixed(digits)));
}

function pct(v) {
    return v === null || v === undefined ? 'n/a' : `${(v * 100).toFixed(1)}%`;
}

/** Left-aligned fixed-width table with a `-`-underlined header */
function table(headers, rows) {
    const widths = headers.map((h, i) => Math.max(
        String(h).length,
        ...rows.map((r) => String(r[i] ?? '').length)
    ));
    const line = (cells) => cells
        .map((c, i) => String(c ?? '').padEnd(widths[i]))
        .join('  ')
        .trimEnd();
    return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)];
}

function renderReport(m, sections = new Set(SECTIONS)) {
    const t = m.terrain;
    const lines = [`# ${m.path}`, ''];
    lines.push(`UUID: ${m.uuid ?? '(not in the asset index — read directly from disk)'}`);
    lines.push(`Type: terrain (.terrain binary, format ${t.versionLabel})`);
    lines.push(`File: ${m.file.size} bytes (${m.file.payloadLength} payload + ${m.file.padding} zero padding)`);

    if (sections.has('geometry')) {
        lines.push('', '## Terrain');
        if (t.isDefaultSentinel) {
            lines.push(
                'Empty default terrain — the "Create > Terrain" sentinel: header only, no heights, ' +
                'weights or layers yet. The editor writes real buffers on the first sculpt + save; ' +
                'build_terrain can materialize it offline (pass overwrite: true).'
            );
            // The 4-byte payload two lines up stores NONE of the geometry below — every
            // number is a TerrainAsset class default. An agent that reads "32 x 32 m" and
            // starts placing props on a 32 m grid has been misled.
            lines.push(
                `The geometry numbers below are TerrainAsset class defaults — this ${m.file.payloadLength}-byte ` +
                'payload stores none of them; they only become real once the editor saves or ' +
                'build_terrain writes the buffers.'
            );
        }
        const none = t.isDefaultSentinel ? '(none stored)' : null;
        lines.push(`Size:       ${fmt(t.size[0])} x ${fmt(t.size[1])} m (X x Z) — local X in [0, ${fmt(t.size[0])}], Z in [0, ${fmt(t.size[1])}]`);
        lines.push(`Blocks:     ${t.blockCount[0]} x ${t.blockCount[1]} = ${t.blockCount[0] * t.blockCount[1]} (${TERRAIN_BLOCK_TILE_COMPLEXITY} x ${TERRAIN_BLOCK_TILE_COMPLEXITY} tiles = ${fmt(t.blockSize)} x ${fmt(t.blockSize)} m each)`);
        lines.push(`Tile size:  ${fmt(t.tileSize)} m`);
        lines.push(`Vertices:   ${t.vertexCount[0]} x ${t.vertexCount[1]} ${none ?? `(${t.heightCount} heights)`}`);
        // Endpoint-inclusive spacing: blockSize / (weightMapSize - 1), NOT / weightMapSize. This
        // is the number an agent sizes a paint region from, so it has to be the one texelPosition
        // (terrainBin.js) implements and edit_terrain's own OPS_DOC states. weightMapSize >= 2 is
        // guaranteed by validateTerrainGeometry.
        lines.push(`Weight map: ${t.weightMapSize} x ${t.weightMapSize} per block => ${t.weightMapTexels[0]} x ${t.weightMapTexels[1]} texels ${none ?? `(${t.weightCount} bytes)`}, ${fmt(t.blockSize / Math.max(1, t.weightMapSize - 1), 6)} m apart (texel 0 sits ON the block's near edge and texel ${t.weightMapSize - 1} ON its far edge, so adjacent blocks share a metre coordinate at the seam)`);
        lines.push(`Light map:  ${t.lightMapSize} (lightmaps are editor-baked; the component's _lightmapInfos stays empty until then)`);
        lines.push(`Normals:    ${t.normalCount} stored (the engine rebuilds them on load)`);
        if (t.height.min === null) {
            lines.push('Height:     no height data');
        } else {
            lines.push(
                `Height:     min ${fmt(t.height.min)} m, max ${fmt(t.height.max)} m, mean ${fmt(t.height.mean)} m` +
                `${t.height.flat ? ' (flat)' : ''} — raw ${t.height.minRaw}..${t.height.maxRaw}, quantum ${fmt(t.height.quantum, 7)} m`
            );
        }
        if (t.rawTileSize !== t.tileSize) {
            lines.push(`Note:       tileSize is stored as ${t.rawTileSize} but the loader snaps it to ${fmt(t.tileSize)}`);
        }
        lines.push('Anchoring:  geometry starts at the node origin (local X/Z above); the terrain shader applies the node worldPosition ONLY — node rotation and scale are ignored.');
    } else {
        // Never let samples land without their coordinate frame
        lines.push(
            `${fmt(t.size[0])} x ${fmt(t.size[1])} m, ${t.blockCount[0]} x ${t.blockCount[1]} blocks, ` +
            `tileSize ${fmt(t.tileSize)} m, ` +
            (t.height.min === null ? 'no height data' : `heights ${fmt(t.height.min)}..${fmt(t.height.max)} m`) +
            ' — local metres, anchored at the node origin (node rotation/scale ignored).'
        );
    }

    if (sections.has('layers')) {
        lines.push('', `## Layers (palette, ${m.layers.length})`);
        if (m.layers.length === 0) {
            lines.push(
                'No layers — every block renders the effect fallback. Rebuild with ' +
                'build_terrain {spec: {layers: [...], fillLayer: 0}}, or paint them in the editor.'
            );
        } else {
            lines.push(...table(
                ['slot', 'detailMap', 'tileSize(m)', 'normalMap', 'rough', 'metal', 'blocks', 'coverage', 'meanW'],
                m.layers.map((l) => [
                    l.slot,
                    l.detailMapName ?? l.detailMapId ?? '(none)',
                    fmt(l.tileSize),
                    l.normalMapName ?? l.normalMapId ?? '-',
                    fmt(l.roughness),
                    fmt(l.metallic),
                    l.blocks,
                    pct(l.coverage),
                    l.meanWeight === null ? 'n/a' : fmt(l.meanWeight, 3)
                ])
            ));
            lines.push('tileSize is metres per texture repeat; coverage = share of the layer\'s weight texels that are non-zero; meanW = mean weight 0..1 over them.');
        }
    }

    if (sections.has('blocks') && m.blocks) {
        lines.push('', `## Blocks (${m.blocks.length}${m.blocksTruncated ? ` of ${m.blockCountTotal}` : ''})`);
        lines.push(...table(
            ['block', 'origin (m)', ...CHANNELS.map((c) => `${c} slot/coverage`)],
            m.blocks.map((b) => [
                `[${b.block[0]},${b.block[1]}]`,
                `${fmt(b.origin[0])},${fmt(b.origin[1])}`,
                ...b.channels.map((c) => (c.slot < 0 ? '-' : `${c.slot} / ${pct(c.coverage)}`))
            ])
        ));
        const ignoring = m.blocks.filter((b) => b.ignoresWeights && b.slots[0] >= 0);
        if (ignoring.length) {
            lines.push(
                `${ignoring.length} block(s) use only channel R — the shader draws that layer flat ` +
                'and never samples the weight map there.'
            );
        }
        if (m.blocksTruncated) {
            lines.push(`… ${m.blocksTruncated} more block(s) not shown.`);
        }
    } else if (sections.has('blocks') && m.blocksOmitted === 'budget') {
        lines.push('', `## Blocks (${m.blockCountTotal})`);
        lines.push(`Table omitted for ${m.blockCountTotal} blocks — pass blocks: true to print it.`);
    }

    if (sections.has('samples') && m.heightSamples) {
        lines.push('', `## Sampled heights (${m.heightSamples.length})`);
        lines.push('Local ground Y in metres; add the terrain node\'s world position to compare with a world-space bounds min.y.');
        lines.push(...table(
            ['x (m)', 'z (m)', 'height (m)', 'note'],
            m.heightSamples.map((s) => [
                fmt(s.x), fmt(s.z),
                s.height === null ? '-' : fmt(s.height),
                s.reason ?? ''
            ])
        ));
    }

    if (sections.has('samples') && m.weightSamples) {
        lines.push('', `## Sampled weights (${m.weightSamples.length})`);
        for (const s of m.weightSamples) {
            if (!s.weights) {
                lines.push(`- (${fmt(s.x)}, ${fmt(s.z)}): ${s.reason}`);
                continue;
            }
            const chans = s.channels
                .map((c) => (c.slot < 0
                    ? `${CHANNELS[c.channel]} -`
                    : `${CHANNELS[c.channel]} w=${fmt(c.weight, 3)} slot ${c.slot} ${c.layer}`))
                .join(' | ');
            lines.push(
                `- (${fmt(s.x)}, ${fmt(s.z)}) block [${s.block[0]},${s.block[1]}] texel [${s.texel[0]},${s.texel[1]}]  ${chans}`
            );
            lines.push(
                `  dominant: ${s.dominantLayer === null
                    ? 'none (block has no layer assigned)'
                    : `slot ${s.dominantLayer} ${s.dominantLayerName} (${fmt(s.dominantWeight, 3)})`}` +
                `${s.blockIgnoresWeights ? ' — block uses channel R only, so the shader ignores the weight map here' : ''}`
            );
        }
    }

    if (sections.has('samples') && m.heightGrid) {
        const g = m.heightGrid;
        lines.push('', '## Height grid');
        lines.push(`Region: x ${fmt(g.region.x)}..${fmt(g.region.x + g.region.width)} m, z ${fmt(g.region.z)}..${fmt(g.region.z + g.region.depth)} m`);
        if (g.note) {
            lines.push(g.note);
        } else {
            lines.push(
                `Samples: ${g.samples[0]} x ${g.samples[1]} (cols x rows), spacing ` +
                `${fmt(g.spacing[0], 6)} x ${fmt(g.spacing[1], 6)} m` +
                (g.downsampled
                    ? ` — downsampled 1:${g.stride} from the vertex grid to stay at or below ${GRID_DEFAULT_MAX_AXIS} samples per axis; pass a region or sampleCount for full resolution`
                    : '')
            );
            lines.push(
                g.format === 'raw16'
                    ? 'Values: raw u16 as stored — metres = (raw - 32768) / 128.'
                    : 'Values: metres, 3 decimals (the height quantum is 0.0078125 m).'
            );
            lines.push('Row i is at z = region.z + i * spacingZ, column k at x = region.x + k * spacingX; row 0 is nearest the node origin.');
            const width = String(g.samples[1] - 1).length;
            g.rows.forEach((row, j) => {
                const cells = row.map((v) => (v === null
                    ? 'null'
                    : (g.format === 'raw16' ? String(v) : v.toFixed(3))));
                lines.push(`${String(j).padStart(width)} | ${cells.join(' ')}`);
            });
        }
    }

    if (m.warnings.length) {
        lines.push('', `## Warnings (${m.warnings.length})`);
        for (const w of m.warnings) lines.push(`- ${w}`);
    }

    if (sections.has('notes')) {
        lines.push('', '## Notes');
        lines.push('- Heights/weights/layers live only in this binary; the library `.json` mirrors just the layer table and is regenerated by the editor on re-import.');
        lines.push('- Never edit a `.terrain` while its Terrain panel is open in the editor — an editor save overwrites the whole file from memory.');
    }

    return lines.join('\n');
}
