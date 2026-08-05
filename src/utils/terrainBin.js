/**
 * Cocos Creator `.terrain` binary reader / writer
 *
 * A `.terrain` asset is a raw native binary — no JSON wrapper. The editor
 * importer copies it verbatim to `library/<xx>/<uuid>.bin` and lifts only the
 * layer table into `library/<xx>/<uuid>.json`; heights, weights and the
 * per-block layer assignment live ONLY in this binary.
 *
 * Layout (V8, little-endian, packed, no alignment — `TerrainAsset._exportNativeData`,
 * terrain-asset.ts:570-633):
 *
 * ```
 * version        i32        0x01010008 (V8). 0x01010111 = "empty" sentinel: header only
 * tileSize       f64        (f32 before V7). Snapped on load: Math.floor(t * 100) / 100
 * blockCount[2]  i32 x2
 * weightMapSize  i16
 * lightMapSize   i16
 * heights        i32 count + u16 x N     N = (bc0*32+1) * (bc1*32+1), row-major, X fastest
 * normals        i32 count + f32 x N     >= V6 only; the editor always writes count 0
 * weights        i32 count + u8  x N     N = (wms*bc0) * (wms*bc1) * 4, one global RGBA8 map
 * layerBuffer    i32 count + i16 x N     >= V2; N = bc0*bc1*4, -1 = empty slot
 * layerInfos     i32 count + records     >= V3; record = slot i32, tileSize f64,
 *                                        detailMapId str, normalMapId str (V4+),
 *                                        roughness f64 (V4+), metallic f64 (V4+)
 *                                        str = i32 char count + 1 byte per char (ASCII)
 * ```
 *
 * Trailing zero padding is part of the format: `_exportNativeData` returns the whole
 * `TerrainBuffer` backing array, whose capacity starts at 2048 and doubles
 * (`reserve`, terrain-asset.ts:60-77), so `fileSize = smallest 2048*2^k >= payloadLength`.
 * The golden 67922-byte payload therefore sits in a 131072-byte file. Never derive the
 * payload length from the file length or from "the last non-zero byte" (the golden's last
 * eight payload bytes are `metallic = 0.0` and read as padding) — always parse structurally.
 *
 * Height encoding: `metres = (raw - 32768) / 128` (V8; V1-V7 use 1/512 and are migrated on
 * load). Range [-256, 255.9921875] m, quantum 7.8125 mm, flat terrain = every sample 32768.
 *
 * Verified against the engine sources shipped with Cocos Creator 3.8.8
 * (`cocos/terrain/{terrain-asset,terrain,height-field}.ts`, byte-identical to 3.8.7) and
 * against the editor-saved golden `test/fixtures/golden/terrain/terrain.terrain`.
 *
 * **Palette indices vs the binary `slot` field.** Every `layerBuffer` entry, every
 * `layerUsage[].slot` and `weightAt().dominantLayer` is an index into the runtime palette
 * `Terrain._layerList` — the same number the library JSON stores as `_layerInfos[].slot`
 * (terrain.ts:2458/2470 fill `_layerList[layerInfo.slot]`, and the palette may be sparse:
 * `exportLayerListToAsset`, terrain.ts:1683-1690, only emits `_layerList` entries that have
 * a detail map). The BINARY layer record's own `slot` field is NOT that index — the engine
 * overwrites it with the array position on every export (`binaryLayer.slot = i`,
 * terrain-asset.ts:613) and only pre-V5 loads read it. So `layers[]` here may be joined with
 * a `layerBuffer` value on `slot` ONLY while the palette is dense, which is exactly what
 * {@link validateTerrainData} enforces for anything this module writes. This module never
 * reads the library JSON, so it cannot recover the true palette indices of a sparse palette.
 *
 * Two engine functions are deliberately NOT ported verbatim because they are broken —
 * see `weightAt()`. The engine's `TerrainBuffer.readDoubleArray` seek bug
 * (terrain-asset.ts:204-210, stride 4 while advancing 8) is unused by the format and is
 * neither emulated nor "fixed" here.
 */

import * as fs from 'fs';

// --- Constants (terrain-asset.ts:28-52) ------------------------------------

/** LOD level count — runtime only, never serialized (terrain-asset.ts:28) */
export const TERRAIN_MAX_LEVELS = 4;
/** Blend layer slots per block, i.e. weight-map channels R/G/B/A (terrain-asset.ts:29) */
export const TERRAIN_MAX_BLEND_LAYERS = 4;
/** Palette size: `Terrain._layerList` has this many entries (terrain-asset.ts:30) */
export const TERRAIN_MAX_LAYER_COUNT = 256;
/** Tiles per block per axis (terrain-asset.ts:31) */
export const TERRAIN_BLOCK_TILE_COMPLEXITY = 32;
/** Vertices per block per axis = tiles + 1 (terrain-asset.ts:32) */
export const TERRAIN_BLOCK_VERTEX_COMPLEXITY = 33;
/** Floats per runtime vertex (pos + normal + uv) — runtime only (terrain-asset.ts:33) */
export const TERRAIN_BLOCK_VERTEX_SIZE = 8;
/** Raw height of 0 m (terrain-asset.ts:34) */
export const TERRAIN_HEIGHT_BASE = 32768;
/** Metres per raw unit in V8 (terrain-asset.ts:35; engine spells it `FACTORY`) */
export const TERRAIN_HEIGHT_FACTOR = 1 / 128;
/** Metres per raw unit in V1-V7, migrated to `TERRAIN_HEIGHT_FACTOR` on load (terrain-asset.ts:36) */
export const TERRAIN_HEIGHT_FACTOR_V7 = 1 / 512;
/** Lowest representable height in metres = -32768/128 (terrain-asset.ts:37) */
export const TERRAIN_HEIGHT_FMIN = -256;
/** Highest representable height in metres = (65535-32768)/128 (terrain-asset.ts:38) */
export const TERRAIN_HEIGHT_FMAX = 255.9921875;

/** Runtime LOD neighbour indices (terrain-asset.ts:39-42) */
export const TERRAIN_NORTH_INDEX = 0;
export const TERRAIN_SOUTH_INDEX = 1;
export const TERRAIN_WEST_INDEX = 2;
export const TERRAIN_EAST_INDEX = 3;

export const TERRAIN_DATA_VERSION = 0x01010001;
export const TERRAIN_DATA_VERSION2 = 0x01010002;
export const TERRAIN_DATA_VERSION3 = 0x01010003;
export const TERRAIN_DATA_VERSION4 = 0x01010004;
export const TERRAIN_DATA_VERSION5 = 0x01010005;
export const TERRAIN_DATA_VERSION6 = 0x01010006;
export const TERRAIN_DATA_VERSION7 = 0x01010007;
export const TERRAIN_DATA_VERSION8 = 0x01010008;
/** "Empty" sentinel written by `_exportDefaultNativeData` — header only (terrain-asset.ts:52) */
export const TERRAIN_DATA_VERSION_DEFAULT = 0x01010111;

/** Minimum `TerrainBuffer` capacity, and therefore the minimum file size */
export const TERRAIN_BUFFER_MIN_CAPACITY = 2048;

/**
 * Authoring guard: the largest `blockCount[0] * blockCount[1]` {@link materialize} will
 * allocate for. The engine has no such limit; this only stops a bad spec (or a corrupt
 * header) from asking for gigabytes. 4096 blocks = 64x64 = a 2049x2049 vertex grid.
 * Reading an existing file is NOT capped — {@link readTerrain} is bounded by the actual
 * bytes on disk.
 */
export const TERRAIN_MAX_BLOCKS = 4096;

/**
 * Authoring guard: the largest global weight map (in texels, i.e.
 * `weightMapSize^2 * blockCount[0] * blockCount[1]`) {@link materialize} will allocate for.
 * 4096x4096 texels = 64 MB of RGBA8 weights.
 */
export const TERRAIN_MAX_WEIGHT_TEXELS = 4096 * 4096;

const KNOWN_VERSIONS = new Set([
    TERRAIN_DATA_VERSION,
    TERRAIN_DATA_VERSION2,
    TERRAIN_DATA_VERSION3,
    TERRAIN_DATA_VERSION4,
    TERRAIN_DATA_VERSION5,
    TERRAIN_DATA_VERSION6,
    TERRAIN_DATA_VERSION7,
    TERRAIN_DATA_VERSION8,
]);

/** Per-axis cap on {@link exportHeights} sample counts */
const MAX_EXPORT_SAMPLES = 8192;
/** Total cap on {@link exportHeights} samples — 8192x8192 would be 547 MB of JS numbers */
const MAX_EXPORT_CELLS = 1_000_000;

/** `clamp` from cocos/core/math */
function clamp(v, min, max) {
    return Math.min(Math.max(v, min), max);
}

/**
 * Render a rejected value for an error message. `JSON.stringify` turns NaN and Infinity into
 * `null` and a string into `"3"` — the first is useless, the second is exactly the
 * distinction worth keeping, so numbers go through `String` and everything else through
 * `JSON.stringify`.
 */
function show(v) {
    if (typeof v === 'number') return String(v);
    return JSON.stringify(v) ?? String(v);
}

// --- Small format helpers ---------------------------------------------------

/**
 * Is this one of the eight parsable data versions (the sentinel is not one)?
 * @param {number} version
 * @returns {boolean}
 */
export function isKnownVersion(version) {
    return KNOWN_VERSIONS.has(version);
}

/**
 * Human label for a version word, e.g. `0x01010008` → `"V8"`.
 * @param {number} version
 * @returns {string}
 */
export function versionName(version) {
    if (version === TERRAIN_DATA_VERSION_DEFAULT) return 'default (empty sentinel)';
    if (isKnownVersion(version)) return `V${version - TERRAIN_DATA_VERSION + 1}`;
    return `unknown (0x${(version >>> 0).toString(16).padStart(8, '0')})`;
}

/**
 * File size for a given payload length — port of `TerrainBuffer.reserve`
 * (terrain-asset.ts:60-77). Capacity starts at 2048 and doubles while
 * `capacity < size`, so the result is the smallest `2048 * 2^k` that is
 * **>=** the payload; an exact fit (2048, 4096, 65536, …) gets NO padding.
 * @param {number} payloadLen
 * @returns {number}
 */
export function padToCapacity(payloadLen) {
    let capacity = TERRAIN_BUFFER_MIN_CAPACITY;
    while (capacity < payloadLen) capacity += capacity;
    return capacity;
}

/**
 * Vertex counts per axis: `blockCount * 32 + 1` (terrain.ts:1471-1485).
 * @param {number[]} blockCount - `[bc0, bc1]`
 * @returns {number[]} `[vertexCountX, vertexCountZ]`
 */
export function vertexCounts(blockCount) {
    return [
        blockCount[0] * TERRAIN_BLOCK_TILE_COMPLEXITY + 1,
        blockCount[1] * TERRAIN_BLOCK_TILE_COMPLEXITY + 1,
    ];
}

/**
 * Global weight-map dimensions in texels: `weightMapSize * blockCount` per axis.
 * @param {object} data - Terrain data object
 * @returns {number[]} `[uWeightComplexity, vWeightComplexity]`
 */
export function weightMapDims(data) {
    return [
        data.weightMapSize * data.blockCount[0],
        data.weightMapSize * data.blockCount[1],
    ];
}

