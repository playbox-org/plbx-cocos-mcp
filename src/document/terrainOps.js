/**
 * terrainOps — semantic edit operations over a `.terrain` binary
 *
 * The write-side counterpart of `src/document/operations.js` for terrain assets: a batch of
 * named operations is applied to the IN-MEMORY data struct that `terrainBin.readTerrain`
 * produced, all-or-nothing, and the caller (`EditTerrain`) validates and writes once at the
 * end. Nothing here touches the filesystem, and nothing here knows the binary layout — all
 * format knowledge lives in `src/utils/terrainBin.js`, all heightmap decoding in
 * `src/utils/heightmap.js`, and layer-texture resolution is shared with `TerrainBuilder`.
 *
 * Coordinates are LOCAL METRES: `x` along the width, `z` along the depth, heights are Y in
 * metres. A terrain is anchored at its node's origin (local X in `[0, width]`, Z in
 * `[0, depth]`) and the terrain shader applies only the node's world POSITION — node rotation
 * and scale are ignored. Heights quantize to 1/128 m and clamp to [-256, 255.9921875] m.
 *
 * Two conventions this module imposes that the ENGINE does not:
 *
 * 1. **Weight channels of a texel sum to 255.** The shader is a plain weighted sum with no
 *    normalization (legacy `terrain.effect:158-172`), so a texel summing to less than 255
 *    just renders darker. `paint_layer`/`remove_layer` therefore rescale the other channels
 *    proportionally, and channels with no layer assigned (`layerBuffer` slot `-1`) are held
 *    at 0 — their weight is meaningless and would only corrupt the sum.
 * 2. **Block slots stay left-packed.** `TerrainBlock.getMaxLayer` (terrain.ts:857-869) derives
 *    the sampled layer count from the HIGHEST non-empty channel, so a `-1` hole below it is
 *    sampled as a null layer and renders as nothing.
 *
 * `set_info` is an exact port of `Terrain.rebuild` (terrain.ts:1569-1610 plus
 * `_rebuildHeights`/`_rebuildLayerBuffer`/`_rebuildWeights` at :2541-2703), including the
 * engine's own early-outs and its diagonal-split weight resampler — see `setInfo` below.
 */

import {
    materialize,
    validateTerrainCapacity,
    expectedCounts,
    heightToRaw,
    rawToHeight,
    vertexCounts,
    terrainSize,
    blockIndex,
    blockLayers,
    setBlockLayers,
    maxLayerIndex,
    removeLayer,
    compactPalette,
    weightTexelIndex,
    texelPosition,
    versionName,
    TERRAIN_HEIGHT_BASE,
    TERRAIN_HEIGHT_FMIN,
    TERRAIN_HEIGHT_FMAX,
    TERRAIN_HEIGHT_FACTOR,
    TERRAIN_MAX_BLEND_LAYERS,
    TERRAIN_MAX_LAYER_COUNT,
    TERRAIN_BLOCK_TILE_COMPLEXITY,
    TERRAIN_DATA_VERSION8,
    TERRAIN_DATA_VERSION_DEFAULT,
} from '../utils/terrainBin.js';
import {
    resolveTextureRef,
    checkTileSize,
    checkWeightMapSize,
    checkLightMapSize,
    TerrainBuildError,
} from './TerrainBuilder.js';
import { buildHeightGrid, HeightmapError } from '../utils/heightmap.js';

/** Thrown by every op; `EditTerrain` turns it into "… Nothing was written." */
export class TerrainOpError extends Error {
    name = 'TerrainOpError';
}

/** Region shapes `paint_layer` understands */
const REGION_SHAPES = ['rect', 'ellipse'];

/** Base keys of a `region` argument (local metres) */
const REGION_KEYS = ['x', 'z', 'width', 'depth'];

/**
 * Accepted keys per op. Unknown keys are REJECTED with the supported list: a silently
 * ignored `radius`/`strength`/`blockCount` is the difference between "the edit did nothing"
 * and a self-correcting error.
 */
const OP_KEYS = {
    set_info: ['tileSize', 'blockCount', 'weightMapSize', 'lightMapSize'],
    set_layer: ['slot', 'detailMap', 'normalMap', 'tileSize', 'roughness', 'metallic'],
    remove_layer: ['slot'],
    set_heights: ['region', 'value', 'rows', 'heightmap'],
    adjust_heights: ['region', 'delta'],
    smooth_heights: ['region', 'iterations'],
    paint_layer: ['layer', 'region', 'weight', 'falloff'],
    set_block_layers: ['block', 'layers'],
};

/** Iteration cap for `smooth_heights` — each pass is a full grid copy */
const MAX_SMOOTH_ITERATIONS = 64;

/**
 * Tolerance for "a vertex/texel sits exactly on the region border". Region bounds come from
 * an LLM as round metre values while vertex positions are `i * tileSize` products, so an
 * exact `<=` would drop the far edge of `{x: 0, width: 10}` on a `tileSize: 0.1` terrain.
 */
const EPS = 1e-6;

// --- small helpers ----------------------------------------------------------

function show(v) {
    if (typeof v === 'number') return String(v);
    return JSON.stringify(v) ?? String(v);
}

/** Compact metre formatting: no trailing zeros */
function fmt(v, digits = 3) {
    if (v === null || v === undefined || Number.isNaN(v)) return 'n/a';
    return String(Number(v.toFixed(digits)));
}

function plural(n, word, many = `${word}s`) {
    return `${n} ${n === 1 ? word : many}`;
}

function requireFinite(op, field) {
    const v = op[field];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new TerrainOpError(`"${field}" (a finite number) is required, got ${show(v)}`);
    }
    return v;
}

function requireNumberIn(op, field, min, max, unit = '') {
    const v = requireFinite(op, field);
    if (v < min || v > max) {
        throw new TerrainOpError(`"${field}" must be in ${min}..${max}${unit}, got ${show(v)}`);
    }
    return v;
}

function requireIntIn(op, field, min, max, tail = '') {
    const v = op[field];
    if (!Number.isInteger(v) || v < min || v > max) {
        throw new TerrainOpError(
            `"${field}" must be an integer in ${min}..${max}, got ${show(v)}${tail}`
        );
    }
    return v;
}

/** Run a `TerrainBuilder` helper and re-badge its error as an op error */
function shared(fn) {
    try {
        return fn();
    } catch (err) {
        if (err instanceof TerrainBuildError) throw new TerrainOpError(err.message);
        throw err;
    }
}

function checkHeightRange(metres, what) {
    if (metres < TERRAIN_HEIGHT_FMIN || metres > TERRAIN_HEIGHT_FMAX) {
        throw new TerrainOpError(
            `${what} = ${metres} m is outside the representable height range ` +
            `[${TERRAIN_HEIGHT_FMIN}, ${TERRAIN_HEIGHT_FMAX}] m`
        );
    }
}

function validateOpKeys(op) {
    const allowed = OP_KEYS[op.op];
    for (const key of Object.keys(op)) {
        if (key === 'op' || allowed.includes(key)) continue;
        throw new TerrainOpError(
            `unknown key "${key}" — ${op.op} takes ${allowed.join(', ')}`
            // shape/falloff are the two keys an agent reaches for on a height op after
            // seeing them on paint_layer. Naming the workaround is the difference between
            // a retry that works and a flat-topped mesa.
            + (key === 'falloff' || key === 'shape'
                ? '. shape/falloff exist only on paint_layer; height ops always cover the whole '
                  + 'rectangle uniformly. For a rounded hill either give set_heights a "rows" grid '
                  + '(it is resampled onto the region\'s vertex grid, so a 5x5 bump is enough), or '
                  + 'run adjust_heights and then smooth_heights over a region 2-3 tiles larger'
                : '')
        );
    }
}

// --- regions ----------------------------------------------------------------

/**
 * Parse a `region` argument into local metres, defaulting to the whole terrain.
 *
 * An omitted `width`/`depth` means "from `x`/`z` to the far edge" (the same rule
 * `query_terrain`'s `exportHeights` uses), never "the whole terrain shifted by x/z".
 *
 * @param {object} op
 * @param {object} data - Terrain data object
 * @param {{shape?: boolean}} [options] - Accept a `shape` key (paint_layer)
 * @returns {{x: number, z: number, width: number, depth: number, shape: string, whole: boolean}}
 */
function parseRegion(op, data, { shape = false } = {}) {
    const [sw, sh] = terrainSize(data);
    const raw = op.region;
    if (raw === undefined || raw === null) {
        return { x: 0, z: 0, width: sw, depth: sh, shape: 'rect', whole: true };
    }
    const keys = shape ? [...REGION_KEYS, 'shape'] : REGION_KEYS;
    if (typeof raw !== 'object' || Array.isArray(raw)) {
        throw new TerrainOpError(
            `region must be an object {${keys.join(', ')}} in local metres, got ${show(raw)}`
        );
    }
    for (const key of Object.keys(raw)) {
        if (!keys.includes(key)) {
            throw new TerrainOpError(
                `region: unknown key "${key}" — valid keys are ${keys.join(', ')} ` +
                '(local metres; x/z default to 0, width/depth to the far edge)'
                + (key === 'shape'
                    ? '. shape is only accepted by paint_layer; height ops always cover the '
                      + 'rectangle. For a rounded hill pass set_heights a "rows" grid, or follow '
                      + 'adjust_heights with smooth_heights over a slightly larger region'
                    : '')
            );
        }
    }
    const r = { x: 0, z: 0, shape: 'rect' };
    for (const key of ['x', 'z']) {
        if (raw[key] === undefined) continue;
        if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key])) {
            throw new TerrainOpError(`region.${key} must be a finite number of metres, got ${show(raw[key])}`);
        }
        r[key] = raw[key];
    }
    r.width = raw.width ?? Math.max(0, sw - r.x);
    r.depth = raw.depth ?? Math.max(0, sh - r.z);
    for (const key of ['width', 'depth']) {
        if (typeof r[key] !== 'number' || !Number.isFinite(r[key]) || r[key] <= 0) {
            throw new TerrainOpError(
                `region.${key} must be a number > 0 metres, got ${show(r[key])}` +
                (raw[key] === undefined
                    ? ` (it defaults to the distance from ${key === 'width' ? 'x' : 'z'} to the far ` +
                      `edge, and the terrain is ${fmt(key === 'width' ? sw : sh)} m on that axis)`
                    : '')
            );
        }
    }
    if (shape && raw.shape !== undefined) {
        if (!REGION_SHAPES.includes(raw.shape)) {
            throw new TerrainOpError(
                `region.shape must be ${REGION_SHAPES.map((s) => `"${s}"`).join(' or ')}, got ${show(raw.shape)}`
            );
        }
        r.shape = raw.shape;
    }
    if (r.x >= sw || r.z >= sh || r.x + r.width <= 0 || r.z + r.depth <= 0) {
        throw new TerrainOpError(
            `region x ${fmt(r.x)}..${fmt(r.x + r.width)} m, z ${fmt(r.z)}..${fmt(r.z + r.depth)} m ` +
            `does not overlap the terrain (x 0..${fmt(sw)} m, z 0..${fmt(sh)} m — local metres, ` +
            'the terrain starts at its node origin)'
        );
    }
    r.whole = false;
    return r;
}

