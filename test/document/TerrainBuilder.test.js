/**
 * TerrainBuilder tests (Phase T3)
 *
 * The bar: whatever `compile()` returns must parse back through `readTerrain` as the same
 * terrain — the builder owns no format knowledge, `src/utils/terrainBin.js` does, and this
 * suite is what keeps it that way. Layer textures resolve against the mock project's real
 * `.meta` files (image sub-asset `@6c48a`) and against the engine builtin table.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as zlib from 'zlib';

import { TerrainBuilder, TerrainBuildError, resolveTextureRef } from '../../src/document/TerrainBuilder.js';
import { AssetIndex } from '../../src/core/AssetIndex.js';
import {
    readTerrain,
    writeTerrain,
    heightToRaw,
    rawToHeight,
    vertexCounts,
    blockLayers,
    TERRAIN_HEIGHT_BASE,
    TERRAIN_DATA_VERSION8,
} from '../../src/utils/terrainBin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_PROJECT = path.resolve(__dirname, '../fixtures/mock-project');
const COIN_UUID = '35b97cf8-601e-4835-8a3e-0d29568af652';
const BUILTIN_LAYER_TEXTURE = '52ef29ed-bd92-4e94-ab2f-0ebc91bf3a60';

const assetIndex = new AssetIndex(MOCK_PROJECT);
const builder = () => new TerrainBuilder(assetIndex, MOCK_PROJECT);

/** Round-trip helper: the returned buffer must re-read as the compiled data */
function roundTrip(result) {
    const back = readTerrain(result.buffer);
    assert.ok(back, 'buffer must parse as a terrain');
    assert.strictEqual(back.version, TERRAIN_DATA_VERSION8);
    assert.strictEqual(back.tileSize, result.data.tileSize);
    assert.deepStrictEqual(back.blockCount, result.data.blockCount);
    assert.strictEqual(back.weightMapSize, result.data.weightMapSize);
    assert.strictEqual(back.lightMapSize, result.data.lightMapSize);
    assert.deepStrictEqual([...back.heights], [...result.data.heights]);
    assert.deepStrictEqual([...back.weights], [...result.data.weights]);
    assert.deepStrictEqual([...back.layerBuffer], [...result.data.layerBuffer]);
    assert.deepStrictEqual(back.layers, result.data.layers);
    return back;
}

describe('TerrainBuilder: defaults', () => {
    it('compiles an empty spec into a flat 1x1-block terrain that round-trips', () => {
        const result = builder().compile({});
        const { data } = result;
        assert.deepStrictEqual(data.blockCount, [1, 1]);
        assert.strictEqual(data.tileSize, 1);
        assert.strictEqual(data.weightMapSize, 128);
        assert.strictEqual(data.lightMapSize, 128);
        assert.strictEqual(data.heights.length, 33 * 33);
        assert.ok([...data.heights].every(h => h === TERRAIN_HEIGHT_BASE));
        assert.strictEqual(data.weights.length, 128 * 128 * 4);
        assert.deepStrictEqual([...data.weights.slice(0, 8)], [255, 0, 0, 0, 255, 0, 0, 0]);
        assert.deepStrictEqual([...data.layerBuffer], [-1, -1, -1, -1]);
        assert.deepStrictEqual(data.layers, []);
        assert.match(result.notes.join('\n'), /no layers defined/);
        roundTrip(result);
    });

    it('produces exactly what writeTerrain would, padded to a power of two', () => {
        const result = builder().compile({ blockCount: [2, 1], weightMapSize: 32 });
        assert.ok(result.buffer.equals(writeTerrain(result.data)));
        assert.strictEqual(result.buffer.length & (result.buffer.length - 1), 0);
        assert.ok(result.buffer.length >= 2048);
        const back = roundTrip(result);
        assert.deepStrictEqual(back.blockCount, [2, 1]);
        assert.deepStrictEqual(vertexCounts(back.blockCount), [65, 33]);
    });

    it('accepts geometry overrides and snaps a lossy tileSize with a note', () => {
        const result = builder().compile({
            blockCount: [1, 2], tileSize: 0.29, weightMapSize: 4, lightMapSize: 64,
        });
        assert.strictEqual(result.data.tileSize, 0.28);
        assert.match(result.notes.join('\n'), /tileSize 0\.29 is snapped to 0\.28/);
        assert.strictEqual(result.data.lightMapSize, 64);
        roundTrip(result);
    });
});