/**
 * Terrain extent in metres: `blockCount * 32 * tileSize` per axis (terrain.ts:1452-1457).
 * @param {object} data - Terrain data object
 * @returns {number[]} `[width (X), height (Z)]`
 */
export function terrainSize(data) {
    return [
        data.blockCount[0] * TERRAIN_BLOCK_TILE_COMPLEXITY * data.tileSize,
        data.blockCount[1] * TERRAIN_BLOCK_TILE_COMPLEXITY * data.tileSize,
    ];
}

/**
 * Block index from block coordinates — `blockId = yBlock * blockCount[0] + xBlock`
 * (confirmed at terrain-asset.ts:426, terrain.ts:2131/2164/2359).
 * @param {number} x - Block X
 * @param {number} y - Block Y (Z axis)
 * @param {number[]} bc - `blockCount`
 * @returns {number}
 */
export function blockIndex(x, y, bc) {
    return y * bc[0] + x;
}

/**
 * Expected element counts for a given geometry configuration.
 * @param {number[]} blockCount
 * @param {number} weightMapSize
 * @returns {{heights: number, normals: number, weights: number, layerBuffer: number}}
 */
export function expectedCounts(blockCount, weightMapSize) {
    const [vx, vz] = vertexCounts(blockCount);
    const uWC = weightMapSize * blockCount[0];
    const vWC = weightMapSize * blockCount[1];
    return {
        heights: vx * vz,
        normals: vx * vz * 3,
        weights: uWC * vWC * 4,
        layerBuffer: blockCount[0] * blockCount[1] * 4,
    };
}

/**
 * Raw u16 height → metres (V8 encoding).
 * @param {number} raw
 * @returns {number} metres
 */
export function rawToHeight(raw) {
    return (raw - TERRAIN_HEIGHT_BASE) * TERRAIN_HEIGHT_FACTOR;
}

/**
 * Metres → raw u16 height, clamped to `[TERRAIN_HEIGHT_FMIN, TERRAIN_HEIGHT_FMAX]` and
 * quantized to 1/128 m. The engine truncates (`Terrain.setHeight`, terrain.ts:1845-1851,
 * relies on the `Uint16Array` store), which is the default here; pass `round = true` for
 * nearest-quantum behaviour when authoring new data.
 *
 * Non-finite input THROWS instead of clamping: `NaN`/`undefined` would sail through the
 * clamp and land in a `Uint16Array` as raw 0, i.e. a silent -256 m hole (the worst
 * representable height). Strings are rejected for the same reason — `'5'` would coerce.
 *
 * @param {number} metres
 * @param {boolean} [round=false] - Round to the nearest quantum instead of truncating
 * @returns {number} raw value in `[0, 65535]`
 * @throws {Error} when `metres` is not a finite number
 */
export function heightToRaw(metres, round = false) {
    if (typeof metres !== 'number' || !Number.isFinite(metres)) {
        throw new Error(`terrain: height must be a finite number of metres, got ${show(metres)}`);
    }
    const h = clamp(metres, TERRAIN_HEIGHT_FMIN, TERRAIN_HEIGHT_FMAX);
    const raw = TERRAIN_HEIGHT_BASE + h / TERRAIN_HEIGHT_FACTOR;
    return clamp(round ? Math.round(raw) : Math.trunc(raw), 0, 65535);
}

/**
 * The load-time tileSize snap `Math.floor(t * 100) / 100` (terrain-asset.ts:491), applied
 * on EVERY load and for every version.
 * @param {number} tileSize
 * @returns {number}
 */
export function snapTileSize(tileSize) {
    return Math.floor(tileSize * 100) / 100;
}

/**
 * Is `tileSize` a fixed point of the load-time snap? Binary floating point makes some
 * innocuous-looking 2-decimal values lossy (`0.29 → 0.28`, `1.005 → 1`), so authoring
 * tools must snap-and-compare rather than trust the user's number.
 * @param {number} tileSize
 * @returns {boolean}
 */
export function isTileSizeStable(tileSize) {
    return snapTileSize(tileSize) === tileSize;
}

/**
 * Element offset of vertex `(i, j)` in `data.heights`: `j * (blockCount[0] * 32 + 1) + i`,
 * row-major with X fastest (terrain.ts:1845-1859).
 *
 * Exists so that code walking the grid in RAW units — masked height writes, the smooth kernel —
 * does not re-derive the layout. No bounds check, exactly like the engine.
 * @param {object} data
 * @param {number} i - Vertex X index
 * @param {number} j - Vertex Z index
 * @returns {number} element offset
 */
export function vertexIndex(data, i, j) {
    return j * (data.blockCount[0] * TERRAIN_BLOCK_TILE_COMPLEXITY + 1) + i;
}

/**
 * Height of vertex `(i, j)` in metres — `Terrain.getHeight` (terrain.ts:1857-1859).
 * Row-major, X fastest. No bounds check, exactly like the engine.
 * @param {object} data
 * @param {number} i - Vertex X index
 * @param {number} j - Vertex Z index
 * @returns {number} metres
 */
export function getVertexHeight(data, i, j) {
    return rawToHeight(data.heights[vertexIndex(data, i, j)]);
}

/**
 * Set the height of vertex `(i, j)` from metres — `Terrain.setHeight` (terrain.ts:1845-1851),
 * clamped and quantized via {@link heightToRaw}.
 * @param {object} data
 * @param {number} i - Vertex X index
 * @param {number} j - Vertex Z index
 * @param {number} metres
 * @param {boolean} [round=false]
 */
export function setVertexHeight(data, i, j, metres, round = false) {
    data.heights[vertexIndex(data, i, j)] = heightToRaw(metres, round);
}

/**
 * Element offset of texel `(i, j)` in `data.weights` — the index formula of
 * `Terrain.getWeight`/`setWeight` (terrain.ts:2016-2027 / 1999-2012), i.e.
 * `(j * weightMapSize * blockCount[0] + i) * 4`. The four channels follow at
 * `+0..+3` (R/G/B/A = block layer slots 0..3).
 *
 * Exists so that code writing raw 0..255 channel bytes (renormalization, painting) does not
 * re-derive the layout. No bounds check, exactly like the engine.
 * @param {object} data
 * @param {number} i - Texel X index in the GLOBAL map
 * @param {number} j - Texel Z index in the GLOBAL map
 * @returns {number} element offset of channel R
 */
export function weightTexelIndex(data, i, j) {
    return (j * data.weightMapSize * data.blockCount[0] + i) * 4;
}

/**
 * Round a fractional grid coordinate that is within 1e-9 of an integer to that integer.
 *
 * Guards the metres → texel/vertex direction against the residue of `(bx * blockSize + off) -
 * bx * blockSize`, which is what makes {@link weightTexelAt} the exact inverse of
 * {@link texelPosition} rather than an off-by-one on most of a multi-block terrain.
 * @param {number} f
 * @returns {number}
 */
function snapToIndex(f) {
    const near = Math.round(f);
    return Math.abs(f - near) < 1e-9 ? near : f;
}

/**
 * Local metres of texel `(i, j)` — the inverse of {@link weightTexelAt}, and therefore the
 * ONE mapping any painting code must use.
 *
 * Block-local and endpoint-inclusive, like everything else about the weight map: texel 0 of
 * a block sits on the block's near edge and texel `weightMapSize - 1` on its far edge. That
 * makes the mapping deliberately discontinuous at a block seam — the last texel of block
 * `bx` and the first texel of block `bx + 1` share a metre coordinate — because the engine
 * uploads one CLAMP_TO_EDGE texture per block and samples it with block-local uv
 * (terrain.ts:920-955, :1170); no sampling path in the engine crosses a seam.
 *
 * @param {object} data
 * @param {number} i - Texel X index in the GLOBAL map
 * @param {number} j - Texel Z index in the GLOBAL map
 * @returns {number[]} `[x, z]` in local metres
 */
export function texelPosition(data, i, j) {
    const wms = data.weightMapSize;
    const blockSize = TERRAIN_BLOCK_TILE_COMPLEXITY * data.tileSize;
    const bx = Math.floor(i / wms);
    const by = Math.floor(j / wms);
    const span = wms > 1 ? wms - 1 : 1;
    return [
        bx * blockSize + ((i - bx * wms) / span) * blockSize,
        by * blockSize + ((j - by * wms) / span) * blockSize,
    ];
}

/**
 * Exact weight-map read at texel `(i, j)` — `Terrain.getWeight` (terrain.ts:2016-2027).
 * Bug-free primitive, unlike {@link weightAt}'s engine counterpart.
 * @param {object} data
 * @param {number} i - Texel X index in the GLOBAL map
 * @param {number} j - Texel Z index in the GLOBAL map
 * @returns {number[]} `[r, g, b, a]` in 0..1
 */
export function weightAtTexel(data, i, j) {
    const index = weightTexelIndex(data, i, j);
    return [
        data.weights[index + 0] / 255,
        data.weights[index + 1] / 255,
        data.weights[index + 2] / 255,
        data.weights[index + 3] / 255,
    ];
}

/**
 * Exact weight-map write at texel `(i, j)` — `Terrain.setWeight` (terrain.ts:1999-2012).
 * The engine's `Uint8Array` store truncates (and wraps out-of-range values); reproduced
 * here. Non-finite channel values THROW rather than storing a silent 0, for the same reason
 * {@link heightToRaw} rejects them.
 * @param {object} data
 * @param {number} i - Texel X index in the GLOBAL map
 * @param {number} j - Texel Z index in the GLOBAL map
 * @param {number[]} w - `[r, g, b, a]` in 0..1
 * @throws {Error} when `w` is not four finite numbers
 */
export function setWeightAtTexel(data, i, j, w) {
    if (!Array.isArray(w) && !ArrayBuffer.isView(w)) {
        throw new Error('terrain: weight must be an array of 4 channel values in 0..1');
    }
    if (w.length !== TERRAIN_MAX_BLEND_LAYERS) {
        throw new Error(`terrain: weight must have exactly 4 channels, got ${w.length}`);
    }
    for (let k = 0; k < TERRAIN_MAX_BLEND_LAYERS; k++) {
        if (typeof w[k] !== 'number' || !Number.isFinite(w[k])) {
            throw new Error(`terrain: weight[${k}] must be a finite number in 0..1, got ${show(w[k])}`);
        }
    }
    const index = weightTexelIndex(data, i, j);
    for (let k = 0; k < 4; k++) data.weights[index + k] = w[k] * 255;
}

/**
 * The four palette slots of a block (`-1` = empty) — `Terrain.getBlockLayers`
 * (terrain.ts:2131). The values are PALETTE indices (`_layerList` / library-JSON
 * `_layerInfos[].slot`), not indices into `data.layers` — see the module header.
 * @param {object} data
 * @param {number} bx - Block X
 * @param {number} by - Block Y (Z axis)
 * @returns {number[]} four palette slots
 */
export function blockLayers(data, bx, by) {
    const base = blockIndex(bx, by, data.blockCount) * TERRAIN_MAX_BLEND_LAYERS;
    const out = [];
    for (let k = 0; k < TERRAIN_MAX_BLEND_LAYERS; k++) out.push(data.layerBuffer[base + k]);
    return out;
}