/**
 * Vertex index range covered by a region: every vertex whose position `i * tileSize` lies
 * inside `[x, x + width]` (border inclusive, {@link EPS} tolerance), clamped to the grid.
 * @param {object} data
 * @param {object} r - Parsed region
 * @returns {{i0: number, i1: number, j0: number, j1: number, cols: number, rows: number, count: number}}
 */
function vertexRange(data, r) {
    const [vx, vz] = vertexCounts(data.blockCount);
    const ts = data.tileSize;
    const i0 = Math.max(0, Math.ceil(r.x / ts - EPS));
    const i1 = Math.min(vx - 1, Math.floor((r.x + r.width) / ts + EPS));
    const j0 = Math.max(0, Math.ceil(r.z / ts - EPS));
    const j1 = Math.min(vz - 1, Math.floor((r.z + r.depth) / ts + EPS));
    if (i1 < i0 || j1 < j0) {
        throw new TerrainOpError(
            `region x ${fmt(r.x)}..${fmt(r.x + r.width)} m, z ${fmt(r.z)}..${fmt(r.z + r.depth)} m ` +
            `contains no height vertex — vertices sit every ${fmt(ts)} m (tileSize), so a region ` +
            'must reach at least one of them'
        );
    }
    return { i0, i1, j0, j1, cols: i1 - i0 + 1, rows: j1 - j0 + 1, count: (i1 - i0 + 1) * (j1 - j0 + 1) };
}

/** `vertices 4..12 x 4..12` — which grid cells a region actually snapped to */
function describeVertices(range) {
    return `vertices ${range.i0}..${range.i1} x ${range.j0}..${range.j1}`;
}

/** `the whole terrain (32 x 32 m)` / `x 4..12 m, z 0..8 m (ellipse)` */
function describeRegion(data, r) {
    if (r.whole) {
        const [sw, sh] = terrainSize(data);
        return `the whole terrain (${fmt(sw)} x ${fmt(sh)} m)`;
    }
    const shape = r.shape === 'rect' ? '' : ` (${r.shape})`;
    return `x ${fmt(r.x)}..${fmt(r.x + r.width)} m, z ${fmt(r.z)}..${fmt(r.z + r.depth)} m${shape}`;
}

// --- weight helpers ---------------------------------------------------------

/**
 * Split `total` (an integer) over `values` (non-negative floats summing to `total`) with
 * largest-remainder rounding, so the integers sum to EXACTLY `total`. Truncating each channel
 * independently would leak up to 3 units per texel and break the sum-255 convention.
 * @param {number[]} values
 * @param {number} total
 * @returns {number[]} integers summing to `total`
 */
function distribute(values, total) {
    if (values.length === 0) return [];
    const out = values.map((v) => Math.floor(v));
    let left = total - out.reduce((a, b) => a + b, 0);
    const order = values
        .map((v, i) => [v - Math.floor(v), i])
        .sort((a, b) => b[0] - a[0] || a[1] - b[1]);
    for (let n = 0; left > 0 && n < order.length; n++, left--) out[order[n][1]]++;
    // Defensive: floating point can leave a unit over when every remainder is 0
    if (left > 0) out[0] += left;
    return out;
}

/**
 * Rescale the four channels of one texel so the channels WITH a layer sum to exactly 255,
 * keeping their relative proportions. Channels without a layer are zeroed.
 *
 * A texel whose assigned channels are ALL 0 has no ratio to preserve and no coverage at all —
 * it would render as nothing (the shader is a plain weighted sum). It falls back to the
 * block's first layer at full weight, which is exactly what a freshly created block looks
 * like `(255, 0, 0, 0)`; the caller counts those and reports them.
 * @param {object} data
 * @param {number} base - `weightTexelIndex(data, i, j)`
 * @param {number[]} slots - The block's four palette slots
 * @returns {{changed: boolean, filled: boolean}} `filled` = the no-coverage fallback was used
 */
function renormalizeTexel(data, base, slots) {
    const w = data.weights;
    const assigned = [];
    let sum = 0;
    let changed = false;
    for (let k = 0; k < TERRAIN_MAX_BLEND_LAYERS; k++) {
        if (slots[k] < 0) {
            if (w[base + k] !== 0) { w[base + k] = 0; changed = true; }
            continue;
        }
        assigned.push(k);
        sum += w[base + k];
    }
    if (assigned.length === 0) return { changed, filled: false };
    if (sum === 0) {
        w[base + assigned[0]] = 255;
        return { changed: true, filled: true };
    }
    if (sum === 255) return { changed, filled: false };
    const scaled = distribute(assigned.map((k) => (w[base + k] * 255) / sum), 255);
    assigned.forEach((k, idx) => {
        if (w[base + k] !== scaled[idx]) { w[base + k] = scaled[idx]; changed = true; }
    });
    return { changed, filled: false };
}

/**
 * Set channel `k` of one texel to `value` (0..255) and give the remaining `255 - value` to the
 * block's other assigned channels, in proportion to what they hold. Two edge cases, both
 * reported by `paint_layer`:
 * - the other assigned channels are all 0 → the remainder is split EQUALLY between them (the
 *   texel had no coverage at all; any split is invented, an equal one at least keeps the sum);
 * - there is no other assigned channel → the requested weight is IGNORED and the channel gets
 *   the full 255. Storing `value` there would look more honest but is a trap: the weight is
 *   provably unobservable while the block assigns one layer (`maxLayerIndex === 0` makes the
 *   shader draw `detailMap0` and never sample the weight map, terrain.ts:879/920-930), and the
 *   moment a LATER op assigns a second layer to that block the map starts being sampled and
 *   every such texel renders at `value/255` brightness — 0 means literally black. 255 is the
 *   only value that stays correct after a second layer arrives, so it is what we store.
 * @param {object} data
 * @param {number} base - `weightTexelIndex(data, i, j)`
 * @param {number[]} slots - The block's four palette slots
 * @param {number} k - Target channel
 * @param {number} value - 0..255
 * @returns {{ignored: boolean, split: boolean}} which edge case was hit
 */
function paintTexel(data, base, slots, k, value) {
    const w = data.weights;
    const others = [];
    let sum = 0;
    for (let c = 0; c < TERRAIN_MAX_BLEND_LAYERS; c++) {
        if (c === k) continue;
        if (slots[c] < 0) { w[base + c] = 0; continue; }
        others.push(c);
        sum += w[base + c];
    }
    if (others.length === 0) {
        w[base + k] = 255;
        return { ignored: value !== 255, split: false };
    }
    w[base + k] = value;
    const remain = 255 - value;
    const shares = sum === 0
        ? others.map(() => remain / others.length)
        : others.map((c) => (w[base + c] * remain) / sum);
    const ints = distribute(shares, remain);
    others.forEach((c, idx) => { w[base + c] = ints[idx]; });
    return { ignored: false, split: sum === 0 && remain > 0 };
}

/** Block coordinates of a block index (`blockIndex`'s inverse) */
function blockCoords(b, bc) {
    return [b % bc[0], Math.floor(b / bc[0])];
}

/** Renormalize every texel of one block; returns how many changed / fell back to slot 0 */
function renormalizeBlock(data, bx, by) {
    const wms = data.weightMapSize;
    const slots = blockLayers(data, bx, by);
    let changed = 0;
    let filled = 0;
    for (let j = 0; j < wms; j++) {
        for (let i = 0; i < wms; i++) {
            const res = renormalizeTexel(data, weightTexelIndex(data, bx * wms + i, by * wms + j), slots);
            if (res.changed) changed++;
            if (res.filled) filled++;
        }
    }
    return { changed, filled, first: slots.find((v) => v >= 0) ?? -1 };
}

// --- set_info ---------------------------------------------------------------

/**
 * `_rebuildHeights` (terrain.ts:2541-2566): a fresh grid filled with `TERRAIN_HEIGHT_BASE`
 * (0 m), the overlapping rect copied in, anchored at the origin corner. Early-out when the
 * vertex counts are unchanged, so a pure `tileSize` edit keeps every height.
 */
function rebuildHeights(data, info) {
    const [oldVX, oldVZ] = vertexCounts(data.blockCount);
    const [newVX, newVZ] = vertexCounts(info.blockCount);
    if (oldVX === newVX && oldVZ === newVZ) return { changed: false };
    const heights = new Uint16Array(newVX * newVZ).fill(TERRAIN_HEIGHT_BASE);
    const w = Math.min(oldVX, newVX);
    const h = Math.min(oldVZ, newVZ);
    for (let j = 0; j < h; j++) {
        for (let i = 0; i < w; i++) heights[j * newVX + i] = data.heights[j * oldVX + i];
    }
    data.heights = heights;
    return { changed: true, kept: w * h, fresh: newVX * newVZ - w * h, keptGrid: [w, h] };
}

