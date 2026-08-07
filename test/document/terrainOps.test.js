/**
 * terrainOps tests (Phase T4)
 *
 * These run on the IN-MEMORY data struct — no files, no tool plumbing (that is
 * `test/tools/EditTerrain.test.js`). Small synthetic terrains (`weightMapSize` 4 = 16 texels
 * per block) keep every buffer small enough to assert exhaustively.
 *
 * The `set_info` expectations are HAND-DERIVED from the engine sources, never read back out
 * of our own implementation:
 * - `_rebuildHeights` (terrain.ts:2541-2566), `_rebuildLayerBuffer` (:2568-2595) and
 *   `_rebuildWeights` (:2597-2703), including the `sampleOldWeight` diagonal-split kernel
 *   (`m = (b+c)/2`, far corner extrapolated, `min(ix0+1, oldWms-1)` clamp) and the truncating
 *   `Uint8Array` store.
 * - Worked example for the 4 -> 8 resample of a column gradient `R = [0, 85, 170, 255]`:
 *   the source is constant along z, so `a == c`, `b == d`, both branches leave the
 *   extrapolated corner equal to the real one and the kernel degenerates to
 *   `A + (B - A) * dx` with `x = u / 7 * 3`. u = 1 gives `0 + (1/3)(3/7) = 1/7` ->
 *   `1/7 * 255 = 36.43` -> stored 36. The whole row is 0, 36, 72, 109, 145, 182, 218, 255.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { fileURLToPath } from 'url';

import {
    applyTerrainOperation,
    applyTerrainOperations,
    TerrainOpError,
    TERRAIN_OP_NAMES,
} from '../../src/document/terrainOps.js';
import { AssetIndex } from '../../src/core/AssetIndex.js';
import {
    materialize,
    readTerrain,
    defaultSentinel,
    getVertexHeight,
    setVertexHeight,
    setWeightAtTexel,
    weightTexelIndex,
    weightMapDims,
    blockLayers,
    setBlockLayers,
    validateTerrainData,
    terrainSize,
    vertexCounts,
    heightToRaw,
    TERRAIN_HEIGHT_BASE,
    TERRAIN_MAX_BLEND_LAYERS,
    TERRAIN_HEIGHT_FMIN,
    TERRAIN_HEIGHT_FMAX,
    TERRAIN_DATA_VERSION7,
    TERRAIN_DATA_VERSION8,
} from '../../src/utils/terrainBin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_PROJECT = path.join(__dirname, '..', 'fixtures', 'mock-project');

/** Read-only use of the shared fixture index (layer texture resolution + labels) */
const CTX = { assetIndex: AssetIndex.shared(MOCK_PROJECT), projectRoot: MOCK_PROJECT };

// --- helpers ----------------------------------------------------------------

/** A palette record with a syntactically valid, project-external texture id */
function layerRecord(n) {
    return {
        slot: n,
        tileSize: 1,
        detailMapId: `1111111${n}-2222-3333-8444-5555666677${n}8@6c48a`,
        normalMapId: '',
        roughness: 1,
        metallic: 0,
    };
}

/**
 * A fresh materialized terrain: `layers` palette entries, every block's slots set to
 * `slots` (defaults to the first `layers` slots, left-packed).
 */
function terrain({
    blockCount = [1, 1], tileSize = 1, weightMapSize = 4, lightMapSize = 4,
    layers = 0, slots = null,
} = {}) {
    const data = materialize({
        blockCount, tileSize, weightMapSize, lightMapSize,
        layers: Array.from({ length: layers }, (_, n) => layerRecord(n)),
    });
    const use = slots ?? Array.from({ length: layers }, (_, n) => n);
    if (use.length) {
        for (let by = 0; by < blockCount[1]; by++) {
            for (let bx = 0; bx < blockCount[0]; bx++) setBlockLayers(data, bx, by, use);
        }
    }
    return data;
}

const apply = (data, ...ops) => applyTerrainOperations(data, ops, CTX);

/** The four channel bytes of one global texel */
function texel(data, i, j) {
    const base = weightTexelIndex(data, i, j);
    return [data.weights[base], data.weights[base + 1], data.weights[base + 2], data.weights[base + 3]];
}

/** Sum of one texel's four channels */
const texelSum = (data, i, j) => texel(data, i, j).reduce((a, b) => a + b, 0);

/** Write one texel's four channel BYTES (terrainBin's setWeightAtTexel takes 0..1 fractions) */
function setTexelBytes(data, i, j, bytes) {
    const base = weightTexelIndex(data, i, j);
    for (let k = 0; k < TERRAIN_MAX_BLEND_LAYERS; k++) data.weights[base + k] = bytes[k];
}

/** terrainOps' own `fmt`: 3 digits, no trailing zeros */
const fmt3 = (v) => String(Number(v.toFixed(3)));

/** Texels of the whole weight map that do not sum to 255 (observable or not) */
function countShort(data) {
    const [w, h] = weightMapDims(data);
    let n = 0;
    for (let j = 0; j < h; j++) {
        for (let i = 0; i < w; i++) if (texelSum(data, i, j) !== 255) n++;
    }
    return n;
}

/** Every texel of the (single-block) weight map, row by row, one channel */
function channelGrid(data, k) {
    const wms = data.weightMapSize;
    const out = [];
    for (let j = 0; j < wms * data.blockCount[1]; j++) {
        const row = [];
        for (let i = 0; i < wms * data.blockCount[0]; i++) row.push(texel(data, i, j)[k]);
        out.push(row);
    }
    return out;
}

const heightAtVertex = (data, i, j) => getVertexHeight(data, i, j);

// ---------------------------------------------------------------------------

describe('terrainOps — dispatch, batching, argument hygiene', () => {
    it('exposes exactly the eight documented ops', () => {
        assert.deepStrictEqual(TERRAIN_OP_NAMES, [
            'set_info', 'set_layer', 'remove_layer', 'set_heights',
            'adjust_heights', 'smooth_heights', 'paint_layer', 'set_block_layers',
        ]);
    });

    it('rejects an unknown op by listing the valid ones', () => {
        const data = terrain();
        assert.throws(
            () => apply(data, { op: 'sculpt' }),
            (err) => {
                assert.ok(err instanceof TerrainOpError);
                assert.strictEqual(err.name, 'TerrainOpError');
                assert.match(err.message, /op\[0\] sculpt: Unknown op "sculpt"\. Supported: set_info, set_layer/);
                return true;
            }
        );
        assert.throws(() => applyTerrainOperation(terrain(), {}), /Unknown op "undefined"/);
    });

    it('requires a non-empty ops array', () => {
        for (const ops of [undefined, null, [], {}, 'set_info']) {
            assert.throws(
                () => applyTerrainOperations(terrain(), ops, CTX),
                /ops must be a non-empty array/
            );
        }
    });

    it('wraps a failure with the op index and name', () => {
        const data = terrain();
        assert.throws(
            () => apply(data, { op: 'adjust_heights', delta: 1 }, { op: 'adjust_heights', delta: 'up' }),
            /^TerrainOpError: op\[1\] adjust_heights: "delta" \(a finite number\) is required, got "up"$/
        );
    });

    it('rejects an unknown key per op instead of silently ignoring it', () => {
        assert.throws(
            () => apply(terrain(), { op: 'set_heights', value: 1, radius: 5 }),
            /unknown key "radius" — set_heights takes region, value, rows, heightmap, falloff, profile, clamp/
        );
        assert.throws(
            () => apply(terrain(), { op: 'adjust_heights', delta: 1, region: { x: 0, radius: 5 } }),
            /region: unknown key "radius" — valid keys are x, z, width, depth/
        );
        assert.throws(
            () => apply(terrain({ layers: 1 }), {
                op: 'paint_layer', layer: 0, weight: 1, region: { shape: 'circle' },
            }),
            /region\.shape must be one of "rect", "ellipse", "band", got "circle"/
        );
    });

    it('returns one {op, summary, notes} per op, in order', () => {
        const data = terrain({ layers: 1 });
        const { results } = apply(
            data,
            { op: 'set_heights', value: 1 },
            { op: 'adjust_heights', delta: 1 }
        );
        assert.deepStrictEqual(results.map((r) => r.op), ['set_heights', 'adjust_heights']);
        results.forEach((r) => {
            assert.strictEqual(typeof r.summary, 'string');
            assert.ok(Array.isArray(r.notes));
        });
        assert.strictEqual(heightAtVertex(data, 0, 0), 2);
    });
});

describe('terrainOps — prepare() normalizes the file before any op', () => {
    it('materializes the empty "Create > Terrain" sentinel', () => {
        const data = readTerrain(defaultSentinel());
        assert.strictEqual(data.isDefaultSentinel, true);

        const { notes } = apply(data, { op: 'adjust_heights', delta: 1 });

        assert.match(notes.join('\n'), /empty "Create > Terrain" sentinel/);
        assert.match(notes.join('\n'), /33x33 vertices at 0 m/);
        assert.strictEqual(data.isDefaultSentinel, false);
        assert.strictEqual(data.version, TERRAIN_DATA_VERSION8);
        assert.deepStrictEqual(data.blockCount, [1, 1]);
        assert.strictEqual(data.weightMapSize, 128);
        assert.strictEqual(data.heights.length, 33 * 33);
        assert.strictEqual(data.weights.length, 128 * 128 * 4);
        assert.deepStrictEqual([...data.layerBuffer], [-1, -1, -1, -1]);
        // the op then ran on the materialized buffers
        assert.strictEqual(heightAtVertex(data, 0, 0), 1);
        assert.strictEqual(heightAtVertex(data, 32, 32), 1);
        assert.deepStrictEqual(texel(data, 0, 0), [255, 0, 0, 0]);
    });

    it('rebuilds buffers whose size contradicts the header, saying so', () => {
        const data = terrain({ layers: 1 });
        data.heights = new Uint16Array(5); // what a corrupt/foreign writer leaves behind
        const { notes } = apply(data, { op: 'adjust_heights', delta: 0 });
        assert.match(notes.join('\n'), /stores 5 heights instead of 1089/);
        assert.match(notes.join('\n'), /REBUILT from scratch/);
        assert.strictEqual(data.heights.length, 1089);
        assert.ok([...data.heights].every((h) => h === TERRAIN_HEIGHT_BASE));
    });

    it('reports the V8 rewrite of a legacy file and drops stored normals', () => {
        const data = terrain({ layers: 1 });
        data.version = TERRAIN_DATA_VERSION7;
        data.normals = new Float32Array([0, 1, 0]);
        const { notes } = apply(data, { op: 'adjust_heights', delta: 0 });
        assert.match(notes.join('\n'), /this file is format V7; it is rewritten as V8/);
        assert.match(notes.join('\n'), /stores 3 normal float\(s\)/);
        assert.strictEqual(data.normals.length, 0);
        assert.strictEqual(data.version, TERRAIN_DATA_VERSION8);
    });

    it('re-indexes a sparse palette (the binary format needs a dense one)', () => {
        const data = terrain({ layers: 2 });
        data.layers[1].slot = 5;
        data.layerBuffer.set([0, 5, -1, -1]);
        const { notes } = apply(data, { op: 'adjust_heights', delta: 0 });
        assert.match(notes.join('\n'), /1 palette layer had a slot number other than its array index/);
        assert.deepStrictEqual(data.layers.map((l) => l.slot), [0, 1]);
        assert.deepStrictEqual([...data.layerBuffer], [0, 1, -1, -1]);
    });
});