/**
 * Write the four palette slots of a block — the write counterpart of {@link blockLayers}
 * (`Terrain.setBlockLayer`, terrain.ts:2152-2155, applied to all four channels). Fewer than
 * four entries are padded with `-1`; slots must be `-1` or a palette index in
 * `0..TERRAIN_MAX_LAYER_COUNT-1`.
 * @param {object} data
 * @param {number} bx - Block X
 * @param {number} by - Block Y (Z axis)
 * @param {number[]} slots - Up to 4 palette slots
 * @throws {Error} on an out-of-range block or slot value
 */
export function setBlockLayers(data, bx, by, slots) {
    const bc = data.blockCount;
    if (!isIntegerIn(bx, 0, bc[0] - 1) || !isIntegerIn(by, 0, bc[1] - 1)) {
        throw new Error(
            `terrain: block [${bx},${by}] is outside blockCount [${bc[0]},${bc[1]}]`
        );
    }
    if (!Array.isArray(slots) && !ArrayBuffer.isView(slots)) {
        throw new Error('terrain: block layers must be an array of up to 4 palette slots');
    }
    if (slots.length > TERRAIN_MAX_BLEND_LAYERS) {
        throw new Error(
            `terrain: a block has only ${TERRAIN_MAX_BLEND_LAYERS} blend slots, got ${slots.length}`
        );
    }
    for (let k = 0; k < slots.length; k++) {
        if (!isIntegerIn(slots[k], -1, TERRAIN_MAX_LAYER_COUNT - 1)) {
            throw new Error(
                `terrain: block layer [${k}] = ${slots[k]} must be -1 (empty) or a palette slot ` +
                `in 0..${TERRAIN_MAX_LAYER_COUNT - 1}`
            );
        }
    }
    const base = blockIndex(bx, by, bc) * TERRAIN_MAX_BLEND_LAYERS;
    for (let k = 0; k < TERRAIN_MAX_BLEND_LAYERS; k++) {
        data.layerBuffer[base + k] = k < slots.length ? slots[k] : -1;
    }
}

/**
 * Highest channel index `k` with `slots[k] >= 0`, or 0 — port of `TerrainBlock.getMaxLayer`
 * (terrain.ts:857-869). `LAYERS = maxLayerIndex + 1`; when it is 0 the shader draws
 * `detailMap0` and never samples the weight map at all (terrain.ts:879, :920-930).
 * @param {number[]} slots - The four block slots
 * @returns {number}
 */
export function maxLayerIndex(slots) {
    if (slots[3] >= 0) return 3;
    if (slots[2] >= 0) return 2;
    if (slots[1] >= 0) return 1;
    return 0;
}

// --- Reading ----------------------------------------------------------------

/** Bounds-checked little-endian cursor over the payload */
class Cursor {
    constructor(buf) {
        this.buf = buf;
        this.pos = 0;
    }

    #need(n, what) {
        if (this.pos + n > this.buf.length) {
            throw new Error(
                `terrain: truncated ${what} at byte ${this.pos} — need ${n} byte(s), ` +
                `${this.buf.length - this.pos} left (file is ${this.buf.length} bytes)`
            );
        }
    }

    int32(what) {
        this.#need(4, what);
        const v = this.buf.readInt32LE(this.pos);
        this.pos += 4;
        return v;
    }

    int16(what) {
        this.#need(2, what);
        const v = this.buf.readInt16LE(this.pos);
        this.pos += 2;
        return v;
    }

    float(what) {
        this.#need(4, what);
        const v = this.buf.readFloatLE(this.pos);
        this.pos += 4;
        return v;
    }

    double(what) {
        this.#need(8, what);
        const v = this.buf.readDoubleLE(this.pos);
        this.pos += 8;
        return v;
    }

    /** i32 element count, sanity-checked against the bytes actually left */
    count(elemSize, what) {
        const at = this.pos;
        const n = this.int32(`${what} count`);
        if (n < 0) {
            throw new Error(`terrain: negative ${what} count ${n} at byte ${at}`);
        }
        const remaining = this.buf.length - this.pos;
        if (n * elemSize > remaining) {
            throw new Error(
                `terrain: ${what} count ${n} at byte ${at} needs ${n * elemSize} byte(s), ` +
                `only ${remaining} left (file is ${this.buf.length} bytes)`
            );
        }
        return n;
    }

    /**
     * Port of `TerrainBuffer.readString` (terrain-asset.ts:212-221): an i32 char count
     * followed by one byte per char, decoded through the engine's SIGNED `readInt8`.
     * Ids in real files are ASCII; a byte >= 0x80 becomes a garbage char in the engine too.
     */
    string(what) {
        const n = this.count(1, what);
        let s = '';
        for (let k = 0; k < n; k++) s += String.fromCharCode(this.buf.readInt8(this.pos + k));
        this.pos += n;
        return s;
    }
}

function toBuffer(input) {
    if (Buffer.isBuffer(input)) return input;
    if (ArrayBuffer.isView(input)) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    if (input instanceof ArrayBuffer) return Buffer.from(input);
    return null;
}

/**
 * The class defaults a sentinel (or a V1 file) leaves untouched
 * (`TerrainAsset`, terrain-asset.ts:264-276).
 */
function sentinelData() {
    return {
        version: TERRAIN_DATA_VERSION_DEFAULT,
        isDefaultSentinel: true,
        tileSize: 1,
        rawTileSize: 1,
        blockCount: [1, 1],
        weightMapSize: 128,
        lightMapSize: 128,
        heights: new Uint16Array(0),
        normals: new Float32Array(0),
        weights: new Uint8Array(0),
        // NOTE: length 4, not empty — terrain-asset.ts:271
        layerBuffer: Int16Array.from([-1, -1, -1, -1]),
        layers: [],
        payloadLength: 4,
    };
}

/**
 * Parse a `.terrain` binary — port of `TerrainAsset._loadNativeData`
 * (terrain-asset.ts:461-565), including the per-version field guards and the
 * pre-V8 1/512 → 1/128 height migration.
 *
 * Returns `null` (glb.js convention) when the buffer is empty or the magic is not a
 * recognized terrain version; throws with byte offsets on structural corruption
 * (truncated stream, counts that overrun the file).
 *
 * `tileSize` is the SNAPPED value the engine works with; `rawTileSize` is what the file
 * literally stores. They differ only for a file whose stored value was never snapped (the
 * editor writes `Terrain._tileSize` unmodified — terrain.ts:1585/1662 — and the snap happens
 * on load), and {@link writeTerrain} puts `rawTileSize` back so such a file still round-trips
 * byte-identically.
 *
 * `skipPayload` walks the same offsets without COPYING the four big arrays (empty, next to their
 * counts and `payloadSkipped`) — the layer table sits behind them. See {@link readTerrainLayout}.
 *
 * @param {Buffer|Uint8Array|ArrayBuffer} buffer - Whole file contents
 * @param {{skipPayload?: boolean}} [options]
 * @returns {object|null} `{version, isDefaultSentinel, tileSize, rawTileSize, blockCount,
 *   weightMapSize, lightMapSize, heights: Uint16Array, normals: Float32Array,
 *   weights: Uint8Array, layerBuffer: Int16Array,
 *   layers: [{slot, tileSize, detailMapId, normalMapId, roughness, metallic}],
 *   payloadLength}` — plus `{payloadSkipped, heightCount, normalCount, weightCount,
 *   layerBufferCount}` and empty arrays under `skipPayload`
 */
export function readTerrain(buffer, options = {}) {
    const skipPayload = options.skipPayload === true;
    const buf = toBuffer(buffer);
    if (!buf || buf.length < 4) return null;

    const version = buf.readInt32LE(0);
    // terrain-asset.ts:471-473 — the sentinel stops the parse, everything stays default
    if (version === TERRAIN_DATA_VERSION_DEFAULT) return sentinelData();
    if (!isKnownVersion(version)) return null;

    const s = new Cursor(buf);
    s.pos = 4;

    // --- geometry info (terrain-asset.ts:486-495) ---
    const rawTileSize = version >= TERRAIN_DATA_VERSION7 ? s.double('tileSize') : s.float('tileSize');
    const tileSize = snapTileSize(rawTileSize);
    const blockCount = [s.int32('blockCount[0]'), s.int32('blockCount[1]')];
    const weightMapSize = s.int16('weightMapSize');
    const lightMapSize = s.int16('lightMapSize');

    // --- heights (terrain-asset.ts:498-510) ---
    // The engine reads with the SIGNED readInt16 into a Uint16Array; the wraparound
    // cancels, so the wire format is plain u16 LE — read it as unsigned.
    const heightCount = s.count(2, 'heights');
    let heights = new Uint16Array(0);
    if (skipPayload) {
        s.pos += heightCount * 2;
    } else {
        heights = new Uint16Array(heightCount);
        for (let i = 0; i < heightCount; i++) {
            heights[i] = buf.readUInt16LE(s.pos + i * 2);
        }
        s.pos += heightCount * 2;

        if (version < TERRAIN_DATA_VERSION8) {
            // terrain-asset.ts:504-510 — simplifies to trunc(32768 + (raw - 32768) * 0.25);
            // the Uint16Array store truncates toward zero (40959.75 → 40959).
            for (let i = 0; i < heightCount; i++) {
                const h = (heights[i] - TERRAIN_HEIGHT_BASE) * TERRAIN_HEIGHT_FACTOR_V7;
                heights[i] = TERRAIN_HEIGHT_BASE + h / TERRAIN_HEIGHT_FACTOR;
            }
        }
    }

    // --- normals, >= V6 only (terrain-asset.ts:513-519) ---
    let normals = new Float32Array(0);
    let normalCount = 0;
    if (version >= TERRAIN_DATA_VERSION6) {
        normalCount = s.count(4, 'normals');
        if (skipPayload) {
            s.pos += normalCount * 4;
        } else {
            normals = new Float32Array(normalCount);
            for (let i = 0; i < normalCount; i++) {
                normals[i] = buf.readFloatLE(s.pos + i * 4);
            }
            s.pos += normalCount * 4;
        }
    }

    // --- weights, all versions (terrain-asset.ts:522-526) ---
    const weightCount = s.count(1, 'weights');
    let weights = new Uint8Array(0);
    if (skipPayload) {
        s.pos += weightCount;
    } else {
        weights = new Uint8Array(weightCount);
        for (let i = 0; i < weightCount; i++) weights[i] = buf[s.pos + i];
        s.pos += weightCount;
    }

    // --- layerBuffer, >= V2 (terrain-asset.ts:529-535) ---
    let layerBuffer = skipPayload ? new Int16Array(0) : Int16Array.from([-1, -1, -1, -1]);
    let layerBufferCount = version >= TERRAIN_DATA_VERSION2 ? 0 : layerBuffer.length;
    if (version >= TERRAIN_DATA_VERSION2) {
        layerBufferCount = s.count(2, 'layerBuffer');
        if (skipPayload) {
            s.pos += layerBufferCount * 2;
        } else {
            layerBuffer = new Int16Array(layerBufferCount);
            for (let i = 0; i < layerBufferCount; i++) {
                layerBuffer[i] = buf.readInt16LE(s.pos + i * 2); // signed: -1 = empty slot
            }
            s.pos += layerBufferCount * 2;
        }
    }

    // --- layerInfos, >= V3 (terrain-asset.ts:538-562) ---
    const layers = [];
    if (version >= TERRAIN_DATA_VERSION3) {
        // Smallest possible record: slot i32 + tileSize f32 + empty string = 12 bytes
        const layerCount = s.count(12, 'layerInfos');
        for (let i = 0; i < layerCount; i++) {
            const layer = {
                slot: s.int32(`layerInfos[${i}].slot`),
                tileSize: version >= TERRAIN_DATA_VERSION7
                    ? s.double(`layerInfos[${i}].tileSize`)
                    : s.float(`layerInfos[${i}].tileSize`),
                detailMapId: s.string(`layerInfos[${i}].detailMapId`),
                normalMapId: '',
                roughness: 1,
                metallic: 0,
            };
            if (version >= TERRAIN_DATA_VERSION4) {
                layer.normalMapId = s.string(`layerInfos[${i}].normalMapId`);
                layer.roughness = version >= TERRAIN_DATA_VERSION7
                    ? s.double(`layerInfos[${i}].roughness`)
                    : s.float(`layerInfos[${i}].roughness`);
                layer.metallic = version >= TERRAIN_DATA_VERSION7
                    ? s.double(`layerInfos[${i}].metallic`)
                    : s.float(`layerInfos[${i}].metallic`);
            }
            layers.push(layer);
        }
    }

    return {
        version,
        isDefaultSentinel: false,
        tileSize,
        rawTileSize,
        blockCount,
        weightMapSize,
        lightMapSize,
        heights,
        normals,
        weights,
        layerBuffer,
        layers,
        payloadLength: s.pos,
        ...(skipPayload
            ? { payloadSkipped: true, heightCount, normalCount, weightCount, layerBufferCount }
            : {}),
    };
}