/** `_rebuildLayerBuffer` (terrain.ts:2568-2595): new blocks get four `-1` slots */
function rebuildLayerBuffer(data, info) {
    const [oldBC0, oldBC1] = data.blockCount;
    const [newBC0, newBC1] = info.blockCount;
    if (oldBC0 === newBC0 && oldBC1 === newBC1) return { changed: false };
    const layerBuffer = new Int16Array(newBC0 * newBC1 * TERRAIN_MAX_BLEND_LAYERS).fill(-1);
    const w = Math.min(oldBC0, newBC0);
    const h = Math.min(oldBC1, newBC1);
    for (let j = 0; j < h; j++) {
        for (let i = 0; i < w; i++) {
            for (let l = 0; l < TERRAIN_MAX_BLEND_LAYERS; l++) {
                layerBuffer[(j * newBC0 + i) * TERRAIN_MAX_BLEND_LAYERS + l]
                    = data.layerBuffer[(j * oldBC0 + i) * TERRAIN_MAX_BLEND_LAYERS + l];
            }
        }
    }
    data.layerBuffer = layerBuffer;
    return { changed: true, kept: w * h, fresh: newBC0 * newBC1 - w * h };
}

/**
 * `_rebuildWeights` (terrain.ts:2597-2703) — the tricky one, ported exactly:
 *
 * - Early-out on the TOTAL texel dimensions, not on `weightMapSize`: `blockCount [2,2]` at
 *   `weightMapSize 64` → `[1,1]` at `128` is 128x128 texels either way, so the engine returns
 *   without re-mapping anything and the old bytes stay where they are. Reproduced (and
 *   reported), because the file the editor would produce is the one we must produce.
 * - The new buffer is pre-filled `(255, 0, 0, 0)`, so blocks outside the overlap are "layer
 *   slot 0 at full strength".
 * - Per overlapping BLOCK: a straight copy when `weightMapSize` is unchanged, otherwise
 *   `sampleOldWeight` — the same diagonal-split kernel as `getHeightAt` (`m = (b+c)/2`, the far
 *   corner extrapolated), NOT plain bilinear. Its `ix1`/`iz1` clamp is `min(ix0+1, oldWms-1)`,
 *   i.e. BLOCK-LOCAL, and the block's texel origin is added AFTER the clamp, so a sample never
 *   crosses a block seam.
 * - Channel stores go through a `Uint8Array`, which truncates toward zero. No clamping is
 *   needed and none is added: despite looking like an extrapolation, the kernel is a CONVEX
 *   COMBINATION of the corner values in both branches, so a channel can never leave [0, 255].
 *   Substituting `d = 2m - a` (`dx + dz <= 1`) collapses the double lerp to
 *   `a(1 - dx - dz) + b·dx + c·dz`, and `a = 2m - d` (`dx + dz > 1`) to
 *   `b(1 - dz) + c(1 - dx) + d(dx + dz - 1)` — both sets of coefficients sum to 1 and are
 *   non-negative on their branch's domain. The `Uint8Array` store still means we would wrap
 *   exactly as the engine does if that ever stopped holding.
 */
function rebuildWeights(data, info) {
    const oldWms = data.weightMapSize;
    const newWms = info.weightMapSize;
    const oldU = oldWms * data.blockCount[0];
    const oldV = oldWms * data.blockCount[1];
    const newU = newWms * info.blockCount[0];
    const newV = newWms * info.blockCount[1];
    if (newU === oldU && newV === oldV) return { changed: false, texels: [newU, newV] };

    const old = data.weights;
    const weights = new Uint8Array(newU * newV * 4);
    for (let i = 0; i < newU * newV; i++) weights[i * 4] = 255;

    const w = Math.min(info.blockCount[0], data.blockCount[0]);
    const h = Math.min(info.blockCount[1], data.blockCount[1]);

    const getOld = (i, j) => {
        const index = (j * oldU + i) * 4;
        return [old[index] / 255, old[index + 1] / 255, old[index + 2] / 255, old[index + 3] / 255];
    };
    const sampleOld = (x, y, xOff, yOff) => {
        const ix0 = Math.floor(x);
        const iz0 = Math.floor(y);
        const ix1 = Math.min(ix0 + 1, oldWms - 1);
        const iz1 = Math.min(iz0 + 1, oldWms - 1);
        const dx = x - ix0;
        const dz = y - iz0;
        let a = getOld(ix0 + xOff, iz0 + yOff);
        const b = getOld(ix1 + xOff, iz0 + yOff);
        const c = getOld(ix0 + xOff, iz1 + yOff);
        let d = getOld(ix1 + xOff, iz1 + yOff);
        const m = b.map((v, k) => (v + c[k]) * 0.5);
        if (dx + dz <= 1.0) d = m.map((v, k) => v + (v - a[k]));
        else a = m.map((v, k) => v + (v - d[k]));
        return a.map((av, k) => {
            const n1 = av + (b[k] - av) * dx;
            const n2 = c[k] + (d[k] - c[k]) * dx;
            return n1 + (n2 - n1) * dz;
        });
    };

    for (let j = 0; j < h; j++) {
        for (let i = 0; i < w; i++) {
            const uOff = i * oldWms;
            const vOff = j * oldWms;
            for (let v = 0; v < newWms; v++) {
                for (let u = 0; u < newWms; u++) {
                    const wv = newWms === oldWms
                        ? getOld(u + uOff, v + vOff)
                        : sampleOld((u / (newWms - 1)) * (oldWms - 1), (v / (newWms - 1)) * (oldWms - 1), uOff, vOff);
                    const index = ((j * newWms + v) * newU + (i * newWms + u)) * 4;
                    for (let k = 0; k < 4; k++) weights[index + k] = wv[k] * 255;
                }
            }
        }
    }
    data.weights = weights;
    return {
        changed: true,
        resampled: newWms !== oldWms,
        blocks: w * h,
        fresh: info.blockCount[0] * info.blockCount[1] - w * h,
        texels: [newU, newV],
    };
}

function parseBlockCount(value) {
    if (!Array.isArray(value) || value.length !== 2) {
        throw new TerrainOpError(
            `blockCount must be an array of two integers [x, z], got ${show(value)} ` +
            `(each block is ${TERRAIN_BLOCK_TILE_COMPLEXITY}x${TERRAIN_BLOCK_TILE_COMPLEXITY} tiles)`
        );
    }
    value.forEach((v, i) => {
        if (!Number.isInteger(v) || v < 1) {
            throw new TerrainOpError(`blockCount[${i}] = ${show(v)} must be an integer >= 1`);
        }
    });
    return [value[0], value[1]];
}

/**
 * `set_info` — overlap-preserving resize, an exact port of `Terrain.rebuild`.
 * @returns {{op: string, summary: string, notes: string[], blockCountChanged: boolean}}
 */