describe('terrainOps — set_info geometry (hand-built expectations)', () => {
    it('needs at least one field, and reports a no-op honestly', () => {
        const data = terrain();
        assert.throws(
            () => apply(data, { op: 'set_info' }),
            /set_info needs at least one of tileSize, blockCount, weightMapSize, lightMapSize/
        );
        const before = Uint16Array.from(data.heights);
        const { results } = apply(data, {
            op: 'set_info', blockCount: [1, 1], tileSize: 1, weightMapSize: 4, lightMapSize: 4,
        });
        assert.match(results[0].summary, /nothing changed/);
        assert.strictEqual(results[0].blockCountChanged, false);
        assert.deepStrictEqual([...data.heights], [...before]);
    });

    it('grows blockCount: overlap kept, new area 0 m / -1 slots / (255,0,0,0)', () => {
        const data = terrain({ blockCount: [1, 1], weightMapSize: 4, layers: 2, slots: [0, 1] });
        setVertexHeight(data, 0, 0, -2, true);
        setVertexHeight(data, 32, 32, 5, true);
        setVertexHeight(data, 7, 9, 1.5, true);
        setWeightAtTexel(data, 3, 3, [0, 1, 0, 0]);

        const { results } = apply(data, { op: 'set_info', blockCount: [2, 2] });

        // heights: the old 33x33 rect survives at the origin corner, the rest is 0 m
        assert.strictEqual(data.heights.length, 65 * 65);
        assert.strictEqual(heightAtVertex(data, 0, 0), -2);
        assert.strictEqual(heightAtVertex(data, 32, 32), 5);
        assert.strictEqual(heightAtVertex(data, 7, 9), 1.5);
        for (const [i, j] of [[33, 0], [0, 33], [64, 64], [40, 12]]) {
            assert.strictEqual(heightAtVertex(data, i, j), 0, `new vertex (${i},${j})`);
        }
        let nonZero = 0;
        for (let j = 0; j < 65; j++) {
            for (let i = 0; i < 65; i++) if (data.heights[j * 65 + i] !== TERRAIN_HEIGHT_BASE) nonZero++;
        }
        assert.strictEqual(nonZero, 3, 'only the three sculpted vertices differ from 0 m');

        // layerBuffer: block 0 kept, the three new blocks unassigned
        assert.deepStrictEqual([...data.layerBuffer], [
            0, 1, -1, -1,
            -1, -1, -1, -1,
            -1, -1, -1, -1,
            -1, -1, -1, -1,
        ]);

        // weights: same weightMapSize, so block (0,0) is copied texel-for-texel into the
        // same coordinates of the bigger map; every other texel is the (255,0,0,0) fill
        assert.strictEqual(data.weights.length, 8 * 8 * 4);
        assert.deepStrictEqual(texel(data, 3, 3), [0, 255, 0, 0]);
        assert.deepStrictEqual(texel(data, 0, 0), [255, 0, 0, 0]);
        for (const [i, j] of [[4, 0], [0, 4], [4, 4], [7, 7]]) {
            assert.deepStrictEqual(texel(data, i, j), [255, 0, 0, 0], `new texel (${i},${j})`);
        }

        assert.strictEqual(results[0].blockCountChanged, true);
        assert.deepStrictEqual(results[0].blockCountFrom, [1, 1]);
        assert.deepStrictEqual(results[0].blockCountTo, [2, 2]);
        assert.match(results[0].summary, /blocks \[1,1\] -> \[2,2\]/);
        assert.match(results[0].summary, /now 64 x 64 m \(was 32 x 32 m\)/);
        assert.match(results[0].summary, /kept the overlapping 33x33 vertices, 3136 new vertices set to 0 m/);
        assert.match(results[0].summary, /kept 1 overlapping block, 3 new blocks left unassigned \(-1\)/);
        assert.match(results[0].summary, /1 overlapping block copied texel-for-texel/);
        assert.match(results[0].notes.join('\n'), /_lightmapInfos/);
    });

    it('shrinks blockCount: the overlapping rect survives, the rest is dropped', () => {
        const data = terrain({ blockCount: [2, 2], weightMapSize: 4, layers: 2, slots: [0, 1] });
        setVertexHeight(data, 10, 10, 3, true);
        setVertexHeight(data, 64, 64, 7, true);
        setWeightAtTexel(data, 1, 1, [0, 1, 0, 0]);
        setWeightAtTexel(data, 5, 5, [0, 0, 0, 1]);
        setBlockLayers(data, 1, 1, [1]);

        const { results } = apply(data, { op: 'set_info', blockCount: [1, 1] });

        assert.strictEqual(data.heights.length, 33 * 33);
        assert.strictEqual(heightAtVertex(data, 10, 10), 3);
        assert.strictEqual(heightAtVertex(data, 32, 32), 0);
        assert.deepStrictEqual([...data.layerBuffer], [0, 1, -1, -1]);
        assert.strictEqual(data.weights.length, 4 * 4 * 4);
        assert.deepStrictEqual(texel(data, 1, 1), [0, 255, 0, 0]);
        assert.deepStrictEqual(texel(data, 3, 3), [255, 0, 0, 0]);
        assert.match(results[0].summary, /kept the overlapping 33x33 vertices, 0 new vertices set to 0 m/);
    });

    it('resamples weights with the engine kernel when weightMapSize grows (4 -> 8)', () => {
        // Source: R = [0, 85, 170, 255] per column, G = 255 - R, constant along z.
        const data = terrain({ weightMapSize: 4, layers: 2, slots: [0, 1] });
        const R = [0, 85, 170, 255];
        for (let j = 0; j < 4; j++) {
            for (let i = 0; i < 4; i++) setWeightAtTexel(data, i, j, [R[i] / 255, (255 - R[i]) / 255, 0, 0]);
        }

        const { results } = apply(data, { op: 'set_info', weightMapSize: 8 });

        assert.strictEqual(data.weights.length, 8 * 8 * 4);
        // Hand-derived (see the file header): A + (B - A) * dx with x = u / 7 * 3, the
        // Uint8Array store truncating 36.43 -> 36, 72.86 -> 72, 109.29 -> 109, …
        const expectedR = [0, 36, 72, 109, 145, 182, 218, 255];
        const expectedG = [255, 218, 182, 145, 109, 72, 36, 0];
        for (const row of channelGrid(data, 0)) assert.deepStrictEqual(row, expectedR);
        for (const row of channelGrid(data, 1)) assert.deepStrictEqual(row, expectedG);
        // The engine does NOT renormalize while resampling: 36 + 218 = 254, not 255.
        assert.strictEqual(texelSum(data, 1, 0), 254);
        assert.match(results[0].summary, /1 overlapping block resampled 4 -> 8 texels per side/);
        assert.match(results[0].summary, /diagonal-split scheme, not bilinear/);
        // heights and layer assignment are untouched by a pure weightMapSize change
        assert.strictEqual(data.heights.length, 33 * 33);
        assert.deepStrictEqual([...data.layerBuffer], [0, 1, -1, -1]);
        assert.match(results[0].summary, /heights: unchanged/);
    });

    it('resamples endpoint-inclusively when weightMapSize shrinks (8 -> 4)', () => {
        // Source: R = i * 32 per column (0, 32, …, 224), constant along z.
        const data = terrain({ weightMapSize: 8, layers: 1 });
        for (let j = 0; j < 8; j++) {
            for (let i = 0; i < 8; i++) setWeightAtTexel(data, i, j, [(i * 32) / 255, 0, 0, 0]);
        }

        apply(data, { op: 'set_info', weightMapSize: 4 });

        // x = u / 3 * 7: u=0 -> 0 (A=0); u=1 -> 2.33 (A=64,B=96,dx=1/3) -> 74.67 -> 74;
        // u=2 -> 4.67 (A=128,B=160,dx=2/3) -> 149.33 -> 149; u=3 -> 7 with ix1 clamped
        // to oldWms-1 = 7, so A = B = 224.
        for (const row of channelGrid(data, 0)) assert.deepStrictEqual(row, [0, 74, 149, 224]);
    });

    it('reproduces the engine early-out when the TOTAL texel count is unchanged', () => {
        // [2,2] at 16 and [1,1] at 32 are both 32x32 texels — terrain.ts:2605 returns false
        // and the old bytes keep their positions in the buffer instead of following blocks.
        const data = terrain({ blockCount: [2, 2], weightMapSize: 16, layers: 1 });
        setWeightAtTexel(data, 20, 20, [0, 0, 1, 0]);
        const before = Uint8Array.from(data.weights);

        const { results } = apply(data, { op: 'set_info', blockCount: [1, 1], weightMapSize: 32 });

        assert.deepStrictEqual([...data.weights], [...before]);
        assert.deepStrictEqual(texel(data, 20, 20), [0, 0, 255, 0]);
        assert.match(results[0].summary, /weights: NOT re-mapped/);
        assert.match(results[0].summary, /terrain\.ts:2605/);
        // …while heights and layerBuffer DID shrink
        assert.strictEqual(data.heights.length, 33 * 33);
        assert.strictEqual(data.layerBuffer.length, 4);
    });

    it('changes tileSize without touching a single buffer', () => {
        const data = terrain({ layers: 1 });
        setVertexHeight(data, 5, 5, 2, true);
        setWeightAtTexel(data, 2, 2, [0.5, 0.5, 0, 0]);
        const heights = Uint16Array.from(data.heights);
        const weights = Uint8Array.from(data.weights);

        const { results } = apply(data, { op: 'set_info', tileSize: 2 });

        assert.strictEqual(data.tileSize, 2);
        assert.strictEqual(data.rawTileSize, 2);
        assert.deepStrictEqual(terrainSize(data), [64, 64]);
        assert.deepStrictEqual([...data.heights], [...heights]);
        assert.deepStrictEqual([...data.weights], [...weights]);
        assert.match(results[0].summary, /tileSize 1 -> 2 m/);
        assert.match(results[0].summary, /heights: unchanged \(the vertex grid is the same size\)/);
        assert.strictEqual(results[0].blockCountChanged, false);
    });

    it('snaps a tileSize the loader would shift, and says so', () => {
        const data = terrain();
        const { results } = apply(data, { op: 'set_info', tileSize: 0.29 });
        assert.strictEqual(data.tileSize, 0.28); // 0.29 * 100 === 28.999999999999996
        assert.match(results[0].notes.join('\n'), /tileSize 0\.29 is snapped to 0\.28 on load/);
    });

    it('changes lightMapSize alone', () => {
        const data = terrain({ layers: 1, lightMapSize: 32 });
        const weights = Uint8Array.from(data.weights);
        const { results } = apply(data, { op: 'set_info', lightMapSize: 64 });
        assert.strictEqual(data.lightMapSize, 64);
        assert.strictEqual(data.weightMapSize, 4);
        assert.deepStrictEqual([...data.weights], [...weights]);
        assert.match(results[0].summary, /lightMapSize 32 -> 64/);
    });

    it('guards weightMapSize, blockCount and the allocation size', () => {
        assert.throws(
            () => apply(terrain(), { op: 'set_info', weightMapSize: 100 }),
            /must be a power of two in 4\.\.1024.*editor UI's convention.*not an engine constraint/s
        );
        assert.throws(
            () => apply(terrain(), { op: 'set_info', weightMapSize: 2 }),
            /power of two in 4\.\.1024/
        );
        assert.throws(
            () => apply(terrain(), { op: 'set_info', blockCount: [0, 1] }),
            /blockCount\[0\] = 0 must be an integer >= 1/
        );
        assert.throws(
            () => apply(terrain(), { op: 'set_info', blockCount: [4] }),
            /blockCount must be an array of two integers \[x, z\]/
        );
        assert.throws(
            () => apply(terrain(), { op: 'set_info', blockCount: [128, 128] }),
            /exceeds TERRAIN_MAX_BLOCKS/
        );
        assert.throws(
            () => apply(terrain({ weightMapSize: 4 }), { op: 'set_info', blockCount: [40, 40], weightMapSize: 512 }),
            /weight texels, over TERRAIN_MAX_WEIGHT_TEXELS/
        );
    });

    it('materializes a sentinel before resizing it', () => {
        const data = readTerrain(defaultSentinel());
        const { results, notes } = apply(data, { op: 'set_info', blockCount: [2, 1], weightMapSize: 4 });
        assert.match(notes.join('\n'), /empty "Create > Terrain" sentinel/);
        assert.deepStrictEqual(data.blockCount, [2, 1]);
        assert.strictEqual(data.heights.length, 65 * 33);
        assert.ok([...data.heights].every((h) => h === TERRAIN_HEIGHT_BASE));
        assert.strictEqual(data.weights.length, 8 * 4 * 4);
        assert.deepStrictEqual([...data.layerBuffer], [-1, -1, -1, -1, -1, -1, -1, -1]);
        assert.match(results[0].summary, /blocks \[1,1\] -> \[2,1\]/);
    });
});