/**
 * Geometry + layer palette only ({@link readTerrain} with `skipPayload` + the file read): for a
 * caller that CHECKS a terrain, not one that samples or edits it (~70 MB of copies skipped).
 * @param {string} filePath - Absolute path to the `.terrain` file
 * @returns {object|null} as {@link readTerrain} with `skipPayload`, or null when not a terrain
 * @throws {Error} on unreadable files (fs errors) or structural corruption
 */
export function readTerrainLayout(filePath) {
    return readTerrain(fs.readFileSync(filePath), { skipPayload: true });
}

/**
 * The scalar half of {@link validateTerrainData}: everything that decides how big the
 * buffers are. Split out so allocating code can check BEFORE it allocates.
 * @param {object} data - Terrain data object (only the scalar fields are read)
 * @throws {Error} naming the offending field
 */
export function validateTerrainGeometry(data) {
    // Order matters: the messages are the caller-facing contract, so the sizing and
    // format-only checks stay interleaved exactly as they were before the split.
    checkBlockCount(data);
    if (!Number.isFinite(data.tileSize) || data.tileSize <= 0) {
        throw new Error(`terrain: tileSize must be a finite number > 0, got ${data.tileSize}`);
    }
    checkWeightMapRange(data);
    const wms = data.weightMapSize;
    if ((wms & (wms - 1)) !== 0) {
        throw new Error(`terrain: weightMapSize = ${wms} must be a power of two`);
    }
    if (!isIntegerIn(data.lightMapSize, -32768, 32767)) {
        throw new Error(`terrain: lightMapSize = ${data.lightMapSize} must be an integer in the i16 range`);
    }
}

/** blockCount: a pair of positive integers — the height/layerBuffer sizing input */
function checkBlockCount(data) {
    if (!data || typeof data !== 'object') throw new Error('terrain: data must be an object');
    const bc = data.blockCount;
    if (!Array.isArray(bc) || bc.length !== 2) {
        throw new Error('terrain: blockCount must be an array of exactly 2 numbers');
    }
    for (let k = 0; k < 2; k++) {
        if (!isIntegerIn(bc[k], 1, 0x7fffffff)) {
            throw new Error(`terrain: blockCount[${k}] = ${bc[k]} must be an integer >= 1`);
        }
    }
}

/** weightMapSize in the i16 range — the weights/texel sizing input, power-of-two aside */
function checkWeightMapRange(data) {
    const wms = data.weightMapSize;
    if (!isIntegerIn(wms, 2, 32767)) {
        throw new Error(`terrain: weightMapSize = ${wms} must be an integer in 2..32767`);
    }
}

/** The two authoring caps of {@link validateTerrainCapacity}, geometry rules aside */
function checkCapacityCaps(data) {
    const [bc0, bc1] = data.blockCount;
    const blocks = bc0 * bc1;
    if (blocks > TERRAIN_MAX_BLOCKS) {
        throw new Error(
            `terrain: blockCount [${bc0},${bc1}] = ${blocks} blocks exceeds ` +
            `TERRAIN_MAX_BLOCKS (${TERRAIN_MAX_BLOCKS}) — that grid would need ` +
            `${(bc0 * 32 + 1) * (bc1 * 32 + 1)} height samples`
        );
    }
    const texels = data.weightMapSize * data.weightMapSize * blocks;
    if (texels > TERRAIN_MAX_WEIGHT_TEXELS) {
        throw new Error(
            `terrain: blockCount [${bc0},${bc1}] with weightMapSize ${data.weightMapSize} ` +
            `needs ${texels} weight texels, over TERRAIN_MAX_WEIGHT_TEXELS ` +
            `(${TERRAIN_MAX_WEIGHT_TEXELS}) — use fewer blocks or a smaller weight map`
        );
    }
}

/**
 * Sizing fields + both caps, format rules waived (power-of-two `weightMapSize`, `tileSize`,
 * `lightMapSize` range): for a batch that must rebuild buffers before its `set_info` repairs them.
 * @param {object} data - Terrain data object (only the scalar fields are read)
 * @throws {Error} naming the offending field
 */
export function validateTerrainAllocation(data) {
    checkBlockCount(data);
    checkWeightMapRange(data);
    checkCapacityCaps(data);
}

/**
 * The allocation guard on top of {@link validateTerrainGeometry}: refuses geometries whose
 * buffers would not fit in a sane amount of memory. Exported so builders/ops can reject an
 * oversized spec with their own message before anything is allocated.
 * @param {object} data - Terrain data object (only the scalar fields are read)
 * @throws {Error} when the geometry is invalid or exceeds the authoring caps
 */
export function validateTerrainCapacity(data) {
    validateTerrainGeometry(data);
    checkCapacityCaps(data);
}

/**
 * The stored (unsnapped) tileSize to write for `data`, or `undefined` when there is no
 * trustworthy one. A `rawTileSize` is only honoured while it still snaps to the effective
 * `tileSize` — otherwise it is a leftover from before somebody changed `tileSize` and must
 * not silently win.
 * @param {object} data
 * @returns {number|undefined}
 */
function consistentRawTileSize(data) {
    const raw = data.rawTileSize;
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
    return snapTileSize(raw) === data.tileSize ? raw : undefined;
}

/**
 * Fill in the buffers the engine would materialize on load — port of the sizing branches
 * of `Terrain._buildImp` (terrain.ts:2481-2526): missing/mis-sized heights become
 * `TERRAIN_HEIGHT_BASE` (0 m), weights `(255, 0, 0, 0)`, layerBuffer all `-1`.
 * Normals stay empty (the engine recomputes them and never writes them back).
 *
 * The geometry is validated and capacity-checked FIRST ({@link validateTerrainCapacity}) —
 * these buffers are sized from `blockCount`/`weightMapSize`, which on the authoring path
 * come straight from a spec, so an unchecked pair would mean a multi-gigabyte allocation
 * long before {@link writeTerrain} ever validates anything.
 *
 * `allowUnwritableGeometry` drops that to {@link validateTerrainAllocation}: still sized and
 * capped, but a geometry the FORMAT refuses is accepted — the caller must replace it to write.
 *
 * Returns a NEW data object; the input is not mutated. Use this to turn a sentinel into
 * a writable terrain before editing.
 *
 * @param {object} data - Terrain data object (e.g. from {@link readTerrain})
 * @param {{allowUnwritableGeometry?: boolean}} [options]
 * @returns {object} Materialized data object, version V8
 * @throws {Error} when the geometry is invalid or exceeds the authoring caps
 */
export function materialize(data, options = {}) {
    if (options.allowUnwritableGeometry) validateTerrainAllocation(data);
    else validateTerrainCapacity(data);
    const blockCount = [data.blockCount[0], data.blockCount[1]];
    const expected = expectedCounts(blockCount, data.weightMapSize);

    let heights = data.heights;
    if (!heights || heights.length !== expected.heights) {
        heights = new Uint16Array(expected.heights).fill(TERRAIN_HEIGHT_BASE);
    } else {
        heights = Uint16Array.from(heights);
    }

    let weights = data.weights;
    if (!weights || weights.length !== expected.weights) {
        weights = new Uint8Array(expected.weights);
        for (let i = 0; i < expected.weights; i += 4) weights[i] = 255;
    } else {
        weights = Uint8Array.from(weights);
    }

    let layerBuffer = data.layerBuffer;
    if (!layerBuffer || layerBuffer.length !== expected.layerBuffer) {
        layerBuffer = new Int16Array(expected.layerBuffer).fill(-1);
    } else {
        layerBuffer = Int16Array.from(layerBuffer);
    }

    return {
        version: TERRAIN_DATA_VERSION8,
        isDefaultSentinel: false,
        tileSize: data.tileSize,
        rawTileSize: consistentRawTileSize(data) ?? data.tileSize,
        blockCount,
        weightMapSize: data.weightMapSize,
        lightMapSize: data.lightMapSize,
        heights,
        normals: new Float32Array(0),
        weights,
        layerBuffer,
        layers: (data.layers ?? []).map((l) => ({ ...l })),
    };
}

// --- Sampling ---------------------------------------------------------------

/**
 * Height in metres at a local point — exact port of `Terrain.getHeightAt`
 * (terrain.ts:1876-1914). NOT plain bilinear: the quad is split along the `b`-`c`
 * diagonal by `dx + dz <= 1` and the far corner is extrapolated (`m = (b+c)/2; d = 2m - a`).
 *
 * Returns `null` when the base corner falls outside `[0, vertexCount-1]` — note the engine
 * tolerates up to one whole tile PAST the far edge (`dx`/`dz` are computed before the clamp,
 * so that strip extrapolates flat), and that heights must be materialized (a sentinel
 * yields `null`). A non-finite/non-numeric coordinate is `null` too, never `NaN`.
 *
 * @param {object} data - Terrain data object
 * @param {number} x - Local X in metres
 * @param {number} z - Local Z in metres
 * @returns {number|null} metres, or null when out of range / no height data
 */