function setInfo(data, op) {
    const notes = [];
    const given = OP_KEYS.set_info.filter((k) => op[k] !== undefined);
    if (given.length === 0) {
        throw new TerrainOpError(
            `set_info needs at least one of ${OP_KEYS.set_info.join(', ')} — ` +
            'the omitted ones keep their current value'
        );
    }
    const info = {
        tileSize: op.tileSize === undefined
            ? data.tileSize
            : shared(() => checkTileSize(op.tileSize, 'tileSize', notes)),
        blockCount: op.blockCount === undefined ? [...data.blockCount] : parseBlockCount(op.blockCount),
        // The weight/light map guards are AUTHORING conventions (the editor panel's four
        // sizes), so they only apply to a value this op actually introduces. Restating the
        // file's own size — as an LLM does when it passes the whole info block back — must
        // never fail, or a terrain already outside the guard could not be edited at all.
        weightMapSize: op.weightMapSize === undefined || op.weightMapSize === data.weightMapSize
            ? data.weightMapSize
            : shared(() => checkWeightMapSize(op.weightMapSize, 'weightMapSize')),
        lightMapSize: op.lightMapSize === undefined || op.lightMapSize === data.lightMapSize
            ? data.lightMapSize
            : shared(() => checkLightMapSize(op.lightMapSize, 'lightMapSize')),
    };
    // The buffers below are sized from these numbers, so refuse an absurd pair BEFORE
    // allocating anything (a 64x64-block terrain at weightMapSize 512 is 4 GB of weights).
    try {
        validateTerrainCapacity(info);
    } catch (err) {
        throw new TerrainOpError(err.message);
    }

    const from = {
        tileSize: data.tileSize,
        blockCount: [...data.blockCount],
        weightMapSize: data.weightMapSize,
        lightMapSize: data.lightMapSize,
    };
    const changedFields = given.filter((k) => (k === 'blockCount'
        ? info.blockCount[0] !== from.blockCount[0] || info.blockCount[1] !== from.blockCount[1]
        : info[k] !== from[k]));
    if (changedFields.length === 0) {
        return {
            op: 'set_info',
            summary: `Geometry already was blockCount [${from.blockCount}], tileSize ${fmt(from.tileSize)} m, ` +
                `weightMapSize ${from.weightMapSize}, lightMapSize ${from.lightMapSize} — nothing changed`,
            notes,
            blockCountChanged: false,
        };
    }

    // Engine order (terrain.ts:1579-1585): every _rebuildX reads the OLD this._* fields,
    // which are only updated afterwards.
    const lb = rebuildLayerBuffer(data, info);
    const hs = rebuildHeights(data, info);
    const wt = rebuildWeights(data, info);

    data.tileSize = info.tileSize;
    // The file stores an unsnapped tileSize; after an EXPLICIT change the only trustworthy stored
    // value is the snapped one we just validated. A resize that never mentioned tileSize must
    // leave the stored value alone, or a `set_info {blockCount}` would silently rewrite a file's
    // 0.295 as 0.29 — the very fidelity `consistentRawTileSize` exists to keep.
    if (changedFields.includes('tileSize')) data.rawTileSize = info.tileSize;
    data.blockCount = [...info.blockCount];
    data.weightMapSize = info.weightMapSize;
    data.lightMapSize = info.lightMapSize;

    const [sw, sh] = terrainSize(data);
    const [oldW, oldH] = terrainSize({ blockCount: from.blockCount, tileSize: from.tileSize });
    const parts = [];
    if (changedFields.includes('blockCount')) {
        parts.push(`blocks [${from.blockCount}] -> [${info.blockCount}]`);
    }
    if (changedFields.includes('tileSize')) {
        parts.push(`tileSize ${fmt(from.tileSize)} -> ${fmt(info.tileSize)} m`);
    }
    if (changedFields.includes('weightMapSize')) {
        parts.push(`weightMapSize ${from.weightMapSize} -> ${info.weightMapSize}`);
    }
    if (changedFields.includes('lightMapSize')) {
        parts.push(`lightMapSize ${from.lightMapSize} -> ${info.lightMapSize}`);
    }
    const detail = [];
    detail.push(hs.changed
        ? `heights: kept the overlapping ${hs.keptGrid[0]}x${hs.keptGrid[1]} vertices, ` +
          `${plural(hs.fresh, 'new vertex', 'new vertices')} set to 0 m`
        : 'heights: unchanged (the vertex grid is the same size)');
    detail.push(lb.changed
        ? `layerBuffer: kept ${plural(lb.kept, 'overlapping block')}, ${plural(lb.fresh, 'new block')} left unassigned (-1)`
        : 'layerBuffer: unchanged');
    if (!wt.changed) {
        detail.push(
            `weights: NOT re-mapped — the total weight map is ${wt.texels[0]}x${wt.texels[1]} texels ` +
            'either way, and the engine early-outs on that (terrain.ts:2605), so the old texels keep ' +
            'their positions in the buffer rather than following their blocks'
        );
    } else if (wt.resampled) {
        detail.push(
            `weights: ${plural(wt.blocks, 'overlapping block')} resampled ${from.weightMapSize} -> ` +
            `${info.weightMapSize} texels per side (the engine's diagonal-split scheme, not bilinear), ` +
            `${plural(wt.fresh, 'new block')} reset to (255,0,0,0)`
        );
    } else {
        detail.push(
            `weights: ${plural(wt.blocks, 'overlapping block')} copied texel-for-texel, ` +
            `${plural(wt.fresh, 'new block')} reset to (255,0,0,0)`
        );
    }

    // `Terrain.rebuild` drops the bake on ANY resize: `_resetLightmap(false)` at terrain.ts:1576
    // runs before the three helpers and unconditionally does `_lightmapInfos.length = 0`
    // (terrain.ts:2323-2333). So a tileSize-only change invalidates it just as much as a
    // blockCount one — and it is the SILENT case, because the block count still matches so the
    // validator's `_lightmapInfos.length ∈ {0, bc0*bc1}` check stays quiet.
    const resized = changedFields.includes('blockCount') || changedFields.includes('tileSize');
    if (resized) {
        notes.push(
            `${changedFields.includes('blockCount') ? 'blockCount' : 'tileSize'} changed: any baked ` +
            'lightmap on a cc.Terrain component using this asset is now wrong — ' +
            (changedFields.includes('blockCount')
                ? '`_lightmapInfos` is keyed by block index and no longer matches the grid'
                : 'the terrain changed physical size, so the bake no longer matches its geometry') +
            '. Clear `_lightmapInfos` on those components and re-bake; the editor clears the bake ' +
            'on any resize too (terrain.ts:1576)'
        );
    }
    return {
        op: 'set_info',
        summary: `${parts.join(', ')} — the terrain is now ${fmt(sw)} x ${fmt(sh)} m ` +
            `(was ${fmt(oldW)} x ${fmt(oldH)} m); ${detail.join('; ')}`,
        notes,
        blockCountChanged: changedFields.includes('blockCount'),
        resized,
        blockCountFrom: from.blockCount,
        blockCountTo: [...info.blockCount],
    };
}

// --- layers -----------------------------------------------------------------

function resolveTexture(ctx, ref, what) {
    return shared(() => resolveTextureRef(ctx.assetIndex ?? null, ref, what));
}

/** Asset name for a `uuid@subId`, falling back to the id itself */
function label(ctx, id) {
    if (!id) return '(none)';
    return ctx.assetIndex?.label(id) ?? id;
}

/**
 * `set_layer` — add (append) or update one palette entry. The palette must stay DENSE
 * (`layers[i].slot === i`): the engine overwrites the binary `slot` with the array index on
 * every export (terrain-asset.ts:613), so a hole makes the binary and the library JSON
 * disagree about which palette index a `layerBuffer` value means.
 */
function setLayer(data, op, ctx) {
    const layers = data.layers;
    const slot = requireIntIn(
        op, 'slot', 0, TERRAIN_MAX_LAYER_COUNT - 1,
        ` (the palette has ${plural(layers.length, 'layer')}; ${layers.length} appends a new one)`
    );
    if (slot > layers.length) {
        throw new TerrainOpError(
            `slot ${slot} would leave a gap: the palette holds ${plural(layers.length, 'layer')}` +
            (layers.length ? ` (slots 0..${layers.length - 1})` : '') +
            ` and must stay dense — use slot ${layers.length} to append`
        );
    }
    const isNew = slot === layers.length;
    const fields = OP_KEYS.set_layer.filter((k) => k !== 'slot' && op[k] !== undefined);
    if (fields.length === 0) {
        throw new TerrainOpError(
            `set_layer needs at least one of ${OP_KEYS.set_layer.filter((k) => k !== 'slot').join(', ')}`
        );
    }
    if (isNew && op.detailMap === undefined) {
        throw new TerrainOpError(
            `slot ${slot} is a new palette entry, so "detailMap" is required — the editor drops a ` +
            'layer without a detail texture on re-save'
        );
    }

    const layer = isNew
        ? { slot, tileSize: 1, detailMapId: '', normalMapId: '', roughness: 1, metallic: 0 }
        : layers[slot];
    const changes = [];

    if (op.detailMap !== undefined) {
        if (op.detailMap === null) {
            throw new TerrainOpError(
                'detailMap cannot be cleared — a layer without a detail texture is dropped by the ' +
                'editor on re-save; use remove_layer to delete the palette entry instead'
            );
        }
        const id = resolveTexture(ctx, op.detailMap, 'detailMap');
        if (id !== layer.detailMapId) {
            changes.push(`detailMap ${label(ctx, layer.detailMapId)} -> ${label(ctx, id)}`);
            layer.detailMapId = id;
        }
    }
    if (op.normalMap !== undefined) {
        // The binary stores an ABSENT normal map as "", never null
        const id = op.normalMap === null ? '' : resolveTexture(ctx, op.normalMap, 'normalMap');
        if (id !== layer.normalMapId) {
            changes.push(id === ''
                ? `normalMap ${label(ctx, layer.normalMapId)} cleared`
                : `normalMap ${label(ctx, layer.normalMapId)} -> ${label(ctx, id)}`);
            layer.normalMapId = id;
        }
    }
    if (op.tileSize !== undefined) {
        const v = requireFinite(op, 'tileSize');
        if (v <= 0) {
            throw new TerrainOpError(
                `"tileSize" must be > 0 (metres per texture repeat for THIS layer — not the ` +
                `terrain's tile size, which set_info owns), got ${show(v)}`
            );
        }
        if (v !== layer.tileSize) {
            changes.push(`tileSize ${fmt(layer.tileSize)} -> ${fmt(v)} m per texture repeat`);
            layer.tileSize = v;
        }
    }
    for (const key of ['roughness', 'metallic']) {
        if (op[key] === undefined) continue;
        const v = requireNumberIn(op, key, 0, 1);
        if (v !== layer[key]) {
            changes.push(`${key} ${fmt(layer[key])} -> ${fmt(v)}`);
            layer[key] = v;
        }
    }

    const notes = [];
    // No "nothing uses this slot yet" note here: a later op in the same batch may assign it.
    // The report derives that from the FINAL state (terrainBin's own unused-slot warning).
    if (isNew) layers.push(layer);
    if (layer.normalMapId) {
        notes.push(
            `layer ${slot} carries a normal map, which the engine only samples when the scene's ` +
            'cc.Terrain component has `_useNormalmap: true` (apply_edits set_component_property)'
        );
    }
    if (layer.roughness !== 1 || layer.metallic !== 0) {
        notes.push(
            `layer ${slot} uses non-default roughness/metallic, which only take effect with ` +
            '`_usePBR: true` on the scene\'s cc.Terrain component'
        );
    }
    return {
        op: 'set_layer',
        appendedSlot: isNew ? slot : null,
        summary: isNew
            ? `Added palette layer ${slot}: ${label(ctx, layer.detailMapId)} ` +
              `(tileSize ${fmt(layer.tileSize)} m, roughness ${fmt(layer.roughness)}, metallic ${fmt(layer.metallic)}` +
              `${layer.normalMapId ? `, normal ${label(ctx, layer.normalMapId)}` : ''})`
            : (changes.length
                ? `Updated palette layer ${slot}: ${changes.join(', ')}`
                : `Palette layer ${slot} (${label(ctx, layer.detailMapId)}) already had those values — nothing changed`),
        notes,
    };
}

/**
 * `remove_layer` — drop a palette entry through `terrainBin.removeLayer` (which unassigns it
 * in every block, LEFT-PACKS the surviving channels with their weights and re-indexes the
 * palette), then restore this module's sum-255 convention on the affected blocks.
 */
