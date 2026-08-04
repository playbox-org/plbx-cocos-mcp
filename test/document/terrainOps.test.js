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
            /unknown key "radius" — set_heights takes region, value, rows, heightmap/
        );
        assert.throws(
            () => apply(terrain(), { op: 'adjust_heights', delta: 1, region: { x: 0, radius: 5 } }),
            /region: unknown key "radius" — valid keys are x, z, width, depth/
        );
        assert.throws(
            () => apply(terrain({ layers: 1 }), {
                op: 'paint_layer', layer: 0, weight: 1, region: { shape: 'circle' },
            }),
            /region\.shape must be "rect" or "ellipse", got "circle"/
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
        assert.match(results[0].notes.join('\n'), /fall back to layer 0 at full weight/);
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
            /region must be an object \{x, z, width, depth\} in local metres/
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
        assert.match(results[0].notes.join('\n'), /did not sum to 255/);
        assert.match(results[0].notes.join('\n'), /rescaled to 255 before painting/);
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