export function heightAt(data, x, z) {
    if (typeof x !== 'number' || typeof z !== 'number'
        || !Number.isFinite(x) || !Number.isFinite(z)) return null;
    const [vx, vz] = vertexCounts(data.blockCount);
    if (!data.heights || data.heights.length !== vx * vz) return null;
    if (!(data.tileSize > 0)) return null;

    const fx = x / data.tileSize;
    const fz = z / data.tileSize;

    let ix0 = Math.floor(fx);
    let iz0 = Math.floor(fz);
    let ix1 = ix0 + 1;
    let iz1 = iz0 + 1;
    const dx = fx - ix0; // terrain.ts:1884-1885 — computed BEFORE the clamp
    const dz = fz - iz0;

    if (ix0 < 0 || ix0 > vx - 1 || iz0 < 0 || iz0 > vz - 1) return null; // terrain.ts:1887-1889

    ix0 = clamp(ix0, 0, vx - 1);
    iz0 = clamp(iz0, 0, vz - 1);
    ix1 = clamp(ix1, 0, vx - 1);
    iz1 = clamp(iz1, 0, vz - 1);

    let a = getVertexHeight(data, ix0, iz0);
    const b = getVertexHeight(data, ix1, iz0);
    const c = getVertexHeight(data, ix0, iz1);
    let d = getVertexHeight(data, ix1, iz1);
    const m = (b + c) * 0.5;

    if (dx + dz <= 1.0) d = m + (m - a);
    else a = m + (m - d);

    const h1 = a * (1.0 - dx) + b * dx;
    const h2 = c * (1.0 - dx) + d * dx;
    return h1 * (1.0 - dz) + h2 * dz;
}

/**
 * Local metres → weight-map sampling coordinates, BLOCK-LOCALLY.
 *
 * The weight map is one logical global array, but the engine uses it as one independent
 * `weightMapSize x weightMapSize` texture PER BLOCK: `TerrainBlock._updateWeightMap`
 * (terrain.ts:920-955) uploads the block's sub-rect into a texture with
 * `WrapMode.CLAMP_TO_EDGE`, and the vertex uv fed to it is block-local
 * `(i / 32, j / 32)` (terrain.ts:1170). Sampling therefore never crosses a block boundary,
 * and the engine's own resampler agrees — `Terrain._rebuildWeights` maps
 * `u / (weightMapSize - 1) * (oldWeightMapSize - 1)` inside a per-block `uOff/vOff` window
 * (terrain.ts:2670-2683). This helper reproduces exactly that mapping (endpoint-inclusive
 * over the block, so the block's first and last texel land on its edges), which is what
 * {@link weightAt} and any painting code must share.
 *
 * @param {object} data - Terrain data object
 * @param {number} x - Local X in metres
 * @param {number} z - Local Z in metres
 * @returns {{block: number[], local: number[], texelFloat: number[], texel: number[],
 *   texelLocal: number[]}|null} `block` = `[bx, by]`, `local` = the 0..1 position inside the
 *   block, `texelFloat` = block-local fractional texel coords, `texelLocal`/`texel` = the
 *   containing texel, block-local and in the GLOBAL map. Null when outside the terrain.
 */
export function weightTexelAt(data, x, z) {
    if (typeof x !== 'number' || typeof z !== 'number'
        || !Number.isFinite(x) || !Number.isFinite(z)) return null;
    const bc = data.blockCount;
    const wms = data.weightMapSize;
    const [sw, sh] = terrainSize(data);
    if (!(wms >= 1) || !(sw > 0) || !(sh > 0)) return null;
    if (x < 0 || z < 0 || x > sw || z > sh) return null;

    const blockSize = TERRAIN_BLOCK_TILE_COMPLEXITY * data.tileSize;
    const bx = clamp(Math.floor(x / blockSize), 0, bc[0] - 1);
    const by = clamp(Math.floor(z / blockSize), 0, bc[1] - 1);
    const u = (x - bx * blockSize) / blockSize;
    const v = (z - by * blockSize) / blockSize;
    // Snap to an exact texel index before flooring. Subtracting the block's metre offset from a
    // coordinate that {@link texelPosition} built by ADDING it does not cancel exactly in binary
    // floating point: for block 1 of a 32 m grid, texel 1 comes back as 0.9999999999999998, and a
    // bare `Math.floor` would report the PREVIOUS texel with `dx ~= 1` — i.e. a neighbouring
    // texel's weights for a coordinate sitting exactly on this one. The error is ~1e-14 relative,
    // so a 1e-9 snap is orders of magnitude away from ever moving a genuine in-between sample.
    const fx = clamp(snapToIndex(u * (wms - 1)), 0, wms - 1);
    const fz = clamp(snapToIndex(v * (wms - 1)), 0, wms - 1);
    const ix = Math.min(Math.floor(fx), wms - 1);
    const iz = Math.min(Math.floor(fz), wms - 1);

    return {
        block: [bx, by],
        local: [u, v],
        texelFloat: [fx, fz],
        texelLocal: [ix, iz],
        texel: [bx * wms + ix, by * wms + iz],
    };
}

/**
 * Blend weights and dominant layer at a local point.
 *
 * **Deliberate divergences from the engine.** `Terrain.getWeightAt` (terrain.ts:2034-2083)
 * computes `fx = x / (weightMapSize * blockCount[0])` — world metres divided by a TEXEL
 * COUNT — so every in-terrain coordinate lands on texel 0; and
 * `Terrain.getMaxWeightLayerAt` (terrain.ts:2089-2124) compares `w.y > w[i]` with numeric
 * indexing of a `Vec4` (`w[0]` is `undefined`, so every comparison is false), tests `w.y`
 * twice, never tests `w.w`, and derives the block from `floor(x / weightMapSize)` — it
 * therefore always returns the layer of channel 0. Only the interpolation KERNEL is ported
 * here; the coordinate mapping (metres → texel space) and the argmax are corrected.
 *
 * The mapping is the block-local one of {@link weightTexelAt}, and the kernel is clamped to
 * the owning block's texel range, exactly like the per-block CLAMP_TO_EDGE texture the
 * renderer samples — so `texel` always lies inside `block` and the returned `weights` belong
 * to the reported `layers`. (Remaining, unavoidable divergence: the GPU does plain bilinear
 * filtering on `uv * wms - 0.5`, while this — like every sampling path in the engine's own
 * TypeScript — uses the diagonal-split kernel on endpoint-inclusive coordinates. The two
 * agree on texel centres and differ by up to half a texel in between.)
 *
 * Weights are NOT clamped to 0..1: like the engine kernel, the diagonal extrapolation can
 * overshoot. The shader does no normalization either (legacy `terrain.effect:158-172` is a
 * plain weighted sum), and a block whose only assigned channel is 0 ignores the weight map
 * entirely — reported as `blockIgnoresWeights`.
 *
 * @param {object} data - Terrain data object
 * @param {number} x - Local X in metres
 * @param {number} z - Local Z in metres
 * @returns {object|null} `{weights: [r,g,b,a], layers: [4 palette slots], dominantLayer,
 *   dominantWeight, texel: [i,j] (global), block: [bx,by], blockIgnoresWeights}`, or null
 *   when out of range. `layers`/`dominantLayer` are palette indices — see the module header.
 */
export function weightAt(data, x, z) {
    const [uWC, vWC] = weightMapDims(data);
    if (uWC <= 0 || vWC <= 0) return null;
    if (!data.weights || data.weights.length !== uWC * vWC * 4) return null;

    const at = weightTexelAt(data, x, z);
    if (!at) return null;

    const wms = data.weightMapSize;
    const [bx, by] = at.block;
    const [fx, fz] = at.texelFloat;

    // Kernel window, clamped INSIDE the block (terrain.ts:2637-2641 `min(ix0+1, wms-1)`
    // plus the `uOff`/`vOff` block offset) — the renderer's texture cannot read a
    // neighbouring block either.
    const lx0 = at.texelLocal[0];
    const lz0 = at.texelLocal[1];
    const dx = fx - lx0;
    const dz = fz - lz0;
    const ix0 = bx * wms + lx0;
    const iz0 = by * wms + lz0;
    const ix1 = bx * wms + Math.min(lx0 + 1, wms - 1);
    const iz1 = by * wms + Math.min(lz0 + 1, wms - 1);

    // Engine kernel (terrain.ts:2059-2082), verbatim apart from the Vec4 plumbing.
    let a = weightAtTexel(data, ix0, iz0);
    const b = weightAtTexel(data, ix1, iz0);
    const c = weightAtTexel(data, ix0, iz1);
    let d = weightAtTexel(data, ix1, iz1);
    const m = b.map((v, k) => (v + c[k]) * 0.5);

    if (dx + dz <= 1.0) d = m.map((v, k) => v + (v - a[k]));
    else a = m.map((v, k) => v + (v - d[k]));

    const weights = a.map((av, k) => {
        const n1 = av + (b[k] - av) * dx;
        const n2 = c[k] + (d[k] - c[k]) * dx;
        return n1 + (n2 - n1) * dz;
    });

    const slots = blockLayers(data, bx, by);

    let dominantLayer = null;
    let dominantWeight = 0;
    for (let k = 0; k < TERRAIN_MAX_BLEND_LAYERS; k++) {
        // strict '>' — lowest channel index wins a tie, matching the engine's intent
        if (slots[k] >= 0 && (dominantLayer === null || weights[k] > dominantWeight)) {
            dominantLayer = slots[k];
            dominantWeight = weights[k];
        }
    }

    return {
        weights,
        layers: slots,
        dominantLayer,
        dominantWeight,
        texel: [ix0, iz0],
        block: [bx, by],
        blockIgnoresWeights: maxLayerIndex(slots) === 0,
    };
}

/**
 * Dump the height grid as rows of metres — the counterpart of
 * `Terrain.exportHeightField` (terrain.ts:1641-1657), which samples
 * `u = i / (w - 1)` over the terrain extent and evaluates `getHeightAt`.
 *
 * Deviations from the engine, both deliberate: values are metres (the engine multiplies by
 * a `heightScale` and stores raw into a `Uint16Array`, wrapping on negatives — use
 * {@link heightToRaw} for a raw16 dump), and an out-of-range sample yields `null` in place
 * instead of shifting the rest of the grid (the engine only advances its write index on a
 * non-null sample).
 *
 * Sizes are capped: each axis at 8192 samples and the product at 1e6 cells — an explicit
 * `sampleCount` over either cap is an error, while the DEFAULT resolution is clamped down
 * (a huge terrain dumps coarsely instead of throwing; check `rows.length` if it matters).
 *
 * @param {object} data - Terrain data object
 * @param {{x?: number, z?: number, width?: number, depth?: number}} [region] - Local metres;
 *   defaults to the whole terrain
 * @param {number|number[]} [sampleCount] - Samples per axis (`n` or `[cols, rows]`);
 *   defaults to the vertex resolution of the region, clamped to the caps
 * @returns {Array<Array<number|null>>} `rows[j][i]`, metres
 */