function removeLayerOp(data, op, ctx) {
    const slot = requireIntIn(op, 'slot', 0, TERRAIN_MAX_LAYER_COUNT - 1);
    const before = data.layers.map((l) => l.slot);
    let removed;
    let blocks;
    let remap;
    try {
        ({ removed, blocks, remap } = removeLayer(data, slot));
    } catch (err) {
        throw new TerrainOpError(err.message);
    }

    let renormalized = 0;
    let filled = 0;
    let fallbackSlot = -1;
    for (const b of blocks) {
        const [bx, by] = blockCoords(b, data.blockCount);
        const res = renormalizeBlock(data, bx, by);
        renormalized += res.changed;
        filled += res.filled;
        if (res.filled > 0) fallbackSlot = res.first;
    }

    const reindexed = [...remap.entries()].filter(([oldSlot, newSlot]) => oldSlot !== newSlot);
    const notes = [];
    if (filled > 0) {
        notes.push(
            `${plural(filled, 'texel')} were covered by the removed layer ALONE and had no weight ` +
            `left at all; they fall back to layer ${fallbackSlot} at full weight (what a freshly ` +
            'created block looks like) instead of rendering as nothing'
        );
    }
    if (reindexed.length) {
        notes.push(
            `the palette was re-indexed so that slot === array index (the binary format requires ` +
            `it): ${reindexed.map(([o, n]) => `${o} -> ${n}`).join(', ')}. Every layerBuffer ` +
            'reference was remapped, but any slot number you hold from an earlier call is stale'
        );
    }
    const affected = blocks
        .slice(0, 8)
        .map((b) => `[${blockCoords(b, data.blockCount).join(',')}]`)
        .join(', ');
    return {
        op: 'remove_layer',
        summary: `Removed palette layer ${slot} (${label(ctx, removed.detailMapId)}) — unassigned in ` +
            `${plural(blocks.length, 'block')}${blocks.length ? ` (${affected}${blocks.length > 8 ? ', …' : ''})` : ''}; ` +
            `the affected blocks' remaining channels were left-packed and ${plural(renormalized, 'texel')} ` +
            'renormalized to sum 255; ' +
            `the palette now holds ${plural(data.layers.length, 'layer')} (was ${before.length})`,
        notes,
    };
}

// --- heights ----------------------------------------------------------------

/** Write raw heights over a vertex range, counting clamps; returns summary numbers */
function writeHeights(data, range, metresAt) {
    const [vx] = vertexCounts(data.blockCount);
    let clamped = 0;
    let low = Infinity;
    let high = -Infinity;
    let changed = 0;
    let maxDelta = 0;
    for (let j = range.j0; j <= range.j1; j++) {
        for (let i = range.i0; i <= range.i1; i++) {
            const metres = metresAt(i, j);
            if (metres < low) low = metres;
            if (metres > high) high = metres;
            if (metres < TERRAIN_HEIGHT_FMIN || metres > TERRAIN_HEIGHT_FMAX) clamped++;
            const raw = heightToRaw(metres, true);
            const index = j * vx + i;
            if (data.heights[index] !== raw) {
                maxDelta = Math.max(maxDelta, Math.abs(rawToHeight(raw) - rawToHeight(data.heights[index])));
                data.heights[index] = raw;
                changed++;
            }
        }
    }
    return { clamped, low, high, changed, maxDelta };
}

function clampNote(res, total) {
    if (res.clamped === 0) return [];
    return [
        `${res.clamped} of ${total} height sample(s) fell outside the representable range ` +
        `[${TERRAIN_HEIGHT_FMIN}, ${TERRAIN_HEIGHT_FMAX}] m (computed ${fmt(res.low)}..${fmt(res.high)} m) ` +
        'and were clamped',
    ];
}

/**
 * `set_heights` — flatten to a value, set from inline rows, or sample a heightmap over the
 * region. Rows/heightmap are resampled onto the region's vertex grid by `heightmap.js` (the
 * engine's `importHeightField` scheme, with a 1:1 copy when the source already matches).
 */
function setHeights(data, op, ctx) {
    const r = parseRegion(op, data);
    const range = vertexRange(data, r);
    const sources = ['value', 'rows', 'heightmap'].filter((k) => op[k] !== undefined);
    if (sources.length !== 1) {
        throw new TerrainOpError(
            'set_heights needs exactly one of "value" (metres), "rows" (2D array of metres, ' +
            'rows[j][i] with x fastest) or "heightmap" {source, min, max}' +
            (sources.length ? ` — got ${sources.join(' + ')}` : '')
        );
    }
    const where = `${describeRegion(data, r)} (${describeVertices(range)})`;

    if (op.value !== undefined) {
        const v = requireFinite(op, 'value');
        checkHeightRange(v, 'value');
        const raw = heightToRaw(v, true);
        const stored = rawToHeight(raw);
        const res = writeHeights(data, range, () => v);
        const notes = stored !== v
            ? [`value ${v} m quantized to ${stored} m (heights are stored in 1/128 m steps)`]
            : [];
        return {
            op: 'set_heights',
            summary: `Flattened ${plural(range.count, 'vertex', 'vertices')} to ${fmt(stored)} m over ${where} ` +
                `— ${res.changed} of them changed, largest move ${fmt(res.maxDelta)} m`,
            notes,
        };
    }

    if (range.cols < 2 || range.rows < 2) {
        throw new TerrainOpError(
            `a rows/heightmap source needs at least 2 vertices per axis; ${where} covers ` +
            `${range.cols}x${range.rows} (vertices sit every ${fmt(data.tileSize)} m) — ` +
            'use "value" to set a single row/column'
        );
    }
    const usedRows = op.rows !== undefined;
    const spec = usedRows ? { rows: op.rows } : op.heightmap;
    let grid;
    try {
        grid = buildHeightGrid(spec, {
            vertexCount: [range.cols, range.rows],
            tileCount: [range.cols - 1, range.rows - 1],
            projectRoot: ctx.projectRoot ?? null,
            // Name the argument the caller actually passed: `rows` values wrapped into a
            // heightmap-shaped spec must not be reported as "heightmap.rows[1] …".
            label: usedRows ? 'rows' : 'heightmap',
        });
    } catch (err) {
        if (err instanceof HeightmapError) throw new TerrainOpError(err.message);
        throw new TerrainOpError(`${usedRows ? 'rows' : 'heightmap'}: ${err.message}`);
    }
    const res = writeHeights(
        data,
        range,
        (i, j) => grid.heights[(j - range.j0) * range.cols + (i - range.i0)]
    );
    return {
        op: 'set_heights',
        summary: `Set ${plural(range.count, 'vertex', 'vertices')} over ${where} from ` +
            `${op.rows !== undefined ? 'inline rows' : `heightmap ${show(spec.source ?? 'inline')}`} ` +
            `— ${res.changed} changed, range ${fmt(res.low)}..${fmt(res.high)} m, largest move ${fmt(res.maxDelta)} m`,
        notes: [...grid.notes, ...clampNote(res, range.count)],
    };
}

/** `adjust_heights` — relative raise/lower over a region */
function adjustHeights(data, op) {
    const r = parseRegion(op, data);
    const range = vertexRange(data, r);
    const delta = requireFinite(op, 'delta');
    const [vx] = vertexCounts(data.blockCount);
    const res = writeHeights(data, range, (i, j) => rawToHeight(data.heights[j * vx + i]) + delta);
    const notes = clampNote(res, range.count);
    if (delta !== 0 && Math.abs(delta) < TERRAIN_HEIGHT_FACTOR / 2) {
        notes.push(
            `delta ${delta} m is smaller than half a height quantum (${TERRAIN_HEIGHT_FACTOR} m), ` +
            'so it rounds away to nothing'
        );
    }
    return {
        op: 'adjust_heights',
        summary: `${delta >= 0 ? 'Raised' : 'Lowered'} ${plural(range.count, 'vertex', 'vertices')} by ` +
            `${fmt(delta)} m over ${describeRegion(data, r)} (${describeVertices(range)}) — ` +
            `${res.changed} changed, result ${fmt(res.low)}..${fmt(res.high)} m before clamping`,
        notes,
    };
}

/**
 * `smooth_heights` — 3x3 box blur (the editor's smooth brush equivalent).
 *
 * Edge behaviour, deliberate and documented: every tap of the 3x3 kernel exists, and a tap
 * outside the TERRAIN reuses the nearest edge vertex (clamp-to-edge — the rule
 * `HeightField.getClamp`/`Terrain.getHeightClamp` use), so a terrain border keeps its height
 * instead of sagging toward 0. Taps outside the REGION but inside the terrain are read
 * normally, so smoothing a patch blends into its surroundings instead of creasing at the
 * region border; only vertices inside the region are written. Each iteration reads a snapshot
 * of the previous one (so the result does not depend on the scan order) and re-quantizes to
 * 1/128 m, which is why many iterations converge instead of flattening completely.
 */
function smoothHeights(data, op) {
    const r = parseRegion(op, data);
    const range = vertexRange(data, r);
    const iterations = op.iterations === undefined
        ? 1
        : requireIntIn(op, 'iterations', 1, MAX_SMOOTH_ITERATIONS);
    const [vx, vz] = vertexCounts(data.blockCount);
    const clampIdx = (v, max) => (v < 0 ? 0 : (v > max ? max : v));

    let changed = 0;
    let maxDelta = 0;
    const original = Uint16Array.from(data.heights);
    for (let it = 0; it < iterations; it++) {
        const prev = Uint16Array.from(data.heights);
        for (let j = range.j0; j <= range.j1; j++) {
            for (let i = range.i0; i <= range.i1; i++) {
                let sum = 0;
                for (let dj = -1; dj <= 1; dj++) {
                    const sj = clampIdx(j + dj, vz - 1) * vx;
                    for (let di = -1; di <= 1; di++) {
                        sum += prev[sj + clampIdx(i + di, vx - 1)];
                    }
                }
                // Raw units are an affine image of metres, so averaging raw == averaging
                // metres; rounding here IS the 1/128 m quantization.
                data.heights[j * vx + i] = Math.round(sum / 9);
            }
        }
    }
    for (let j = range.j0; j <= range.j1; j++) {
        for (let i = range.i0; i <= range.i1; i++) {
            const index = j * vx + i;
            if (data.heights[index] === original[index]) continue;
            changed++;
            maxDelta = Math.max(maxDelta, Math.abs(rawToHeight(data.heights[index]) - rawToHeight(original[index])));
        }
    }
    return {
        op: 'smooth_heights',
        summary: `Smoothed ${plural(range.count, 'vertex', 'vertices')} over ${describeRegion(data, r)} ` +
            `(${describeVertices(range)}) with ${plural(iterations, 'iteration')} of a 3x3 box blur — ` +
            `${changed} changed, largest move ${fmt(maxDelta)} m; outside the terrain the edge vertex ` +
            'is reused, vertices outside the region are read but never written',
        notes: [],
    };
}