describe('terrainOps — set_layer / remove_layer', () => {
    it('appends a palette entry and resolves its textures', () => {
        const data = terrain({ layers: 1 });
        const { results } = apply(data, {
            op: 'set_layer', slot: 1, detailMap: 'Sprites/panel.png', tileSize: 4, roughness: 0.25,
        });
        assert.strictEqual(data.layers.length, 2);
        assert.deepStrictEqual(data.layers[1], {
            slot: 1,
            tileSize: 4,
            detailMapId: '11112222-3333-4444-8555-666677778888@6c48a',
            normalMapId: '',
            roughness: 0.25,
            metallic: 0,
        });
        assert.strictEqual(results[0].appendedSlot, 1);
        assert.match(results[0].summary, /Added palette layer 1: panel\.png@6c48a \(tileSize 4 m/);
    });

    it('updates an existing entry and reports only what changed', () => {
        const data = terrain({ layers: 1 });
        const first = apply(data, { op: 'set_layer', slot: 0, metallic: 1, tileSize: 2 });
        assert.strictEqual(data.layers[0].metallic, 1);
        assert.strictEqual(data.layers[0].tileSize, 2);
        assert.strictEqual(first.results[0].appendedSlot, null);
        assert.match(first.results[0].summary, /Updated palette layer 0: tileSize 1 -> 2 m per texture repeat, metallic 0 -> 1/);
        assert.match(first.results[0].notes.join('\n'), /_usePBR: true/);

        const second = apply(data, { op: 'set_layer', slot: 0, metallic: 1 });
        assert.match(second.results[0].summary, /already had those values — nothing changed/);
    });

    it('keeps the palette dense and demands a detailMap for a new slot', () => {
        const data = terrain({ layers: 1 });
        assert.throws(
            () => apply(data, { op: 'set_layer', slot: 3, detailMap: 'Sprites/panel.png' }),
            /slot 3 would leave a gap: the palette holds 1 layer \(slots 0\.\.0\) and must stay dense — use slot 1 to append/
        );
        assert.throws(
            () => apply(data, { op: 'set_layer', slot: 1, tileSize: 2 }),
            /slot 1 is a new palette entry, so "detailMap" is required/
        );
        assert.throws(
            () => apply(data, { op: 'set_layer', slot: 0 }),
            /set_layer needs at least one of detailMap, normalMap, tileSize, roughness, metallic/
        );
        assert.throws(
            () => apply(data, { op: 'set_layer', slot: 0, detailMap: null }),
            /detailMap cannot be cleared.*use remove_layer/s
        );
        assert.throws(
            () => apply(data, { op: 'set_layer', slot: 0, detailMap: 'Sprites/nope.png' }),
            /detailMap: texture not found: "Sprites\/nope\.png"/
        );
        assert.throws(
            () => apply(data, { op: 'set_layer', slot: 0, roughness: 2 }),
            /"roughness" must be in 0\.\.1, got 2/
        );
        assert.strictEqual(data.layers.length, 1);
    });

    it('sets and clears a normal map, warning about _useNormalmap', () => {
        const data = terrain({ layers: 1 });
        const set = apply(data, { op: 'set_layer', slot: 0, normalMap: 'Sprites/panel.png' });
        assert.strictEqual(data.layers[0].normalMapId, '11112222-3333-4444-8555-666677778888@6c48a');
        assert.match(set.results[0].notes.join('\n'), /_useNormalmap: true/);

        const cleared = apply(data, { op: 'set_layer', slot: 0, normalMap: null });
        assert.strictEqual(data.layers[0].normalMapId, ''); // "" in the binary, never null
        assert.match(cleared.results[0].summary, /normalMap .* cleared/);
    });

    it('removes a layer: refs dropped, channels left-packed, weights renormalized', () => {
        // Three layers on one block, every texel (100, 100, 55, 0) — sum 255.
        const data = terrain({ weightMapSize: 4, layers: 3, slots: [0, 1, 2] });
        for (let j = 0; j < 4; j++) {
            for (let i = 0; i < 4; i++) setWeightAtTexel(data, i, j, [100 / 255, 100 / 255, 55 / 255, 0]);
        }

        const { results } = apply(data, { op: 'remove_layer', slot: 1 });

        // Palette: the survivors are re-indexed so slot === array index
        assert.strictEqual(data.layers.length, 2);
        assert.deepStrictEqual(data.layers.map((l) => l.slot), [0, 1]);
        assert.strictEqual(data.layers[1].detailMapId, layerRecord(2).detailMapId);
        // Block slots: the old channel 2 (now palette slot 1) moved down to channel 1
        assert.deepStrictEqual([...data.layerBuffer], [0, 1, -1, -1]);
        // Weights: channels [0, 2] survive as [0, 1] and are rescaled to sum 255 —
        // 100 * 255 / 155 = 164.52 and 55 * 255 / 155 = 90.48, floors 164 + 90 = 254,
        // the largest remainder (0.52) takes the last unit.
        for (let j = 0; j < 4; j++) {
            for (let i = 0; i < 4; i++) {
                assert.deepStrictEqual(texel(data, i, j), [165, 90, 0, 0], `texel (${i},${j})`);
                assert.strictEqual(texelSum(data, i, j), 255);
            }
        }
        assert.match(results[0].summary, /Removed palette layer 1 .* unassigned in 1 block \(\[0,0\]\)/);
        assert.match(results[0].summary, /16 texels renormalized to sum 255/);
        assert.match(results[0].summary, /palette now holds 2 layers \(was 3\)/);
        assert.match(results[0].notes.join('\n'), /re-indexed .*: 2 -> 1/s);
    });

    it('falls back to the block\'s first layer where the removed one was alone', () => {
        const data = terrain({ weightMapSize: 4, layers: 2, slots: [0, 1] });
        setWeightAtTexel(data, 2, 2, [0, 1, 0, 0]); // covered by layer 1 ONLY

        const { results } = apply(data, { op: 'remove_layer', slot: 1 });

        assert.deepStrictEqual([...data.layerBuffer], [0, -1, -1, -1]);
        assert.deepStrictEqual(texel(data, 2, 2), [255, 0, 0, 0]);
        assert.strictEqual(texelSum(data, 2, 2), 255);
        assert.match(results[0].notes.join('\n'), /1 texel .* covered by the removed layer ALONE/s);
        assert.match(results[0].notes.join('\n'), /1 texel to layer 0/);
    });

    it('attributes the fallback per block, not once for the whole batch', () => {
        // Palettes differ ([2,0] vs [2,1]), so removing slot 2 falls back to DIFFERENT layers; one
        // shared variable reported the last block's layer for every texel counted.
        const data = terrain({ blockCount: [2, 1], weightMapSize: 4, layers: 3, slots: [2, 0] });
        setBlockLayers(data, 1, 0, [2, 1]);
        for (let j = 0; j < 4; j++) {
            for (let i = 0; i < 8; i++) setWeightAtTexel(data, i, j, [255, 0, 0, 0]); // layer 2 alone
        }

        const { results } = apply(data, { op: 'remove_layer', slot: 2 });

        assert.deepStrictEqual([...data.layerBuffer], [0, -1, -1, -1, 1, -1, -1, -1]);
        const notes = results[0].notes.join('\n');
        assert.match(notes, /32 texels were covered by the removed layer ALONE/);
        assert.match(notes, /16 texels to layer 0/);
        assert.match(notes, /16 texels to layer 1/);
        // and each block really did get its OWN first surviving layer at full weight
        assert.deepStrictEqual(texel(data, 0, 0), [255, 0, 0, 0]);
        assert.deepStrictEqual(texel(data, 4, 0), [255, 0, 0, 0]);
        assert.strictEqual(countShort(data), 0);
    });

    it('reports only the blocks that referenced the layer', () => {
        const data = terrain({ blockCount: [2, 2], weightMapSize: 4, layers: 2, slots: [0] });
        setBlockLayers(data, 1, 0, [0, 1]);
        setBlockLayers(data, 0, 1, [1]);

        const { results } = apply(data, { op: 'remove_layer', slot: 1 });

        assert.match(results[0].summary, /unassigned in 2 blocks \(\[1,0\], \[0,1\]\)/);
        assert.deepStrictEqual([...data.layerBuffer], [
            0, -1, -1, -1, // [0,0] never referenced it
            0, -1, -1, -1, // [1,0] left-packed
            -1, -1, -1, -1, // [0,1] had only layer 1
            0, -1, -1, -1,
        ]);
    });

    it('rejects removing a slot that has no palette entry', () => {
        assert.throws(
            () => apply(terrain({ layers: 1 }), { op: 'remove_layer', slot: 2 }),
            /no palette layer with slot 2 \(have 0\)/
        );
    });
});

describe('terrainOps — heights', () => {
    it('flattens a region to a value, quantizing to 1/128 m', () => {
        const data = terrain();
        const { results } = apply(data, { op: 'set_heights', value: 2.5 });
        assert.ok([...data.heights].every((h) => h === heightToRaw(2.5, true)));
        assert.match(results[0].summary, /Flattened 1089 vertices to 2\.5 m over the whole terrain \(32 x 32 m\)/);

        const quantized = apply(terrain(), { op: 'set_heights', value: 0.01 });
        assert.match(quantized.results[0].notes.join('\n'), /0\.01 m quantized to 0\.0078125 m/);
    });

    it('refuses a value outside the representable range', () => {
        assert.throws(
            () => apply(terrain(), { op: 'set_heights', value: 300 }),
            new RegExp(`value = 300 m is outside the representable height range \\[${TERRAIN_HEIGHT_FMIN}, ${TERRAIN_HEIGHT_FMAX}\\] m`)
        );
        assert.throws(
            () => apply(terrain(), { op: 'set_heights', value: NaN }),
            /"value" \(a finite number\) is required/
        );
        assert.throws(
            () => apply(terrain(), { op: 'set_heights' }),
            /set_heights needs exactly one of "value" .*, "rows" .* or "heightmap"/
        );
        assert.throws(
            () => apply(terrain(), { op: 'set_heights', value: 1, rows: [[0, 0], [0, 0]] }),
            /got value \+ rows/
        );
    });

    it('clamps adjust_heights at both limits and reports it', () => {
        const up = terrain();
        const raised = apply(up, { op: 'adjust_heights', delta: 1000 });
        assert.strictEqual(heightAtVertex(up, 0, 0), TERRAIN_HEIGHT_FMAX);
        assert.ok([...up.heights].every((h) => h === 65535));
        assert.match(raised.results[0].notes.join('\n'), /1089 of 1089 height sample\(s\) fell outside the representable range/);

        const down = terrain();
        apply(down, { op: 'adjust_heights', delta: -1000 });
        assert.strictEqual(heightAtVertex(down, 0, 0), TERRAIN_HEIGHT_FMIN);
        assert.ok([...down.heights].every((h) => h === 0));
    });

    it('warns when a delta rounds away to nothing', () => {
        const data = terrain();
        const { results } = apply(data, { op: 'adjust_heights', delta: 0.001 });
        assert.ok([...data.heights].every((h) => h === TERRAIN_HEIGHT_BASE));
        assert.match(results[0].notes.join('\n'), /smaller than half a height quantum/);
    });

    it('snaps a metre region onto the vertices it actually contains', () => {
        const data = terrain(); // tileSize 1 -> vertices every metre
        const { results } = apply(data, {
            op: 'adjust_heights', delta: 4, region: { x: 0.5, z: 0.5, width: 2, depth: 2 },
        });
        // vertices at 1 and 2 metres are inside [0.5, 2.5]; 0 and 3 are not
        assert.match(results[0].summary, /vertices 1\.\.2 x 1\.\.2/);
        const [vx] = vertexCounts(data.blockCount);
        let changed = 0;
        for (let j = 0; j < 33; j++) {
            for (let i = 0; i < 33; i++) if (data.heights[j * vx + i] !== TERRAIN_HEIGHT_BASE) changed++;
        }
        assert.strictEqual(changed, 4);
        assert.strictEqual(heightAtVertex(data, 1, 1), 4);
        assert.strictEqual(heightAtVertex(data, 2, 2), 4);
        assert.strictEqual(heightAtVertex(data, 0, 0), 0);
        assert.strictEqual(heightAtVertex(data, 3, 3), 0);
    });

    it('defaults an omitted width/depth to the far edge', () => {
        const data = terrain();
        const { results } = apply(data, { op: 'adjust_heights', delta: 1, region: { x: 30, z: 30 } });
        assert.match(results[0].summary, /x 30\.\.32 m, z 30\.\.32 m \(vertices 30\.\.32 x 30\.\.32\)/);
        assert.strictEqual(heightAtVertex(data, 32, 32), 1);
        assert.strictEqual(heightAtVertex(data, 29, 32), 0);
    });

    it('rejects a region off the terrain and one too small to reach a vertex', () => {
        assert.throws(
            () => apply(terrain(), { op: 'adjust_heights', delta: 1, region: { x: 40, z: 0, width: 5, depth: 5 } }),
            /does not overlap the terrain \(x 0\.\.32 m, z 0\.\.32 m/
        );
        assert.throws(
            () => apply(terrain(), { op: 'adjust_heights', delta: 1, region: { x: 0.2, z: 0.2, width: 0.5, depth: 0.5 } }),
            /contains no height vertex — vertices sit every 1 m \(tileSize\)/
        );
        assert.throws(
            () => apply(terrain(), { op: 'adjust_heights', delta: 1, region: { width: 0 } }),
            /region\.width must be a number > 0 metres/
        );
        assert.throws(
            () => apply(terrain(), { op: 'adjust_heights', delta: 1, region: [0, 0, 4, 4] }),
            /region must be an object \{x, z, width, depth, shape, contour, inner, outer\} in local metres/
        );
    });

    it('sets heights from inline rows, copied 1:1 onto an exact vertex grid', () => {
        const data = terrain();
        const rows = [[0, 1, 2], [3, 4, 5], [6, 7, 8]];
        const { results } = apply(data, {
            op: 'set_heights', region: { x: 0, z: 0, width: 2, depth: 2 }, rows,
        });
        for (let j = 0; j < 3; j++) {
            for (let i = 0; i < 3; i++) {
                assert.strictEqual(heightAtVertex(data, i, j), rows[j][i], `vertex (${i},${j})`);
            }
        }
        assert.strictEqual(heightAtVertex(data, 3, 0), 0); // outside the region
        assert.match(results[0].notes.join('\n'), /matches the 3x3 vertex grid exactly — copied 1:1/);
        assert.match(results[0].summary, /from inline rows/);
    });

    it('resamples inline rows that do not match the vertex grid', () => {
        const data = terrain();
        // 2x2 corners over the whole 33x33 grid: 0 at the near corner, 6 at the far one
        const { results } = apply(data, { op: 'set_heights', rows: [[0, 2], [4, 6]] });
        assert.strictEqual(heightAtVertex(data, 0, 0), 0);
        assert.ok(heightAtVertex(data, 32, 32) > 5, `far corner ${heightAtVertex(data, 32, 32)} m`);
        assert.match(results[0].notes.join('\n'), /resampled onto the 33x33 vertex grid/);
    });

    it('crops an overhanging source instead of squeezing it into the terrain', () => {
        // The region asks for x 16..48 m on a 32 m terrain, so half of it hangs off the edge.
        // The source must keep its scale over the half that lands — it used to be resampled onto
        // the CLIPPED span, which compressed the whole 0..10 m ramp into x 16..32.
        const rows = Array.from({ length: 5 }, () => [0, 2.5, 5, 7.5, 10]);
        const region = { x: 16, z: 0, width: 32, depth: 32 };
        const clipped = terrain();
        const { results } = apply(clipped, { op: 'set_heights', region, rows });
        // Same op on a terrain wide enough to hold the whole region: the overlap must match
        const roomy = terrain({ blockCount: [2, 1] });
        apply(roomy, { op: 'set_heights', region, rows });
        for (let i = 16; i <= 32; i++) {
            assert.strictEqual(heightAtVertex(clipped, i, 0), heightAtVertex(roomy, i, 0), `vertex ${i}`);
        }
        assert.ok(heightAtVertex(clipped, 32, 0) < 7,
            `the far end of the ramp is off the terrain, got ${heightAtVertex(clipped, 32, 0)} m at the edge`);
        const notes = results[0].notes.join('\n');
        assert.match(notes, /resampled onto the 33x33 vertex grid/);
        assert.match(notes, /overhangs the terrain: .*\(vertices 16\.\.48 x 0\.\.32\)/s);
        assert.match(notes, /only the part on the grid \(vertices 16\.\.32 x 0\.\.32\) was written/);
        assert.match(results[0].summary, /clipped from the 33x33 vertices it asks for/);
    });

    it('refuses a source resample far larger than the terrain itself', () => {
        assert.throws(
            () => apply(terrain(), {
                op: 'set_heights', region: { x: 0, z: 0, width: 4000, depth: 4000 }, rows: [[0, 1], [2, 3]],
            }),
            /asks for a 4001x4001 vertex span, more than 4x the terrain's own 33x33 grid/
        );
    });

    it('rejects a rows/heightmap source on a one-vertex-wide region', () => {
        assert.throws(
            () => apply(terrain(), {
                op: 'set_heights', region: { x: 1, z: 1, width: 0.5, depth: 4 }, rows: [[1, 2], [3, 4]],
            }),
            /needs at least 2 vertices per axis; .* covers 1x5 .* use "value" to set a single row\/column/s
        );
    });

    it('smooths with a clamp-to-edge kernel, so a border keeps its height', () => {
        const flat = terrain();
        apply(flat, { op: 'set_heights', value: 5 });
        apply(flat, { op: 'smooth_heights', iterations: 3 });
        assert.ok([...flat.heights].every((h) => h === heightToRaw(5, true)),
            'a flat terrain must stay flat — an outside tap reuses the edge vertex, it does not read 0');

        // A 9 m spike in the corner: the 3x3 kernel sees it FOUR times through the clamp
        // (x and z each clamp -1 to 0), so (0,0) becomes (4 * 9) / 9 = 4 m.
        const corner = terrain();
        setVertexHeight(corner, 0, 0, 9, true);
        apply(corner, { op: 'smooth_heights' });
        assert.strictEqual(heightAtVertex(corner, 0, 0), 4);
        assert.strictEqual(heightAtVertex(corner, 1, 1), 1); // interior: one tap of 9 m
        assert.strictEqual(heightAtVertex(corner, 2, 2), 0);
    });

    it('reads taps outside the region but writes only inside it', () => {
        const data = terrain();
        setVertexHeight(data, 5, 5, 9, true);
        const { results } = apply(data, {
            op: 'smooth_heights', region: { x: 6, z: 4, width: 2, depth: 2 },
        });
        assert.match(results[0].summary, /vertices 6\.\.8 x 4\.\.6/);
        assert.strictEqual(heightAtVertex(data, 5, 5), 9, 'the spike is outside the region and untouched');
        assert.strictEqual(heightAtVertex(data, 6, 5), 1, 'reads the spike through the region border');
        assert.strictEqual(heightAtVertex(data, 6, 4), 1);
        assert.strictEqual(heightAtVertex(data, 7, 5), 0, 'out of the kernel reach');
        assert.match(results[0].summary, /1 iteration of a 3x3 box blur/);
    });

    it('caps smooth iterations', () => {
        assert.throws(
            () => apply(terrain(), { op: 'smooth_heights', iterations: 0 }),
            /"iterations" must be an integer in 1\.\.64/
        );
        assert.throws(
            () => apply(terrain(), { op: 'smooth_heights', iterations: 65 }),
            /"iterations" must be an integer in 1\.\.64/
        );
    });
});

describe('terrainOps — shaped height edits (falloff / profile / clamp / band)', () => {
    // Closed-form expectations: the factor is `min(1, edge / falloff)`, edge = distance to border

    it('tapers a delta to exactly 0 at the region border', () => {
        const data = terrain({ blockCount: [1, 1], tileSize: 1 });
        apply(data, {
            op: 'adjust_heights', delta: 4, falloff: 4,
            region: { x: 8, z: 8, width: 16, depth: 16 },
        });
        // edge distance: 0 at x=8, 1 m at x=9, full 4 m at x=12
        assert.strictEqual(heightAtVertex(data, 8, 16), 0, 'the border vertex does not move');
        assert.strictEqual(heightAtVertex(data, 9, 16), 1, '1/4 of the delta one tile in');
        assert.strictEqual(heightAtVertex(data, 12, 16), 4, 'full delta 4 m in');
        assert.strictEqual(heightAtVertex(data, 7, 16), 0, 'outside is untouched');
    });

    it('applies the smooth and cosine profiles to the same ramp', () => {
        const t = 0.25; // one tile into a 4 m falloff
        const cases = [
            ['linear', t],
            ['smooth', t * t * (3 - 2 * t)],
            ['cosine', 0.5 - 0.5 * Math.cos(Math.PI * t)],
        ];
        for (const [profile, factor] of cases) {
            const data = terrain();
            apply(data, {
                op: 'adjust_heights', delta: 8, falloff: 4, profile,
                region: { x: 8, z: 8, width: 16, depth: 16 },
            });
            // compare against the 1/128 m-quantized expectation
            const expected = Math.round((8 * factor) * 128) / 128;
            assert.strictEqual(heightAtVertex(data, 9, 16), expected, `${profile} at t=0.25`);
        }
    });

    it('confines an ellipse to its own footprint', () => {
        const data = terrain();
        const { results } = apply(data, {
            op: 'adjust_heights', delta: 3,
            region: { x: 8, z: 8, width: 16, depth: 16, shape: 'ellipse' },
        });
        assert.strictEqual(heightAtVertex(data, 16, 16), 3, 'the centre moves');
        assert.strictEqual(heightAtVertex(data, 8, 8), 0, 'the box corner is outside the ellipse');
        assert.match(results[0].summary, /mask covers \d+ of 289 vertices/);
    });

    it('measures an ellipse falloff on the axis it runs along, not on the short radius', () => {
        // A 60 x 10 m ellipse: 2 m of falloff must be 2 m on BOTH axes. It used to be measured
        // along min(rx, rz), spreading the long-axis ramp over falloff * rx/rz = 12 m.
        const data = terrain({ blockCount: [2, 2] });
        const { results } = apply(data, {
            op: 'adjust_heights', delta: 5, falloff: 2,
            region: { x: 2, z: 27, width: 60, depth: 10, shape: 'ellipse' },
        });
        assert.strictEqual(heightAtVertex(data, 3, 32), 2.5, 'long axis: half way up the ramp 1 m in');
        assert.strictEqual(heightAtVertex(data, 4, 32), 5, 'long axis: full delta exactly 2 m in');
        assert.strictEqual(heightAtVertex(data, 60, 32), 5, 'and the same at the far end');
        assert.strictEqual(heightAtVertex(data, 32, 28), 2.5, 'short axis: half way up 1 m in');
        assert.strictEqual(heightAtVertex(data, 32, 29), 5, 'short axis: full delta exactly 2 m in');
        assert.deepStrictEqual(results[0].notes, [], 'a ramp that fits leaves nothing to report');

        // A circle is unchanged: the taper was already the plain radial distance
        const circle = terrain();
        apply(circle, {
            op: 'adjust_heights', delta: 4, falloff: 4,
            region: { x: 8, z: 8, width: 16, depth: 16, shape: 'ellipse' },
        });
        assert.strictEqual(heightAtVertex(circle, 10, 16), 2);
        assert.strictEqual(heightAtVertex(circle, 12, 16), 4);
    });

    it('caps an ellipse taper at the inradius, so a too-wide falloff has one flat peak', () => {
        // The taper cannot exceed min(rx, rz) anywhere inside an ellipse (that IS the largest
        // inner distance), so the middle is a plateau at 5/8 — not a dimple around the centre
        const data = terrain({ blockCount: [2, 2] });
        const { results } = apply(data, {
            op: 'adjust_heights', delta: 5, falloff: 8,
            region: { x: 2, z: 27, width: 60, depth: 10, shape: 'ellipse' },
        });
        assert.match(results[0].notes.join('\n'), /falloff 8 m is wider than the region's half-extent/);
        assert.match(results[0].notes.join('\n'), /the ramp peaks at 0\.625 of it/);
        for (const i of [20, 31, 32, 33, 44]) {
            assert.strictEqual(heightAtVertex(data, i, 32), 5 * 0.625, `vertex (${i},32)`);
        }
    });

    it('clamps to raise-only / lower-only so an edit cannot fight the surface', () => {
        const build = () => {
            const data = terrain();
            for (let j = 0; j < 33; j++) {
                for (let i = 0; i < 33; i++) setVertexHeight(data, i, j, i < 16 ? 5 : -5, true);
            }
            return data;
        };
        const raise = build();
        const { results } = apply(raise, {
            op: 'set_heights', value: 0, clamp: 'raise-only',
            region: { x: 0, z: 0, width: 32, depth: 32 },
        });
        assert.strictEqual(heightAtVertex(raise, 0, 0), 5, 'already higher — kept');
        assert.strictEqual(heightAtVertex(raise, 20, 0), 0, 'lower — filled up to 0');
        assert.match(results[0].notes.join('\n'), /clamp "raise-only" held \d+ vertices/);

        const lower = build();
        apply(lower, {
            op: 'set_heights', value: 0, clamp: 'lower-only',
            region: { x: 0, z: 0, width: 32, depth: 32 },
        });
        assert.strictEqual(heightAtVertex(lower, 0, 0), 0, 'higher — cut down to 0');
        assert.strictEqual(heightAtVertex(lower, 20, 0), -5, 'already lower — kept');
    });

    it('reports the step a hard-edged edit leaves, and stays quiet once tapered', () => {
        const hard = terrain();
        const step = apply(hard, {
            op: 'adjust_heights', delta: 3, region: { x: 10, z: 10, width: 8, depth: 8 },
        });
        assert.match(step.results[0].notes.join('\n'), /ends in a STEP of up to 3 m at the mask border/);
        assert.match(step.results[0].notes.join('\n'), /Pass falloff: <metres>/);

        const tapered = terrain();
        const smooth = apply(tapered, {
            op: 'adjust_heights', delta: 3, falloff: 4,
            region: { x: 6, z: 6, width: 20, depth: 20 },
        });
        assert.doesNotMatch(smooth.results[0].notes.join('\n'), /STEP/);
    });

    it('names the peak a too-wide falloff actually reaches', () => {
        const data = terrain();
        const { results } = apply(data, {
            op: 'adjust_heights', delta: 4, falloff: 30,
            region: { x: 12, z: 12, width: 8, depth: 8 },
        });
        assert.match(results[0].notes.join('\n'), /falloff 30 m is wider than the region's half-extent/);
        assert.match(results[0].notes.join('\n'), /the ramp peaks at 0\.133 of it/);
    });

    it('blends a smoothed patch through the mask instead of creasing at its border', () => {
        const data = terrain();
        for (let j = 0; j < 33; j++) {
            for (let i = 0; i < 33; i++) setVertexHeight(data, i, j, i % 2 ? 2 : 0, true);
        }
        apply(data, {
            op: 'smooth_heights', iterations: 4, falloff: 4,
            region: { x: 4, z: 4, width: 24, depth: 24 },
        });
        // The border vertex keeps its original comb value (factor 0), the middle is flattened
        assert.strictEqual(heightAtVertex(data, 4, 16), 0, 'vertex 4 is even, so it started at 0 m');
        const middle = heightAtVertex(data, 16, 16);
        assert.ok(middle > 0.5 && middle < 1.5, `middle smoothed toward the mean, got ${middle}`);
    });

    it('follows an iso-contour with a band region', () => {
        // Ramp h = (x - 16) / 4, so the 0 m contour is the line x = 16
        const data = terrain();
        for (let j = 0; j < 33; j++) {
            for (let i = 0; i < 33; i++) setVertexHeight(data, i, j, (i - 16) / 4, true);
        }
        const { results } = apply(data, {
            op: 'adjust_heights', delta: 1,
            region: { shape: 'band', contour: 0, inner: -2, outer: 3 },
        });
        assert.match(results[0].summary, /band -2\.\.3 m around the 0 m contour/);
        // inner -2 = 2 m ABOVE the contour (x > 16), outer 3 = 3 m below it (x < 16)
        assert.strictEqual(heightAtVertex(data, 18, 10), (18 - 16) / 4 + 1, 'inside the band');
        assert.strictEqual(heightAtVertex(data, 13, 10), (13 - 16) / 4 + 1, 'the low side, within 3 m');
        assert.strictEqual(heightAtVertex(data, 19, 10), (19 - 16) / 4, 'beyond inner — untouched');
        assert.strictEqual(heightAtVertex(data, 12, 10), (12 - 16) / 4, 'beyond outer — untouched');
    });

    it('tapers a band across its thickness only, not against the bounding box', () => {
        // The box defaults to the whole terrain, so ramping against it would leave the band at 0
        // amplitude on the border rows — a step along the whole band, in the middle of the edit
        const data = terrain();
        for (let j = 0; j < 33; j++) {
            for (let i = 0; i < 33; i++) setVertexHeight(data, i, j, (i - 16) / 4, true);
        }
        const { results } = apply(data, {
            op: 'adjust_heights', delta: 2, falloff: 1,
            region: { shape: 'band', contour: 0, inner: -2, outer: 2 },
        });
        assert.deepStrictEqual(results[0].notes, [], 'nothing to report — no step, full amplitude');
        for (const z of [0, 1, 16, 32]) {
            assert.strictEqual(heightAtVertex(data, 16, z), 2, `full amplitude on row z ${z}`);
        }
        // Across the band it still tapers: the band edge at x 14 keeps its original height
        assert.strictEqual(heightAtVertex(data, 14, 16), (14 - 16) / 4, 'factor 0 at the band edge');
    });

    it('follows a contour a flat plain sits exactly ON', () => {
        // build_terrain leaves a flat 0 m field, so the foot of anything raised into it is the
        // 0 m contour — with the sampled plain landing EXACTLY on the threshold
        const data = terrain();
        for (let j = 0; j < 33; j++) {
            for (let i = 0; i < 33; i++) {
                setVertexHeight(data, i, j, Math.hypot(i - 16, j - 16) < 6 ? 3 : 0, true);
            }
        }
        const { results } = apply(data, {
            op: 'adjust_heights', delta: 1,
            region: { shape: 'band', contour: 0, inner: -1, outer: 1 },
        });
        assert.match(results[0].summary, /band -1\.\.1 m around the 0 m contour/);
        assert.ok(results[0].summary.includes('108 changed'), results[0].summary);
    });

    it('rejects a band that has no contour, no width, or wrong-way offsets', () => {
        const data = terrain();
        assert.throws(
            () => apply(data, { op: 'adjust_heights', delta: 1, region: { shape: 'band', inner: -1, outer: 1 } }),
            /shape "band" needs "contour"/
        );
        assert.throws(
            () => apply(data, {
                op: 'adjust_heights', delta: 1,
                region: { shape: 'band', contour: 0, inner: 2, outer: 1 },
            }),
            /inner 2 must be less than outer 1 m/
        );
        assert.throws(
            () => apply(data, {
                op: 'adjust_heights', delta: 1, region: { shape: 'band', contour: 0, inner: 0, outer: 0 },
            }),
            /inner 0 must be less than outer 0 m/
        );
        assert.throws(
            () => apply(data, {
                op: 'adjust_heights', delta: 1, region: { shape: 'band', contour: 99, outer: 2 },
            }),
            /no 99 m contour runs through/
        );
        assert.throws(
            () => apply(data, { op: 'adjust_heights', delta: 1, region: { x: 0, contour: 1 } }),
            /region\.contour only applies to shape: "band"/
        );
    });

    it('rejects an unknown profile and clamp', () => {
        const data = terrain();
        assert.throws(
            () => apply(data, { op: 'adjust_heights', delta: 1, falloff: 2, profile: 'ease' }),
            /"profile" must be "linear" \/ "smooth" \/ "cosine", got "ease"/
        );
        assert.throws(
            () => apply(data, { op: 'adjust_heights', delta: 1, clamp: 'up' }),
            /"clamp" must be "none" \/ "raise-only" \/ "lower-only", got "up"/
        );
    });

    it('paints a band along a shoreline, tapering to 0 at both of its edges', () => {
        const data = terrain({ layers: 2, weightMapSize: 32 });
        for (let j = 0; j < 33; j++) {
            for (let i = 0; i < 33; i++) setVertexHeight(data, i, j, (i - 16) / 4, true);
        }
        const { results } = apply(data, {
            op: 'paint_layer', layer: 1, weight: 1, falloff: 1,
            region: { shape: 'band', contour: 0, inner: -3, outer: 3 },
        });
        assert.match(results[0].summary, /band -3\.\.3 m around the 0 m contour/);
        assert.match(results[0].summary, /1 m linear falloff/);
        assert.strictEqual(countShort(data), 0, 'the sum-255 convention holds');
        // Texels near the contour carry the layer; texels far from it do not
        const wms = data.weightMapSize;
        const spacing = 32 / (wms - 1);
        const onContour = Math.round(16 / spacing);
        assert.ok(texel(data, onContour, 3)[1] > 200, 'the contour texel is painted');
        assert.strictEqual(texel(data, 0, 3)[1], 0, 'the far edge of the terrain is not');
    });
});

describe('terrainOps — set_heights from heightmap files', () => {
    let root;

    before(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'terrain-ops-hm-'));
        // 3x3 16-bit LE raw: white centre only
        const raw = Buffer.alloc(3 * 3 * 2);
        raw.writeUInt16LE(65535, (1 * 3 + 1) * 2);
        fs.writeFileSync(path.join(root, 'spike.raw'), raw);
        // 3x3 8-bit grayscale PNG: white centre only
        const samples = new Uint8Array(9);
        samples[4] = 255;
        fs.writeFileSync(path.join(root, 'spike.png'), grayPng(3, 3, samples));
        // 5x5 8-bit grayscale PNG: a ramp along x, constant along z
        const ramp = new Uint8Array(25);
        for (let y = 0; y < 5; y++) ramp.set([0, 64, 128, 191, 255], y * 5);
        fs.writeFileSync(path.join(root, 'ramp.png'), grayPng(5, 5, ramp));
    });

    after(() => fs.rmSync(root, { recursive: true, force: true }));

    const ctx = () => ({ assetIndex: null, projectRoot: root });

    it('reads a headerless 16-bit .raw', () => {
        const data = terrain();
        const region = { x: 0, z: 0, width: 2, depth: 2 };
        applyTerrainOperations(data, [{
            op: 'set_heights', region,
            heightmap: { source: 'spike.raw', width: 3, height: 3, min: 0, max: 8 },
        }], ctx());
        assert.strictEqual(heightAtVertex(data, 1, 1), 8);
        assert.strictEqual(heightAtVertex(data, 0, 0), 0);
        assert.strictEqual(heightAtVertex(data, 2, 2), 0);
    });

    it('reads a grayscale PNG', () => {
        const data = terrain();
        const { results } = applyTerrainOperations(data, [{
            op: 'set_heights',
            region: { x: 0, z: 0, width: 2, depth: 2 },
            heightmap: { source: 'spike.png', min: 0, max: 4 },
        }], ctx());
        assert.strictEqual(heightAtVertex(data, 1, 1), 4);
        assert.strictEqual(heightAtVertex(data, 0, 0), 0);
        assert.match(results[0].summary, /from heightmap "spike\.png"/);
    });

    it('crops an overhanging image the same way inline rows are cropped', () => {
        // Half of x 16..48 m hangs off a 32 m terrain, so only the left half of the ramp lands —
        // the image used to be squeezed into the surviving span and reached its full 10 m there
        const region = { x: 16, z: 0, width: 32, depth: 32 };
        const heightmap = { source: 'ramp.png', min: 0, max: 10 };
        const data = terrain();
        const { results } = applyTerrainOperations(data, [{ op: 'set_heights', region, heightmap }], ctx());
        const roomy = terrain({ blockCount: [2, 1] });
        applyTerrainOperations(roomy, [{ op: 'set_heights', region, heightmap }], ctx());
        for (let i = 16; i <= 32; i++) {
            assert.strictEqual(heightAtVertex(data, i, 4), heightAtVertex(roomy, i, 4), `vertex ${i}`);
        }
        assert.ok(heightAtVertex(data, 32, 4) < 7,
            `the white end of the ramp is off the terrain, got ${heightAtVertex(data, 32, 4)} m at the edge`);
        assert.match(results[0].notes.join('\n'), /overhangs the terrain/);
    });

    it('turns heightmap failures into op errors', () => {
        for (const [heightmap, re] of [
            [{ source: 'nope.png', max: 4 }, /heightmap\.source not found: "nope\.png"/],
            [{ source: 'spike.raw', width: 4, height: 4, max: 4 }, /raw file is 18 bytes, expected 32/],
            [{ source: 'spike.png' }, /"max" .* is required/],
            [{ source: 'spike.png', max: 4, gain: 2 }, /unknown key "gain"/],
        ]) {
            assert.throws(
                () => applyTerrainOperations(terrain(), [{ op: 'set_heights', heightmap }], ctx()),
                (err) => {
                    assert.ok(err instanceof TerrainOpError, `${err.constructor.name}: ${err.message}`);
                    assert.match(err.message, re);
                    return true;
                }
            );
        }
    });

    it('needs a projectRoot for a file source', () => {
        assert.throws(
            () => applyTerrainOperations(
                terrain(), [{ op: 'set_heights', heightmap: { source: 'spike.png', max: 4 } }],
                { assetIndex: null }
            ),
            /requires a project \(projectRoot\) — pass inline "rows" instead/
        );
    });
});

describe('terrainOps — paint_layer', () => {
    it('keeps every touched texel summing to exactly 255', () => {
        const data = terrain({ weightMapSize: 4, layers: 2, slots: [0, 1] });
        const { results } = apply(data, { op: 'paint_layer', layer: 1, weight: 0.5 });
        // 0.5 * 255 = 127.5 -> 128 for the painted channel, 127 left for slot 0
        for (let j = 0; j < 4; j++) {
            for (let i = 0; i < 4; i++) {
                assert.deepStrictEqual(texel(data, i, j), [127, 128, 0, 0], `texel (${i},${j})`);
            }
        }
        assert.match(results[0].summary, /Painted layer 1 .* at weight 0\.5 over 16 texels in 1 block/);
        assert.match(results[0].summary, /every touched texel sums to 255/);
    });

    it('holds the sum at 255 for an odd weight over an ellipse with falloff', () => {
        const data = terrain({ weightMapSize: 8, layers: 3, slots: [0, 1, 2] });
        apply(data, {
            op: 'paint_layer', layer: 2, weight: 0.37, falloff: 6,
            region: { x: 4, z: 4, width: 24, depth: 24, shape: 'ellipse' },
        });
        for (let j = 0; j < 8; j++) {
            for (let i = 0; i < 8; i++) {
                assert.strictEqual(texelSum(data, i, j), 255, `texel (${i},${j})`);
            }
        }
    });

    it('paints a rect region and leaves the rest alone', () => {
        const data = terrain({ weightMapSize: 4, layers: 2, slots: [0, 1] });
        // texels sit every 32 / (4 - 1) = 10.667 m: 0, 10.667, 21.333, 32
        apply(data, { op: 'paint_layer', layer: 1, weight: 1, region: { x: 0, z: 0, width: 11, depth: 11 } });
        assert.deepStrictEqual(texel(data, 0, 0), [0, 255, 0, 0]);
        assert.deepStrictEqual(texel(data, 1, 1), [0, 255, 0, 0]);
        assert.deepStrictEqual(texel(data, 2, 2), [255, 0, 0, 0]);
        assert.deepStrictEqual(texel(data, 3, 0), [255, 0, 0, 0]);
    });

    it('paints an ellipse: the inscribed texels only', () => {
        const data = terrain({ weightMapSize: 4, layers: 2, slots: [0, 1] });
        const { results } = apply(data, {
            op: 'paint_layer', layer: 1, weight: 1, region: { shape: 'ellipse' },
        });
        // centre (16,16), radii 16: only the inner 2x2 texels are inside the ellipse
        assert.match(results[0].summary, /over 4 texels in 1 block/);
        assert.match(results[0].summary, /\(ellipse\)/);
        for (const [i, j] of [[1, 1], [1, 2], [2, 1], [2, 2]]) {
            assert.deepStrictEqual(texel(data, i, j), [0, 255, 0, 0], `inside (${i},${j})`);
        }
        for (const [i, j] of [[0, 0], [3, 3], [0, 2], [3, 1]]) {
            assert.deepStrictEqual(texel(data, i, j), [255, 0, 0, 0], `outside (${i},${j})`);
        }
    });

    it('ramps the weight down to 0 at the region border with falloff', () => {
        const data = terrain({ weightMapSize: 4, layers: 2, slots: [0, 1] });
        apply(data, { op: 'paint_layer', layer: 1, weight: 1, falloff: 32 });
        // falloff t = distance-to-border / 32: the border texels get 0, the inner ring
        // 10.667 / 32 = 1/3 -> round(0.3333 * 255) = 85
        assert.deepStrictEqual(texel(data, 0, 0), [255, 0, 0, 0]);
        assert.deepStrictEqual(texel(data, 3, 3), [255, 0, 0, 0]);
        assert.deepStrictEqual(texel(data, 1, 1), [170, 85, 0, 0]);
        assert.deepStrictEqual(texel(data, 2, 1), [170, 85, 0, 0]);
    });

    // The falloff BLENDS toward the requested weight, it does not write `weight * t`. Writing it
    // made every mask border erase the coverage it reached — for heights the same module has always
    // blended (`current + (target - current) * t`), and a paint has to agree or two overlapping
    // strokes leave a bare stripe of the underlying layer down the middle of continuous painting.
    it('blends a falloff paint into existing coverage instead of erasing it', () => {
        // Two 20 m strokes overlapping by 4 m, both with a 4 m falloff. z is deliberately overhung
        // so only the x edges taper: the seam at x = 16 is where stroke 1 reached full weight and
        // stroke 2's ramp starts at 0.
        const data = terrain({ weightMapSize: 32, layers: 2, slots: [0, 1] });
        const stroke = (x) => ({
            op: 'paint_layer', layer: 1, weight: 1, falloff: 4,
            region: { x, z: -8, width: 20, depth: 48 },
        });
        apply(data, stroke(0));
        const afterFirst = channelGrid(data, 1);
        // Texels sit every 32/31 m, so the seam texel is at x = 16.5 m: stroke 2's ramp is barely
        // above 0 there while stroke 1 had it all but fully covered
        assert.ok(afterFirst[0][16] > 200, `stroke 1 covers the seam (${afterFirst[0][16]})`);

        apply(data, stroke(16));
        const afterBoth = channelGrid(data, 1);
        for (let j = 0; j < 32; j++) {
            for (let i = 0; i < 32; i++) {
                // Painting TOWARD weight 1 can never lower a texel: t = 0 keeps it, t = 1 sets 255
                assert.ok(afterBoth[j][i] >= afterFirst[j][i],
                    `texel (${i},${j}) fell from ${afterFirst[j][i]} to ${afterBoth[j][i]}`);
                assert.strictEqual(texelSum(data, i, j), 255, `texel (${i},${j})`);
            }
        }
        // …so the continuously painted middle stays continuous. Two blended ramps compose as
        // `1 - (1 - a)(1 - b)`, which bottoms out at 0.75 where both are half — the old write-through
        // left the seam texel at its own ramp value (0.13) with stroke 1's coverage gone.
        for (let i = 4; i < 32; i++) {
            assert.ok(afterBoth[0][i] > 180, `texel ${i} of the joined strokes is ${afterBoth[0][i]}`);
        }
    });

    it('leaves an already-normalized texel byte-identical where the mask factor is 0', () => {
        const data = terrain({ weightMapSize: 8, layers: 3, slots: [0, 1, 2] });
        for (let j = 0; j < 8; j++) {
            for (let i = 0; i < 8; i++) setTexelBytes(data, i, j, [100, 80, 75, 0]);
        }
        const before = Uint8Array.from(data.weights);
        // The whole terrain with a falloff: the border texels sit exactly ON the region edge, t = 0
        apply(data, { op: 'paint_layer', layer: 2, weight: 1, falloff: 8 });
        for (let n = 0; n < 8; n++) {
            for (const [i, j] of [[n, 0], [n, 7], [0, n], [7, n]]) {
                assert.deepStrictEqual(texel(data, i, j), [100, 80, 75, 0], `border texel (${i},${j})`);
            }
        }
        assert.ok(data.weights.some((v, n) => v !== before[n]), 'the inside was painted');

        // Re-running the identical paint moves nothing where the factor is 0 (nothing to blend) or
        // 1 (already at the target) — texels 2..5 of both axes are the 8 m-inside plateau
        const settled = Uint8Array.from(data.weights);
        apply(data, { op: 'paint_layer', layer: 2, weight: 1, falloff: 8 });
        for (const [i, j] of [[0, 0], [7, 3], [3, 7], [2, 2], [5, 5], [3, 4]]) {
            assert.deepStrictEqual(
                texel(data, i, j),
                [0, 1, 2, 3].map((k) => settled[weightTexelIndex(data, i, j) + k]),
                `texel (${i},${j}) at factor 0 or 1`
            );
        }
    });

    // A blend by 0 is a no-op only for a texel that already sums to 255. A SHORT one is repaired
    // (deliberately — a short texel renders darkened), and that repair was silent: `repaired`
    // counts only blocks that GAINED a channel, and `short` is measured AFTER the write.
    it('reports the texels it repaired, including the ones the mask factor left at 0', () => {
        const data = terrain({ weightMapSize: 8, layers: 3, slots: [0, 1, 2] });
        for (let j = 0; j < 8; j++) {
            for (let i = 0; i < 8; i++) setTexelBytes(data, i, j, [85, 85, 85, 0]);
        }
        // (0,0) is a corner of the whole-terrain region → factor 0; (1,1) sits 4.571 m in → 0.571
        setTexelBytes(data, 0, 0, [80, 80, 80, 0]);
        setTexelBytes(data, 1, 1, [80, 80, 80, 0]);
        const { results } = apply(data, { op: 'paint_layer', layer: 2, weight: 1, falloff: 8 });

        // The repair happened at factor 0: only the painted layer's own byte was left alone
        assert.strictEqual(texelSum(data, 0, 0), 255);
        assert.strictEqual(texel(data, 0, 0)[2], 80, 'a blend by 0 keeps the painted channel');
        assert.notDeepStrictEqual(texel(data, 0, 0), [80, 80, 80, 0]);
        assert.ok(texel(data, 1, 1)[2] > 80, 'the in-ramp texel was painted');
        assert.strictEqual(texelSum(data, 1, 1), 255);

        const notes = results[0].notes.join('\n');
        assert.match(notes, /2 texels did not sum to 255 before this op and were rescaled to it, as they were written/);
        assert.match(notes, /1 texel changed where the mask factor is 0/);
        // …and it is a repair, not the "please report it" defect
        assert.doesNotMatch(notes, /please report it/);
        assert.strictEqual(countShort(data), 0);

        // Nothing to repair → nothing claimed: the same paint over a normalized map stays quiet
        const clean = terrain({ weightMapSize: 8, layers: 3, slots: [0, 1, 2] });
        for (let j = 0; j < 8; j++) {
            for (let i = 0; i < 8; i++) setTexelBytes(clean, i, j, [85, 85, 85, 0]);
        }
        const quiet = apply(clean, { op: 'paint_layer', layer: 2, weight: 1, falloff: 8 });
        assert.doesNotMatch(quiet.results[0].notes.join('\n'), /did not sum to 255 before this op|mask factor is 0/);
    });

    // `rescaled` counts short texels at ANY factor, so justifying ALL of them with "they move bytes
    // this op was not asked to write" claimed the wrong thing about most of them: a texel at factor 1
    // WAS asked to be written. Measured, 64 of 64 texels are rescaled while only the 28 of the border
    // ring sit at factor 0 — and only those 28 are what the unasked-bytes clause may claim.
    it('justifies the repair count by what it counts, not by the factor-0 subset', () => {
        const data = terrain({ weightMapSize: 8, layers: 3, slots: [0, 1, 2] });
        for (let j = 0; j < 8; j++) {
            for (let i = 0; i < 8; i++) setTexelBytes(data, i, j, [80, 80, 80, 0]);
        }
        // Whole terrain with a 2 m falloff: only the border ring's texels sit ON the region edge
        const { results } = apply(data, { op: 'paint_layer', layer: 2, weight: 1, falloff: 2 });
        // MEASURED: a blend by 0 keeps the painted channel, so a texel still holding 80 there is a
        // factor-0 one — 28, the border ring, against 64 rescaled in all
        let atZeroFactor = 0;
        for (let j = 0; j < 8; j++) {
            for (let i = 0; i < 8; i++) if (texel(data, i, j)[2] === 80) atZeroFactor++;
        }
        assert.strictEqual(atZeroFactor, 28);
        const notes = results[0].notes.join('\n');
        assert.match(notes, /64 texels did not sum to 255 before this op and were rescaled to it, as they were written/);
        assert.match(notes, /28 texels changed where the mask factor is 0/, 'the factor-0 subset is 28 of 64');
        assert.doesNotMatch(notes, /a factor of 0 otherwise means/);
        // the count the op was not asked to write is the factor-0 one, and it is the only one claimed
        assert.match(notes, /bytes moved outside what this op was asked to write: a factor-0 texel asked for no change at all/);
        assert.doesNotMatch(notes, /whatever the mask factor there/);
        assert.doesNotMatch(notes, /the sweep reaches beyond/, 'no block gained a layer here');
    });

    it('agrees with itself about one texel', () => {
        const data = terrain({ weightMapSize: 8, layers: 3, slots: [0, 1, 2] });
        for (let j = 0; j < 8; j++) {
            for (let i = 0; i < 8; i++) setTexelBytes(data, i, j, [85, 85, 85, 0]);
        }
        setTexelBytes(data, 3, 3, [80, 80, 80, 0]);
        const { results } = apply(data, { op: 'paint_layer', layer: 2, weight: 1 });
        // `plural()` yields "1 texel" — the verb beside it used to be hardcoded plural
        assert.match(results[0].notes.join('\n'), /1 texel did not sum to 255 before this op and was rescaled to it, as it was written/);
    });

    it('assigns the layer into the first free block channel', () => {
        const data = terrain({ blockCount: [2, 1], weightMapSize: 4, layers: 3, slots: [0] });
        const { results } = apply(data, { op: 'paint_layer', layer: 2, weight: 1 });
        assert.deepStrictEqual([...data.layerBuffer], [0, 2, -1, -1, 0, 2, -1, -1]);
        assert.match(results[0].notes.join('\n'), /layer 2 was assigned to channel G of block \[0,0\], channel G of block \[1,0\]/);
        assert.deepStrictEqual(texel(data, 0, 0), [0, 255, 0, 0]);
    });

    it('errors, naming the block, when all four blend slots are taken', () => {
        const data = terrain({ weightMapSize: 4, layers: 5, slots: [0, 1, 2, 3] });
        assert.throws(
            () => apply(data, { op: 'paint_layer', layer: 4, weight: 1 }),
            /layer 4 cannot be painted: all 4 blend slots of 1 block are taken by other layers — \[0,0\] uses slots 0, 1, 2, 3/
        );
        // nothing moved
        assert.deepStrictEqual([...data.layerBuffer], [0, 1, 2, 3]);
        assert.deepStrictEqual(texel(data, 0, 0), [255, 0, 0, 0]);
    });

    it('splits the remainder equally when no other channel carries weight', () => {
        const data = terrain({ weightMapSize: 4, layers: 3, slots: [0, 1, 2] });
        setWeightAtTexel(data, 1, 1, [0, 0, 1, 0]);
        const { results } = apply(data, {
            op: 'paint_layer', layer: 2, weight: 0.2, region: { x: 8, z: 8, width: 6, depth: 6 },
        });
        // 0.2 * 255 = 51 on channel B; the 204 left is split 102/102 over R and G
        assert.deepStrictEqual(texel(data, 1, 1), [102, 102, 51, 0]);
        assert.strictEqual(texelSum(data, 1, 1), 255);
        assert.match(results[0].notes.join('\n'), /split equally between the block's other assigned layers/);
    });

    it('ignores the requested weight in a single-layer block and stores 255 instead', () => {
        // Storing 0.5*255 there is a time bomb: while the block assigns one layer the weight map
        // is not sampled at all (maxLayerIndex === 0 -> LAYERS 1, terrain.ts:879/920-930), but the
        // moment a second layer is painted into the block the shader starts sampling and every
        // such texel renders at half brightness. 255 is the only value that survives that.
        const data = terrain({ weightMapSize: 4, layers: 1, slots: [0] });
        const { results } = apply(data, { op: 'paint_layer', layer: 0, weight: 0.5 });
        assert.deepStrictEqual(texel(data, 0, 0), [255, 0, 0, 0]);
        assert.strictEqual(texelSum(data, 0, 0), 255);
        const notes = results[0].notes.join('\n');
        assert.match(notes, /16 texels got weight 1 instead of the requested 0\.5/);
        assert.match(notes, /only layer their block assigns/);
        assert.match(notes, /dark patch the moment a second layer is painted/);
    });

    it('erases a channel at weight 0, reporting how many texels', () => {
        const data = terrain({ weightMapSize: 4, layers: 2, slots: [0, 1] });
        apply(data, { op: 'paint_layer', layer: 1, weight: 1 });
        const { results } = apply(data, { op: 'paint_layer', layer: 1, weight: 0 });
        assert.deepStrictEqual(texel(data, 0, 0), [255, 0, 0, 0]);
        assert.match(results[0].summary, /16 of them at weight 0/);
    });

    it('paints both sides of a block seam a region ends on (as documented)', () => {
        // Each block owns a full weightMapSize grid whose first and last texel sit ON its
        // edges, so the last texel of block [0,0] and the first of block [1,0] share the
        // metre coordinate x = 32 — a region ending there touches both, and the layer gets
        // assigned in both blocks.
        const data = terrain({ blockCount: [2, 1], weightMapSize: 4, layers: 2, slots: [0] });
        const { results } = apply(data, {
            op: 'paint_layer', layer: 1, weight: 1, region: { x: 0, z: 0, width: 32, depth: 32 },
        });
        assert.match(results[0].summary, /over 20 texels in 2 blocks/); // 16 + one edge column
        assert.deepStrictEqual([...data.layerBuffer], [0, 1, -1, -1, 0, 1, -1, -1]);
        assert.deepStrictEqual(texel(data, 3, 0), [0, 255, 0, 0]); // last texel of block 0
        assert.deepStrictEqual(texel(data, 4, 0), [0, 255, 0, 0]); // first texel of block 1
        assert.deepStrictEqual(texel(data, 5, 0), [255, 0, 0, 0]); // and no further
    });

    it('accepts a builtin texture and reports its label', () => {
        const data = terrain({ layers: 1 });
        const { results } = apply(data, {
            op: 'set_layer', slot: 1, detailMap: 'db://internal/default-terrain/default-layer-texture.jpg',
        });
        assert.strictEqual(data.layers[1].detailMapId, '52ef29ed-bd92-4e94-ab2f-0ebc91bf3a60@6c48a');
        assert.match(results[0].summary, /Added palette layer 1: builtin:texture/);
    });

    it('refuses a slot that an earlier op in the same batch re-indexed away', () => {
        const data = terrain({ weightMapSize: 4, layers: 3, slots: [0, 1, 2] });
        assert.throws(
            () => apply(data, { op: 'remove_layer', slot: 0 }, { op: 'paint_layer', layer: 2, weight: 1 }),
            /op\[1\] paint_layer: no palette layer with slot 2 — the palette holds 0 \(.*\), 1 \(.*\)/
        );
    });

    it('clips a region that starts before the terrain', () => {
        const data = terrain();
        const { results } = apply(data, {
            op: 'adjust_heights', delta: 2, region: { x: -5, z: -5, width: 10, depth: 10 },
        });
        assert.match(results[0].summary, /x -5\.\.5 m, z -5\.\.5 m \(vertices 0\.\.5 x 0\.\.5\)/);
        assert.strictEqual(heightAtVertex(data, 0, 0), 2);
        assert.strictEqual(heightAtVertex(data, 5, 5), 2);
        assert.strictEqual(heightAtVertex(data, 6, 6), 0);
    });

    it('validates its arguments', () => {
        const data = terrain({ layers: 1 });
        assert.throws(
            () => apply(data, { op: 'paint_layer', layer: 3, weight: 1 }),
            /no palette layer with slot 3 — the palette holds 0 \(.*\); add one with set_layer first/
        );
        assert.throws(
            () => apply(data, { op: 'paint_layer', layer: 0 }),
            /"weight" \(a finite number\) is required/
        );
        assert.throws(
            () => apply(data, { op: 'paint_layer', layer: 0, weight: 1.5 }),
            /"weight" must be in 0\.\.1, got 1\.5/
        );
        assert.throws(
            () => apply(data, { op: 'paint_layer', layer: 0, weight: 1, falloff: -1 }),
            /"falloff" must be in 0\.\.Infinity metres/
        );
    });

    it('reports the texel spacing when a region catches no texel', () => {
        // weightMapSize 2 puts texels on the block's near and far edge only, 32 / (2 - 1) = 32 m
        // apart — the same endpoint-inclusive figure query_terrain prints.
        const data = terrain({ weightMapSize: 2, layers: 1 });
        assert.throws(
            () => apply(data, {
                op: 'paint_layer', layer: 0, weight: 1, region: { x: 5, z: 5, width: 2, depth: 2 },
            }),
            /contains no weight texel — texels sit every 32 m \(weightMapSize 2 per block side\)/
        );
    });
});

describe('terrainOps — T4 review regressions', () => {
    // Each test here pins a defect the T4 review found. The engine facts they encode are cited
    // inline; all were verified against
    // /Applications/Cocos/Creator/3.8.8/…/cocos/terrain/terrain.ts and the legacy terrain.effect.

    it('does not leave a texel below 255 when a later op makes the block multi-layer', () => {
        // The 2-op accident: paint into a single-layer block at weight 0.5 (unobservable, the
        // shader ignores that block's weight map), then assign a second layer — the map starts
        // being sampled and every one of those texels would render at half brightness. With
        // weight 0 the whole area went pure black (terrain.effect LAYERS==2 is a plain weighted
        // sum with baseColor starting at vec4(0), lines 157-165: no normalization anywhere).
        for (const weight of [0.5, 0]) {
            const data = terrain({ weightMapSize: 8, layers: 2, slots: [0] });
            apply(
                data,
                { op: 'paint_layer', layer: 0, weight },
                { op: 'paint_layer', layer: 1, weight: 1, region: { x: 0, z: 0, width: 4, depth: 4 } },
            );
            assert.deepStrictEqual(blockLayers(data, 0, 0), [0, 1, -1, -1]);
            for (let j = 0; j < 8; j++) {
                for (let i = 0; i < 8; i++) {
                    assert.strictEqual(texelSum(data, i, j), 255,
                        `weight ${weight}: texel (${i},${j}) is ${JSON.stringify(texel(data, i, j))}`);
                }
            }
        }
    });

    it('repairs pre-existing short texels when paint_layer assigns a new slot to a block', () => {
        // A hand-made / older file can hold sum != 255 in a single-layer block. The moment this op
        // adds a second layer the block starts sampling, so renormalize it first — the same repair
        // remove_layer already performs when it changes a block's channel set.
        const data = terrain({ weightMapSize: 4, layers: 2, slots: [0] });
        for (let j = 0; j < 4; j++) {
            for (let i = 0; i < 4; i++) setWeightAtTexel(data, i, j, [0.5, 0, 0, 0]);
        }
        setWeightAtTexel(data, 3, 3, [0, 0, 0, 0]); // a fully black texel too
        const { results } = apply(data, {
            op: 'paint_layer', layer: 1, weight: 1, region: { x: 0, z: 0, width: 1, depth: 1 },
        });
        for (let j = 0; j < 4; j++) {
            for (let i = 0; i < 4; i++) assert.strictEqual(texelSum(data, i, j), 255, `texel (${i},${j})`);
        }
        assert.match(results[0].notes.join('\n'), /16 texels did not sum to 255/);
        assert.match(results[0].notes.join('\n'), /in 1 block that gained layer 1, swept WHOLE before painting/);
    });

    // The sum-255 diagnostic must measure the texels this op WROTE, not every texel of the
    // touched blocks. The editor's own brush stores trunc(w * 255), so a real editor-saved
    // terrain is full of (254,0,0,0) texels — a block-wide sweep reported those as a bug in the
    // op, suppressed the true summary clause, and advised re-running paint_layer over a region
    // that provably cannot reach them.
    it('does not blame the editor\'s own short texels on the op', () => {
        const golden = path.join(
            __dirname, '..', 'fixtures', 'golden', 'terrain', 'terrain.terrain');
        const data = readTerrain(fs.readFileSync(golden));
        // precondition: this is a multi-layer block holding short texels the editor wrote
        assert.deepStrictEqual(blockLayers(data, 0, 0).slice(0, 2), [0, 1]);
        const shortBefore = countShort(data);
        assert.ok(shortBefore > 0, `expected editor-authored short texels, got ${shortBefore}`);

        const { results } = apply(data, {
            op: 'paint_layer', layer: 1, weight: 1, region: { x: 4, z: 4, width: 2, depth: 2 },
        });
        const notes = results[0].notes.join('\n');
        assert.ok(!notes.includes('please report it'), `false alarm in notes:\n${notes}`);
        assert.match(results[0].summary, /every touched texel sums to 255/);
        // untouched texels stay exactly as the editor left them
        assert.strictEqual(countShort(data), shortBefore);
    });

    it('warns when the painted layer becomes a block\'s ONLY layer (whole-block spill)', () => {
        // "Paint the left half" of a 2x1-block terrain: the seam texel column reaches into block
        // [1,0], the auto-assignment makes the layer that block's sole channel, and the engine then
        // draws it flat over the block's whole 32x32-tile area — twice the intended area.
        // getMaxLayer() === 0 -> _updateWeightMap destroys the texture (terrain.ts:857-869,
        // :920-930) and the effect compiles LAYERS 1, whose body never samples the weight map.
        const data = terrain({ blockCount: [2, 1], weightMapSize: 8, layers: 2, slots: [] });
        const { results } = apply(data, {
            op: 'paint_layer', layer: 1, weight: 1, region: { x: 0, z: 0, width: 32, depth: 32 },
        });
        assert.deepStrictEqual([...data.layerBuffer], [1, -1, -1, -1, 1, -1, -1, -1]);
        const notes = results[0].notes.join('\n');
        assert.match(notes, /became the ONLY layer of 2 blocks \(\[0,0\], \[1,0\]\)/);
        assert.match(notes, /render it over their WHOLE 32x32-tile \(32 m\) area, not just the painted region/);
        assert.match(notes, /terrain\.ts:920-930/);
        assert.match(notes, /reaches 4\.571 m \(one texel\) into the next block/);

        // …and it stays quiet when the block genuinely blends more than one layer
        const multi = terrain({ blockCount: [2, 1], weightMapSize: 8, layers: 2, slots: [0] });
        const r2 = apply(multi, { op: 'paint_layer', layer: 1, weight: 0.5 });
        assert.doesNotMatch(r2.results[0].notes.join('\n'), /ONLY layer/);
    });

    it('names the achieved peak when falloff is wider than the region', () => {
        // The ramp is min(1, edge/falloff) with edge = distance to the border, so its peak is
        // min(1, halfExtent/falloff) — a falloff wider than the region's half-extent means the
        // requested weight is reached nowhere, and the summary used to claim it anyway.
        const data = terrain({ weightMapSize: 32, layers: 2, slots: [0] });
        const { results } = apply(data, {
            op: 'paint_layer', layer: 1, weight: 1, region: { x: 10, z: 10, width: 4, depth: 4 }, falloff: 50,
        });
        const notes = results[0].notes.join('\n');
        assert.match(notes, /falloff 50 m is wider than the region's 2 m half-extent/);
        assert.match(notes, /reached NOWHERE/);
        assert.match(notes, /Use a falloff of at most 2 m, or a larger region/);
        // the summary reports what was actually written, not just what was asked for
        assert.match(results[0].summary, /weights written 0\.\d+\.\.0\.\d+/);

        // a falloff that fits stays quiet
        const fine = terrain({ weightMapSize: 32, layers: 2, slots: [0] });
        const r2 = apply(fine, {
            op: 'paint_layer', layer: 1, weight: 1, region: { x: 8, z: 8, width: 16, depth: 16 }, falloff: 2,
        });
        assert.doesNotMatch(r2.results[0].notes.join('\n'), /wider than the region/);
    });

    // The note has to bound the MOVE, not name an amount "every texel keeps": the blend leaves
    // `1 - t` of what a texel held with `t <= peak`, so `1 - peak` is a floor the deepest texel
    // alone sits at — the note claimed it of every texel while its own weight range disproved it.
    it('bounds the blend by the achieved factor when the falloff is too wide', () => {
        const data = terrain({ weightMapSize: 8, layers: 2, slots: [0, 1] });
        for (let j = 0; j < 8; j++) {
            for (let i = 0; i < 8; i++) setTexelBytes(data, i, j, [0, 255, 0, 0]);
        }
        // Painted DOWN to 0 from full coverage, so a texel's remaining byte IS what it kept
        const { results } = apply(data, {
            op: 'paint_layer', layer: 1, weight: 0, falloff: 20,
            region: { x: 6, z: 6, width: 20, depth: 20 },
        });
        const notes = results[0].notes.join('\n');
        assert.match(notes, /the mask peaks at 0\.5/); // min(1, 10 / 20)

        const bound = Number(/no texel moves more than ([\d.]+) of the way/.exec(notes)?.[1]);
        assert.ok(Number.isFinite(bound), `no move bound in: ${notes}`);
        const kept = [];
        for (let j = 0; j < 8; j++) {
            for (let i = 0; i < 8; i++) kept.push(texel(data, i, j)[1] / 255);
        }
        const moved = Math.max(...kept.map((v) => 1 - v));
        assert.ok(moved <= bound + 1 / 255, `moved ${fmt3(moved)} exceeds the stated ${bound}`);
        assert.ok(moved >= bound - 1 / 255, `the stated ${bound} is not reached (max ${fmt3(moved)})`);
        // The old claim, disproven by measurement: NO texel keeps as little as 1 - peakFactor
        assert.ok(Math.min(...kept) > 0.5, `least kept is ${fmt3(Math.min(...kept))}, not 0.5`);
        assert.doesNotMatch(notes, /every texel keeps/);
        // and the weight range the note quotes is the one the summary reports
        assert.match(notes, new RegExp(`weights written ${fmt3(Math.min(...kept))}\\.\\.`));
    });

    // Same claim on the band branch, where the peak is MEASURED rather than derived
    it('bounds the blend by the measured factor when a band is thinner than its falloff', () => {
        // Ramp h = (x - 16) / 4, so the 0 m contour is the line x = 16 and the band is x 14..18
        const data = terrain({ weightMapSize: 32, layers: 2, slots: [0, 1] });
        for (let j = 0; j < 33; j++) {
            for (let i = 0; i < 33; i++) setVertexHeight(data, i, j, (i - 16) / 4, true);
        }
        const { results } = apply(data, {
            op: 'paint_layer', layer: 1, weight: 1, falloff: 4,
            region: { shape: 'band', contour: 0, inner: -2, outer: 2 },
        });
        const notes = results[0].notes.join('\n');
        assert.match(notes, /wider than the band is thick/);
        const bound = Number(/the mask peaks at ([\d.]+)/.exec(notes)?.[1]);
        assert.ok(bound > 0 && bound < 0.5, `measured peak ${bound} (half-thickness 2 / falloff 4)`);

        // Painting up from 0 coverage, so the stored byte IS the fraction of the way it moved
        let moved = 0;
        for (let j = 0; j < 32; j++) {
            for (let i = 0; i < 32; i++) moved = Math.max(moved, texel(data, i, j)[1] / 255);
        }
        assert.ok(moved <= bound + 1 / 255, `moved ${fmt3(moved)} exceeds the stated ${bound}`);
        assert.ok(moved >= bound - 1 / 255, `the stated ${bound} is not reached (max ${fmt3(moved)})`);
        assert.doesNotMatch(notes, /every texel keeps/);
    });

    // The mask bounds NOTHING where the painted layer is the block's only assigned one: paintTexel
    // stores 255 whatever the factor (the same fact the op reports as `ignored`), so the note that
    // claimed "no texel moves more than 0.114 of the way toward 0.5" was refuted by its own
    // parenthetical — every texel moved the whole way and PAST the target.
    it('does not bound the move by the mask where the block assigns this layer alone', () => {
        const data = terrain({ weightMapSize: 8, layers: 2, slots: [0] });
        for (let j = 0; j < 8; j++) {
            for (let i = 0; i < 8; i++) setWeightAtTexel(data, i, j, [0, 0, 0, 0]);
        }
        const { results } = apply(data, {
            op: 'paint_layer', layer: 0, weight: 0.5, falloff: 20,
            region: { x: 8, z: 8, width: 8, depth: 8 },
        });
        // measured: all four covered texels went 0 -> 255, i.e. twice the way to the requested 0.5
        for (const [i, j] of [[2, 2], [3, 2], [2, 3], [3, 3]]) {
            assert.deepStrictEqual(texel(data, i, j), [255, 0, 0, 0], `texel (${i},${j})`);
        }
        const notes = results[0].notes.join('\n');
        assert.match(notes, /the mask peaks at 0\.2 \(0\.114 on the texel grid\)/);
        assert.match(notes, /but that bounds nothing here/);
        assert.match(notes, /every texel it covers \(4\) sits in a block assigning layer 0 alone/);
        assert.doesNotMatch(notes, /no texel moves more than/, 'there is no such bound here');
        assert.doesNotMatch(notes, /reached NOWHERE/, 'weight 1 was reached everywhere');
        // …and a single stored value is not printed as a range, which the summary omits outright
        assert.doesNotMatch(notes, /weights written 1\.\.1/);
        assert.match(notes, /every touched texel at weight 1/);
        assert.doesNotMatch(results[0].summary, /weights written/);
    });

    it('excepts those texels from the bound but keeps it for the blended ones', () => {
        // Block [0,0] assigns layer 0 alone, block [1,0] blends 0 and 1: one paint, both regimes
        const data = terrain({ blockCount: [2, 1], weightMapSize: 8, layers: 2, slots: [] });
        setBlockLayers(data, 0, 0, [0, -1, -1, -1]);
        setBlockLayers(data, 1, 0, [0, 1, -1, -1]);
        for (let j = 0; j < 8; j++) {
            for (let i = 0; i < 8; i++) setWeightAtTexel(data, i, j, [0, 0, 0, 0]);
            for (let i = 8; i < 16; i++) setWeightAtTexel(data, i, j, [0, 1, 0, 0]);
        }
        const { results } = apply(data, {
            op: 'paint_layer', layer: 0, weight: 1, falloff: 30,
            region: { x: 20, z: 8, width: 24, depth: 8 },
        });
        const notes = results[0].notes.join('\n');
        assert.match(notes, /EXCEPT the 6 texels whose block assigns layer 0 alone/);
        const bound = Number(/no texel moves more than ([\d.]+) of the way/.exec(notes)?.[1]);
        assert.ok(Number.isFinite(bound), `no move bound in: ${notes}`);
        // Painting up from 0 coverage, so the stored byte IS the fraction of the way it moved
        for (let j = 0; j < 8; j++) {
            for (let i = 8; i < 16; i++) {
                assert.ok(texel(data, i, j)[0] / 255 <= bound + 1 / 255,
                    `blended texel (${i},${j}) moved past the stated ${bound}`);
            }
            // …while the sole-layer block ignored the mask entirely
            for (let i = 0; i < 8; i++) {
                assert.ok([0, 255].includes(texel(data, i, j)[0]), `sole-layer texel (${i},${j})`);
            }
        }
    });

    // A sole-layer block stores 255 whatever the mask says, so the REQUEST is ignored at every one of
    // its texels — but the count was decided against the BLENDED value, which is itself 255 at factor 0
    // on an already-full texel. Every falloff border texel therefore dropped out of the count: measured
    // 196 of the 289 the byte scan finds, while the same op without a falloff reported all 289.
    it('counts every texel whose block ignored the requested weight, at any mask factor', () => {
        const sole = () => terrain({
            blockCount: [2, 2], weightMapSize: 16, layers: 3, slots: [0, -1, -1, -1],
        });
        const region = { x: 0, z: 0, width: 32, depth: 32 };
        const data = sole();
        const { results } = apply(data, { op: 'paint_layer', layer: 0, weight: 0, region, falloff: 8 });
        // MEASURED: all 17x17 touched texels stand at 255, i.e. the requested 0 was ignored at each
        let at255 = 0;
        for (let j = 0; j <= 16; j++) {
            for (let i = 0; i <= 16; i++) if (texel(data, i, j)[0] === 255) at255++;
        }
        assert.strictEqual(at255, 289);
        assert.match(results[0].summary, /over 289 texels in 4 blocks/);
        assert.match(results[0].notes.join('\n'), /289 texels got weight 1 instead of the requested 0, whatever the mask factor there/);

        // …and the falloff cannot change that count, since the request is one number for the region
        const flat = apply(sole(), { op: 'paint_layer', layer: 0, weight: 0, region });
        assert.match(flat.results[0].notes.join('\n'), /289 texels got weight 1 instead of the requested 0,/);
    });

    // The wide-falloff note's EXCEPT clause counted `ignored` while its parenthetical quoted the whole
    // region: "reached NOWHERE …, EXCEPT the 196 texels … (every touched texel at weight 1)" — 289 and
    // 196 in one sentence. The escapees are the FORCED texels, a property of their blocks alone, so
    // "bounds nothing here" holds whenever the whole region sits in such blocks (against the blended
    // value it needed a texel the mask had actually moved, which a factor-0 border never is).
    it('states one count in the wide-falloff note when every texel is in a sole-layer block', () => {
        const sole = () => terrain({
            blockCount: [2, 2], weightMapSize: 16, layers: 3, slots: [0, -1, -1, -1],
        });
        const region = { x: 0, z: 0, width: 32, depth: 32 };
        const { results } = apply(sole(), {
            op: 'paint_layer', layer: 0, weight: 0.25, region, falloff: 40,
        });
        const wideNote = results[0].notes.find((n) => n.startsWith('falloff 40 m'));
        assert.match(wideNote, /but that bounds nothing here: every texel it covers \(289\)/);
        assert.doesNotMatch(wideNote, /EXCEPT/, 'the exception cannot coexist with "bounds nothing"');
        assert.doesNotMatch(wideNote, /reached NOWHERE/);
        assert.doesNotMatch(wideNote, /\b196\b/, 'the two clauses used to disagree by 93 texels');
        assert.match(results[0].notes.join('\n'), /289 texels got weight 1 instead of the requested 0\.25/);

        // At weight 1 the request IS 1, so nothing is ignored — but the same texels still escape the
        // bound, so the note keeps counting them and its "see below" pointer goes away with the note
        const asked = apply(sole(), { op: 'paint_layer', layer: 0, weight: 1, region, falloff: 40 });
        const notes = asked.results[0].notes.join('\n');
        assert.match(notes, /every texel it covers \(289\)/);
        assert.doesNotMatch(notes, /got weight 1 instead of the requested/);
        assert.doesNotMatch(notes, /see below/);
    });

    // Two differently-worded notes for one phenomenon, with disjoint counts and no statement that
    // they partition: measured, a block gaining the layer contributed 64 and the writes 64 for 128
    // touched texels, reported as "64 … of the newly-multi-layer block(s)" AND "64 … in the region".
    it('accounts for both halves of the short-texel repair in one note', () => {
        const data = terrain({ blockCount: [2, 1], weightMapSize: 8, layers: 3 });
        setBlockLayers(data, 0, 0, [0, -1, -1, -1]); // gains layer 2 → swept before painting
        setBlockLayers(data, 1, 0, [0, 1, 2, -1]); // already assigns it → rescaled as written
        for (let j = 0; j < 8; j++) {
            for (let i = 0; i < 16; i++) setTexelBytes(data, i, j, [90, 10, 5, 0]); // sums to 105
        }
        const { results } = apply(data, { op: 'paint_layer', layer: 2, weight: 1 });
        const accounts = results[0].notes.filter((n) => /did not sum to 255/.test(n));
        assert.strictEqual(accounts.length, 1, `one account, not two:\n${accounts.join('\n')}`);
        assert.match(accounts[0], /128 texels did not sum to 255 before this op and were rescaled to it, 64 in 1 block that gained layer 2, swept WHOLE before painting/);
        assert.match(accounts[0], /64 as they were written/);
        // …and 128 is every touched texel, so the two halves partition the region
        assert.match(results[0].summary, /over 128 texels in 2 blocks/);
        assert.strictEqual(countShort(data), 0);
    });

    // …and the sweep's justification must hold for what it counts: `repaired` sums over the blocks
    // that GAINED the layer, which is not the same as the blocks that became multi-layer — a block
    // already blending two layers was counted as "left over from when the block assigned a single
    // layer, where the shader ignores the weight map", where the shortness had been rendering all along.
    it('does not explain the sweep by a single-layer block that was already blending two', () => {
        const data = terrain({ weightMapSize: 8, layers: 3, slots: [0, 1, -1, -1] });
        for (let j = 0; j < 8; j++) {
            for (let i = 0; i < 8; i++) setTexelBytes(data, i, j, [90, 10, 0, 0]); // sums to 100
        }
        const { results } = apply(data, {
            op: 'paint_layer', layer: 2, weight: 1, region: { x: 0, z: 0, width: 4, depth: 4 },
        });
        const notes = results[0].notes.join('\n');
        assert.match(notes, /64 texels did not sum to 255 before this op and were rescaled to it, in 1 block that gained layer 2, swept WHOLE before painting/);
        assert.match(notes, /gaining a channel changes what the block blends/);
        assert.doesNotMatch(notes, /left over from when the block assigned a single layer/);
        // the sweep reached the whole block: 64 texels for a region that touches exactly one
        assert.match(results[0].summary, /over 1 texel in 1 block/);
        assert.strictEqual(countShort(data), 0);
    });

    it('reports the painted texel index range so a falloff paint is verifiable', () => {
        const data = terrain({ weightMapSize: 8, layers: 2, slots: [0, 1] });
        const { results } = apply(data, {
            op: 'paint_layer', layer: 1, weight: 1, region: { x: 0, z: 0, width: 8, depth: 8 },
        });
        assert.match(results[0].summary, /global texels 0\.\.1 x 0\.\.1/);
    });

    it('rejects an op name inherited from Object.prototype', () => {
        // A bare `HANDLERS[op.op]` lookup resolves `constructor` to `Object`, which passed the
        // truthiness guard, "succeeded" as a no-op and still wrote the file.
        for (const name of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
            assert.throws(
                () => applyTerrainOperation(terrain(), { op: name }),
                (err) => {
                    assert.ok(err instanceof TerrainOpError, `${name}: ${err.name}`);
                    assert.strictEqual(
                        err.message,
                        `Unknown op "${name}". Supported: ${TERRAIN_OP_NAMES.join(', ')}`
                    );
                    return true;
                }
            );
        }
    });

    it('reports a dangling layerBuffer reference instead of silently dropping it', () => {
        // compactPalette rewrites a layerBuffer value with no layer record to -1. Left unreported,
        // the block silently loses an assignment — and the -1 can land BELOW a used channel, which
        // the engine samples as a null layer (renders as nothing).
        const data = terrain({ weightMapSize: 4, layers: 2, slots: [0, 1] });
        for (let j = 0; j < 4; j++) {
            for (let i = 0; i < 4; i++) setWeightAtTexel(data, i, j, [0.25, 0.75, 0, 0]);
        }
        setBlockLayers(data, 0, 0, [7, 1]); // channel R points at a non-existent palette slot
        const { notes } = apply(data, { op: 'adjust_heights', delta: 0 });
        const text = notes.join('\n');
        assert.match(text, /referenced palette slot\(s\) 7, which have no layer record/);
        assert.match(text, /1 block lost a layer assignment/);
        assert.match(text, /left-packed/);
        // the repair is complete: no hole below a used channel, and the surviving weights moved
        assert.deepStrictEqual(blockLayers(data, 0, 0), [1, -1, -1, -1]);
        assert.deepStrictEqual(texel(data, 0, 0), [255, 0, 0, 0]);
    });

    it('accepts weightMapSize 1024 — one of the four sizes the editor panel offers', () => {
        const data = terrain({ weightMapSize: 512, layers: 1 });
        const { results } = apply(data, { op: 'set_info', weightMapSize: 1024 });
        assert.strictEqual(data.weightMapSize, 1024);
        assert.strictEqual(data.weights.length, 1024 * 1024 * 4);
        assert.match(results[0].summary, /weightMapSize 512 -> 1024/);
        // …and back down again, so the trip is not one-way
        const back = apply(data, { op: 'set_info', weightMapSize: 512 });
        assert.strictEqual(data.weightMapSize, 512);
        assert.match(back.results[0].summary, /weightMapSize 1024 -> 512/);
    });

    it('does not apply the authoring guard to a weightMapSize the op leaves unchanged', () => {
        // The guard is an editor convention, so restating the file's own size — what an LLM does
        // when it echoes the whole info block back — must never fail, even for a file whose size
        // is outside the guard.
        const data = materialize({
            blockCount: [1, 1], tileSize: 1, weightMapSize: 2048, lightMapSize: 128,
            layers: [layerRecord(0)],
        });
        setBlockLayers(data, 0, 0, [0]);
        const { results } = apply(data, { op: 'set_info', weightMapSize: 2048, tileSize: 2 });
        assert.strictEqual(data.weightMapSize, 2048);
        assert.match(results[0].summary, /tileSize 1 -> 2 m/);
    });
});

describe('terrainOps — set_block_layers', () => {
    it('writes one block, or every block, without touching weights', () => {
        const data = terrain({ blockCount: [2, 2], weightMapSize: 4, layers: 2, slots: [0] });
        const weights = Uint8Array.from(data.weights);

        const one = apply(data, { op: 'set_block_layers', block: [1, 1], layers: [1, 0] });
        assert.deepStrictEqual(blockLayers(data, 1, 1), [1, 0, -1, -1]);
        assert.deepStrictEqual(blockLayers(data, 0, 0), [0, -1, -1, -1]);
        assert.match(one.results[0].summary, /Set the layer slots of block \[1,1\] to \[1, 0, -1, -1\]/);
        assert.match(one.results[0].notes.join('\n'), /weights are not PAINTED by this op/);

        const all = apply(data, { op: 'set_block_layers', block: 'all', layers: [1] });
        for (let by = 0; by < 2; by++) {
            for (let bx = 0; bx < 2; bx++) assert.deepStrictEqual(blockLayers(data, bx, by), [1, -1, -1, -1]);
        }
        assert.match(all.results[0].summary, /all 4 blocks to \[1, -1, -1, -1\] = R: /);
        assert.match(all.results[0].summary, /\(4 of 4 block\(s\) actually changed\)/);
        assert.deepStrictEqual([...data.weights], [...weights]);
    });

    // Un-assigning a channel used to leave its weight byte in place. That byte is not inert:
    // while the block still blends >= 2 layers the four channels stop summing to 255 (the shader
    // is a plain weighted sum, so the whole block darkens), and it comes back as coverage nobody
    // painted the moment that channel gains a layer again.
    it('zeroes and renormalizes the weights of un-assigned channels', () => {
        const data = terrain({ weightMapSize: 4, layers: 4 });
        for (let j = 0; j < 4; j++) {
            for (let i = 0; i < 4; i++) setWeightAtTexel(data, i, j, [64, 64, 64, 63]);
        }

        const { results } = apply(data, { op: 'set_block_layers', block: [0, 0], layers: [0, 1, 2] });
        assert.deepStrictEqual(blockLayers(data, 0, 0), [0, 1, 2, -1]);
        // channel A zeroed, the three survivors rescaled from 192 back up to 255
        assert.deepStrictEqual(texel(data, 0, 0), [85, 85, 85, 0]);
        assert.strictEqual(texelSum(data, 2, 3), 255);
        assert.match(results[0].notes.join('\n'), /16 texels were renormalized/);
        assert.match(results[0].notes.join('\n'), /no stale byte resurfaces/);

        // and the stale byte cannot resurface: re-assigning a 4th layer starts from 0, not 63
        const again = apply(data, { op: 'set_block_layers', block: [0, 0], layers: [0, 1, 2, 3] });
        assert.deepStrictEqual(texel(data, 0, 0), [85, 85, 85, 0]);
        assert.strictEqual(texelSum(data, 0, 0), 255);
        assert.ok(!again.results[0].notes.join('\n').includes('renormalized'),
            'nothing to repair — the channel was already zeroed when it lost its layer');
    });

    // A weight byte belongs to its LAYER, not to its channel position. Renormalizing by position
    // handed the bytes to whichever layer landed on that channel: [0,1] -> [1] gave layer 0's
    // coverage to layer 1 and dropped layer 1's own, which is exactly what the emitted note claimed
    // did NOT happen. terrainBin's removeLayer has always moved the weights along.
    it('moves each channel\'s weights with its layer, dropping only un-assigned ones', () => {
        const data = terrain({ weightMapSize: 4, layers: 3 });
        for (let j = 0; j < 4; j++) {
            for (let i = 0; i < 4; i++) setTexelBytes(data, i, j, [51, 68, 136, 0]);
        }
        const { results } = apply(data, { op: 'set_block_layers', block: [0, 0], layers: [1, 2] });
        assert.deepStrictEqual(blockLayers(data, 0, 0), [1, 2, -1, -1]);
        // layers 1 and 2 keep their own 68 : 136 ratio, rescaled from 204 up to 255; layer 0's 51 is
        // gone rather than inherited by layer 1
        assert.deepStrictEqual(texel(data, 0, 0), [85, 170, 0, 0]);
        assert.strictEqual(texelSum(data, 2, 3), 255);
        const notes = results[0].notes.join('\n');
        assert.match(notes, /weights of 16 texels FOLLOWED their layer/);
        assert.match(notes, /16 texels were renormalized/);
    });

    it('keeps every layer\'s coverage when the channels are only reordered', () => {
        const data = terrain({ blockCount: [1, 1], weightMapSize: 4, layers: 2 });
        for (let j = 0; j < 4; j++) {
            for (let i = 0; i < 4; i++) setTexelBytes(data, i, j, [64, 191, 0, 0]);
        }
        /** What each palette slot covers at texel (0,0), by its channel */
        const coverage = () => {
            const slots = blockLayers(data, 0, 0);
            return [0, 1].map((s) => texel(data, 0, 0)[slots.indexOf(s)]);
        };
        assert.deepStrictEqual(coverage(), [64, 191]);

        const { results } = apply(data, { op: 'set_block_layers', block: [0, 0], layers: [1, 0] });
        assert.deepStrictEqual(blockLayers(data, 0, 0), [1, 0, -1, -1]);
        assert.deepStrictEqual(coverage(), [64, 191], 'a pure reorder cannot change what a layer covers');
        assert.deepStrictEqual(texel(data, 0, 0), [191, 64, 0, 0]);
        // The sum never left 255, so there was nothing to renormalize — only to move
        assert.match(results[0].notes.join('\n'), /weights of 16 texels FOLLOWED their layer/);
        assert.doesNotMatch(results[0].notes.join('\n'), /were renormalized/);
    });

    // The same repair remove_layer performs: a texel covered ONLY by an un-assigned layer has
    // no weight left at all and would render as nothing.
    it('falls back to the first remaining layer for texels left with no coverage', () => {
        const data = terrain({ weightMapSize: 4, layers: 2 });
        for (let j = 0; j < 4; j++) {
            for (let i = 0; i < 4; i++) setWeightAtTexel(data, i, j, [0, 255, 0, 0]);
        }
        const { results } = apply(data, { op: 'set_block_layers', block: [0, 0], layers: [0] });
        assert.deepStrictEqual(texel(data, 0, 0), [255, 0, 0, 0]);
        assert.match(results[0].notes.join('\n'), /16 texels were covered by an un-assigned layer ALONE/);
        assert.match(results[0].notes.join('\n'), /fall back to layer 0 at full weight/);
    });

    // Only blocks whose channel SET changed may be touched — a no-op batch has to stay
    // byte-identical, which the golden round-trip test relies on.
    it('leaves the weights of unchanged blocks alone', () => {
        const data = terrain({ blockCount: [2, 1], weightMapSize: 4, layers: 2 });
        setWeightAtTexel(data, 0, 0, [64, 64, 64, 63]); // block [0,0], deliberately short
        const before = Uint8Array.from(data.weights);
        const { results } = apply(data, { op: 'set_block_layers', block: [1, 0], layers: [0, 1] });
        assert.deepStrictEqual([...data.weights], [...before]);
        assert.match(results[0].summary, /\(0 of 1 block\(s\) actually changed\)/);
        assert.ok(!results[0].notes.join('\n').includes('renormalized'));
    });

    it('clears a block and warns that nothing will render', () => {
        const data = terrain({ layers: 1 });
        const { results } = apply(data, { op: 'set_block_layers', block: [0, 0], layers: [] });
        assert.deepStrictEqual(blockLayers(data, 0, 0), [-1, -1, -1, -1]);
        assert.match(results[0].notes.join('\n'), /render the effect's flat grey fallback/);
    });

    it('refuses holes, duplicates, unknown slots and out-of-range blocks', () => {
        const data = terrain({ layers: 2 });
        for (const [op, re] of [
            [{ layers: [0, -1, 1] }, /leaves an empty channel before a used one/],
            [{ layers: [0, 0] }, /palette slot 0 appears twice/],
            [{ layers: [0, 5] }, /layers\[1\] = 5 has no palette entry/],
            [{ layers: [0, 1, 0, 1, 0] }, /"layers" has 5 entries but a block has only 4 blend slots/],
            [{ layers: 0 }, /"layers" must be an array of up to 4 palette slots/],
            [{ layers: [1.5] }, /layers\[0\] = 1\.5 must be -1 \(empty\) or a palette slot in 0\.\.255/],
        ]) {
            assert.throws(() => apply(data, { op: 'set_block_layers', block: [0, 0], ...op }), re);
        }
        assert.throws(
            () => apply(data, { op: 'set_block_layers', block: [1, 0], layers: [0] }),
            /block \[1,0\] is outside the 1 x 1 block grid \(valid: \[0\.\.0, 0\.\.0\]\)/
        );
        assert.throws(
            () => apply(data, { op: 'set_block_layers', layers: [0] }),
            /"block" is required: \[x, z\] block coordinates/
        );
        assert.throws(
            () => apply(data, { op: 'set_block_layers', block: 'every', layers: [0] }),
            /"block" must be \[x, z\] integer block coordinates or "all"/
        );
        assert.deepStrictEqual(blockLayers(data, 0, 0), [0, 1, -1, -1], 'nothing changed');
    });
});

describe('terrainOps — a geometry the binary format cannot store', () => {
    /**
     * A terrain whose stored `weightMapSize` is not a power of two. The engine loads such a
     * file (plain i16, no power-of-two check anywhere in `cocos/terrain/`), `writeTerrain`
     * refuses it — so it has to be built by hand here, `materialize` validating the geometry.
     */
    function oddWeightMapTerrain(weightMapSize = 6) {
        const data = terrain({ layers: 1 });
        data.weightMapSize = weightMapSize;
        data.weights = new Uint8Array(weightMapSize * weightMapSize * 4);
        for (let i = 0; i < data.weights.length; i += 4) data.weights[i] = 255;
        return data;
    }

    it('is refused before the first op, naming the file and not the ops', () => {
        const data = oddWeightMapTerrain();
        assert.throws(() => validateTerrainData(data), /weightMapSize = 6 must be a power of two/,
            'the write path would reject this file whatever the batch does');
        const heights = Uint16Array.from(data.heights);
        assert.throws(
            () => apply(data, { op: 'adjust_heights', delta: 3 }),
            (err) => {
                assert.ok(err instanceof TerrainOpError);
                assert.match(err.message, /cannot be written back at all: weightMapSize = 6 must be a power of two/);
                assert.match(err.message, /Nothing is wrong with the requested ops/);
                assert.match(err.message, /"op": "set_info"/);
                return true;
            }
        );
        assert.deepStrictEqual([...data.heights], [...heights], 'no op ran');
    });

    it('does not take a RESTATE of the bad size as the repair', () => {
        assert.throws(
            () => apply(oddWeightMapTerrain(), { op: 'set_info', weightMapSize: 6 }),
            /cannot be written back at all: weightMapSize = 6 must be a power of two/
        );
    });

    it('runs the batch when a set_info introduces a writable size', () => {
        const data = oddWeightMapTerrain();
        const { results } = apply(
            data,
            { op: 'set_info', weightMapSize: 4 },
            { op: 'paint_layer', layer: 0, weight: 1 },
        );
        assert.match(results[0].summary, /weightMapSize 6 -> 4/);
        assert.strictEqual(data.weightMapSize, 4);
        assert.strictEqual(data.weights.length, 4 * 4 * 4);
        assert.doesNotThrow(() => validateTerrainData(data));
    });

    // The guard asks terrainBin about the WHOLE scalar geometry, so a field other than
    // weightMapSize gets the same early, honest refusal instead of dying after the batch.
    it('covers the other geometry fields the format refuses', () => {
        const zeroTile = terrain({ layers: 1 });
        zeroTile.tileSize = 0;
        assert.throws(
            () => apply(zeroTile, { op: 'adjust_heights', delta: 1 }),
            /cannot be written back at all: tileSize must be a finite number > 0, got 0/
        );
        // …and a set_info that replaces it lets the batch through
        const { results } = apply(zeroTile, { op: 'set_info', tileSize: 1 });
        assert.match(results[0].summary, /tileSize 0 -> 1 m/);
        assert.doesNotThrow(() => validateTerrainData(zeroTile));
    });

    // The repair used to be refused BY THE REPAIR PATH: `prepare`'s rebuild re-validated the very
    // geometry the batch replaces. Buffer sizes derive from weightMapSize, so this is the common case.
    it('repairs a bad size whose buffers are mis-sized too', () => {
        const data = oddWeightMapTerrain(3);
        // buffers sized for the real map, not for the bogus declaration
        data.weights = new Uint8Array(4 * 4 * 4);
        for (let i = 0; i < data.weights.length; i += 4) data.weights[i] = 255;

        const { results, notes } = apply(
            data,
            { op: 'set_info', weightMapSize: 128 },
            { op: 'paint_layer', layer: 0, weight: 1 },
        );

        assert.match(results[0].summary, /weightMapSize 3 -> 128/);
        assert.strictEqual(data.weightMapSize, 128);
        assert.strictEqual(data.weights.length, 128 * 128 * 4);
        assert.doesNotThrow(() => validateTerrainData(data), 'the repaired file is writable');
        assert.match(notes.join('\n'), /stores 64 weights instead of 36/);
        assert.match(notes.join('\n'), /rebuilt a second time, onto the new one/);
    });

    // Replacing SOME sizing field is not automatically the repair: the guard composes and re-asks,
    // so a batch leaving the offending value in place is refused up front, not at write time.
    it('does not take an unrelated sizing change as the repair', () => {
        const data = oddWeightMapTerrain();
        const heights = Uint16Array.from(data.heights);
        assert.throws(
            () => apply(data, { op: 'set_info', blockCount: [2, 2] }),
            /cannot be written back at all: weightMapSize = 6 must be a power of two/
        );
        assert.deepStrictEqual([...data.heights], [...heights], 'no op ran');
        // the same batch WITH the offending field replaced is accepted
        assert.doesNotThrow(() => apply(data, { op: 'set_info', blockCount: [2, 2], weightMapSize: 4 }));
        assert.doesNotThrow(() => validateTerrainData(data));
    });

    // Waiving the format rules must not waive the caps that stop a garbage header asking for GBs.
    it('still refuses a geometry it could not even allocate', () => {
        const data = oddWeightMapTerrain();
        data.blockCount = [4096, 4096];
        assert.throws(
            () => apply(data, { op: 'set_info', weightMapSize: 4 }),
            (err) => {
                assert.ok(err instanceof TerrainOpError);
                assert.match(err.message, /cannot be prepared for editing/);
                assert.match(err.message, /exceeds TERRAIN_MAX_BLOCKS/);
                assert.match(err.message, /property of the FILE|what the FILE already stores/);
                return true;
            }
        );
    });

    it('leaves a writable size outside the editor panel editable', () => {
        // 2 is below the panel's smallest map, so `checkWeightMapSize` refuses to INTRODUCE it
        // — but it is a writable power of two, and a file already holding one must stay
        // editable, restated info block and all.
        const data = terrain({ weightMapSize: 2, layers: 1 });
        const { results } = apply(data, { op: 'set_info', weightMapSize: 2, tileSize: 2 });
        assert.strictEqual(data.weightMapSize, 2);
        assert.strictEqual(data.tileSize, 2);
        assert.match(results[0].summary, /tileSize 1 -> 2 m/);
        assert.doesNotThrow(() => validateTerrainData(data));
    });
});

// --- helpers -----------------------------------------------------------------

/** Minimal 8-bit grayscale PNG (filter 0 rows) */
function grayPng(width, height, samples) {
    const raw = Buffer.alloc(height * (width + 1));
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) raw[y * (width + 1) + 1 + x] = samples[y * width + x];
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', zlib.deflateSync(raw)),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
}

function pngChunk(type, data) {
    const out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'latin1');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
}

const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c;
    }
    return table;
})();

function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}