describe('TerrainBuilder: geometry validation', () => {
    const bad = (spec, re) => assert.throws(
        () => builder().compile(spec),
        (err) => err instanceof TerrainBuildError && re.test(err.message),
        `expected ${re} for ${JSON.stringify(spec)}`);

    it('rejects malformed specs', () => {
        bad(null, /spec must be an object/);
        bad([], /spec must be an object/);
        bad({ blocks: [1, 1] }, /unknown key "blocks"/);
    });

    it('rejects a bad blockCount', () => {
        bad({ blockCount: 2 }, /must be an array of two integers/);
        bad({ blockCount: [1, 2, 3] }, /must be an array of two integers/);
        bad({ blockCount: [0, 1] }, /blockCount\[0\] = 0 must be an integer >= 1/);
        bad({ blockCount: [1, 1.5] }, /blockCount\[1\] = 1\.5 must be an integer >= 1/);
    });

    it('rejects a bad tileSize / lightMapSize', () => {
        bad({ tileSize: 0 }, /tileSize must be a finite number > 0/);
        bad({ tileSize: 'big' }, /tileSize must be a finite number > 0/);
        bad({ lightMapSize: 0 }, /lightMapSize = 0 must be an integer in 1\.\.32767/);
    });

    // Regression: a sub-centimetre tileSize passed the `> 0` guard, was floored to 0
    // by snapTileSize, and the geometry validator then complained about "0" — the
    // caller could not tell what was wrong with the 0.001 they typed.
    it('rejects a tileSize the load-time snap would floor to 0, quoting the input', () => {
        for (const value of [0.001, 0.005, 0.0099]) {
            assert.throws(() => builder().compile({ tileSize: value }), (err) => {
                assert.ok(err instanceof TerrainBuildError, String(err));
                assert.match(err.message, new RegExp(`spec\\.tileSize = ${value} m is floored to 0`));
                assert.match(err.message, /smallest usable tile size is 0\.01 m/);
                return true;
            });
        }
        // …and 0.01 itself still builds
        assert.strictEqual(builder().compile({ tileSize: 0.01 }).data.tileSize, 0.01);
    });

    // Regression: "make a 200x200 m terrain" has no direct spelling; the unknown-key
    // error has to carry the blockCount * 32 * tileSize derivation or it is a dead end.
    it('routes metre-flavoured size keys to the blockCount formula', () => {
        for (const spec of [{ width: 200 }, { size: [200, 200] }, { sizeInMetres: 200 }]) {
            assert.throws(() => builder().compile(spec), (err) => {
                assert.match(err.message, /there is no metres-based size key/);
                assert.match(err.message, /blockCount \* 32 \* tileSize/);
                assert.match(err.message, /blockCount \[6, 6\] \(192 m\)/);
                return true;
            });
        }
        // a plain typo keeps the plain message, with no size lecture
        assert.throws(() => builder().compile({ blocCount: [2, 2] }), (err) => {
            assert.match(err.message, /unknown key "blocCount"/);
            assert.doesNotMatch(err.message, /no metres-based size key/);
            return true;
        });
    });

    it('enforces the power-of-two weightMapSize guard and owns up to it being the editor\'s', () => {
        bad({ weightMapSize: 100 }, /must be a power of two in 4\.\.1024/);
        bad({ weightMapSize: 2 }, /power of two in 4\.\.1024/);
        bad({ weightMapSize: 2048 }, /power of two in 4\.\.1024/);
        // The message must not blame the engine: there is no power-of-two check anywhere in
        // cocos/terrain/, the field is a plain i16, and the per-block weight texture is created
        // NPOT-safe (LINEAR/CLAMP_TO_EDGE, no mipmaps — terrain.ts:932-936).
        assert.throws(() => builder().compile({ weightMapSize: 100 }), (err) => {
            assert.match(err.message, /editor UI's convention/);
            assert.match(err.message, /128\/256\/512\/1024/);
            assert.match(err.message, /not an engine constraint/);
            assert.doesNotMatch(err.message, /required by the engine/);
            return true;
        });
        // 1024 is one of the four sizes the editor's own Terrain panel offers, so it MUST be
        // buildable — otherwise an editor-authored 1024 terrain could be lowered but never restored.
        for (const wms of [4, 8, 128, 512, 1024]) {
            assert.strictEqual(builder().compile({ weightMapSize: wms }).data.weightMapSize, wms);
        }
    });

    it('refuses a geometry that would allocate gigabytes', () => {
        bad({ blockCount: [512, 512] }, /exceeds TERRAIN_MAX_BLOCKS/);
        bad({ blockCount: [64, 64], weightMapSize: 512 }, /TERRAIN_MAX_WEIGHT_TEXELS/);
    });
});

describe('TerrainBuilder: heights', () => {
    it('fills a flat terrain at baseHeight', () => {
        const result = builder().compile({ baseHeight: 5 });
        const raw = heightToRaw(5, true);
        assert.ok([...result.data.heights].every(h => h === raw));
        assert.strictEqual(rawToHeight(result.data.heights[0]), 5);
        roundTrip(result);
    });

    it('notes quantization to the 1/128 m grid', () => {
        const result = builder().compile({ baseHeight: 0.001 });
        assert.match(result.notes.join('\n'), /baseHeight 0\.001 m quantized to 0 m/);
    });

    it('rejects a baseHeight outside the representable range', () => {
        assert.throws(() => builder().compile({ baseHeight: 300 }),
            /spec.baseHeight = 300 m is outside the representable height range/);
        assert.throws(() => builder().compile({ baseHeight: NaN }),
            /baseHeight must be a finite number of metres/);
    });

    it('takes an exactly-sized inline height grid verbatim', () => {
        const rows = [];
        for (let j = 0; j < 33; j++) {
            rows.push(Array.from({ length: 33 }, (_, i) => (i + j) / 8));
        }
        const result = builder().compile({ heightmap: { rows } });
        for (let j = 0; j < 33; j++) {
            for (let i = 0; i < 33; i++) {
                assert.strictEqual(rawToHeight(result.data.heights[j * 33 + i]), (i + j) / 8, `(${i},${j})`);
            }
        }
        assert.ok(!result.notes.join('\n').includes('resampled'));
        roundTrip(result);
    });

    it('resamples a smaller inline grid and reports it', () => {
        const result = builder().compile({ heightmap: { rows: [[0, 0], [0, 8]] } });
        assert.match(result.notes.join('\n'), /2x2 resampled onto the 33x33 vertex grid/);
        assert.strictEqual(rawToHeight(result.data.heights[0]), 0);
        assert.ok(rawToHeight(result.data.heights[33 * 33 - 1]) > 0);
    });

    it('adds baseHeight as an offset on top of a heightmap', () => {
        const rows = Array.from({ length: 33 }, () => new Array(33).fill(2));
        const result = builder().compile({ baseHeight: 10, heightmap: { rows } });
        assert.strictEqual(rawToHeight(result.data.heights[0]), 12);
        assert.match(result.notes.join('\n'), /baseHeight 10 m added as an offset/);
    });

    it('clamps out-of-range heightmap samples and counts them', () => {
        const rows = Array.from({ length: 33 }, () => new Array(33).fill(0));
        rows[0][0] = 1000;
        rows[0][1] = -1000;
        const result = builder().compile({ heightmap: { rows } });
        assert.match(result.notes.join('\n'), /2 of 1089 height sample\(s\) fell outside/);
        assert.strictEqual(rawToHeight(result.data.heights[0]), 255.9921875);
        assert.strictEqual(rawToHeight(result.data.heights[1]), -256);
    });

    it('reads a grayscale PNG heightmap from the project', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-'));
        try {
            fs.mkdirSync(path.join(dir, 'assets'));
            // 32x32 = one sample per tile → the engine mapping is exact
            const samples = new Uint8Array(32 * 32);
            for (let j = 0; j < 32; j++) for (let i = 0; i < 32; i++) samples[j * 32 + i] = i * 8;
            fs.writeFileSync(path.join(dir, 'assets', 'h.png'), grayPng(32, 32, samples));
            const result = new TerrainBuilder(assetIndex, dir).compile({
                heightmap: { source: 'h.png', min: 0, max: 25.5 },
            });
            // sample 8*i of 255 mapped onto 0..25.5 m → 0.8 * i metres, quantized to 1/128
            const metres = (i) => ((i * 8) / 255) * 25.5;
            assert.strictEqual(result.data.heights[0], heightToRaw(0, true));
            assert.strictEqual(result.data.heights[10], heightToRaw(metres(10), true));
            assert.strictEqual(Math.round(rawToHeight(result.data.heights[10]) * 100) / 100, 8);
            // the last vertex re-uses the last texel through the clamp, i.e. i = 31
            assert.strictEqual(result.data.heights[32], heightToRaw(metres(31), true));
            assert.strictEqual(Math.round(rawToHeight(result.data.heights[32]) * 100) / 100, 24.8);
            roundTrip(result);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('surfaces heightmap errors as TerrainBuildError', () => {
        assert.throws(() => builder().compile({ heightmap: { rows: [[1, 2], [3]] } }),
            (err) => err instanceof TerrainBuildError && /every row must be the same length/.test(err.message));
        assert.throws(() => builder().compile({ heightmap: { source: 'nope.png', max: 1 } }),
            (err) => err instanceof TerrainBuildError && /heightmap.source not found/.test(err.message));
    });
});

describe('TerrainBuilder: layers', () => {
    it('resolves a bare image to its texture sub-asset', () => {
        const result = builder().compile({ layers: [{ detailMap: 'Sprites/coin_bar.png' }] });
        assert.deepStrictEqual(result.data.layers, [{
            slot: 0, tileSize: 1, detailMapId: `${COIN_UUID}@6c48a`,
            normalMapId: '', roughness: 1, metallic: 0,
        }]);
        roundTrip(result);
    });

    it('accepts a UUID, an explicit sub-asset ref and an engine builtin', () => {
        const result = builder().compile({
            layers: [
                { detailMap: COIN_UUID },
                { detailMap: `${COIN_UUID}@6c48a` },
                { detailMap: 'db://internal/default-terrain/default-layer-texture.jpg' },
            ],
        });
        assert.deepStrictEqual(result.data.layers.map(l => l.detailMapId), [
            `${COIN_UUID}@6c48a`,
            `${COIN_UUID}@6c48a`,
            `${BUILTIN_LAYER_TEXTURE}@6c48a`,
        ]);
        assert.deepStrictEqual(result.data.layers.map(l => l.slot), [0, 1, 2]);
    });

    it('stores an absent normal map as "" and a present one as an id', () => {
        const result = builder().compile({
            layers: [
                { detailMap: 'Sprites/coin_bar.png', normalMap: null },
                { detailMap: 'Sprites/coin_bar.png', normalMap: 'Sprites/panel.png' },
            ],
        });
        assert.strictEqual(result.data.layers[0].normalMapId, '');
        assert.match(result.data.layers[1].normalMapId, /@6c48a$/);
        assert.notStrictEqual(result.data.layers[1].normalMapId, '');
    });

    it('applies per-layer tileSize / roughness / metallic', () => {
        const result = builder().compile({
            layers: [{ detailMap: 'Sprites/coin_bar.png', tileSize: 4, roughness: 0.25, metallic: 0.5 }],
        });
        assert.strictEqual(result.data.layers[0].tileSize, 4);
        assert.strictEqual(result.data.layers[0].roughness, 0.25);
        assert.strictEqual(result.data.layers[0].metallic, 0.5);
        roundTrip(result);
    });

    it('rejects bad layer specs', () => {
        const bad = (layers, re) => assert.throws(() => builder().compile({ layers }), re);
        bad('Sprites/coin_bar.png', /spec.layers must be an array/);
        bad([{}], /layers\[0\]\.detailMap is required/);
        bad([{ map: 'x' }], /layers\[0\]: unknown key "map"/);
        bad([{ detailMap: 'Sprites/coin_bar.png', tileSize: 0 }], /tileSize must be a finite number > 0/);
        bad([{ detailMap: 'Sprites/coin_bar.png', roughness: 2 }], /roughness must be a number in 0\.\.1/);
        bad([{ detailMap: 'Sprites/coin_bar.png', metallic: -1 }], /metallic must be a number in 0\.\.1/);
        bad([{ detailMap: 42 }], /detailMap must be a non-empty string/);
    });

    it('lists alternatives when a texture cannot be resolved', () => {
        assert.throws(() => builder().compile({ layers: [{ detailMap: 'Sprites/coin.png' }] }),
            /texture not found: "Sprites\/coin\.png".*Similar textures: assets\/Sprites\/coin_bar\.png/s);
        assert.throws(() => builder().compile({ layers: [{ detailMap: 'Sprites/zzz.tga' }] }),
            /Use list_assets \{type: "image"\}/);
        assert.throws(() => builder().compile({ layers: [{ detailMap: 'Materials/Dynamite.mtl' }] }),
            /\(material\) has no texture sub-asset.*has no sub-assets/s);
        assert.throws(() => builder().compile({ layers: [{ detailMap: 'Models/Coin.fbx' }] }),
            /has no texture sub-asset.*Sub-assets of "assets\/Models\/Coin\.fbx": @2e1ee \(gltf-mesh\)/s);
        assert.throws(() => builder().compile({ layers: [{ detailMap: `${COIN_UUID}@f9941` }] }),
            /is a sprite-frame, not a texture/);
    });

    it('needs an assetIndex to resolve textures at all', () => {
        assert.throws(
            () => new TerrainBuilder(null).compile({ layers: [{ detailMap: 'Sprites/coin_bar.png' }] }),
            /requires a project \(assetIndex\)/);
        // …but a layerless terrain compiles without a project
        assert.ok(new TerrainBuilder(null).compile({ baseHeight: 1 }).buffer.length >= 2048);
    });

    it('exports resolveTextureRef for reuse', () => {
        assert.strictEqual(
            resolveTextureRef(assetIndex, 'Sprites/coin_bar.png', 'layer'),
            `${COIN_UUID}@6c48a`);
    });
});

describe('TerrainBuilder: fillLayer', () => {
    const oneLayer = { detailMap: 'Sprites/coin_bar.png' };

    it('paints every block with slot 0 by default', () => {
        const result = builder().compile({ blockCount: [2, 2], layers: [oneLayer] });
        assert.deepStrictEqual([...result.data.layerBuffer], [
            0, -1, -1, -1, 0, -1, -1, -1, 0, -1, -1, -1, 0, -1, -1, -1,
        ]);
        assert.deepStrictEqual(blockLayers(result.data, 1, 1), [0, -1, -1, -1]);
        // channel 0 at full strength everywhere, the rest empty
        assert.deepStrictEqual([...result.data.weights.slice(0, 4)], [255, 0, 0, 0]);
        assert.match(result.notes.join('\n'), /every block is painted with layer 0.*fillLayer defaults to 0/s);
        roundTrip(result);
    });

    it('honours an explicit slot', () => {
        const result = builder().compile({
            layers: [oneLayer, { detailMap: 'Sprites/panel.png' }],
            fillLayer: 1,
        });
        assert.deepStrictEqual([...result.data.layerBuffer], [1, -1, -1, -1]);
        assert.ok(!result.notes.join('\n').includes('defaults to 0'));
    });

    // Regression: an explicitly-passed fillLayer used to be echoed back as a note
    // ("every block is painted with layer 0"), which build_terrain renders under
    // "## Warnings" — a warning restating the caller's own argument.
    it('says nothing when the caller passed fillLayer itself', () => {
        const result = builder().compile({ layers: [oneLayer], fillLayer: 0 });
        assert.deepStrictEqual([...result.data.layerBuffer], [0, -1, -1, -1]);
        assert.doesNotMatch(result.notes.join('\n'), /every block is painted/);
    });

    it('never names the unimplemented edit_terrain tool', () => {
        const off = builder().compile({ layers: [oneLayer], fillLayer: -1 });
        assert.doesNotMatch(off.notes.join('\n'), /edit_terrain/);
    });

    it('leaves blocks unpainted for -1 / null', () => {
        for (const fillLayer of [-1, null]) {
            const result = builder().compile({ layers: [oneLayer], fillLayer });
            assert.deepStrictEqual([...result.data.layerBuffer], [-1, -1, -1, -1]);
            assert.match(result.notes.join('\n'), /fillLayer is off/);
        }
    });

    // The resolved slot is DATA on the result: build_terrain drops the duplicate
    // "no block uses it" card warning off this field, and used to read the note's prose instead.
    it('reports the resolved slot as a field, painted or not', () => {
        assert.strictEqual(builder().compile({ layers: [oneLayer] }).fillLayer, 0);
        assert.strictEqual(builder().compile({
            layers: [oneLayer, { detailMap: 'Sprites/panel.png' }], fillLayer: 1,
        }).fillLayer, 1);
        for (const fillLayer of [-1, null]) {
            assert.strictEqual(builder().compile({ layers: [oneLayer], fillLayer }).fillLayer, -1);
        }
        // no palette at all: nothing references a layer either
        assert.strictEqual(builder().compile({}).fillLayer, -1);
    });

    it('rejects an out-of-range or layerless fillLayer', () => {
        assert.throws(() => builder().compile({ layers: [oneLayer], fillLayer: 1 }),
            /fillLayer = 1 must be a layer index in 0\.\.0/);
        assert.throws(() => builder().compile({ fillLayer: 0 }),
            /fillLayer = 0 but spec.layers is empty/);
        assert.throws(() => builder().compile({ layers: [oneLayer], fillLayer: 'first' }),
            /fillLayer = "first" must be a layer index/);
    });
});

describe('TerrainBuilder: meta', () => {
    it('createMeta matches the editor-saved golden meta apart from the UUID', () => {
        const golden = JSON.parse(fs.readFileSync(
            path.resolve(__dirname, '../fixtures/golden/terrain/terrain.terrain.meta'), 'utf-8'));
        const meta = TerrainBuilder.createMeta();
        assert.deepStrictEqual({ ...meta, uuid: 'x' }, { ...golden, uuid: 'x' });
        assert.match(meta.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        assert.notStrictEqual(TerrainBuilder.createMeta().uuid, meta.uuid);
    });
});

// --- helpers -----------------------------------------------------------------

/** Minimal 8-bit grayscale PNG (filter 0 rows) — enough to feed the decoder */
function grayPng(width, height, samples) {
    const raw = Buffer.alloc(height * (width + 1));
    for (let y = 0; y < height; y++) {
        raw[y * (width + 1)] = 0;
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