// --- weights ----------------------------------------------------------------

/**
 * Blocks a region touches, and for each one the texels inside the region with their falloff
 * factor. Iterates the touched blocks' texels and tests each texel's METRE position through
 * `terrainBin.texelPosition` — the exact inverse of the `weightTexelAt` mapping the read side
 * and the engine's own resampler use, so painting and sampling agree texel for texel.
 */
function regionTexels(data, r, falloff, visit) {
    const [bc0, bc1] = data.blockCount;
    const wms = data.weightMapSize;
    const blockSize = TERRAIN_BLOCK_TILE_COMPLEXITY * data.tileSize;
    const clampB = (v, max) => Math.min(Math.max(v, 0), max);
    const bx0 = clampB(Math.floor(r.x / blockSize), bc0 - 1);
    const bx1 = clampB(Math.floor((r.x + r.width) / blockSize), bc0 - 1);
    const by0 = clampB(Math.floor(r.z / blockSize), bc1 - 1);
    const by1 = clampB(Math.floor((r.z + r.depth) / blockSize), bc1 - 1);

    const cx = r.x + r.width / 2;
    const cz = r.z + r.depth / 2;
    const rx = r.width / 2;
    const rz = r.depth / 2;

    for (let by = by0; by <= by1; by++) {
        for (let bx = bx0; bx <= bx1; bx++) {
            for (let lj = 0; lj < wms; lj++) {
                for (let li = 0; li < wms; li++) {
                    const gi = bx * wms + li;
                    const gj = by * wms + lj;
                    const [x, z] = texelPosition(data, gi, gj);
                    let inside;
                    let edge; // distance from the region border, metres
                    if (r.shape === 'ellipse') {
                        const q = Math.sqrt(((x - cx) / rx) ** 2 + ((z - cz) / rz) ** 2);
                        inside = q <= 1 + EPS;
                        // Approximate for a strongly elliptical region: the falloff band is
                        // measured along the SHORTER radius.
                        edge = (1 - q) * Math.min(rx, rz);
                    } else {
                        inside = x >= r.x - EPS && x <= r.x + r.width + EPS
                            && z >= r.z - EPS && z <= r.z + r.depth + EPS;
                        edge = Math.min(x - r.x, r.x + r.width - x, z - r.z, r.z + r.depth - z);
                    }
                    if (!inside) continue;
                    const t = falloff > 0 ? Math.min(Math.max(edge / falloff, 0), 1) : 1;
                    visit(bx, by, gi, gj, t);
                }
            }
        }
    }
}

/**
 * Metres between two adjacent weight texels of the same block — endpoint-inclusive, so
 * `blockSize / (weightMapSize - 1)` and NOT `blockSize / weightMapSize` (texel 0 sits on the
 * block's near edge and texel `weightMapSize - 1` on its far edge). Same figure
 * `query_terrain` prints and `texelPosition` implements.
 */
function texelSpacing(data) {
    return (TERRAIN_BLOCK_TILE_COMPLEXITY * data.tileSize) / Math.max(1, data.weightMapSize - 1);
}

/**
 * Whether one texel fails the sum-255 convention OBSERVABLY — i.e. its block blends more than
 * one layer, so the shader (a plain weighted sum) renders the shortfall as darkening. Measures
 * the invariant `paint_layer` claims in its summary instead of asserting it.
 *
 * Scope matters here: only texels the op itself WROTE may be measured. A block-wide sweep would
 * also count the editor's own output — its brush stores `trunc(w * 255)`, so a real editor-saved
 * terrain holds thousands of `(254,0,0,0)` texels — and report them as a bug in this op, with a
 * remedy (re-run the op) that provably cannot reach texels outside the region.
 * @param {object} data
 * @param {number} base - `weightTexelIndex(data, i, j)`
 * @param {number[]} slots - The block's four palette slots
 * @returns {boolean}
 */
function isShortTexel(data, base, slots) {
    if (maxLayerIndex(slots) === 0) return false; // the weight map is not sampled for this block
    const sum = data.weights[base] + data.weights[base + 1]
        + data.weights[base + 2] + data.weights[base + 3];
    return sum !== 255;
}

/**
 * `paint_layer` — write one layer's weight over a region, renormalizing the other channels so
 * every touched texel keeps summing to 255, and auto-assigning the slot into each touched
 * block's `layerBuffer`.
 */
function paintLayer(data, op, ctx) {
    const slot = requireIntIn(op, 'layer', 0, TERRAIN_MAX_LAYER_COUNT - 1);
    if (!data.layers.some((l) => l.slot === slot)) {
        throw new TerrainOpError(
            `no palette layer with slot ${slot} — the palette holds ` +
            `${data.layers.length ? data.layers.map((l) => `${l.slot} (${label(ctx, l.detailMapId)})`).join(', ') : 'no layers'}; ` +
            'add one with set_layer first'
        );
    }
    const weight = requireNumberIn(op, 'weight', 0, 1);
    const falloff = op.falloff === undefined ? 0 : requireNumberIn(op, 'falloff', 0, Infinity, ' metres');
    const r = parseRegion(op, data, { shape: true });

    // The falloff ramp is `min(1, edge / falloff)` where `edge` is the distance to the region
    // border, so its peak is `min(1, halfExtent / falloff)` — a falloff wider than the region's
    // half-extent silently caps the achievable weight far below the requested one.
    const halfExtent = Math.min(r.width, r.depth) / 2;
    const peakFactor = falloff > 0 ? Math.min(1, halfExtent / falloff) : 1;

    // Pass 1: which blocks are touched, and can each host the layer? All-or-nothing, so the
    // whole plan is checked before a single byte moves.
    const touched = new Map(); // blockIndex -> texel count
    regionTexels(data, r, falloff, (bx, by) => {
        const b = blockIndex(bx, by, data.blockCount);
        touched.set(b, (touched.get(b) ?? 0) + 1);
    });
    if (touched.size === 0) {
        throw new TerrainOpError(
            `region ${describeRegion(data, r)} contains no weight texel — texels sit every ` +
            `${fmt((TERRAIN_BLOCK_TILE_COMPLEXITY * data.tileSize) / Math.max(1, data.weightMapSize - 1))} m ` +
            `(weightMapSize ${data.weightMapSize} per block side)`
        );
    }

    const channelOf = new Map();
    const assigned = [];
    const full = [];
    for (const b of [...touched.keys()].sort((a, c) => a - c)) {
        const [bx, by] = blockCoords(b, data.blockCount);
        const slots = blockLayers(data, bx, by);
        let k = slots.indexOf(slot);
        if (k < 0) {
            k = slots.indexOf(-1); // blocks stay left-packed, so this is the first free channel
            if (k < 0) {
                full.push(`[${bx},${by}] uses slots ${slots.join(', ')}`);
                continue;
            }
            assigned.push([bx, by, k]);
        }
        channelOf.set(b, k);
    }
    if (full.length) {
        throw new TerrainOpError(
            `layer ${slot} cannot be painted: all ${TERRAIN_MAX_BLEND_LAYERS} blend slots of ` +
            `${plural(full.length, 'block')} are taken by other layers — ${full.slice(0, 8).join('; ')}` +
            `${full.length > 8 ? '; …' : ''}. A block blends at most ${TERRAIN_MAX_BLEND_LAYERS} ` +
            'layers (the weight map has 4 channels); free one with remove_layer or set_block_layers'
        );
    }

    // Pass 2: assign, then write.
    // A block that GAINS a channel here may hold texels that do not sum to 255 — either from an
    // earlier paint into what was then its only assigned layer, or from a hand-made file. While
    // the block had a single channel that was unobservable (the shader ignored the weight map);
    // now that it blends two, every such texel would render darkened. Repair the block on
    // assignment, exactly as `remove_layer` does when it changes a block's channel set.
    let repaired = 0;
    for (const [bx, by, k] of assigned) {
        const slots = blockLayers(data, bx, by);
        slots[k] = slot;
        setBlockLayers(data, bx, by, slots);
        repaired += renormalizeBlock(data, bx, by).changed;
    }
    const slotsByBlock = new Map();
    for (const b of touched.keys()) {
        slotsByBlock.set(b, blockLayers(data, ...blockCoords(b, data.blockCount)));
    }

    let texels = 0;
    let ignored = 0;
    let splitSum = 0;
    let zeroed = 0;
    let short = 0;
    let vLow = Infinity;
    let vHigh = -Infinity;
    let ti0 = Infinity;
    let ti1 = -Infinity;
    let tj0 = Infinity;
    let tj1 = -Infinity;
    regionTexels(data, r, falloff, (bx, by, gi, gj, t) => {
        const b = blockIndex(bx, by, data.blockCount);
        const k = channelOf.get(b);
        const slots = slotsByBlock.get(b);
        const base = weightTexelIndex(data, gi, gj);
        const value = Math.round(weight * t * 255);
        const res = paintTexel(data, base, slots, k, value);
        // The invariant this op advertises, MEASURED rather than asserted — on the texel just
        // written, while its block's slots are at hand
        if (isShortTexel(data, base, slots)) short++;
        texels++;
        if (value === 0) zeroed++;
        if (res.ignored) ignored++;
        if (res.split) splitSum++;
        if (value < vLow) vLow = value;
        if (value > vHigh) vHigh = value;
        ti0 = Math.min(ti0, gi); ti1 = Math.max(ti1, gi);
        tj0 = Math.min(tj0, gj); tj1 = Math.max(tj1, gj);
    });

    const notes = [];
    if (peakFactor < 1 - 1e-9) {
        notes.push(
            `falloff ${fmt(falloff)} m is wider than the region's ${fmt(halfExtent)} m half-extent, ` +
            `so the requested weight ${fmt(weight)} is reached NOWHERE — the ramp peaks at ` +
            `${fmt(peakFactor)} of it and the strongest texel got ${fmt((vHigh < 0 ? 0 : vHigh) / 255)}. ` +
            `Use a falloff of at most ${fmt(halfExtent)} m, or a larger region`
        );
    }
    if (assigned.length) {
        notes.push(
            `layer ${slot} was assigned to ${assigned.map(([bx, by, k]) => `channel ${'RGBA'[k]} of block [${bx},${by}]`).join(', ')}`
        );
    }
    // The accident this op can cause: the auto-assignment makes the layer a block's ONLY
    // channel, and the engine then draws it flat over that block's whole 32x32-tile area
    // instead of only the painted texels. Most visible when a region ends exactly on a block
    // seam, where a single edge texel reaches into the untouched neighbour.
    const sole = assigned
        .map(([bx, by]) => [bx, by, blockLayers(data, bx, by)])
        .filter(([, , s]) => s[0] === slot && s[1] < 0 && s[2] < 0 && s[3] < 0);
    if (sole.length) {
        notes.push(
            `layer ${slot} became the ONLY layer of ${plural(sole.length, 'block')} ` +
            `(${sole.map(([bx, by]) => `[${bx},${by}]`).join(', ')}), so those blocks now render it ` +
            `over their WHOLE ${TERRAIN_BLOCK_TILE_COMPLEXITY}x${TERRAIN_BLOCK_TILE_COMPLEXITY}-tile ` +
            `(${fmt(TERRAIN_BLOCK_TILE_COMPLEXITY * data.tileSize)} m) area, not just the painted ` +
            'region: the engine drops the weight map for a block with a single assigned channel and ' +
            'draws that detail map flat (terrain.ts:920-930, terrain.effect LAYERS==1). Weight texels ' +
            `sit ON block edges, so a region ending exactly on a seam reaches ${fmt(texelSpacing(data))} m ` +
            '(one texel) into the next block — shrink the region by that much to stay inside, or ' +
            'paint the neighbour deliberately'
        );
    }
    if (repaired) {
        notes.push(
            `${plural(repaired, 'texel')} of the newly-multi-layer block(s) did not sum to 255 ` +
            '(left over from when the block assigned a single layer, where the shader ignores the ' +
            'weight map) and were rescaled to 255 before painting — otherwise they would now render ' +
            'darkened'
        );
    }
    if (ignored) {
        notes.push(
            `${plural(ignored, 'texel')} got weight 1 instead of the requested ${fmt(weight)}: ` +
            `layer ${slot} is the only layer their block assigns, so there is no other channel to ` +
            'carry the remaining weight and the shader ignores the weight map for such a block ' +
            'anyway. Storing the requested value would render correctly now but turn into a dark ' +
            'patch the moment a second layer is painted into that block'
        );
    }
    if (splitSum) {
        notes.push(
            `${plural(splitSum, 'texel')} had no weight on any other layer, so the remaining ` +
            `${fmt(1 - weight)} was split equally between the block's other assigned layers`
        );
    }
    if (short) {
        notes.push(
            `${plural(short, 'texel')} THIS OP WROTE in a multi-layer block do not sum to 255 and ` +
            'will render darkened — this should not happen; please report it'
        );
    }

    const ranged = vLow !== vHigh;
    return {
        op: 'paint_layer',
        summary: `Painted layer ${slot} (${label(ctx, data.layers[slot]?.detailMapId)}) at weight ` +
            `${fmt(weight)} over ${plural(texels, 'texel')} in ${plural(touched.size, 'block')} ` +
            `(${describeRegion(data, r)}${falloff > 0 ? `, ${fmt(falloff)} m falloff` : ''}` +
            `; global texels ${ti0}..${ti1} x ${tj0}..${tj1}` +
            (ranged ? `, weights written ${fmt(vLow / 255)}..${fmt(vHigh / 255)}` : '') +
            `${zeroed ? `, ${zeroed} of them at weight 0` : ''})` +
            (short ? '' : '; every touched texel sums to 255'),
        notes,
    };
}