export function exportHeights(data, region = null, sampleCount = null) {
    const [sw, sh] = terrainSize(data);
    const r = {
        x: region?.x ?? 0,
        z: region?.z ?? 0,
        width: region?.width ?? sw,
        depth: region?.depth ?? sh,
    };
    for (const key of ['x', 'z', 'width', 'depth']) {
        if (!Number.isFinite(r[key])) throw new Error(`terrain: region.${key} must be a finite number`);
    }
    if (r.width < 0 || r.depth < 0) throw new Error('terrain: region width/depth must not be negative');

    let cols;
    let rowCount;
    if (sampleCount === null || sampleCount === undefined) {
        // Derived resolution: clamp rather than throw — the caller asked for "the whole
        // thing" and a 300x300-block terrain would otherwise be undumpable.
        cols = clamp(Math.max(2, Math.round(r.width / data.tileSize) + 1), 2, MAX_EXPORT_SAMPLES);
        rowCount = clamp(Math.max(2, Math.round(r.depth / data.tileSize) + 1), 2, MAX_EXPORT_SAMPLES);
        if (cols * rowCount > MAX_EXPORT_CELLS) {
            // Scale both axes alike to keep the aspect, then bound the product outright: today's
            // constants make the sqrt enough, and the clamps hold for any others.
            const scale = Math.sqrt(MAX_EXPORT_CELLS / (cols * rowCount));
            const colCap = Math.max(2, Math.floor(MAX_EXPORT_CELLS / 2));
            cols = clamp(Math.max(2, Math.floor(cols * scale)), 2, colCap);
            rowCount = clamp(Math.max(2, Math.floor(rowCount * scale)), 2,
                Math.max(2, Math.floor(MAX_EXPORT_CELLS / cols)));
        }
    } else {
        const pair = Array.isArray(sampleCount) ? sampleCount : [sampleCount, sampleCount];
        cols = pair[0];
        rowCount = pair[1];
        for (const [name, n] of [['cols', cols], ['rows', rowCount]]) {
            if (!Number.isInteger(n) || n < 1 || n > MAX_EXPORT_SAMPLES) {
                throw new Error(
                    `terrain: sampleCount ${name} must be an integer in 1..${MAX_EXPORT_SAMPLES}, ` +
                    `got ${show(n)}`
                );
            }
        }
        if (cols * rowCount > MAX_EXPORT_CELLS) {
            throw new Error(
                `terrain: sampleCount ${cols}x${rowCount} = ${cols * rowCount} samples exceeds ` +
                `${MAX_EXPORT_CELLS} — ask for a smaller region or a coarser sampleCount`
            );
        }
    }

    const rows = [];
    for (let j = 0; j < rowCount; j++) {
        const v = rowCount === 1 ? 0 : j / (rowCount - 1);
        const z = r.z + v * r.depth;
        const row = new Array(cols);
        for (let i = 0; i < cols; i++) {
            const u = cols === 1 ? 0 : i / (cols - 1);
            row[i] = heightAt(data, r.x + u * r.width, z);
        }
        rows.push(row);
    }
    return rows;
}

// --- Validation + writing ---------------------------------------------------

function isIntegerIn(v, min, max) {
    return Number.isInteger(v) && v >= min && v <= max;
}

function isAscii(str) {
    for (let i = 0; i < str.length; i++) if (str.charCodeAt(i) > 0x7f) return false;
    return true;
}

function checkElements(arr, name, min, max) {
    // Skip the element loop only when the typed array's OWN representable range already
    // fits inside the requested one — a Uint16Array handed in as `weights` (checked against
    // 0..255) must still be inspected, otherwise the writer would silently truncate it.
    const native = arr instanceof Uint8Array ? [0, 255]
        : arr instanceof Uint16Array ? [0, 65535]
            : null;
    if (native && native[0] >= min && native[1] <= max) return;
    for (let i = 0; i < arr.length; i++) {
        if (!isIntegerIn(arr[i], min, max)) {
            throw new Error(`terrain: ${name}[${i}] = ${arr[i]} is not an integer in ${min}..${max}`);
        }
    }
}

/**
 * Throw a descriptive `Error` unless `data` can be written as a valid V8 binary.
 * Enforced beyond the raw format (documented deviations):
 * - `weightMapSize` must be a power of two >= 2 — the engine leaves the field
 *   unconstrained, but `_rebuildWeights` divides by `weightMapSize - 1`
 *   (terrain.ts:2682), so 1 is a division by zero, and the editor UI only offers pow-2.
 * - `layers[i].slot === i` — a dense palette. `_exportNativeData` overwrites the binary
 *   slot with the array index (terrain-asset.ts:613) while the library JSON keeps the true
 *   palette index, so the two encodings only agree when the palette has no holes.
 *
 * @param {object} data - Terrain data object
 * @throws {Error} naming the offending field
 */
export function validateTerrainData(data) {
    validateTerrainGeometry(data);

    const bc = data.blockCount;
    const wms = data.weightMapSize;
    // No capacity cap here on purpose: anything readTerrain produced from a real file must
    // stay writable, and by then the buffers exist already.
    const expected = expectedCounts(bc, wms);
    const [vx, vz] = vertexCounts(bc);

    if (!data.heights || data.heights.length !== expected.heights) {
        throw new Error(
            `terrain: heights length ${data.heights?.length ?? 'undefined'} does not match ` +
            `blockCount [${bc}] (expected ${expected.heights} = ${vx}x${vz} vertices)`
        );
    }
    checkElements(data.heights, 'heights', 0, 65535);

    if (!data.weights || data.weights.length !== expected.weights) {
        throw new Error(
            `terrain: weights length ${data.weights?.length ?? 'undefined'} does not match ` +
            `blockCount [${bc}] / weightMapSize ${wms} ` +
            `(expected ${expected.weights} = ${wms * bc[0]}x${wms * bc[1]} texels x 4 channels)`
        );
    }
    checkElements(data.weights, 'weights', 0, 255);

    if (!data.layerBuffer || data.layerBuffer.length !== expected.layerBuffer) {
        throw new Error(
            `terrain: layerBuffer length ${data.layerBuffer?.length ?? 'undefined'} does not match ` +
            `blockCount [${bc}] (expected ${expected.layerBuffer} = ${bc[0] * bc[1]} blocks x 4 slots)`
        );
    }
    for (let i = 0; i < data.layerBuffer.length; i++) {
        const v = data.layerBuffer[i];
        if (!isIntegerIn(v, -1, TERRAIN_MAX_LAYER_COUNT - 1)) {
            throw new Error(
                `terrain: layerBuffer[${i}] = ${v} must be -1 (empty) or a palette slot ` +
                `in 0..${TERRAIN_MAX_LAYER_COUNT - 1}`
            );
        }
    }

    const layers = data.layers ?? [];
    if (!Array.isArray(layers)) throw new Error('terrain: layers must be an array');
    if (layers.length > TERRAIN_MAX_LAYER_COUNT) {
        throw new Error(
            `terrain: ${layers.length} layers exceed TERRAIN_MAX_LAYER_COUNT (${TERRAIN_MAX_LAYER_COUNT})`
        );
    }
    layers.forEach((layer, i) => {
        if (!layer || typeof layer !== 'object') throw new Error(`terrain: layers[${i}] must be an object`);
        if (!isIntegerIn(layer.slot, 0, TERRAIN_MAX_LAYER_COUNT - 1)) {
            throw new Error(
                `terrain: layers[${i}].slot = ${layer.slot} must be an integer in ` +
                `0..${TERRAIN_MAX_LAYER_COUNT - 1}`
            );
        }
        if (layer.slot !== i) {
            throw new Error(
                `terrain: layers[${i}].slot = ${layer.slot} — the palette must stay dense ` +
                '(slot === array index), otherwise the binary and the library JSON disagree; ' +
                'use removeLayer()/compactPalette() to drop a layer and re-index the rest'
            );
        }
        if (!Number.isFinite(layer.tileSize) || layer.tileSize <= 0) {
            throw new Error(`terrain: layers[${i}].tileSize must be a finite number > 0, got ${layer.tileSize}`);
        }
        for (const key of ['roughness', 'metallic']) {
            if (!Number.isFinite(layer[key])) {
                throw new Error(`terrain: layers[${i}].${key} must be a finite number, got ${layer[key]}`);
            }
        }
        for (const key of ['detailMapId', 'normalMapId']) {
            const id = layer[key] ?? '';
            if (typeof id !== 'string') throw new Error(`terrain: layers[${i}].${key} must be a string`);
            if (!isAscii(id)) {
                throw new Error(
                    `terrain: layers[${i}].${key} contains non-ASCII characters — the engine's ` +
                    'readString decodes one signed byte per char and would mangle them'
                );
            }
        }
    });
}

/**
 * Re-index the palette so `layers[i].slot === i` again, remapping every `layerBuffer`
 * reference in the same pass. This is the invariant {@link validateTerrainData} enforces, and
 * it is format knowledge rather than op semantics — it lives here so that every caller that
 * drops or reorders palette entries produces the same result.
 *
 * Mutates `data` in place (`layers` entries are rewritten, `layerBuffer` remapped) and
 * returns what changed. A `layerBuffer` value with no matching layer record becomes `-1`.
 *
 * @param {object} data - Terrain data object
 * @returns {{remap: Map<number, number>, changedSlots: number, clearedRefs: number}}
 */
export function compactPalette(data) {
    const layers = data.layers ?? [];
    const remap = new Map();
    let changedSlots = 0;
    layers.forEach((layer, i) => {
        if (layer.slot !== i) changedSlots++;
        remap.set(layer.slot, i);
        layer.slot = i;
    });

    let clearedRefs = 0;
    const lb = data.layerBuffer ?? [];
    for (let i = 0; i < lb.length; i++) {
        const v = lb[i];
        if (v < 0) continue;
        const to = remap.has(v) ? remap.get(v) : -1;
        if (to === -1) clearedRefs++;
        lb[i] = to;
    }
    return { remap, changedSlots, clearedRefs };
}

/**
 * Drop palette entry `slot`: removes the layer record, drops every `layerBuffer` reference
 * to it, and left-packs the affected blocks' remaining channels — moving each surviving
 * channel's WEIGHTS along with it and zeroing the freed channels — then re-indexes the
 * palette via {@link compactPalette}.
 *
 * Left-packing matters: the shader derives its `LAYERS` count from the highest non-empty
 * channel (`TerrainBlock.getMaxLayer`, terrain.ts:857-869) and samples a null layer for any
 * empty channel below it, so simply blanking the channel in place would leave a hole that
 * renders as nothing.
 *
 * Mutates `data` in place. Blocks that never referenced the slot are untouched.
 *
 * @param {object} data - Terrain data object
 * @param {number} slot - Palette slot to remove
 * @returns {{removed: object, blocks: number[], remap: Map<number, number>}} `blocks` are
 *   block indices (`blockIndex`) that referenced the slot
 * @throws {Error} when there is no such layer record
 */
