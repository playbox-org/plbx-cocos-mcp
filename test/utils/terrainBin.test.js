/**
 * `.terrain` binary reader/writer tests (Phase T0)
 *
 * The acceptance bar is the golden round-trip: an unmodified editor-saved
 * `terrain.terrain` must come back byte-for-byte identical — INCLUDING the
 * 63150 bytes of power-of-two zero padding — after `readTerrain` →
 * `writeTerrain`. Everything else (sampling, migration, validation) is layered
 * on top of that.
 *
 * Golden fixtures are editor output; never reformat or hand-edit them.
 * The mock-project fixture (`assets/Maps/Terrain.terrain`) is generated —
 * regenerate with `node scratchpad/gen-mock-terrain.mjs` (see git history of
 * TERRAIN_PLAN.md T0; the script is throwaway scaffolding, the fixture is committed).
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

import {
    readTerrain,
    readTerrainInfo,
    writeTerrain,
    heightAt,
    weightAt,
    exportHeights,
    defaultSentinel,
    materialize,
    validateTerrainData,
    payloadLength,
    padToCapacity,
    vertexCounts,
    weightMapDims,
    terrainSize,
    blockIndex,
    expectedCounts,
    heightToRaw,
    rawToHeight,
    snapTileSize,
    isTileSizeStable,
    getVertexHeight,
    setVertexHeight,
    weightAtTexel,
    texelPosition,
    setWeightAtTexel,
    blockLayers,
    setBlockLayers,
    weightTexelAt,
    compactPalette,
    removeLayer,
    validateTerrainGeometry,
    validateTerrainCapacity,
    maxLayerIndex,
    heightStats,
    isKnownVersion,
    versionName,
    TERRAIN_MAX_BLOCKS,
    TERRAIN_MAX_WEIGHT_TEXELS,
    TERRAIN_HEIGHT_BASE,
    TERRAIN_HEIGHT_FACTOR,
    TERRAIN_HEIGHT_FMIN,
    TERRAIN_HEIGHT_FMAX,
    TERRAIN_MAX_LAYER_COUNT,
    TERRAIN_BUFFER_MIN_CAPACITY,
    TERRAIN_DATA_VERSION,
    TERRAIN_DATA_VERSION2,
    TERRAIN_DATA_VERSION3,
    TERRAIN_DATA_VERSION4,
    TERRAIN_DATA_VERSION6,
    TERRAIN_DATA_VERSION7,
    TERRAIN_DATA_VERSION8,
    TERRAIN_DATA_VERSION_DEFAULT,
} from '../../src/utils/terrainBin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = path.join(__dirname, '..', 'fixtures', 'golden', 'terrain');
const GOLDEN_TERRAIN = path.join(GOLDEN_DIR, 'terrain.terrain');
const GOLDEN_SENTINEL = path.join(GOLDEN_DIR, 'default.terrain');
const MOCK_TERRAIN = path.join(
    __dirname, '..', 'fixtures', 'mock-project', 'assets', 'Maps', 'Terrain.terrain'
);

/** Empirically decoded golden values (scratchpad/terrain-fixtures.md §2) */
const GOLDEN = {
    fileSize: 131072,
    payload: 67922,
    padding: 63150,
    heightCount: 1089,
    weightCount: 65536,
    detail0: 'e7f590b3-ddfc-4d45-a66b-4958d57f1652@6c48a',
    detail1: '978d665a-6fbd-436a-b7c9-79b5fd75529e@6c48a',
    minRaw: 32552,
    maxRaw: 33126,
    minMetres: -1.6875,
    maxMetres: 2.796875,
};

const EPS = 1e-12;
const close = (actual, expected, eps = EPS) =>
    assert.ok(Math.abs(actual - expected) <= eps, `expected ${actual} ≈ ${expected}`);
const closeArray = (actual, expected, eps = EPS) => {
    assert.strictEqual(actual.length, expected.length);
    actual.forEach((v, i) => close(v, expected[i], eps));
};

/** A fresh, fully materialized terrain data object */
function synthetic({ blockCount = [1, 1], tileSize = 1, weightMapSize = 128, lightMapSize = 128 } = {}) {
    return materialize({
        blockCount, tileSize, weightMapSize, lightMapSize, layers: [],
    });
}

/**
 * Assembles a terrain buffer by hand, any version, no invariants enforced — the writer
 * only emits well-formed V8, so legacy and deliberately broken files must be crafted here.
 */
function craft(version, {
    tileSize = 1, blockCount = [1, 1], weightMapSize = 4, lightMapSize = 4,
    heights = [], normals = null, weights = [], layerBuffer = null, layers = null,
} = {}) {
    const parts = [];
    const push = (len, fn) => { const b = Buffer.alloc(len); fn(b); parts.push(b); };
    push(4, (b) => b.writeInt32LE(version, 0));
    if (version >= TERRAIN_DATA_VERSION7) push(8, (b) => b.writeDoubleLE(tileSize, 0));
    else push(4, (b) => b.writeFloatLE(tileSize, 0));
    push(8, (b) => { b.writeInt32LE(blockCount[0], 0); b.writeInt32LE(blockCount[1], 4); });
    push(4, (b) => { b.writeInt16LE(weightMapSize, 0); b.writeInt16LE(lightMapSize, 2); });

    push(4 + heights.length * 2, (b) => {
        b.writeInt32LE(heights.length, 0);
        heights.forEach((h, i) => b.writeUInt16LE(h, 4 + i * 2));
    });
    if (version >= TERRAIN_DATA_VERSION6) {
        const n = normals ?? [];
        push(4 + n.length * 4, (b) => {
            b.writeInt32LE(n.length, 0);
            n.forEach((v, i) => b.writeFloatLE(v, 4 + i * 4));
        });
    }
    push(4 + weights.length, (b) => {
        b.writeInt32LE(weights.length, 0);
        weights.forEach((v, i) => { b[4 + i] = v; });
    });
    if (version >= TERRAIN_DATA_VERSION2) {
        const lb = layerBuffer ?? [];
        push(4 + lb.length * 2, (b) => {
            b.writeInt32LE(lb.length, 0);
            lb.forEach((v, i) => b.writeInt16LE(v, 4 + i * 2));
        });
    }
    if (version >= TERRAIN_DATA_VERSION3) {
        const ls = layers ?? [];
        push(4, (b) => b.writeInt32LE(ls.length, 0));
        const wide = version >= TERRAIN_DATA_VERSION7;
        const num = (v) => {
            const b = Buffer.alloc(wide ? 8 : 4);
            if (wide) b.writeDoubleLE(v, 0); else b.writeFloatLE(v, 0);
            return b;
        };
        const str = (s) => {
            const b = Buffer.alloc(4 + s.length);
            b.writeInt32LE(s.length, 0);
            b.write(s, 4, 'latin1');
            return b;
        };
        for (const l of ls) {
            push(4, (b) => b.writeInt32LE(l.slot, 0));
            parts.push(num(l.tileSize));
            parts.push(str(l.detailMapId));
            if (version >= TERRAIN_DATA_VERSION4) {
                parts.push(str(l.normalMapId ?? ''));
                parts.push(num(l.roughness ?? 1));
                parts.push(num(l.metallic ?? 0));
            }
        }
    }
    const payload = Buffer.concat(parts);
    const out = Buffer.alloc(padToCapacity(payload.length));
    payload.copy(out);
    return { buffer: out, payloadLength: payload.length };
}