/**
 * `set_block_layers` — low-level `layerBuffer` write. Weights are NOT touched: use
 * `paint_layer` for that.
 */
function setBlockLayersOp(data, op, ctx) {
    if (op.block === undefined) {
        throw new TerrainOpError(
            '"block" is required: [x, z] block coordinates (0-based, same order as blockCount — '
            + 'the second component walks along Z), or "all"'
        );
    }
    const [bc0, bc1] = data.blockCount;
    const all = op.block === 'all';
    if (!all) {
        if (!Array.isArray(op.block) || op.block.length !== 2
            || !op.block.every((v) => Number.isInteger(v))) {
            throw new TerrainOpError(
                `"block" must be [x, z] integer block coordinates or "all", got ${show(op.block)} ` +
                `(this terrain has ${bc0} x ${bc1} blocks)`
            );
        }
        if (op.block[0] < 0 || op.block[0] >= bc0 || op.block[1] < 0 || op.block[1] >= bc1) {
            throw new TerrainOpError(
                `block [${op.block}] is outside the ${bc0} x ${bc1} block grid ` +
                `(valid: [0..${bc0 - 1}, 0..${bc1 - 1}])`
            );
        }
    }
    if (!Array.isArray(op.layers)) {
        throw new TerrainOpError(
            '"layers" must be an array of up to 4 palette slots, -1 for an empty channel ' +
            '(e.g. [0, 2] = layer 0 on channel R, layer 2 on channel G)'
        );
    }
    if (op.layers.length > TERRAIN_MAX_BLEND_LAYERS) {
        throw new TerrainOpError(
            `"layers" has ${op.layers.length} entries but a block has only ` +
            `${TERRAIN_MAX_BLEND_LAYERS} blend slots (the weight map's R/G/B/A channels)`
        );
    }
    const slots = [];
    for (let k = 0; k < TERRAIN_MAX_BLEND_LAYERS; k++) {
        const v = k < op.layers.length ? op.layers[k] : -1;
        if (!Number.isInteger(v) || v < -1 || v >= TERRAIN_MAX_LAYER_COUNT) {
            throw new TerrainOpError(
                `layers[${k}] = ${show(v)} must be -1 (empty) or a palette slot in ` +
                `0..${TERRAIN_MAX_LAYER_COUNT - 1}`
            );
        }
        if (v >= 0 && !data.layers.some((l) => l.slot === v)) {
            throw new TerrainOpError(
                `layers[${k}] = ${v} has no palette entry — the palette holds ` +
                `${data.layers.length ? `slots 0..${data.layers.length - 1}` : 'no layers'}; ` +
                'add one with set_layer'
            );
        }
        if (v >= 0 && slots.includes(v)) {
            throw new TerrainOpError(
                `layers: palette slot ${v} appears twice — one block channel per layer`
            );
        }
        if (v >= 0 && slots.length && slots[slots.length - 1] === -1) {
            throw new TerrainOpError(
                `layers ${JSON.stringify(op.layers)} leaves an empty channel before a used one — ` +
                'block slots must stay left-packed, because the engine derives the sampled layer ' +
                'count from the HIGHEST used channel and renders an empty one below it as nothing'
            );
        }
        slots.push(v);
    }

    const targets = all
        ? Array.from({ length: bc0 * bc1 }, (_, b) => blockCoords(b, data.blockCount))
        : [[op.block[0], op.block[1]]];
    let changed = 0;
    const changedBlocks = [];
    for (const [bx, by] of targets) {
        const before = blockLayers(data, bx, by);
        try {
            setBlockLayers(data, bx, by, slots);
        } catch (err) {
            throw new TerrainOpError(err.message);
        }
        if (before.some((v, k) => v !== slots[k])) {
            changed++;
            changedBlocks.push([bx, by]);
        }
    }

    // A channel that just LOST its layer keeps its weight byte, and that byte is not inert: while
    // the block still blends two or more layers the four channels no longer sum to 255, so the
    // shader (a plain weighted sum) darkens the whole block; and the moment that channel gains a
    // layer again the stale byte reappears as coverage nobody painted — `renormalizeBlock` would
    // then see a sum of 255 already and report nothing. So repair the blocks whose channel SET
    // changed, exactly as `remove_layer` and `paint_layer`'s auto-assignment do.
    let renormalized = 0;
    let filled = 0;
    let fallbackSlot = -1;
    for (const [bx, by] of changedBlocks) {
        const res = renormalizeBlock(data, bx, by);
        renormalized += res.changed;
        filled += res.filled;
        if (res.filled > 0) fallbackSlot = res.first;
    }

    const used = slots.filter((v) => v >= 0);
    const notes = [];
    if (used.length === 0) {
        notes.push(
            'the block(s) now assign no layer at all and will render the effect\'s flat grey ' +
            'fallback — assign a layer with set_layer + paint_layer'
        );
    }
    notes.push(
        'weights are not PAINTED by this op: a channel that just gained a layer keeps whatever ' +
        'weight was stored there (a freshly built terrain has R = 255, G/B/A = 0). Use paint_layer ' +
        'to set them'
    );
    if (renormalized) {
        notes.push(
            `${plural(renormalized, 'texel')} were renormalized: the channels of layers this op ` +
            'un-assigned were zeroed and the remaining ones rescaled back to a sum of 255, so the ' +
            'block does not render darkened and no stale byte resurfaces if that channel gains a ' +
            'layer again'
        );
    }
    if (filled) {
        notes.push(
            `${plural(filled, 'texel')} were covered by an un-assigned layer ALONE and had no ` +
            `weight left at all; they fall back to layer ${fallbackSlot} at full weight (what a ` +
            'freshly created block looks like) instead of rendering as nothing'
        );
    }
    return {
        op: 'set_block_layers',
        summary: `Set the layer slots of ${all ? `all ${plural(targets.length, 'block')}` : `block [${op.block}]`} ` +
            `to [${slots.join(', ')}]` +
            `${used.length ? ` = ${used.map((v) => `${'RGBA'[slots.indexOf(v)]}: ${label(ctx, data.layers[v]?.detailMapId)}`).join(', ')}` : ''} ` +
            `(${changed} of ${targets.length} block(s) actually changed)`,
        notes,
    };
}