export function removeLayer(data, slot) {
    const layers = data.layers ?? [];
    const index = layers.findIndex((l) => l.slot === slot);
    if (index < 0) {
        throw new Error(
            `terrain: no palette layer with slot ${slot} (have ${layers.map((l) => l.slot).join(', ') || 'none'})`
        );
    }
    const [removed] = layers.splice(index, 1);

    const [bc0, bc1] = data.blockCount;
    const wms = data.weightMapSize;
    const [uWC] = weightMapDims(data);
    const expected = expectedCounts(data.blockCount, wms);
    const haveWeights = (data.weights?.length ?? 0) === expected.weights;
    const blocks = [];

    if ((data.layerBuffer?.length ?? 0) === expected.layerBuffer) {
        for (let by = 0; by < bc1; by++) {
            for (let bx = 0; bx < bc0; bx++) {
                const b = blockIndex(bx, by, data.blockCount);
                const slots = blockLayers(data, bx, by);
                if (!slots.includes(slot)) continue;
                blocks.push(b);

                // surviving channels, in order — the new channel n takes over `keep[n]`
                const keep = [];
                for (let k = 0; k < TERRAIN_MAX_BLEND_LAYERS; k++) {
                    if (slots[k] >= 0 && slots[k] !== slot) keep.push(k);
                }
                for (let k = 0; k < TERRAIN_MAX_BLEND_LAYERS; k++) {
                    data.layerBuffer[b * 4 + k] = k < keep.length ? slots[keep[k]] : -1;
                }
                if (!haveWeights) continue;
                for (let j = 0; j < wms; j++) {
                    const row = (by * wms + j) * uWC + bx * wms;
                    for (let i = 0; i < wms; i++) {
                        const base = (row + i) * 4;
                        const old = [
                            data.weights[base], data.weights[base + 1],
                            data.weights[base + 2], data.weights[base + 3],
                        ];
                        for (let k = 0; k < TERRAIN_MAX_BLEND_LAYERS; k++) {
                            data.weights[base + k] = k < keep.length ? old[keep[k]] : 0;
                        }
                    }
                }
            }
        }
    }

    const { remap } = compactPalette(data);
    return { removed, blocks, remap };
}

/**
 * Is this data object flagged as the empty default sentinel?
 * @param {object} data
 * @returns {boolean}
 */
function isSentinelFlagged(data) {
    return Boolean(data?.isDefaultSentinel) || data?.version === TERRAIN_DATA_VERSION_DEFAULT;
}

/**
 * Does the payload actually carry nothing, i.e. is the sentinel flag telling the truth?
 * The sentinel encodes "header only, all class defaults" (terrain-asset.ts:264-276): no
 * heights, no weights, no layers, and a layerBuffer that is empty or all `-1`.
 * @param {object} data
 * @returns {boolean}
 */
function isEmptyPayload(data) {
    if ((data.heights?.length ?? 0) !== 0) return false;
    if ((data.weights?.length ?? 0) !== 0) return false;
    if ((data.layers?.length ?? 0) !== 0) return false;
    const lb = data.layerBuffer ?? [];
    for (let i = 0; i < lb.length; i++) if (lb[i] !== -1) return false;
    return true;
}

/**
 * Payload length in bytes for the V8 encoding of `data` (normals count 0), i.e. the file
 * length before {@link padToCapacity}.
 * @param {object} data - Terrain data object
 * @returns {number}
 */
export function payloadLength(data) {
    if (isSentinelFlagged(data) && isEmptyPayload(data)) return 4;
    let len = 4 + 8 + 8 + 2 + 2 // version, tileSize, blockCount, weightMapSize, lightMapSize
        + 4 + 2 * data.heights.length
        + 4 // normals: always count 0
        + 4 + data.weights.length
        + 4 + 2 * data.layerBuffer.length
        + 4; // layerInfos count
    for (const layer of data.layers ?? []) {
        len += 4 + 8 // slot, tileSize
            + 4 + (layer.detailMapId ?? '').length
            + 4 + (layer.normalMapId ?? '').length
            + 8 + 8; // roughness, metallic
    }
    return len;
}

/**
 * The 2048-byte "empty" sentinel — port of `_exportDefaultNativeData`
 * (terrain-asset.ts:638-642): a single `0x01010111` version word inside an untouched
 * 2048-byte `TerrainBuffer`. Byte-identical to the editor's shipped
 * `editor/assets/default_file_content/terrain/default.terrain`.
 * @returns {Buffer}
 */
export function defaultSentinel() {
    const buf = Buffer.alloc(TERRAIN_BUFFER_MIN_CAPACITY);
    buf.writeInt32LE(TERRAIN_DATA_VERSION_DEFAULT, 0);
    return buf;
}

/**
 * Serialize a terrain data object — port of `TerrainAsset._exportNativeData`
 * (terrain-asset.ts:570-633), including the power-of-two zero padding.
 *
 * Always writes **V8** and **normals count 0**, exactly like the editor: `exportAsset`
 * never assigns `asset.normals` (terrain.ts:1659-1680) and the engine rebuilds them on load
 * when `normals.length !== vertexCount * 3` (terrain.ts:2496-2499). Any `data.normals` is
 * therefore read-only inspection data and is not written back.
 *
 * A sentinel data object (`isDefaultSentinel`, or `version` = the sentinel word) round-trips
 * to {@link defaultSentinel} — but only when its payload really is empty. A flag left over
 * on an object that carries heights/weights/layers is an ERROR, never a silent 2 KB empty
 * file: the editor's "Create → Terrain" ships the sentinel, so the first edit of a
 * user-created terrain runs on a sentinel-flagged object and dropping its data would destroy
 * the asset. Call {@link materialize} to turn a sentinel into a writable terrain.
 *
 * Everything else is validated by {@link validateTerrainData} first — nothing is written
 * when an invariant fails.
 *
 * @param {object} data - Terrain data object
 * @returns {Buffer} the whole file, padded with zeros
 * @throws {Error} on a failed invariant, or on a stale sentinel flag over real data
 */
export function writeTerrain(data) {
    if (isSentinelFlagged(data)) {
        if (isEmptyPayload(data)) return defaultSentinel();
        throw new Error(
            'terrain: data is flagged as the empty default sentinel ' +
            `(isDefaultSentinel/version 0x${TERRAIN_DATA_VERSION_DEFAULT.toString(16)}) but carries ` +
            `${data.heights?.length ?? 0} height(s), ${data.weights?.length ?? 0} weight byte(s) and ` +
            `${data.layers?.length ?? 0} layer(s) — call materialize() before writing, ` +
            'otherwise the payload would be dropped'
        );
    }
    validateTerrainData(data);

    const layers = data.layers ?? [];
    const len = payloadLength(data);
    const out = Buffer.alloc(padToCapacity(len));
    let p = 0;

    out.writeInt32LE(TERRAIN_DATA_VERSION8, p); p += 4;      // :574 — always V8
    // The FILE stores the unsnapped value (the editor writes `Terrain._tileSize` verbatim,
    // terrain.ts:1662; the `floor(t*100)/100` snap is load-time only, terrain-asset.ts:491),
    // so preserve it whenever it still snaps to the effective tileSize — otherwise a
    // read→write of such a file would rewrite 0.29 as 0.28.
    out.writeDoubleLE(consistentRawTileSize(data) ?? data.tileSize, p); p += 8;  // :577
    out.writeInt32LE(data.blockCount[0], p); p += 4;         // :578
    out.writeInt32LE(data.blockCount[1], p); p += 4;
    out.writeInt16LE(data.weightMapSize, p); p += 2;         // :579
    out.writeInt16LE(data.lightMapSize, p); p += 2;          // :580

    out.writeInt32LE(data.heights.length, p); p += 4;        // :583
    for (let i = 0; i < data.heights.length; i++) {          // :584-586
        // writeInt16 in the engine; the u16 values wrap to identical bytes
        out.writeUInt16LE(data.heights[i] & 0xffff, p);
        p += 2;
    }

    out.writeInt32LE(0, p); p += 4;                          // :589 — normals count

    out.writeInt32LE(data.weights.length, p); p += 4;        // :595
    for (let i = 0; i < data.weights.length; i++) out[p++] = data.weights[i] & 0xff; // :596-598

    out.writeInt32LE(data.layerBuffer.length, p); p += 4;    // :601
    for (let i = 0; i < data.layerBuffer.length; i++) {      // :602-604
        out.writeInt16LE(data.layerBuffer[i], p);
        p += 2;
    }

    out.writeInt32LE(layers.length, p); p += 4;              // :622
    for (const layer of layers) {                            // :623-630
        out.writeInt32LE(layer.slot, p); p += 4;
        out.writeDoubleLE(layer.tileSize, p); p += 8;
        p = writeString(out, p, layer.detailMapId ?? '');
        p = writeString(out, p, layer.normalMapId ?? '');
        out.writeDoubleLE(layer.roughness, p); p += 8;       // roughness BEFORE metallic
        out.writeDoubleLE(layer.metallic, p); p += 8;
    }

    if (p !== len) {
        // Defensive: payloadLength() and the writer must never disagree
        throw new Error(`terrain: internal writer error — wrote ${p} bytes, expected ${len}`);
    }
    return out;
}

/** Port of `TerrainBuffer.writeString` (terrain-asset.ts:148-156): i32 count + low byte per char */
function writeString(out, pos, str) {
    out.writeInt32LE(str.length, pos);
    let p = pos + 4;
    for (let i = 0; i < str.length; i++) out[p++] = str.charCodeAt(i) & 0xff;
    return p;
}

// --- Info card --------------------------------------------------------------

/**
 * Height statistics in metres over the whole grid.
 * @param {object} data - Terrain data object
 * @returns {{min: number, max: number, mean: number, minRaw: number, maxRaw: number,
 *   flat: boolean}|null} null when there is no height data
 */
export function heightStats(data) {
    const heights = data.heights;
    if (!heights || heights.length === 0) return null;
    let minRaw = heights[0];
    let maxRaw = heights[0];
    let sum = 0;
    for (let i = 0; i < heights.length; i++) {
        const v = heights[i];
        if (v < minRaw) minRaw = v;
        if (v > maxRaw) maxRaw = v;
        sum += v;
    }
    return {
        min: rawToHeight(minRaw),
        max: rawToHeight(maxRaw),
        mean: rawToHeight(sum / heights.length),
        minRaw,
        maxRaw,
        flat: minRaw === maxRaw,
    };
}

/**
 * Weight coverage in both shapes an agent asks for, off ONE sweep of the weight buffer:
 * `blocks` — per block, per channel, row-major — and `layerUsage`, the same numbers summed
 * per PALETTE slot (see the module header; not an index into `data.layers`). A slot's
 * denominator is `weightMapSize^2` per (block, channel) it occupies, so the two agree by
 * construction; sweeping twice for them cost ~80 ms on an 8x8-block / 512 terrain.
 *
 * Both are `[]` when `layerBuffer` does not match the declared geometry. Without that guard
 * the `bc0 * bc1` loop would run on a file-declared block count that nothing bounds: a 2 KB
 * file claiming `blockCount [10000,10000]` costs 0.6 s, and the i32 field allows 4.6e18
 * iterations.
 *
 * @param {object} data - Terrain data object
 * @returns {{blocks: Array<{block: number[], index: number, origin: number[], slots: number[],
 *   channels: Array<{channel: number, slot: number, coverage: number|null,
 *   meanWeight: number|null}>, ignoresWeights: boolean}>,
 *   layerUsage: Array<{slot: number, blocks: number[], channels: number[], texels: number,
 *   nonZeroTexels: number, coverage: number, meanWeight: number}>}}
 */