/** Writes `buffer` to a throwaway file, runs `fn(path)`, always cleans up */
function withTempTerrain(buffer, fn) {
    const dir = fs.mkdtempSync(path.join(__dirname, '.tmp-terrain-'));
    try {
        const file = path.join(dir, 'scratch.terrain');
        fs.writeFileSync(file, buffer);
        return fn(file);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

// ---------------------------------------------------------------------------

describe('terrainBin — golden round-trip', () => {
    let golden;
    let data;

    before(() => {
        golden = fs.readFileSync(GOLDEN_TERRAIN);
        data = readTerrain(golden);
    });

    it('reads the editor-saved golden terrain', () => {
        assert.ok(data, 'readTerrain returned null on the golden file');
        assert.strictEqual(golden.length, GOLDEN.fileSize);
        assert.strictEqual(data.version, TERRAIN_DATA_VERSION8);
        assert.strictEqual(data.isDefaultSentinel, false);
        assert.strictEqual(data.payloadLength, GOLDEN.payload);
    });

    it('re-writes it byte-for-byte, padding included', () => {
        const out = writeTerrain(data);
        assert.strictEqual(out.length, golden.length, 'file size changed');
        const firstDiff = out.equals(golden)
            ? -1
            : [...golden].findIndex((b, i) => out[i] !== b);
        assert.strictEqual(firstDiff, -1, `first differing byte at ${firstDiff}`);
        assert.strictEqual(Buffer.compare(out, golden), 0);
    });

    it('keeps the zero padding out of the payload', () => {
        assert.strictEqual(payloadLength(data), GOLDEN.payload);
        assert.strictEqual(padToCapacity(GOLDEN.payload), GOLDEN.fileSize);
        // the tail is all zeros, but the last 8 payload bytes (metallic = 0.0) are too:
        // parsing must be structural, never "last non-zero byte"
        assert.ok(golden.subarray(GOLDEN.payload).every((b) => b === 0));
        assert.strictEqual(golden[GOLDEN.payload - 1], 0);
    });

    it('decodes the header exactly as the byte-map says', () => {
        assert.strictEqual(data.tileSize, 1);
        assert.deepStrictEqual(data.blockCount, [1, 1]);
        assert.strictEqual(data.weightMapSize, 128);
        assert.strictEqual(data.lightMapSize, 128);
        assert.strictEqual(data.heights.length, GOLDEN.heightCount);
        assert.strictEqual(data.normals.length, 0, 'the editor writes normals count 0');
        assert.strictEqual(data.weights.length, GOLDEN.weightCount);
        assert.deepStrictEqual([...data.layerBuffer], [0, 1, -1, -1]);
    });

    it('decodes the layer table with the real texture uuids', () => {
        assert.strictEqual(data.layers.length, 2);
        assert.deepStrictEqual(data.layers[0], {
            slot: 0, tileSize: 1, detailMapId: GOLDEN.detail0,
            normalMapId: '', roughness: 1, metallic: 0,
        });
        assert.deepStrictEqual(data.layers[1], {
            slot: 1, tileSize: 1, detailMapId: GOLDEN.detail1,
            normalMapId: '', roughness: 1, metallic: 0,
        });
    });

    it('decodes the sculpted heights and the painted weight map', () => {
        assert.strictEqual(data.heights[0], 32664);
        assert.strictEqual(data.heights[544], 33011);   // vertex (16,16)
        assert.strictEqual(data.heights[1088], 32701);  // vertex (32,32)

        const stats = heightStats(data);
        assert.strictEqual(stats.minRaw, GOLDEN.minRaw);
        assert.strictEqual(stats.maxRaw, GOLDEN.maxRaw);
        close(stats.min, GOLDEN.minMetres);
        close(stats.max, GOLDEN.maxMetres);
        close(stats.mean, -0.110257, 1e-5);
        assert.strictEqual(stats.flat, false);

        closeArray(weightAtTexel(data, 0, 0).map((v) => v * 255), [255, 0, 0, 0]);
        closeArray(weightAtTexel(data, 64, 64).map((v) => v * 255), [0, 255, 0, 0]);
        // the editor's own normalization drops a unit here — a round-trip must keep it
        closeArray(weightAtTexel(data, 24, 27).map((v) => v * 255), [254, 0, 0, 0]);
    });
});

describe('terrainBin — default sentinel', () => {
    it('reproduces the shipped default.terrain byte-for-byte', () => {
        const shipped = fs.readFileSync(GOLDEN_SENTINEL);
        assert.strictEqual(shipped.length, TERRAIN_BUFFER_MIN_CAPACITY);
        assert.strictEqual(Buffer.compare(defaultSentinel(), shipped), 0);
    });

    it('reads it as isDefaultSentinel with the engine class defaults', () => {
        const data = readTerrain(fs.readFileSync(GOLDEN_SENTINEL));
        assert.strictEqual(data.isDefaultSentinel, true);
        assert.strictEqual(data.version, TERRAIN_DATA_VERSION_DEFAULT);
        assert.strictEqual(data.tileSize, 1);
        assert.deepStrictEqual(data.blockCount, [1, 1]);
        assert.strictEqual(data.weightMapSize, 128);
        assert.strictEqual(data.lightMapSize, 128);
        assert.strictEqual(data.heights.length, 0);
        assert.strictEqual(data.weights.length, 0);
        // terrain-asset.ts:271 — the class default is a 4-entry buffer, not an empty one
        assert.deepStrictEqual([...data.layerBuffer], [-1, -1, -1, -1]);
        assert.deepStrictEqual(data.layers, []);
        assert.strictEqual(data.payloadLength, 4);
    });

    it('round-trips through writeTerrain', () => {
        const shipped = fs.readFileSync(GOLDEN_SENTINEL);
        assert.strictEqual(Buffer.compare(writeTerrain(readTerrain(shipped)), shipped), 0);
    });

    it('materializes into a real, writable, stable buffer', () => {
        const data = materialize(readTerrain(fs.readFileSync(GOLDEN_SENTINEL)));
        assert.strictEqual(data.isDefaultSentinel, false);
        assert.strictEqual(data.version, TERRAIN_DATA_VERSION8);
        assert.strictEqual(data.heights.length, 33 * 33);
        assert.ok([...data.heights].every((h) => h === TERRAIN_HEIGHT_BASE));
        assert.strictEqual(data.weights.length, 128 * 128 * 4);
        assert.deepStrictEqual([...data.weights.subarray(0, 8)], [255, 0, 0, 0, 255, 0, 0, 0]);
        assert.deepStrictEqual([...data.layerBuffer], [-1, -1, -1, -1]);

        const buf = writeTerrain(data);
        assert.strictEqual(payloadLength(data), 67766);
        assert.strictEqual(buf.length, 131072);
        assert.strictEqual(Buffer.compare(writeTerrain(readTerrain(buf)), buf), 0);
    });
});

describe('terrainBin — readTerrainInfo', () => {
    let info;

    before(() => { info = readTerrainInfo(GOLDEN_TERRAIN); });

    it('reports sizes and geometry of the golden terrain', () => {
        assert.strictEqual(info.version, TERRAIN_DATA_VERSION8);
        assert.strictEqual(info.versionLabel, 'V8');
        assert.strictEqual(info.isDefaultSentinel, false);
        assert.strictEqual(info.fileSize, GOLDEN.fileSize);
        assert.strictEqual(info.payloadLength, GOLDEN.payload);
        assert.strictEqual(info.padding, GOLDEN.padding);
        assert.strictEqual(info.tileSize, 1);
        assert.deepStrictEqual(info.blockCount, [1, 1]);
        assert.strictEqual(info.weightMapSize, 128);
        assert.strictEqual(info.lightMapSize, 128);
        assert.deepStrictEqual(info.size, [32, 32]);
        assert.deepStrictEqual(info.vertexCount, [33, 33]);
        assert.deepStrictEqual(info.weightMapTexels, [128, 128]);
        assert.strictEqual(info.heightCount, GOLDEN.heightCount);
        assert.strictEqual(info.weightCount, GOLDEN.weightCount);
        assert.strictEqual(info.normalCount, 0);
    });

    it('reports the height range in metres', () => {
        close(info.heightMin, GOLDEN.minMetres);
        close(info.heightMax, GOLDEN.maxMetres);
        assert.strictEqual(info.heightMinRaw, GOLDEN.minRaw);
        assert.strictEqual(info.heightMaxRaw, GOLDEN.maxRaw);
        assert.strictEqual(info.isFlat, false);
    });

    it('reports the layer table and per-block usage', () => {
        assert.deepStrictEqual(info.layers.map((l) => l.detailMapId), [GOLDEN.detail0, GOLDEN.detail1]);
        assert.deepStrictEqual(info.layers.map((l) => l.slot), [0, 1]);
        assert.deepStrictEqual(info.blockLayers, [[0, 1, -1, -1]]);

        assert.strictEqual(info.layerUsage.length, 2);
        assert.deepStrictEqual(info.layerUsage[0].channels, [0]);
        assert.deepStrictEqual(info.layerUsage[1].channels, [1]);
        // channel coverage measured on the fixture: R 15001/16384, G 2480/16384
        close(info.layerUsage[0].coverage, 15001 / 16384, 1e-9);
        close(info.layerUsage[1].coverage, 2480 / 16384, 1e-9);
        close(info.layerUsage[0].meanWeight * 255, 221.3476, 1e-3);
        close(info.layerUsage[1].meanWeight * 255, 33.5793, 1e-3);
    });

    it('finds nothing to warn about in editor output', () => {
        assert.deepStrictEqual(info.warnings, []);
    });

    it('retains no typed arrays (it is a card, not a data object)', () => {
        assert.ok(!Object.values(info).some((v) => ArrayBuffer.isView(v)));
    });

    it('describes the sentinel file', () => {
        const sentinel = readTerrainInfo(GOLDEN_SENTINEL);
        assert.strictEqual(sentinel.isDefaultSentinel, true);
        assert.strictEqual(sentinel.versionLabel, 'default (empty sentinel)');
        assert.strictEqual(sentinel.fileSize, 2048);
        assert.strictEqual(sentinel.payloadLength, 4);
        assert.strictEqual(sentinel.padding, 2044);
        assert.strictEqual(sentinel.heightMin, null);
        assert.strictEqual(sentinel.heightMax, null);
        assert.deepStrictEqual(sentinel.layers, []);
        assert.deepStrictEqual(sentinel.layerUsage, []);
        assert.deepStrictEqual(sentinel.warnings, []);
    });

    it('returns null for a file that is not a terrain', () => {
        assert.strictEqual(readTerrainInfo(path.join(GOLDEN_DIR, 'terrain.library.json')), null);
    });

    it('warns about an unbacked layerBuffer slot and an unused layer record', () => {
        const data = synthetic({ weightMapSize: 4 });
        data.layerBuffer.set([7, -1, -1, -1]);    // no layer record for slot 7
        data.layers = [{ slot: 0, tileSize: 1, detailMapId: 'abc@6c48a', normalMapId: '', roughness: 1, metallic: 0 }];
        const warnings = withTempTerrain(writeTerrain(data), (f) => readTerrainInfo(f).warnings);
        assert.ok(warnings.some((w) => /slot 7, which has no layer record/.test(w)), warnings.join(' | '));
        assert.ok(warnings.some((w) => /slot 0 is defined but no block uses it/.test(w)), warnings.join(' | '));
    });

    it('warns about a sparse palette, an id-less layer and a non-left-packed block', () => {
        const { buffer } = craft(TERRAIN_DATA_VERSION8, {
            heights: new Array(33 * 33).fill(TERRAIN_HEIGHT_BASE),
            weights: new Array(4 * 4 * 4).fill(0),
            layerBuffer: [-1, 2, -1, -1],          // channel 0 empty below used channel 1
            layers: [{ slot: 2, tileSize: 1, detailMapId: '' }],
        });
        const warnings = withTempTerrain(buffer, (f) => readTerrainInfo(f).warnings);
        assert.ok(warnings.some((w) => /layers\[0\]\.slot is 2/.test(w)), warnings.join(' | '));
        assert.ok(warnings.some((w) => /has no detailMapId/.test(w)), warnings.join(' | '));
        assert.ok(warnings.some((w) => /empty channel 0 below used channel 1/.test(w)), warnings.join(' | '));
        assert.ok(warnings.some((w) => /zero weight coverage/.test(w)), warnings.join(' | '));
    });

    it('warns about a zero-coverage layer per BLOCK, not per layer channel-set', () => {
        // The suppression used to be per LAYER ("it only ever sits on channel 0, so the weight map
        // is ignored"), but the engine's rule is per BLOCK: getMaxLayer() === 0 (a single assigned
        // channel) is what makes the shader draw detailMap0 flat and destroys the weight texture
        // (terrain.ts:857-869, :879, :920-930). In a block that assigns TWO layers, channel 0 is
        // sampled like any other — so a layer with zero weight there is genuinely invisible.
        const layer = (n) => ({
            slot: n, tileSize: 1, detailMapId: `aaa${n}@6c48a`, normalMapId: '', roughness: 1, metallic: 0,
        });
        const two = synthetic({ weightMapSize: 4 });
        two.layers = [layer(0), layer(1)];
        two.layerBuffer.set([0, 1, -1, -1]);
        for (let j = 0; j < 4; j++) {
            for (let i = 0; i < 4; i++) setWeightAtTexel(two, i, j, [0, 1, 0, 0]);
        }
        const warned = withTempTerrain(writeTerrain(two), (f) => readTerrainInfo(f).warnings);
        assert.ok(
            warned.some((w) => /layer slot 0 is assigned to 1 block\(s\) but has zero weight coverage/.test(w)),
            warned.join(' | ')
        );
        assert.ok(warned.some((w) => /their weight map IS sampled/.test(w)), warned.join(' | '));

        // Control: the SAME zero coverage in a block that assigns only that layer stays silent —
        // the shader never looks at the weight map there.
        const one = synthetic({ weightMapSize: 4 });
        one.layers = [layer(0)];
        one.layerBuffer.set([0, -1, -1, -1]);
        for (let j = 0; j < 4; j++) {
            for (let i = 0; i < 4; i++) setWeightAtTexel(one, i, j, [0, 0, 0, 0]);
        }
        const quiet = withTempTerrain(writeTerrain(one), (f) => readTerrainInfo(f).warnings);
        assert.ok(!quiet.some((w) => /zero weight coverage/.test(w)), quiet.join(' | '));
    });

    it('warns when the buffers do not match the declared geometry', () => {
        const { buffer } = craft(TERRAIN_DATA_VERSION8, {
            heights: [TERRAIN_HEIGHT_BASE, TERRAIN_HEIGHT_BASE],   // should be 33*33
            normals: [0, 1, 0],                                    // neither 0 nor 33*33*3
            weights: [255, 0, 0, 0],                               // should be 4*4*4
            layerBuffer: [0, -1],                                  // should be 4
            layers: [{ slot: 0, tileSize: 1, detailMapId: 'abc@6c48a' }],
        });
        const info2 = withTempTerrain(buffer, (f) => readTerrainInfo(f));
        const joined = info2.warnings.join(' | ');
        assert.match(joined, /heights count 2 != 1089/);
        assert.match(joined, /weights count 4 != 64/);
        assert.match(joined, /layerBuffer count 2 != 4/);
        assert.match(joined, /normals count 3 is neither 0 nor 3267/);
        // a mis-sized layerBuffer means no per-block table at all
        assert.deepStrictEqual(info2.blockLayers, []);
    });
});

describe('terrainBin — height encoding', () => {
    it('puts 0 m at TERRAIN_HEIGHT_BASE', () => {
        assert.strictEqual(TERRAIN_HEIGHT_BASE, 32768);
        assert.strictEqual(heightToRaw(0), TERRAIN_HEIGHT_BASE);
        assert.strictEqual(rawToHeight(TERRAIN_HEIGHT_BASE), 0);
    });

    it('quantizes to 1/128 m', () => {
        assert.strictEqual(TERRAIN_HEIGHT_FACTOR, 1 / 128);
        assert.strictEqual(heightToRaw(1 / 128), TERRAIN_HEIGHT_BASE + 1);
        assert.strictEqual(heightToRaw(1), TERRAIN_HEIGHT_BASE + 128);
        assert.strictEqual(heightToRaw(-1), TERRAIN_HEIGHT_BASE - 128);
        // sub-quantum input truncates by default, rounds on request
        assert.strictEqual(heightToRaw(0.001), TERRAIN_HEIGHT_BASE);
        assert.strictEqual(heightToRaw(0.0078125), TERRAIN_HEIGHT_BASE + 1);
        assert.strictEqual(heightToRaw(0.012), TERRAIN_HEIGHT_BASE + 1);
        assert.strictEqual(heightToRaw(0.012, true), TERRAIN_HEIGHT_BASE + 2);
    });

    it('clamps to TERRAIN_HEIGHT_FMIN / FMAX', () => {
        assert.strictEqual(TERRAIN_HEIGHT_FMIN, -256);
        assert.strictEqual(TERRAIN_HEIGHT_FMAX, 255.9921875);
        assert.strictEqual(heightToRaw(TERRAIN_HEIGHT_FMIN), 0);
        assert.strictEqual(heightToRaw(TERRAIN_HEIGHT_FMAX), 65535);
        assert.strictEqual(heightToRaw(-1e9), 0);
        assert.strictEqual(heightToRaw(1e9), 65535);
        // truncation only reaches FMAX on an exact quantum
        assert.strictEqual(heightToRaw(255.99), 65534);
        assert.strictEqual(heightToRaw(255.99, true), 65535);
        assert.strictEqual(rawToHeight(0), TERRAIN_HEIGHT_FMIN);
        assert.strictEqual(rawToHeight(65535), TERRAIN_HEIGHT_FMAX);
    });

    it('round-trips representative heights', () => {
        for (const m of [-256, -12.5, -1.6875, -0.0078125, 0, 0.0078125, 2.796875, 100.25, 255.9921875]) {
            assert.strictEqual(rawToHeight(heightToRaw(m)), m, `round-trip of ${m} m`);
        }
    });

    it('reads and writes vertices through the grid helpers', () => {
        const data = synthetic({ blockCount: [2, 1], weightMapSize: 4 });
        assert.deepStrictEqual(vertexCounts([2, 1]), [65, 33]);
        setVertexHeight(data, 3, 2, 1.5);
        assert.strictEqual(data.heights[2 * 65 + 3], TERRAIN_HEIGHT_BASE + 192);
        assert.strictEqual(getVertexHeight(data, 3, 2), 1.5);
        assert.strictEqual(getVertexHeight(data, 0, 0), 0);
    });

    it('snaps tileSize the way the loader does', () => {
        assert.strictEqual(snapTileSize(1), 1);
        assert.strictEqual(snapTileSize(1.005), 1);
        assert.strictEqual(snapTileSize(0.29), 0.28); // binary float, not a typo
        assert.strictEqual(isTileSizeStable(1), true);
        assert.strictEqual(isTileSizeStable(0.29), false);
    });
});

describe('terrainBin — geometry helpers', () => {
    it('derives vertex, texel and metre extents', () => {
        assert.deepStrictEqual(vertexCounts([2, 3]), [65, 97]);
        const data = synthetic({ blockCount: [2, 3], tileSize: 0.5, weightMapSize: 8 });
        assert.deepStrictEqual(weightMapDims(data), [16, 24]);
        assert.deepStrictEqual(terrainSize(data), [32, 48]);
        assert.deepStrictEqual(expectedCounts([2, 3], 8), {
            heights: 65 * 97, normals: 65 * 97 * 3, weights: 16 * 24 * 4, layerBuffer: 24,
        });
    });

    it('indexes blocks row-major', () => {
        assert.strictEqual(blockIndex(0, 0, [3, 3]), 0);
        assert.strictEqual(blockIndex(1, 2, [3, 3]), 7);
    });

    it('reads block slots and the shader LAYERS count', () => {
        const data = synthetic({ blockCount: [2, 1], weightMapSize: 4 });
        data.layerBuffer.set([0, 1, -1, -1, 2, -1, -1, -1]);
        assert.deepStrictEqual(blockLayers(data, 0, 0), [0, 1, -1, -1]);
        assert.deepStrictEqual(blockLayers(data, 1, 0), [2, -1, -1, -1]);
        assert.strictEqual(maxLayerIndex([0, 1, -1, -1]), 1);
        assert.strictEqual(maxLayerIndex([0, -1, -1, -1]), 0);
        assert.strictEqual(maxLayerIndex([-1, -1, -1, -1]), 0);
        assert.strictEqual(maxLayerIndex([0, 1, 2, 3]), 3);
    });

    it('pads to the smallest 2048 * 2^k that is >= the payload', () => {
        assert.strictEqual(padToCapacity(0), 2048);
        assert.strictEqual(padToCapacity(1), 2048);
        assert.strictEqual(padToCapacity(2048), 2048);   // exact fit is NOT doubled
        assert.strictEqual(padToCapacity(2049), 4096);
        assert.strictEqual(padToCapacity(4096), 4096);
        assert.strictEqual(padToCapacity(67922), 131072);
    });

    it('names versions', () => {
        assert.strictEqual(versionName(TERRAIN_DATA_VERSION), 'V1');
        assert.strictEqual(versionName(TERRAIN_DATA_VERSION8), 'V8');
        assert.strictEqual(versionName(TERRAIN_DATA_VERSION_DEFAULT), 'default (empty sentinel)');
        assert.match(versionName(0x12345678), /^unknown \(0x12345678\)$/);
        assert.strictEqual(isKnownVersion(TERRAIN_DATA_VERSION8), true);
        assert.strictEqual(isKnownVersion(TERRAIN_DATA_VERSION_DEFAULT), false);
    });
});

describe('terrainBin — heightAt', () => {
    // tileSize 2 so metres and vertex indices differ; the four corner vertices of
    // cell (0,0) are hand-picked exact quanta.
    let data;

    before(() => {
        data = synthetic({ tileSize: 2, weightMapSize: 4 });
        setVertexHeight(data, 0, 0, 0);   // a
        setVertexHeight(data, 1, 0, 1);   // b
        setVertexHeight(data, 0, 1, 2);   // c
        setVertexHeight(data, 1, 1, 4);   // d
        setVertexHeight(data, 32, 0, 1.5);
        setVertexHeight(data, 32, 1, -0.5);
    });

    it('returns the vertex height exactly on a vertex', () => {
        for (const [i, j] of [[0, 0], [1, 0], [0, 1], [1, 1], [32, 32]]) {
            close(heightAt(data, i * 2, j * 2), getVertexHeight(data, i, j));
        }
    });

    it('interpolates the lower-left triangle (dx + dz <= 1)', () => {
        // a=0 b=1 c=2 → m = 1.5, d = 2m - a = 3
        // dx = 0.5, dz = 0.25 → h1 = 0.5, h2 = 2.5 → 0.5*0.75 + 2.5*0.25 = 1
        close(heightAt(data, 1, 0.5), 1);
    });

    it('interpolates the upper-right triangle (dx + dz > 1)', () => {
        // b=1 c=2 d=4 → m = 1.5, a = 2m - d = -1
        // dx = 0.8, dz = 0.7 → h1 = 0.6, h2 = 3.6 → 0.6*0.3 + 3.6*0.7 = 2.7
        close(heightAt(data, 1.6, 1.4), 2.7, 1e-9);
    });

    it('agrees with the diagonal-split formula on the golden terrain', () => {
        const gold = readTerrain(fs.readFileSync(GOLDEN_TERRAIN));
        const a = getVertexHeight(gold, 0, 0);
        const b = getVertexHeight(gold, 1, 0);
        const c = getVertexHeight(gold, 0, 1);
        const m = (b + c) * 0.5;
        const d = m + (m - a);
        const dx = 0.5;
        const dz = 0.25;
        const expected = (a * (1 - dx) + b * dx) * (1 - dz) + (c * (1 - dx) + d * dx) * dz;
        close(heightAt(gold, 0.5, 0.25), expected);
        // ... and it is NOT plain bilinear (the far corner is extrapolated, not read)
        const dReal = getVertexHeight(gold, 1, 1);
        const bilinear = (a * (1 - dx) + b * dx) * (1 - dz) + (c * (1 - dx) + dReal * dx) * dz;
        assert.notStrictEqual(expected, bilinear);
    });

    it('extrapolates flat over the one-tile strip past the far edge', () => {
        // ix0 = 32 = vertexCount-1 is still legal; ix1 clamps back onto it
        close(heightAt(data, 64, 0), 1.5);
        close(heightAt(data, 65, 0), 1.5, 1e-9);   // half a tile past the last vertex
        close(heightAt(data, 65.9, 0), 1.5, 1e-9);
    });

    it('returns null outside the sampling range', () => {
        assert.strictEqual(heightAt(data, -0.01, 0), null);
        assert.strictEqual(heightAt(data, 0, -0.01), null);
        assert.strictEqual(heightAt(data, 66, 0), null);   // fx = 33 > vertexCount-1
        assert.strictEqual(heightAt(data, 0, 66), null);
    });

    it('returns null when there is no height data (a sentinel)', () => {
        const sentinel = readTerrain(fs.readFileSync(GOLDEN_SENTINEL));
        assert.strictEqual(heightAt(sentinel, 0, 0), null);
    });
});

describe('terrainBin — weightAt', () => {
    // weightMapSize 2 → a 2x2 global texel map over 32x32 m, so every texel sits on an
    // exact metre coordinate and the kernel can be hand-computed.
    let data;

    before(() => {
        data = synthetic({ weightMapSize: 2 });
        data.layerBuffer.set([0, 1, 2, 3]);
        setWeightAtTexel(data, 0, 0, [1, 0, 0, 0]);
        setWeightAtTexel(data, 1, 0, [0, 1, 0, 0]);
        setWeightAtTexel(data, 0, 1, [0, 0, 1, 0]);
        setWeightAtTexel(data, 1, 1, [0, 0, 0, 1]);
    });

    it('samples the painted texels exactly at their coordinates', () => {
        const corners = [
            [0, 0, [1, 0, 0, 0], 0],
            [32, 0, [0, 1, 0, 0], 1],
            [0, 32, [0, 0, 1, 0], 2],
            [32, 32, [0, 0, 0, 1], 3],
        ];
        for (const [x, z, expected, dominant] of corners) {
            const w = weightAt(data, x, z);
            assert.ok(w, `weightAt(${x}, ${z}) returned null`);
            closeArray(w.weights, expected);
            assert.strictEqual(w.dominantLayer, dominant);
            close(w.dominantWeight, 1);
            assert.deepStrictEqual(w.layers, [0, 1, 2, 3]);
            assert.deepStrictEqual(w.block, [0, 0]);
            assert.strictEqual(w.blockIgnoresWeights, false);
        }
    });

    it('blends with the engine kernel between texels', () => {
        // (16, 0): dx = 0.5, dz = 0 → lower triangle, d = 2m - a = [-1,1,1,0]
        // n1 = [0.5,0.5,0,0], n2 = [-0.5,0.5,1,0], dz = 0 → n1
        const edge = weightAt(data, 16, 0);
        closeArray(edge.weights, [0.5, 0.5, 0, 0]);
        assert.strictEqual(edge.dominantLayer, 0, 'a tie goes to the lowest channel');

        // (16, 16): dx + dz = 1 → still the lower triangle
        // result = n1 + (n2 - n1) * 0.5 = [0, 0.5, 0.5, 0]
        const centre = weightAt(data, 16, 16);
        closeArray(centre.weights, [0, 0.5, 0.5, 0]);
        assert.strictEqual(centre.dominantLayer, 1, 'first channel reaching the max wins');
        close(centre.dominantWeight, 0.5);
        assert.deepStrictEqual(centre.texel, [0, 0]);
    });

    it('ignores channels whose block slot is empty', () => {
        const sparse = synthetic({ weightMapSize: 2 });
        sparse.layerBuffer.set([5, -1, 9, -1]);
        setWeightAtTexel(sparse, 0, 0, [0.25, 1, 0.5, 1]);
        setWeightAtTexel(sparse, 1, 0, [0.25, 1, 0.5, 1]);
        setWeightAtTexel(sparse, 0, 1, [0.25, 1, 0.5, 1]);
        setWeightAtTexel(sparse, 1, 1, [0.25, 1, 0.5, 1]);
        const w = weightAt(sparse, 0, 0);
        assert.strictEqual(w.dominantLayer, 9, 'channel 2 (slot 9) beats channel 0 (slot 5)');
        assert.strictEqual(w.blockIgnoresWeights, false);
    });

    it('flags a block that the shader renders without sampling weights', () => {
        const single = synthetic({ weightMapSize: 2 });
        single.layerBuffer.set([4, -1, -1, -1]);
        const w = weightAt(single, 0, 0);
        assert.strictEqual(w.blockIgnoresWeights, true, 'getMaxLayer() === 0 → LAYERS 1');
        assert.strictEqual(w.dominantLayer, 4);
    });

    it('locates the right block on a multi-block terrain', () => {
        const wide = synthetic({ blockCount: [2, 1], tileSize: 1, weightMapSize: 2 });
        wide.layerBuffer.set([0, -1, -1, -1, 1, -1, -1, -1]);
        assert.deepStrictEqual(weightAt(wide, 0, 0).block, [0, 0]);
        assert.deepStrictEqual(weightAt(wide, 40, 0).block, [1, 0]);
        assert.strictEqual(weightAt(wide, 40, 0).dominantLayer, 1);
        assert.deepStrictEqual(weightMapDims(wide), [4, 2]);
    });

    it('returns null outside the map and on a sentinel', () => {
        assert.strictEqual(weightAt(data, -1, 0), null);
        assert.strictEqual(weightAt(data, 0, -1), null);
        assert.strictEqual(weightAt(data, 64, 0), null);
        assert.strictEqual(weightAt(readTerrain(fs.readFileSync(GOLDEN_SENTINEL)), 0, 0), null);
    });

    it('samples the golden terrain', () => {
        const gold = readTerrain(fs.readFileSync(GOLDEN_TERRAIN));
        const corner = weightAt(gold, 0, 0);
        closeArray(corner.weights, [1, 0, 0, 0]);
        assert.strictEqual(corner.dominantLayer, 0);
        assert.deepStrictEqual(corner.layers, [0, 1, -1, -1]);
        assert.strictEqual(weightAt(gold, 16, 16).dominantLayer, 1, 'the painted patch is slot 1');
    });
});

describe('terrainBin — exportHeights', () => {
    let data;

    before(() => {
        data = synthetic({ tileSize: 2, weightMapSize: 4 });
        for (let j = 0; j < 33; j++) {
            for (let i = 0; i < 33; i++) setVertexHeight(data, i, j, (i + j) / 8);
        }
    });

    it('dumps the whole vertex grid by default', () => {
        const rows = exportHeights(data);
        assert.strictEqual(rows.length, 33);
        assert.strictEqual(rows[0].length, 33);
        for (let j = 0; j < 33; j++) {
            for (let i = 0; i < 33; i++) close(rows[j][i], getVertexHeight(data, i, j), 1e-9);
        }
    });

    it('dumps a region at the requested sample count', () => {
        const rows = exportHeights(data, { x: 0, z: 0, width: 8, depth: 4 }, [5, 3]);
        assert.strictEqual(rows.length, 3);
        assert.strictEqual(rows[0].length, 5);
        // 8 m wide with tileSize 2 = 4 tiles, 5 samples → one per vertex
        for (let i = 0; i < 5; i++) close(rows[0][i], getVertexHeight(data, i, 0), 1e-9);
        close(rows[2][0], getVertexHeight(data, 0, 2), 1e-9);
    });

    it('defaults the sample count to the region vertex resolution', () => {
        const rows = exportHeights(data, { x: 2, z: 2, width: 8, depth: 12 });
        assert.strictEqual(rows[0].length, 5);
        assert.strictEqual(rows.length, 7);
    });

    it('accepts a scalar sample count and honours the offset', () => {
        const rows = exportHeights(data, { x: 4, z: 0, width: 0, depth: 0 }, 1);
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(rows[0].length, 1);
        close(rows[0][0], getVertexHeight(data, 2, 0), 1e-9);
    });

    it('reports out-of-range samples as null instead of shifting the grid', () => {
        const rows = exportHeights(data, { x: -4, z: 0, width: 8, depth: 0 }, [3, 1]);
        assert.strictEqual(rows[0][0], null);
        assert.notStrictEqual(rows[0][2], null);
    });

    it('rejects nonsense regions and sample counts', () => {
        assert.throws(() => exportHeights(data, { x: NaN }), /region\.x/);
        assert.throws(() => exportHeights(data, { width: -1 }), /must not be negative/);
        assert.throws(() => exportHeights(data, null, 0), /sampleCount/);
        assert.throws(() => exportHeights(data, null, 2.5), /sampleCount/);
        assert.throws(() => exportHeights(data, null, [4, 99999]), /sampleCount rows/);
    });
});

describe('terrainBin — pre-V8 reads', () => {
    it('migrates V7 heights from 1/512 to 1/128 metres', () => {
        const { buffer, payloadLength: len } = craft(TERRAIN_DATA_VERSION7, {
            heights: [0, 32768, 65535],
        });
        const data = readTerrain(buffer);
        // raw → metres at 1/512 → re-encoded at 1/128, truncated by the Uint16Array store
        assert.deepStrictEqual([...data.heights], [24576, 32768, 40959]);
        assert.strictEqual(data.version, TERRAIN_DATA_VERSION7);
        assert.strictEqual(data.payloadLength, len);
        assert.strictEqual(rawToHeight(data.heights[0]), -64);   // -32768/512 m
        assert.strictEqual(data.tileSize, 1);
    });

    it('reads V6 with f32 scalars, real normals and V4-era layer fields', () => {
        const { buffer } = craft(TERRAIN_DATA_VERSION6, {
            tileSize: 0.5,
            heights: [32768],
            normals: [0, 1, 0],
            weights: [255, 0, 0, 0],
            layerBuffer: [0, -1, -1, -1],
            layers: [{ slot: 0, tileSize: 2, detailMapId: 'abc@6c48a', normalMapId: 'def@6c48a', roughness: 0.5, metallic: 0.25 }],
        });
        const data = readTerrain(buffer);
        assert.strictEqual(data.version, TERRAIN_DATA_VERSION6);
        assert.strictEqual(data.tileSize, 0.5);
        assert.deepStrictEqual([...data.normals], [0, 1, 0]);
        assert.deepStrictEqual([...data.layerBuffer], [0, -1, -1, -1]);
        assert.deepStrictEqual(data.layers, [{
            slot: 0, tileSize: 2, detailMapId: 'abc@6c48a',
            normalMapId: 'def@6c48a', roughness: 0.5, metallic: 0.25,
        }]);
    });

    it('defaults the V4-era layer fields away on a V3 file', () => {
        const { buffer } = craft(TERRAIN_DATA_VERSION3, {
            heights: [32768],
            weights: [255, 0, 0, 0],
            layerBuffer: [0, -1, -1, -1],
            layers: [{ slot: 0, tileSize: 1, detailMapId: 'abc@6c48a' }],
        });
        const data = readTerrain(buffer);
        assert.strictEqual(data.normals.length, 0, 'no normals section before V6');
        assert.deepStrictEqual(data.layers, [{
            slot: 0, tileSize: 1, detailMapId: 'abc@6c48a',
            normalMapId: '', roughness: 1, metallic: 0,
        }]);
    });

    it('reads a minimal V1 file — no normals, no layerBuffer, no layerInfos', () => {
        const { buffer, payloadLength: len } = craft(TERRAIN_DATA_VERSION, {
            heights: [32768, 33280],
            weights: [255, 0, 0, 0],
        });
        const data = readTerrain(buffer);
        assert.strictEqual(data.version, TERRAIN_DATA_VERSION);
        assert.strictEqual(data.payloadLength, len);
        assert.strictEqual(data.normals.length, 0);
        assert.deepStrictEqual([...data.layerBuffer], [-1, -1, -1, -1], 'class default, not empty');
        assert.deepStrictEqual(data.layers, []);
        // 33280 raw at 1/512 = 1 m → 32768 + 128 at 1/128
        assert.deepStrictEqual([...data.heights], [32768, 32896]);
    });

    it('reads V2 layerBuffer without a layer table', () => {
        const { buffer } = craft(TERRAIN_DATA_VERSION2, {
            heights: [32768],
            weights: [255, 0, 0, 0],
            layerBuffer: [3, -1, -1, -1],
        });
        const data = readTerrain(buffer);
        assert.deepStrictEqual([...data.layerBuffer], [3, -1, -1, -1]);
        assert.deepStrictEqual(data.layers, []);
    });

    it('re-writes a legacy file as V8', () => {
        const { buffer } = craft(TERRAIN_DATA_VERSION7, {
            weightMapSize: 4, lightMapSize: 4,
            heights: new Array(33 * 33).fill(32768 * 4 - 3 * 32768), // 32768 at 1/512 → 32768
            weights: new Array(4 * 4 * 4).fill(0).map((_, i) => (i % 4 === 0 ? 255 : 0)),
            layerBuffer: [0, -1, -1, -1],
            layers: [{ slot: 0, tileSize: 1, detailMapId: 'abc@6c48a' }],
        });
        const data = readTerrain(buffer);
        const out = writeTerrain(data);
        assert.strictEqual(out.readInt32LE(0), TERRAIN_DATA_VERSION8);
        const back = readTerrain(out);
        assert.strictEqual(back.version, TERRAIN_DATA_VERSION8);
        assert.deepStrictEqual([...back.heights], [...data.heights]);
        assert.strictEqual(Buffer.compare(writeTerrain(back), out), 0);
    });
});

describe('terrainBin — bad input', () => {
    it('returns null (does not throw) for anything that is not a terrain', () => {
        assert.strictEqual(readTerrain(Buffer.alloc(0)), null);
        assert.strictEqual(readTerrain(Buffer.from([1, 2, 3])), null);
        assert.strictEqual(readTerrain(Buffer.from('{"not":"a terrain"}')), null);
        const badMagic = Buffer.alloc(2048);
        badMagic.writeInt32LE(0x01010009, 0); // one past V8
        assert.strictEqual(readTerrain(badMagic), null);
        assert.strictEqual(readTerrain(null), null);
        assert.strictEqual(readTerrain('nope'), null);
    });

    it('accepts Uint8Array and ArrayBuffer inputs', () => {
        const golden = fs.readFileSync(GOLDEN_TERRAIN);
        const view = new Uint8Array(golden);
        assert.strictEqual(readTerrain(view).payloadLength, GOLDEN.payload);
        const ab = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
        assert.strictEqual(readTerrain(ab).payloadLength, GOLDEN.payload);
    });

    it('throws with a byte offset on a truncated file', () => {
        const golden = fs.readFileSync(GOLDEN_TERRAIN);
        assert.throws(() => readTerrain(golden.subarray(0, 100)), (err) => {
            assert.match(err.message, /^terrain: /);
            assert.match(err.message, /byte \d+/);
            return true;
        });
        // truncated right inside the header
        assert.throws(() => readTerrain(golden.subarray(0, 10)), /truncated tileSize at byte 4/);
    });

    it('throws when a declared count overruns the file', () => {
        const buf = Buffer.alloc(64);
        let p = 0;
        buf.writeInt32LE(TERRAIN_DATA_VERSION8, p); p += 4;
        buf.writeDoubleLE(1, p); p += 8;
        buf.writeInt32LE(1, p); p += 4;
        buf.writeInt32LE(1, p); p += 4;
        buf.writeInt16LE(4, p); p += 2;
        buf.writeInt16LE(4, p); p += 2;
        buf.writeInt32LE(1 << 20, p);           // heights count far beyond the buffer
        assert.throws(() => readTerrain(buf), /heights count 1048576 at byte 24 needs 2097152 byte\(s\)/);
    });

    it('throws on a negative count', () => {
        const buf = Buffer.alloc(64);
        buf.writeInt32LE(TERRAIN_DATA_VERSION8, 0);
        buf.writeDoubleLE(1, 4);
        buf.writeInt32LE(1, 12);
        buf.writeInt32LE(1, 16);
        buf.writeInt16LE(4, 20);
        buf.writeInt16LE(4, 22);
        buf.writeInt32LE(-5, 24);
        assert.throws(() => readTerrain(buf), /negative heights count -5 at byte 24/);
    });
});

describe('terrainBin — writer invariants', () => {
    /** A valid, minimal, writable terrain */
    function valid() {
        const data = synthetic({ weightMapSize: 4 });
        data.layerBuffer.set([0, -1, -1, -1]);
        data.layers = [{ slot: 0, tileSize: 1, detailMapId: 'abc@6c48a', normalMapId: '', roughness: 1, metallic: 0 }];
        return data;
    }

    it('writes the valid baseline', () => {
        const data = valid();
        assert.doesNotThrow(() => validateTerrainData(data));
        const buf = writeTerrain(data);
        assert.strictEqual(buf.length, padToCapacity(payloadLength(data)));
        assert.strictEqual(Buffer.compare(writeTerrain(readTerrain(buf)), buf), 0);
    });

    const rejections = [
        ['blockCount is not a pair', (d) => { d.blockCount = [1]; }, /blockCount must be an array of exactly 2/],
        ['blockCount below 1', (d) => { d.blockCount = [0, 1]; }, /blockCount\[0\] = 0 must be an integer >= 1/],
        ['blockCount not an integer', (d) => { d.blockCount = [1.5, 1]; }, /blockCount\[0\] = 1\.5/],
        ['tileSize zero', (d) => { d.tileSize = 0; }, /tileSize must be a finite number > 0/],
        ['tileSize NaN', (d) => { d.tileSize = NaN; }, /tileSize must be a finite number > 0/],
        ['weightMapSize not a power of two', (d) => { d.weightMapSize = 100; }, /weightMapSize = 100 must be a power of two/],
        ['weightMapSize 1', (d) => { d.weightMapSize = 1; }, /weightMapSize = 1 must be an integer in 2\.\.32767/],
        ['lightMapSize out of i16 range', (d) => { d.lightMapSize = 70000; }, /lightMapSize = 70000/],
        ['heights length mismatch', (d) => { d.heights = new Uint16Array(10); }, /heights length 10 does not match/],
        ['heights missing', (d) => { d.heights = null; }, /heights length undefined does not match/],
        ['weights length mismatch', (d) => { d.weights = new Uint8Array(10); }, /weights length 10 does not match/],
        ['layerBuffer length mismatch', (d) => { d.layerBuffer = Int16Array.from([-1]); }, /layerBuffer length 1 does not match/],
        ['layerBuffer slot out of range', (d) => { d.layerBuffer = [999, -1, -1, -1]; }, /layerBuffer\[0\] = 999 must be -1/],
        ['layerBuffer slot below -1', (d) => { d.layerBuffer = [-2, -1, -1, -1]; }, /layerBuffer\[0\] = -2 must be -1/],
        ['layers is not an array', (d) => { d.layers = {}; }, /layers must be an array/],
        ['layer is not an object', (d) => { d.layers = [null]; }, /layers\[0\] must be an object/],
        ['sparse palette', (d) => { d.layers[0].slot = 1; }, /the palette must stay dense/],
        ['layer slot out of range', (d) => { d.layers[0].slot = 999; }, /layers\[0\]\.slot = 999 must be an integer/],
        ['layer tileSize zero', (d) => { d.layers[0].tileSize = 0; }, /layers\[0\]\.tileSize must be a finite number > 0/],
        ['layer roughness NaN', (d) => { d.layers[0].roughness = NaN; }, /layers\[0\]\.roughness must be a finite number/],
        ['layer metallic missing', (d) => { d.layers[0].metallic = undefined; }, /layers\[0\]\.metallic must be a finite number/],
        ['non-ASCII detailMapId', (d) => { d.layers[0].detailMapId = 'текстура'; }, /layers\[0\]\.detailMapId contains non-ASCII/],
        ['non-ASCII normalMapId', (d) => { d.layers[0].normalMapId = 'ÿ'; }, /layers\[0\]\.normalMapId contains non-ASCII/],
        ['detailMapId not a string', (d) => { d.layers[0].detailMapId = 42; }, /layers\[0\]\.detailMapId must be a string/],
        ['too many layers', (d) => {
            d.layers = Array.from({ length: TERRAIN_MAX_LAYER_COUNT + 1 }, (_, i) => ({
                slot: i, tileSize: 1, detailMapId: '', normalMapId: '', roughness: 1, metallic: 0,
            }));
        }, /exceed TERRAIN_MAX_LAYER_COUNT/],
    ];

    for (const [label, mutate, pattern] of rejections) {
        it(`rejects ${label}`, () => {
            const data = valid();
            mutate(data);
            assert.throws(() => writeTerrain(data), pattern);
            assert.throws(() => validateTerrainData(data), pattern);
        });
    }

    it('rejects a non-object', () => {
        assert.throws(() => validateTerrainData(null), /data must be an object/);
        assert.throws(() => validateTerrainData(42), /data must be an object/);
    });

    it('never writes the normals it read back out', () => {
        const data = valid();
        data.normals = new Float32Array([1, 2, 3]);
        const back = readTerrain(writeTerrain(data));
        assert.strictEqual(back.normals.length, 0);
    });

    it('accepts plain arrays as well as typed arrays', () => {
        const data = valid();
        data.heights = [...data.heights];
        data.weights = [...data.weights];
        data.layerBuffer = [...data.layerBuffer];
        const back = readTerrain(writeTerrain(data));
        assert.strictEqual(back.heights.length, 33 * 33);
        assert.deepStrictEqual([...back.layerBuffer], [0, -1, -1, -1]);
    });

    it('rejects out-of-range values in plain height / weight arrays', () => {
        const a = valid();
        a.heights = [...a.heights];
        a.heights[0] = 70000;
        assert.throws(() => writeTerrain(a), /heights\[0\] = 70000 is not an integer in 0\.\.65535/);

        const b = valid();
        b.weights = [...b.weights];
        b.weights[3] = -1;
        assert.throws(() => writeTerrain(b), /weights\[3\] = -1 is not an integer in 0\.\.255/);
    });

    it('round-trips a multi-block terrain with normal maps', () => {
        const data = synthetic({ blockCount: [2, 3], tileSize: 0.5, weightMapSize: 8, lightMapSize: 16 });
        data.layerBuffer.set([0, 1, -1, -1], 0);
        data.layers = [
            { slot: 0, tileSize: 1, detailMapId: 'aaa@6c48a', normalMapId: 'nnn@6c48a', roughness: 0.25, metallic: 0.75 },
            { slot: 1, tileSize: 4, detailMapId: 'bbb@6c48a', normalMapId: '', roughness: 1, metallic: 0 },
        ];
        setVertexHeight(data, 64, 96, 12.5);
        const buf = writeTerrain(data);
        const back = readTerrain(buf);
        assert.strictEqual(back.tileSize, 0.5);
        assert.deepStrictEqual(back.blockCount, [2, 3]);
        assert.strictEqual(back.lightMapSize, 16);
        assert.strictEqual(getVertexHeight(back, 64, 96), 12.5);
        assert.deepStrictEqual(back.layers, data.layers);
        assert.strictEqual(Buffer.compare(writeTerrain(back), buf), 0);
    });
});

/**
 * Regressions for the Phase T0 review findings. Each `it` locks the FIXED behaviour of one
 * finding; the comment names what used to happen.
 */
describe('terrainBin — review regressions', () => {
    /** Paints one pure channel over a whole block of the global weight map */
    function paintBlock(data, bx, by, channel) {
        const wms = data.weightMapSize;
        const [uWC] = weightMapDims(data);
        for (let j = 0; j < wms; j++) {
            for (let i = 0; i < wms; i++) {
                const idx = ((by * wms + j) * uWC + bx * wms + i) * 4;
                for (let k = 0; k < 4; k++) data.weights[idx + k] = k === channel ? 255 : 0;
            }
        }
    }

    // --- weightAt samples per block, like the renderer -----------------------
    describe('weightAt is block-local', () => {
        // 2x1 blocks, block 0 painted pure R (slots 10/11), block 1 pure G (slots 20/21).
        // The old global endpoint-inclusive mapping blended ACROSS the seam, so x = 33..40
        // reported leftover R from block 0 and x = 32 reported block 1 with block 0's texel.
        let wide;

        before(() => {
            wide = synthetic({ blockCount: [2, 1], tileSize: 1, weightMapSize: 4 });
            wide.layerBuffer.set([10, 11, -1, -1, 20, 21, -1, -1]);
            paintBlock(wide, 0, 0, 0);
            paintBlock(wide, 1, 0, 1);
        });

        it('never bleeds a neighbouring block into the sample', () => {
            for (const x of [32, 33, 36, 40, 63, 64]) {
                const w = weightAt(wide, x, 8);
                assert.ok(w, `weightAt(${x}) returned null`);
                closeArray(w.weights, [0, 1, 0, 0], 1e-12);
                assert.deepStrictEqual(w.block, [1, 0], `block at x=${x}`);
                assert.strictEqual(w.dominantLayer, 21, `dominant at x=${x}`);
            }
            for (const x of [0, 8, 24, 31]) {
                closeArray(weightAt(wide, x, 8).weights, [1, 0, 0, 0], 1e-12);
                assert.strictEqual(weightAt(wide, x, 8).dominantLayer, 10);
            }
        });

        it('reports a texel that lies inside the reported block', () => {
            const wms = wide.weightMapSize;
            for (let x = 0; x <= 64; x += 0.5) {
                const w = weightAt(wide, x, 8);
                const [bx] = w.block;
                assert.ok(
                    w.texel[0] >= bx * wms && w.texel[0] <= bx * wms + wms - 1,
                    `texel ${w.texel[0]} outside block ${bx} at x=${x}`
                );
            }
        });

        it('shares its metres → texel mapping through weightTexelAt', () => {
            const at = weightTexelAt(wide, 40, 8);
            assert.deepStrictEqual(at.block, [1, 0]);
            close(at.local[0], 0.25);
            close(at.texelFloat[0], 0.75);            // 0.25 * (wms - 1)
            close(at.texelFloat[1], 0.75);
            assert.deepStrictEqual(at.texelLocal, [0, 0]);
            assert.deepStrictEqual(at.texel, [4, 0]); // global: block 1 starts at texel 4
            assert.deepStrictEqual(weightAt(wide, 40, 8).texel, at.texel);
            assert.strictEqual(weightTexelAt(wide, -0.5, 0), null);
            assert.strictEqual(weightTexelAt(wide, 64.5, 0), null);
            assert.strictEqual(weightTexelAt(wide, NaN, 0), null);
        });

        it('is the exact inverse of texelPosition for every texel of a multi-block terrain', () => {
            // Regression: `(x - bx * blockSize) / blockSize` does NOT cancel the block offset that
            // texelPosition added, so texel 1 of block 1 came back as 0.9999999999999998 and
            // Math.floor reported the PREVIOUS texel with dx ~= 1 — i.e. a neighbouring texel's
            // weights for a coordinate sitting exactly on this one. 432 of 1024 texels were wrong
            // for blockCount [2,2] / weightMapSize 16, and 0 of them for any single-block terrain
            // (where the offset is 0, so nothing cancels).
            for (const [blockCount, wms, tileSize] of [
                [[2, 2], 16, 1], [[2, 2], 32, 1], [[3, 3], 8, 0.25], [[1, 1], 16, 1],
            ]) {
                const data = synthetic({ blockCount, weightMapSize: wms, tileSize });
                const [uWC, vWC] = weightMapDims(data);
                for (let j = 0; j < vWC; j++) {
                    for (let i = 0; i < uWC; i++) {
                        const [x, z] = texelPosition(data, i, j);
                        const at = weightTexelAt(data, x, z);
                        assert.ok(at, `no texel at ${x},${z}`);
                        // The ONE legitimate exception: texel wms-1 of block b and texel 0 of block
                        // b+1 share a metre coordinate (blocks are endpoint-inclusive), and the
                        // block resolution picks the LATER block there.
                        const seam = (i % wms === wms - 1 && Math.floor(i / wms) < blockCount[0] - 1)
                            || (j % wms === wms - 1 && Math.floor(j / wms) < blockCount[1] - 1);
                        if (seam) continue;
                        assert.deepStrictEqual(
                            at.texel, [i, j],
                            `bc ${blockCount} wms ${wms}: texel (${i},${j}) at ${x},${z} resolved to ${at.texel}`
                        );
                        assert.deepStrictEqual(at.texelLocal, [i % wms, j % wms]);
                    }
                }
            }
        });

        it('reads back the exact stored weights at a non-origin block\'s texel positions', () => {
            // The consequence of the above for query_terrain: weightAt used to interpolate almost
            // all the way to the neighbouring texel and report its weights instead.
            const data = synthetic({ blockCount: [2, 2], weightMapSize: 16, tileSize: 1 });
            setWeightAtTexel(data, 20, 12, [0.4, 0.6, 0, 0]);
            setBlockLayers(data, 1, 0, [0, 1]);
            const [x, z] = texelPosition(data, 20, 12);
            const at = weightTexelAt(data, x, z);
            assert.deepStrictEqual(at.texel, [20, 12]);
            closeArray(weightAt(data, x, z).weights, weightAtTexel(data, 20, 12), 1e-9);
        });

        it('is unchanged on a single-block terrain (the golden mapping)', () => {
            // For blockCount [1,1] block-local === the old global mapping, so the golden
            // samples must be bit-identical.
            const gold = readTerrain(fs.readFileSync(GOLDEN_TERRAIN));
            const [uWC, vWC] = weightMapDims(gold);
            const [sw, sh] = terrainSize(gold);
            for (let z = 0; z <= 32; z += 1.7) {
                for (let x = 0; x <= 32; x += 1.3) {
                    const fx = (x / sw) * (uWC - 1);
                    const fz = (z / sh) * (vWC - 1);
                    const w = weightAt(gold, x, z);
                    assert.deepStrictEqual(w.texel, [Math.floor(fx), Math.floor(fz)]);
                }
            }
        });
    });

    // --- non-finite input ----------------------------------------------------
    it('rejects a non-finite height instead of storing raw 0 (= -256 m)', () => {
        // heightToRaw(NaN) used to sail through both clamps and land in the Uint16Array
        // as 0, punching a silent -256 m hole.
        for (const bad of [NaN, undefined, null, Infinity, -Infinity, '5']) {
            assert.throws(() => heightToRaw(bad), /terrain: height must be a finite number/,
                `heightToRaw(${String(bad)})`);
        }
        const data = synthetic({ weightMapSize: 4 });
        assert.throws(() => setVertexHeight(data, 5, 5, NaN), /must be a finite number/);
        assert.strictEqual(getVertexHeight(data, 5, 5), 0, 'nothing was written');
        // finite extremes still clamp, they do not throw
        assert.strictEqual(heightToRaw(-1e9), 0);
        assert.strictEqual(heightToRaw(1e9), 65535);
    });

    it('rejects non-finite / mis-shaped weight values', () => {
        const data = synthetic({ weightMapSize: 4 });
        assert.throws(() => setWeightAtTexel(data, 0, 0, [NaN, 0, 0, 0]), /weight\[0\] must be a finite number/);
        assert.throws(() => setWeightAtTexel(data, 0, 0, [1, 0, 0]), /exactly 4 channels/);
        assert.throws(() => setWeightAtTexel(data, 0, 0, null), /must be an array of 4/);
        assert.deepStrictEqual(weightAtTexel(data, 0, 0), [1, 0, 0, 0], 'nothing was written');
    });

    it('answers null (not NaN, not a garbage object) for non-finite coordinates', () => {
        const data = synthetic({ weightMapSize: 4 });
        for (const [x, z] of [[NaN, 0], [0, NaN], [null, 0], [undefined, 0], ['4', 0]]) {
            assert.strictEqual(heightAt(data, x, z), null, `heightAt(${String(x)}, ${String(z)})`);
            assert.strictEqual(weightAt(data, x, z), null, `weightAt(${String(x)}, ${String(z)})`);
        }
    });

    // --- validation vs. allocation ------------------------------------------
    it('validates geometry BEFORE materialize allocates', () => {
        // materialize used to size its buffers straight from an unchecked spec:
        // blockCount [600,600] meant 23.6 GB of weights, [1.5,1.5] a nonsense grid.
        assert.throws(() => materialize({}), /^Error: terrain: blockCount must be an array/);
        assert.throws(
            () => materialize({ blockCount: [1.5, 1.5], tileSize: 1, weightMapSize: 4, lightMapSize: 4 }),
            /terrain: blockCount\[0\] = 1\.5 must be an integer >= 1/
        );
        assert.throws(
            () => materialize({ blockCount: [1, 1], tileSize: 1, weightMapSize: 100, lightMapSize: 4 }),
            /must be a power of two/
        );
        assert.throws(
            () => materialize({ blockCount: [600, 600], tileSize: 1, weightMapSize: 128, lightMapSize: 128 }),
            new RegExp(`exceeds TERRAIN_MAX_BLOCKS \\(${TERRAIN_MAX_BLOCKS}\\)`)
        );
        assert.throws(
            () => materialize({ blockCount: [64, 64], tileSize: 1, weightMapSize: 128, lightMapSize: 128 }),
            new RegExp(`over TERRAIN_MAX_WEIGHT_TEXELS \\(${TERRAIN_MAX_WEIGHT_TEXELS}\\)`)
        );
        // the same checks are callable on their own, before anything is allocated
        assert.throws(() => validateTerrainGeometry({ blockCount: [0, 1] }), /blockCount\[0\] = 0/);
        assert.doesNotThrow(() => validateTerrainCapacity({
            blockCount: [16, 16], tileSize: 1, weightMapSize: 128, lightMapSize: 128,
        }));
    });

    it('range-checks typed arrays whose element range is wider than the field', () => {
        // the old shortcut skipped the loop for ANY Uint16Array/Uint8Array, so a
        // Uint16Array of weights passed validation and was truncated by `& 0xff`.
        const data = synthetic({ weightMapSize: 4 });
        data.weights = Uint16Array.from(data.weights);
        data.weights[0] = 1000;
        data.weights[1] = 300;
        assert.throws(() => validateTerrainData(data), /weights\[0\] = 1000 is not an integer in 0\.\.255/);
        assert.throws(() => writeTerrain(data), /weights\[0\] = 1000/);
        // in range it still passes, and a Uint16Array of heights is never walked twice
        data.weights[0] = 255;
        data.weights[1] = 0;
        assert.doesNotThrow(() => validateTerrainData(data));
    });

    // --- the sentinel shortcut ----------------------------------------------
    it('refuses to write a real terrain as the empty sentinel', () => {
        // `isDefaultSentinel` (or the sentinel version word) used to short-circuit
        // writeTerrain BEFORE validation — a full terrain silently became 2048 zero bytes.
        const gold = readTerrain(fs.readFileSync(GOLDEN_TERRAIN));

        const flagged = { ...gold, isDefaultSentinel: true };
        assert.throws(() => writeTerrain(flagged), /flagged as the empty default sentinel/);
        assert.throws(() => writeTerrain(flagged), /call materialize\(\) before writing/);

        const versioned = { ...gold, version: TERRAIN_DATA_VERSION_DEFAULT };
        assert.throws(() => writeTerrain(versioned), /flagged as the empty default sentinel/);

        // a genuine sentinel is still a 2048-byte sentinel, and materialize clears the flag
        const sentinel = readTerrain(fs.readFileSync(GOLDEN_SENTINEL));
        assert.strictEqual(writeTerrain(sentinel).length, TERRAIN_BUFFER_MIN_CAPACITY);
        assert.strictEqual(payloadLength(sentinel), 4);
        assert.strictEqual(payloadLength(flagged), payloadLength(gold));
        const materialized = materialize(sentinel);
        materialized.isDefaultSentinel = false;
        assert.strictEqual(writeTerrain(materialized).length, 131072);
    });

    // --- readTerrainInfo cost ------------------------------------------------
    it('does not walk a file-declared block count it never validated', () => {
        // computeLayerUsage looped blockCount[0] * blockCount[1] times with no guard:
        // a 2 KB file claiming [10000,10000] cost 0.6 s, and the i32 field allows 4.6e18.
        const { buffer } = craft(TERRAIN_DATA_VERSION8, {
            blockCount: [20000, 20000],
            heights: [TERRAIN_HEIGHT_BASE, TERRAIN_HEIGHT_BASE],
            weights: [255, 0, 0, 0],
            layerBuffer: [-1, -1, -1, -1],
            layers: [],
        });
        const started = Date.now();
        const info = withTempTerrain(buffer, (f) => readTerrainInfo(f));
        const elapsed = Date.now() - started;
        assert.deepStrictEqual(info.blockCount, [20000, 20000]);
        assert.deepStrictEqual(info.layerUsage, [], 'no usage table for a mis-sized layerBuffer');
        assert.deepStrictEqual(info.blockLayers, []);
        assert.ok(info.warnings.some((w) => /layerBuffer count 4 != 1600000000/.test(w)));
        assert.ok(elapsed < 500, `readTerrainInfo took ${elapsed} ms on a 2 KB file`);
    });

    // --- tileSize round-trip -------------------------------------------------
    it('preserves an unsnapped stored tileSize through read → write', () => {
        // tileSize is snapped on LOAD (floor(t*100)/100) but stored unsnapped; the writer
        // used to emit the snapped value, so 0.29 silently became 0.28 and byte-identity
        // was lost for any file the editor wrote with such a value.
        const base = synthetic({ weightMapSize: 4 });
        base.tileSize = 0.29;
        const first = writeTerrain(base);
        assert.strictEqual(first.readDoubleLE(4), 0.29);

        const back = readTerrain(first);
        assert.strictEqual(back.tileSize, 0.28, 'the loader snap is what geometry uses');
        assert.strictEqual(back.rawTileSize, 0.29);
        assert.strictEqual(Buffer.compare(writeTerrain(back), first), 0, 'rewrite is byte-identical');

        // a stale rawTileSize must never win over an explicitly changed tileSize
        back.tileSize = 2;
        assert.strictEqual(readTerrain(writeTerrain(back)).tileSize, 2);

        // and readTerrainInfo says so
        const info = withTempTerrain(first, (f) => readTerrainInfo(f));
        assert.strictEqual(info.tileSize, 0.28);
        assert.strictEqual(info.rawTileSize, 0.29);
        assert.ok(info.warnings.some((w) => /snaps it to 0\.28/.test(w)), info.warnings.join(' | '));
    });

    it('flags normals that a rewrite would drop', () => {
        // the writer always emits count 0 (like the editor); a file that carries real
        // normals used to round-trip silently lossy with no diagnostic anywhere.
        const { buffer } = craft(TERRAIN_DATA_VERSION8, {
            heights: new Array(33 * 33).fill(TERRAIN_HEIGHT_BASE),
            normals: new Array(33 * 33 * 3).fill(0),
            weights: new Array(4 * 4 * 4).fill(0).map((_, i) => (i % 4 === 0 ? 255 : 0)),
            layerBuffer: [-1, -1, -1, -1],
            layers: [],
        });
        const info = withTempTerrain(buffer, (f) => readTerrainInfo(f));
        assert.strictEqual(info.normalCount, 33 * 33 * 3);
        assert.ok(
            info.warnings.some((w) => /normals count 3267 is non-zero/.test(w)),
            info.warnings.join(' | ')
        );
        assert.strictEqual(readTerrain(writeTerrain(readTerrain(buffer))).normals.length, 0);
    });

    it('describes a foreign binary slot as what it is', () => {
        // the old wording blamed "a sparse palette"; the engine hardcodes
        // `binaryLayer.slot = i` (terrain-asset.ts:613), so this state is un-editor-able.
        const { buffer } = craft(TERRAIN_DATA_VERSION8, {
            heights: new Array(33 * 33).fill(TERRAIN_HEIGHT_BASE),
            weights: new Array(4 * 4 * 4).fill(0),
            layerBuffer: [2, -1, -1, -1],
            layers: [{ slot: 2, tileSize: 1, detailMapId: 'abc@6c48a' }],
        });
        const warnings = withTempTerrain(buffer, (f) => readTerrainInfo(f).warnings);
        assert.ok(
            warnings.some((w) => /layers\[0\]\.slot is 2, not the array index 0/.test(w)),
            warnings.join(' | ')
        );
        assert.ok(warnings.some((w) => /not produced by Cocos Creator/.test(w)));
    });

    // --- exportHeights budget -------------------------------------------------
    it('caps the total number of exported samples', () => {
        // the 1..8192 check was per axis, so 8192x8192 = 67 M samples / 547 MB was legal.
        const data = synthetic({ weightMapSize: 4 });
        assert.throws(() => exportHeights(data, null, 4096), /16777216 samples exceeds 1000000/);
        assert.throws(() => exportHeights(data, null, [8192, 8192]), /samples exceeds/);
        assert.doesNotThrow(() => exportHeights(data, null, [1000, 1000]));
    });

    it('clamps the DEFAULT resolution instead of throwing', () => {
        // exportHeights(data) on a big terrain used to throw "sampleCount cols must be an
        // integer in 1..8192, got 9601" — the caller never asked for a sample count at all.
        const data = synthetic({ weightMapSize: 4 });
        const huge = { ...data, blockCount: [300, 300] };
        const rows = exportHeights(huge);
        assert.ok(rows.length >= 2 && rows[0].length >= 2);
        assert.ok(rows.length * rows[0].length <= 1_000_000, `${rows.length}x${rows[0].length}`);
        assert.strictEqual(rows.length, rows[0].length, 'a square region stays square');
    });

    it('does not print a string sample count as a number', () => {
        assert.throws(() => exportHeights(synthetic({ weightMapSize: 4 }), null, [2, '3']),
            /sampleCount rows must be an integer in 1\.\.8192, got "3"/);
    });

    // --- palette maintenance ---------------------------------------------------
    it('removes a palette layer and keeps the binary writable', () => {
        // dropping a layer left `layers[i].slot !== i`, which writeTerrain rejects — T4's
        // remove_layer was unimplementable without this helper.
        const data = synthetic({ weightMapSize: 4 });
        data.layers = [0, 1, 2].map((i) => ({
            slot: i, tileSize: 1, detailMapId: `id${i}@6c48a`, normalMapId: '', roughness: 1, metallic: 0,
        }));
        setBlockLayers(data, 0, 0, [0, 1, 2]);
        setWeightAtTexel(data, 0, 0, [0.2, 0.5, 0.3, 0]);

        const result = removeLayer(data, 1);
        assert.strictEqual(result.removed.detailMapId, 'id1@6c48a');
        assert.deepStrictEqual(result.blocks, [0]);
        assert.deepStrictEqual(data.layers.map((l) => [l.slot, l.detailMapId]), [
            [0, 'id0@6c48a'], [1, 'id2@6c48a'],
        ]);
        // the surviving slot 2 became slot 1, and its weights moved to channel 1 with it
        assert.deepStrictEqual(blockLayers(data, 0, 0), [0, 1, -1, -1]);
        closeArray(weightAtTexel(data, 0, 0).map((v) => Math.round(v * 255)), [51, 76, 0, 0]);

        const buf = writeTerrain(data);
        const info = withTempTerrain(buf, (f) => readTerrainInfo(f));
        assert.deepStrictEqual(info.warnings, [], 'the result is a clean, dense, left-packed file');
        assert.throws(() => removeLayer(data, 9), /no palette layer with slot 9/);
    });

    it('compacts a hand-made sparse palette', () => {
        const data = synthetic({ weightMapSize: 4 });
        data.layers = [
            { slot: 0, tileSize: 1, detailMapId: 'a@6c48a', normalMapId: '', roughness: 1, metallic: 0 },
            { slot: 5, tileSize: 1, detailMapId: 'b@6c48a', normalMapId: '', roughness: 1, metallic: 0 },
        ];
        data.layerBuffer.set([5, 0, 7, -1]);
        const { changedSlots, clearedRefs } = compactPalette(data);
        assert.strictEqual(changedSlots, 1);
        assert.strictEqual(clearedRefs, 1, 'slot 7 had no record');
        assert.deepStrictEqual(data.layers.map((l) => l.slot), [0, 1]);
        assert.deepStrictEqual([...data.layerBuffer], [1, 0, -1, -1]);
        assert.doesNotThrow(() => writeTerrain(data));
    });

    it('writes block slots through setBlockLayers', () => {
        const data = synthetic({ blockCount: [2, 1], weightMapSize: 4 });
        setBlockLayers(data, 1, 0, [3, 4]);
        assert.deepStrictEqual(blockLayers(data, 1, 0), [3, 4, -1, -1]);
        assert.deepStrictEqual(blockLayers(data, 0, 0), [-1, -1, -1, -1]);
        setBlockLayers(data, 1, 0, []);
        assert.deepStrictEqual(blockLayers(data, 1, 0), [-1, -1, -1, -1]);
        assert.throws(() => setBlockLayers(data, 2, 0, [0]), /block \[2,0\] is outside blockCount/);
        assert.throws(() => setBlockLayers(data, 0, 0, [0, 1, 2, 3, 4]), /only 4 blend slots/);
        assert.throws(() => setBlockLayers(data, 0, 0, [256]), /must be -1 \(empty\) or a palette slot/);
        assert.throws(() => setBlockLayers(data, 0, 0, [-2]), /must be -1 \(empty\)/);
    });
});

describe('terrainBin — mock-project fixture', () => {
    // Regenerate with scratchpad/gen-mock-terrain.mjs (pyramid heights + a painted disc).
    let info;

    before(() => { info = readTerrainInfo(MOCK_TERRAIN); });

    it('round-trips byte-for-byte like the golden one', () => {
        const raw = fs.readFileSync(MOCK_TERRAIN);
        assert.strictEqual(Buffer.compare(writeTerrain(readTerrain(raw)), raw), 0);
    });

    it('is a small, non-flat, two-layer 1x1-block terrain', () => {
        assert.strictEqual(info.fileSize, 8192);
        assert.strictEqual(info.versionLabel, 'V8');
        assert.deepStrictEqual(info.blockCount, [1, 1]);
        assert.strictEqual(info.tileSize, 1);
        assert.strictEqual(info.weightMapSize, 32);
        assert.deepStrictEqual(info.size, [32, 32]);
        assert.strictEqual(info.isFlat, false);
        assert.strictEqual(info.heightMin, 0);
        assert.strictEqual(info.heightMax, 3);
        assert.deepStrictEqual(info.blockLayers, [[0, 1, -1, -1]]);
        assert.deepStrictEqual(info.warnings, []);
    });

    it('references textures that exist in the mock project', () => {
        assert.deepStrictEqual(info.layers.map((l) => l.detailMapId), [
            '35b97cf8-601e-4835-8a3e-0d29568af652@6c48a', // Sprites/coin_bar.png
            '11112222-3333-4444-8555-666677778888@6c48a', // Sprites/panel.png
        ]);
        for (const layer of info.layers) {
            const uuid = layer.detailMapId.split('@')[0];
            const metas = fs.readdirSync(path.join(path.dirname(MOCK_TERRAIN), '..', 'Sprites'));
            assert.ok(metas.some((m) => fs.readFileSync(
                path.join(path.dirname(MOCK_TERRAIN), '..', 'Sprites', m), 'utf8'
            ).includes(uuid)), `${uuid} is not a mock-project asset`);
        }
    });

    it('has a terrain importer meta with a stable uuid', () => {
        const meta = JSON.parse(fs.readFileSync(`${MOCK_TERRAIN}.meta`, 'utf8'));
        assert.strictEqual(meta.importer, 'terrain');
        assert.strictEqual(meta.ver, '1.1.50');
        assert.deepStrictEqual(meta.files, ['.bin', '.json']);
        assert.deepStrictEqual(meta.userData, {});
        assert.match(meta.uuid, /^[0-9a-f-]{36}$/);
    });

    it('samples the pyramid and the painted disc', () => {
        const data = readTerrain(fs.readFileSync(MOCK_TERRAIN));
        assert.strictEqual(getVertexHeight(data, 16, 16), 3);
        assert.strictEqual(getVertexHeight(data, 0, 0), 0);
        assert.strictEqual(getVertexHeight(data, 8, 16), 1.5);
        close(heightAt(data, 16, 16), 3);
        assert.strictEqual(weightAt(data, 16, 16).dominantLayer, 1, 'the disc is slot 1');
        assert.strictEqual(weightAt(data, 0, 0).dominantLayer, 0);
    });
});