// --- dispatch ---------------------------------------------------------------

const HANDLERS = {
    set_info: setInfo,
    set_layer: setLayer,
    remove_layer: removeLayerOp,
    set_heights: setHeights,
    adjust_heights: adjustHeights,
    smooth_heights: smoothHeights,
    paint_layer: paintLayer,
    set_block_layers: setBlockLayersOp,
};

/** The op names `edit_terrain` accepts, in documentation order */
export const TERRAIN_OP_NAMES = Object.keys(HANDLERS);

/**
 * Apply ONE operation to an in-memory terrain data object.
 * @param {object} data - Terrain data object (mutated in place)
 * @param {object} op - `{op: name, …}`
 * @param {{assetIndex?: object, projectRoot?: string}} [ctx]
 * @returns {{op: string, summary: string, notes: string[]}}
 * @throws {TerrainOpError}
 */
export function applyTerrainOperation(data, op, ctx = {}) {
    // `Object.hasOwn`, not a bare lookup: `HANDLERS.constructor` / `.toString` / `.valueOf` all
    // resolve through Object.prototype, so a bare truthiness check would let `{op: "constructor"}`
    // past this guard and "succeed" as a no-op that still writes the file.
    if (!Object.hasOwn(HANDLERS, op?.op ?? '')) {
        throw new TerrainOpError(
            `Unknown op "${op?.op}". Supported: ${TERRAIN_OP_NAMES.join(', ')}`
        );
    }
    const handler = HANDLERS[op.op];
    validateOpKeys(op);
    const result = handler(data, op, ctx);
    result.notes = result.notes ?? [];
    return result;
}

/**
 * Make `data` writable before any op runs: materialize the "Create > Terrain" sentinel into
 * real buffers (what the editor does on its first save) and drop stored normals (the editor
 * writes none and the engine rebuilds them on load, so `writeTerrain` never emits any).
 * @param {object} data
 * @param {string[]} notes
 */
function prepare(data, notes) {
    if (data.isDefaultSentinel || data.version === TERRAIN_DATA_VERSION_DEFAULT) {
        let materialized;
        try {
            materialized = materialize(data);
        } catch (err) {
            throw new TerrainOpError(err.message);
        }
        delete data.payloadLength;
        Object.assign(data, materialized);
        const [vx, vz] = vertexCounts(data.blockCount);
        notes.push(
            'this file was the empty "Create > Terrain" sentinel (a 4-byte header, everything else ' +
            `implied) — it is materialized into real buffers first: ${vx}x${vz} vertices at 0 m, ` +
            `a ${data.weightMapSize * data.blockCount[0]}x${data.weightMapSize * data.blockCount[1]} ` +
            'weight map of (255,0,0,0) and no layer assignments, exactly what the editor writes on ' +
            'its first save'
        );
    } else if (data.version !== TERRAIN_DATA_VERSION8) {
        notes.push(
            `this file is format ${versionName(data.version)}; it is rewritten as V8 (the only ` +
            'version the editor writes since 3.8). Heights were migrated from the old 1/512 m ' +
            'quantum to 1/128 m on read, which is exactly what the engine does on load'
        );
    }
    // Mis-sized buffers: the engine DISCARDS them on load and rebuilds
    // (`_buildImp`, terrain.ts:2481-2526). Do the same before editing, so an op cannot read
    // `undefined` out of a short buffer and silently store a 0 (= -256 m / palette slot 0).
    const expected = expectedCounts(data.blockCount, data.weightMapSize);
    const mismatched = [
        ['heights', data.heights?.length ?? 0, expected.heights],
        ['weights', data.weights?.length ?? 0, expected.weights],
        ['layerBuffer', data.layerBuffer?.length ?? 0, expected.layerBuffer],
    ].filter(([, have, want]) => have !== want);
    if (mismatched.length) {
        let rebuilt;
        try {
            rebuilt = materialize(data);
        } catch (err) {
            throw new TerrainOpError(err.message);
        }
        Object.assign(data, rebuilt);
        notes.push(
            `this file declares blockCount [${data.blockCount}] / weightMapSize ${data.weightMapSize} ` +
            `but stores ${mismatched.map(([name, have, want]) => `${have} ${name} instead of ${want}`).join(' and ')} ` +
            '— those buffers were REBUILT from scratch (flat 0 m heights / (255,0,0,0) weights / no ' +
            'layer assignments), which is exactly what the engine does with them on load ' +
            '(terrain.ts:2481-2526). Their previous contents are gone'
        );
    }

    if ((data.normals?.length ?? 0) !== 0) {
        notes.push(
            `this file stores ${data.normals.length} normal float(s); the editor writes none and the ` +
            'engine rebuilds them on load, so they are dropped by this write (no visual change)'
        );
        data.normals = new Float32Array(0);
    }
    data.version = TERRAIN_DATA_VERSION8;
    // A palette that is already dense (everything this module and the editor write) makes
    // this a no-op; a hand-made sparse one is repaired here rather than at write time, where
    // the invariant check would only reject it.
    const before = [...(data.layerBuffer ?? [])];
    const { changedSlots, clearedRefs } = compactPalette(data);
    if (changedSlots > 0) {
        notes.push(
            `${plural(changedSlots, 'palette layer')} had a slot number other than its array index; ` +
            'they were re-indexed (and every layerBuffer reference remapped) because the binary ' +
            'format requires a dense palette'
        );
    }
    // `compactPalette` rewrites a layerBuffer value with no matching layer record to -1. Saying
    // so matters twice over: the block loses a layer assignment, and the -1 can land BELOW a used
    // channel, which the engine then samples as a null layer (renders as nothing). Left-pack
    // those blocks — moving each surviving channel's weights along, exactly like `removeLayer` —
    // so the repair is complete instead of half-done.
    if (clearedRefs > 0) {
        const dropped = new Set();
        const blocks = [];
        for (let i = 0; i < before.length; i++) {
            if (before[i] >= 0 && data.layerBuffer[i] < 0) {
                dropped.add(before[i]);
                const b = Math.floor(i / TERRAIN_MAX_BLEND_LAYERS);
                if (!blocks.includes(b)) blocks.push(b);
            }
        }
        const packed = blocks.filter((b) => leftPackBlock(data, ...blockCoords(b, data.blockCount)));
        notes.push(
            `${plural(clearedRefs, 'layerBuffer entry', 'layerBuffer entries')} referenced palette ` +
            `slot(s) ${[...dropped].sort((a, c) => a - c).join(', ')}, which have no layer record — ` +
            `they were cleared to -1, so ${plural(blocks.length, 'block')} lost a layer assignment` +
            (packed.length
                ? `, and ${plural(packed.length, 'block')} had their remaining channels left-packed ` +
                  '(weights moved along and renormalized) because a -1 below a used channel is ' +
                  'sampled as a null layer'
                : '')
        );
    }
}

/**
 * Move a block's assigned channels (slots AND their weight bytes) down to channels 0..n-1,
 * zeroing the freed ones, then renormalize. No-op — and returns false — when the block is
 * already left-packed.
 * @param {object} data
 * @param {number} bx
 * @param {number} by
 * @returns {boolean} whether anything moved
 */
function leftPackBlock(data, bx, by) {
    const slots = blockLayers(data, bx, by);
    const keep = [];
    for (let k = 0; k < TERRAIN_MAX_BLEND_LAYERS; k++) {
        if (slots[k] >= 0) keep.push(k);
    }
    if (keep.every((k, n) => k === n)) return false;
    setBlockLayers(data, bx, by, keep.map((k) => slots[k]));
    const wms = data.weightMapSize;
    for (let j = 0; j < wms; j++) {
        for (let i = 0; i < wms; i++) {
            const base = weightTexelIndex(data, bx * wms + i, by * wms + j);
            const old = [
                data.weights[base], data.weights[base + 1],
                data.weights[base + 2], data.weights[base + 3],
            ];
            for (let k = 0; k < TERRAIN_MAX_BLEND_LAYERS; k++) {
                data.weights[base + k] = k < keep.length ? old[keep[k]] : 0;
            }
        }
    }
    renormalizeBlock(data, bx, by);
    return true;
}

/**
 * Apply a batch of operations in order, all-or-nothing. Throws on the first failing op, at
 * which point `data` is partially modified and MUST be discarded — the caller writes only on
 * success.
 *
 * @param {object} data - Terrain data object from `readTerrain` (mutated in place)
 * @param {object[]} ops
 * @param {{assetIndex?: object, projectRoot?: string}} [ctx]
 * @returns {{results: Array<{op: string, summary: string, notes: string[]}>, notes: string[]}}
 * @throws {TerrainOpError}
 */
export function applyTerrainOperations(data, ops, ctx = {}) {
    if (!Array.isArray(ops) || ops.length === 0) {
        throw new TerrainOpError('ops must be a non-empty array');
    }
    const notes = [];
    prepare(data, notes);
    const results = ops.map((op, i) => {
        try {
            return applyTerrainOperation(data, op, ctx);
        } catch (err) {
            throw new TerrainOpError(`op[${i}] ${op?.op ?? '<no op field>'}: ${err.message}`);
        }
    });
    return { results, notes };
}