export function weightUsage(data) {
    const [bc0, bc1] = data.blockCount;
    const wms = data.weightMapSize;
    const [uWC] = weightMapDims(data);
    const expected = expectedCounts(data.blockCount, wms);
    if ((data.layerBuffer?.length ?? 0) !== expected.layerBuffer) return { blocks: [], layerUsage: [] };
    const haveWeights = Boolean(data.weights) && data.weights.length === expected.weights;
    const perChannel = wms * wms;
    const blockSize = TERRAIN_BLOCK_TILE_COMPLEXITY * data.tileSize;
    const usage = new Map();
    const blocks = [];

    for (let by = 0; by < bc1; by++) {
        for (let bx = 0; bx < bc0; bx++) {
            const b = blockIndex(bx, by, data.blockCount);
            const slots = blockLayers(data, bx, by);
            const channels = [];
            for (let k = 0; k < TERRAIN_MAX_BLEND_LAYERS; k++) {
                const slot = slots[k];
                if (!(slot >= 0)) {
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
                            if (w !== 0) {
                                nonZero++;
                                sum += w;
                            }
                        }
                    }
                }
                channels.push({
                    channel: k,
                    slot,
                    coverage: haveWeights ? nonZero / perChannel : null,
                    meanWeight: haveWeights ? sum / (255 * perChannel) : null,
                });
                let u = usage.get(slot);
                if (!u) {
                    u = {
                        slot,
                        blocks: [],
                        channels: [],
                        texels: 0,
                        nonZeroTexels: 0,
                        coverage: 0,
                        meanWeight: 0,
                        _sum: 0,
                    };
                    usage.set(slot, u);
                }
                if (!u.blocks.includes(b)) u.blocks.push(b);
                if (!u.channels.includes(k)) u.channels.push(k);
                if (!haveWeights) continue;
                u.texels += perChannel;
                u.nonZeroTexels += nonZero;
                u._sum += sum;
            }
            blocks.push({
                block: [bx, by],
                index: b,
                origin: [bx * blockSize, by * blockSize],
                slots,
                channels,
                ignoresWeights: maxLayerIndex(slots) === 0,
            });
        }
    }

    const layerUsage = [...usage.values()].sort((a, b) => a.slot - b.slot);
    for (const u of layerUsage) {
        u.coverage = u.texels ? u.nonZeroTexels / u.texels : 0;
        u.meanWeight = u.texels ? u._sum / (255 * u.texels) : 0;
        delete u._sum;
    }
    return { blocks, layerUsage };
}

/**
 * Cheap header + statistics card for a `.terrain` file. Reads the file, derives everything
 * a tool needs to describe it, and drops the big arrays — the returned object holds only
 * scalars and per-block/per-layer summaries.
 *
 * `blockLayers` and `layerUsage[].slot` are PALETTE indices, not `layers[]` positions — see
 * the module header; they line up with `layers[i].slot` only while the palette is dense.
 *
 * @param {string} filePath - Absolute path to the `.terrain` file
 * @returns {object|null} `{filePath, fileSize, version, versionLabel, isDefaultSentinel,
 *   tileSize, rawTileSize, blockCount, weightMapSize, lightMapSize, size, vertexCount,
 *   weightMapTexels,
 *   heightCount, weightCount, normalCount, payloadLength, padding,
 *   heightMin, heightMax, heightMean, heightMinRaw, heightMaxRaw, isFlat,
 *   layers, blockLayers, layerUsage, blockUsage, warnings}`, or null when the file is not
 *   a terrain
 * @throws {Error} on unreadable files (fs errors) or structural corruption
 */
export function readTerrainInfo(filePath) {
    const buf = fs.readFileSync(filePath);
    const data = readTerrain(buf);
    if (!data) return null;
    return terrainInfoFromData(data, {
        filePath,
        fileSize: buf.length,
        payloadLength: data.payloadLength,
    });
}

/**
 * The same card as {@link readTerrainInfo}, computed from an IN-MEMORY data object — what an
 * editing tool needs to describe the result of a `dryRun` (nothing on disk to re-read) and
 * the single implementation both paths share.
 *
 * `fileSize`/`payloadLength` default to what {@link writeTerrain} would produce, so a card
 * built from edited data reports the file the write WOULD create.
 *
 * @param {object} data - Terrain data object (e.g. from {@link readTerrain})
 * @param {{filePath?: string|null, fileSize?: number|null, payloadLength?: number|null,
 *   blockUsage?: boolean}} [opts] - `blockUsage` keeps {@link weightUsage}'s per-block rows
 *   on the card instead of only their per-slot sum
 * @returns {object} same shape as {@link readTerrainInfo}
 */
export function terrainInfoFromData(data, opts = {}) {
    const payloadLen = opts.payloadLength ?? payloadLength(data);
    const fileSize = opts.fileSize ?? padToCapacity(payloadLen);
    const filePath = opts.filePath ?? null;

    const [bc0, bc1] = data.blockCount;
    const [vx, vz] = vertexCounts(data.blockCount);
    const [uWC, vWC] = weightMapDims(data);
    const expected = expectedCounts(data.blockCount, data.weightMapSize);
    const stats = heightStats(data);
    const warnings = [];

    // Structural consistency — warnings, not errors: the file parsed fine, the engine
    // would simply re-materialize the mis-sized buffers on load (terrain.ts:2481-2526).
    if (!data.isDefaultSentinel) {
        if (data.heights.length !== expected.heights) {
            warnings.push(
                `heights count ${data.heights.length} != ${expected.heights} expected for ` +
                `blockCount [${bc0},${bc1}] — the engine would discard them and rebuild a flat grid`
            );
        }
        if (data.weights.length !== expected.weights) {
            warnings.push(
                `weights count ${data.weights.length} != ${expected.weights} expected for ` +
                `blockCount [${bc0},${bc1}] / weightMapSize ${data.weightMapSize} — ` +
                'the engine would reset the weight map'
            );
        }
        if (data.layerBuffer.length !== expected.layerBuffer) {
            warnings.push(
                `layerBuffer count ${data.layerBuffer.length} != ${expected.layerBuffer} expected ` +
                `for blockCount [${bc0},${bc1}] — the engine would clear all layer assignments`
            );
        }
        if (data.normals.length !== 0 && data.normals.length !== expected.normals) {
            warnings.push(
                `normals count ${data.normals.length} is neither 0 nor ${expected.normals} — ` +
                'the engine rebuilds them on load'
            );
        } else if (data.normals.length !== 0) {
            warnings.push(
                `normals count ${data.normals.length} is non-zero — the editor writes 0 and the ` +
                'engine rebuilds them on load, so rewriting this file through the MCP drops them ' +
                '(no visual change, but the file will not stay byte-identical)'
            );
        }
        if (!isTileSizeStable(data.rawTileSize)) {
            warnings.push(
                `tileSize is stored as ${data.rawTileSize} but the loader snaps it to ${data.tileSize} ` +
                '(Math.floor(t * 100) / 100) — every size/coordinate here uses the snapped value'
            );
        }
    }

    data.layers.forEach((layer, i) => {
        if (layer.slot !== i) {
            // Not reachable from editor output: `_exportNativeData` overwrites the binary
            // slot with the array index (terrain-asset.ts:613). A file that has one anyway
            // was written by something else, and its palette indices are then ambiguous —
            // layerBuffer indexes `_layerList` (the library JSON's `_layerInfos[].slot`),
            // which this module cannot see.
            warnings.push(
                `layers[${i}].slot is ${layer.slot}, not the array index ${i} — the engine always ` +
                'writes the array index here, so this file was not produced by Cocos Creator; ' +
                'layerBuffer palette indices cannot be matched to layer records reliably'
            );
        }
        for (const key of ['detailMapId', 'normalMapId']) {
            if (layer[key] && !isAscii(layer[key])) {
                warnings.push(`layers[${i}].${key} contains non-ASCII characters (unreadable id)`);
            }
        }
        if (!layer.detailMapId) {
            warnings.push(`layers[${i}] has no detailMapId — the editor drops such layers on re-save`);
        }
    });

    // Per-block slots + block-level warnings
    const blocks = [];
    const usedSlots = new Set();
    if (data.layerBuffer.length === expected.layerBuffer) {
        for (let by = 0; by < bc1; by++) {
            for (let bx = 0; bx < bc0; bx++) {
                const slots = blockLayers(data, bx, by);
                blocks.push(slots);
                slots.forEach((s) => { if (s >= 0) usedSlots.add(s); });
                const maxIdx = maxLayerIndex(slots);
                for (let k = 0; k < maxIdx; k++) {
                    if (slots[k] < 0) {
                        warnings.push(
                            `block [${bx},${by}] has an empty channel ${k} below used channel ${maxIdx} — ` +
                            'the engine samples it as a null layer; keep block slots left-packed'
                        );
                    }
                }
            }
        }
    }

    for (const slot of [...usedSlots].sort((a, b) => a - b)) {
        if (!data.layers.some((l) => l.slot === slot)) {
            warnings.push(`layerBuffer references palette slot ${slot}, which has no layer record`);
        }
    }
    data.layers.forEach((layer) => {
        if (!usedSlots.has(layer.slot)) {
            warnings.push(`layer slot ${layer.slot} is defined but no block uses it`);
        }
    });

    const usage = data.isDefaultSentinel ? { blocks: [], layerUsage: [] } : weightUsage(data);
    const layerUsage = usage.layerUsage;
    for (const u of layerUsage) {
        if (u.texels === 0 || u.nonZeroTexels !== 0) continue;
        // Zero weight everywhere is only harmless where the engine IGNORES the weight map, and
        // that rule is per BLOCK, not per layer: `TerrainBlock.getMaxLayer() === 0` (a single
        // assigned channel) makes the shader draw `detailMap0` flat and destroys the weight
        // texture (terrain.ts:857-869, :879, :920-930). A layer that only ever sits on channel 0
        // can still be invisible — in a block that assigns a SECOND layer, channel 0 is sampled
        // like any other. So suppress only when EVERY block referencing the slot ignores weights.
        const sampled = u.blocks.filter((b) => {
            const [bx, by] = [b % bc0, Math.floor(b / bc0)];
            return maxLayerIndex(blockLayers(data, bx, by)) !== 0;
        });
        if (sampled.length === 0) continue;
        warnings.push(
            `layer slot ${u.slot} is assigned to ${u.blocks.length} block(s) but has zero ` +
            `weight coverage — it never shows up (${sampled.length} of those block(s) blend more ` +
            'than one layer, so their weight map IS sampled and this layer contributes nothing there)'
        );
    }

    return {
        filePath,
        fileSize,
        version: data.version,
        versionLabel: versionName(data.version),
        isDefaultSentinel: data.isDefaultSentinel,
        tileSize: data.tileSize,
        rawTileSize: data.rawTileSize,
        blockCount: [bc0, bc1],
        weightMapSize: data.weightMapSize,
        lightMapSize: data.lightMapSize,
        size: terrainSize(data),
        vertexCount: [vx, vz],
        weightMapTexels: [uWC, vWC],
        heightCount: data.heights.length,
        weightCount: data.weights.length,
        normalCount: data.normals.length,
        payloadLength: payloadLen,
        padding: fileSize - payloadLen,
        heightMin: stats ? stats.min : null,
        heightMax: stats ? stats.max : null,
        heightMean: stats ? stats.mean : null,
        heightMinRaw: stats ? stats.minRaw : null,
        heightMaxRaw: stats ? stats.maxRaw : null,
        isFlat: stats ? stats.flat : null,
        layers: data.layers.map((l) => ({ ...l })),
        blockLayers: blocks,
        layerUsage,
        // Opt-in: the rows exist either way (layerUsage is their sum), but a caller that
        // does not print a block table should not retain bc0*bc1 of them in a cached card.
        blockUsage: opts.blockUsage ? usage.blocks : null,
        warnings,
    };
}
