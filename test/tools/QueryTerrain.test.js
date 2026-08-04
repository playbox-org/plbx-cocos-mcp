/**
 * query_terrain tool tests
 *
 * Three corpora:
 *  - the GOLDEN editor-saved terrain (read through the unindexed-path fallback,
 *    so its layer uuids stay unresolvable — that is the "texture id does not
 *    resolve" warning under test),
 *  - the mock-project terrain (indexed: path + UUID addressing, layer textures
 *    resolve to asset names),
 *  - synthetic terrains written into a temp project with terrainBin's own
 *    writer, for geometry the fixtures do not cover (many blocks, normal maps,
 *    a slot with no layer record, the empty sentinel).
 *
 * The tool is instantiated directly — registration in src/tools/index.js is a
 * later phase.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { QueryTerrain } from '../../src/tools/QueryTerrain.js';
import { AssetIndex } from '../../src/core/AssetIndex.js';
import {
    materialize,
    writeTerrain,
    defaultSentinel,
    setVertexHeight,
    setBlockLayers,
    setWeightAtTexel,
    heightAt,
    readTerrain,
    readTerrainInfo
} from '../../src/utils/terrainBin.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const MOCK_PROJECT = join(__dirname, '..', 'fixtures', 'mock-project');
const GOLDEN_DIR = join(__dirname, '..', 'fixtures', 'golden', 'terrain');
const GOLDEN_REL = 'test/fixtures/golden/terrain/terrain.terrain';
const SENTINEL_REL = 'test/fixtures/golden/terrain/default.terrain';
const MOCK_TERRAIN = 'assets/Maps/Terrain.terrain';
const MOCK_TERRAIN_UUID = 'a3c1b7d2-4e58-4f0a-9b6c-1d2e3f405060';

const tool = new QueryTerrain();

/** run() (alias + schema validation) and assert success */
async function ok(args, projectRoot) {
    const result = await tool.run(args, projectRoot);
    assert.ok(!result.isError, result.content[0].text);
    return result.content[0].text;
}

async function fails(args, projectRoot) {
    const result = await tool.run(args, projectRoot);
    assert.strictEqual(result.isError, true, `expected an error, got:\n${result.content[0].text}`);
    return result.content[0].text;
}

async function json(args, projectRoot) {
    return JSON.parse(await ok({ ...args, format: 'json' }, projectRoot));
}

describe('QueryTerrain — tool contract', () => {
    it('declares the BaseTool surface', () => {
        assert.strictEqual(tool.name, 'query_terrain');
        assert.ok(tool.description.includes('Args: {terrainPath'));
        assert.strictEqual(tool.inputSchema.type, 'object');
        assert.deepStrictEqual(tool.inputSchema.required, ['terrainPath']);
        for (const key of ['terrainPath', 'heightAt', 'weightAt', 'exportHeights', 'contourAt',
            'slope', 'blocks', 'format']) {
            assert.ok(tool.inputSchema.properties[key], `missing schema property ${key}`);
        }
        // every required entry is a declared property (createTools.test.js's rule)
        for (const key of tool.inputSchema.required) {
            assert.ok(key in tool.inputSchema.properties);
        }
    });

    it('accepts the courtesy path aliases', async () => {
        const viaAlias = await ok({ filePath: MOCK_TERRAIN }, MOCK_PROJECT);
        const viaPath = await ok({ path: MOCK_TERRAIN }, MOCK_PROJECT);
        const canonical = await ok({ terrainPath: MOCK_TERRAIN }, MOCK_PROJECT);
        assert.strictEqual(viaAlias, canonical);
        assert.strictEqual(viaPath, canonical);
        assert.strictEqual(await ok({ uuid: MOCK_TERRAIN_UUID }, MOCK_PROJECT), canonical);
    });

    // `uuid` is an ALIAS of terrainPath, not a second parameter, so passing both with
    // different values cannot conflict-error the way two aliases do (validateArgs only
    // compares alias against alias — the canonical key always wins). That is the
    // repo-wide BaseTool convention; the contract here is that the precedence is
    // documented where an agent reads it, so the wart stays discoverable.
    it('lets terrainPath win over a conflicting alias, and says so in the schema', async () => {
        const both = await ok(
            { terrainPath: MOCK_TERRAIN, uuid: '00000000-1111-2222-8333-444455556666' },
            MOCK_PROJECT
        );
        assert.strictEqual(both, await ok({ terrainPath: MOCK_TERRAIN }, MOCK_PROJECT));
        assert.match(
            tool.inputSchema.properties.terrainPath.description,
            /if both an alias and terrainPath are given, terrainPath wins/
        );
        // two ALIASES that disagree are still a hard error (validateArgs)
        assert.match(
            await fails({ path: MOCK_TERRAIN, uuid: MOCK_TERRAIN_UUID }, MOCK_PROJECT),
            /conflicting values for "terrainPath"/
        );
    });

    it('rejects a missing terrainPath and unknown parameters through validateArgs', async () => {
        assert.match(await fails({}, MOCK_PROJECT), /missing required parameter "terrainPath"/);
        const unknown = await fails({ terrainPath: MOCK_TERRAIN, heights: [[0, 0]] }, MOCK_PROJECT);
        assert.match(unknown, /unknown parameter "heights"/);
        assert.match(
            await fails({ terrainPath: MOCK_TERRAIN, format: 'yaml' }, MOCK_PROJECT),
            /must be one of "text", "json"/
        );
    });
});

describe('QueryTerrain — resolution and error paths', () => {
    it('resolves by project path and by UUID, reporting the indexed path + uuid', async () => {
        const byPath = await json({ terrainPath: MOCK_TERRAIN }, MOCK_PROJECT);
        const byUuid = await json({ terrainPath: MOCK_TERRAIN_UUID }, MOCK_PROJECT);
        assert.deepStrictEqual(byPath, byUuid);
        assert.strictEqual(byPath.path, MOCK_TERRAIN);
        assert.strictEqual(byPath.uuid, MOCK_TERRAIN_UUID);
        assert.strictEqual(byPath.importer, 'terrain');
    });

    it('reads an unindexed file straight from disk (golden fixture, no project around it)', async () => {
        const model = await json({ terrainPath: GOLDEN_REL }, REPO_ROOT);
        assert.strictEqual(model.uuid, null);
        assert.strictEqual(model.file.size, 131072);
        assert.strictEqual(model.terrain.versionLabel, 'V8');
    });

    it('errors on a non-terrain asset with the importer name', async () => {
        const msg = await fails({ terrainPath: 'assets/Sprites/coin_bar.png' }, MOCK_PROJECT);
        assert.match(msg, /is a image asset, not a terrain/);
    });

    it('errors on a missing file with a browse hint', async () => {
        const msg = await fails({ terrainPath: 'assets/Maps/Nope.terrain' }, MOCK_PROJECT);
        assert.match(msg, /Terrain not found/);
        assert.match(msg, /list_assets \{type: "terrain"\}/);
    });

    it('errors on a file that is not a terrain binary', async () => {
        const dir = fs.mkdtempSync(join(os.tmpdir(), 'cocos-terrain-bad-'));
        try {
            fs.mkdirSync(join(dir, 'assets'), { recursive: true });
            fs.writeFileSync(join(dir, 'assets/Bogus.terrain'), Buffer.alloc(64, 7));
            const msg = await fails({ terrainPath: 'assets/Bogus.terrain' }, dir);
            assert.match(msg, /not a Cocos Creator \.terrain binary/);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('QueryTerrain — the card (golden terrain)', () => {
    let text;
    let model;

    before(async () => {
        text = await ok({ terrainPath: GOLDEN_REL }, REPO_ROOT);
        model = await json({ terrainPath: GOLDEN_REL }, REPO_ROOT);
    });

    it('reports geometry exactly as the binary layer decodes it', () => {
        assert.deepStrictEqual(model.terrain.blockCount, [1, 1]);
        assert.deepStrictEqual(model.terrain.size, [32, 32]);
        assert.deepStrictEqual(model.terrain.vertexCount, [33, 33]);
        assert.deepStrictEqual(model.terrain.weightMapTexels, [128, 128]);
        assert.strictEqual(model.terrain.tileSize, 1);
        assert.strictEqual(model.terrain.weightMapSize, 128);
        assert.strictEqual(model.terrain.lightMapSize, 128);
        assert.strictEqual(model.terrain.heightCount, 1089);
        assert.strictEqual(model.terrain.weightCount, 65536);
        assert.strictEqual(model.terrain.normalCount, 0);
        assert.strictEqual(model.file.payloadLength, 67922);
        assert.strictEqual(model.file.padding, 131072 - 67922);
    });

    it('reports height statistics', () => {
        assert.strictEqual(model.terrain.height.min, -1.6875);
        assert.strictEqual(model.terrain.height.max, 2.796875);
        assert.ok(Math.abs(model.terrain.height.mean + 0.11025740358) < 1e-9);
        assert.strictEqual(model.terrain.height.minRaw, 32552);
        assert.strictEqual(model.terrain.height.maxRaw, 33126);
        assert.strictEqual(model.terrain.height.flat, false);
        assert.match(text, /Height: +min -1\.6875 m, max 2\.7969 m, mean -0\.1103 m/);
    });

    it('renders the get_asset_info-style card lines', () => {
        assert.ok(text.startsWith(`# ${GOLDEN_REL}\n`));
        assert.match(text, /Type: terrain \(\.terrain binary, format V8\)/);
        assert.match(text, /File: 131072 bytes \(67922 payload \+ 63150 zero padding\)/);
        assert.match(text, /Size: +32 x 32 m \(X x Z\)/);
        assert.match(text, /Blocks: +1 x 1 = 1/);
        assert.match(text, /Vertices: +33 x 33 \(1089 heights\)/);
        assert.match(text, /Weight map: 128 x 128 per block => 128 x 128 texels/);
        assert.match(text, /## Layers \(palette, 2\)/);
    });

    it('reports the weight-texel spacing endpoint-inclusively, as texelPosition does', () => {
        // Regression: this printed blockSize / weightMapSize (0.25 m here), contradicting
        // terrainBin's texelPosition, edit_terrain's OPS_DOC and paint_layer's own error message,
        // all of which use blockSize / (weightMapSize - 1). An agent sizing a paint region from
        // the wrong figure is off by wms/(wms-1) and can miss the intended edge texel.
        // blockSize 32 m over weightMapSize 128 -> 32/127 = 0.251969, NOT 32/128 = 0.25
        assert.match(text, /texels \(65536 bytes\), 0\.251969 m apart/);
        assert.doesNotMatch(text, /m per texel/);
        assert.doesNotMatch(text, /0\.25 m/);
        assert.match(text, /texel 0 sits ON the block's near edge and texel 127 ON its far edge/);
        assert.match(text, /adjacent blocks share a metre coordinate at the seam/);
    });

    it('states the node-origin anchoring rule (rotation/scale ignored)', () => {
        assert.match(text, /geometry starts at the node origin/);
        assert.match(text, /node rotation and scale are ignored/);
    });

    it('lists the palette with per-layer weight coverage', () => {
        assert.strictEqual(model.layers.length, 2);
        assert.strictEqual(model.layers[0].slot, 0);
        assert.strictEqual(model.layers[0].detailMapId, 'e7f590b3-ddfc-4d45-a66b-4958d57f1652@6c48a');
        assert.strictEqual(model.layers[0].normalMapId, null);
        assert.strictEqual(model.layers[0].tileSize, 1);
        assert.strictEqual(model.layers[0].blocks, 1);
        assert.ok(Math.abs(model.layers[0].coverage - 0.91558837890625) < 1e-12);
        assert.ok(Math.abs(model.layers[1].coverage - 0.1513671875) < 1e-12);
        assert.match(text, /^0 +e7f590b3-.*1 +- +1 +0 +1 +91\.6% +0\.868$/m);
    });

    it('warns about texture ids that do not resolve in this project', () => {
        const unresolved = model.warnings.filter((w) => /does not resolve to an asset/.test(w));
        assert.strictEqual(unresolved.length, 2);
        assert.match(unresolved[0], /layer slot 0: detailMap e7f590b3-/);
        assert.match(text, /## Warnings \(2\)/);
    });

    it('carries the editing hazard notes', () => {
        assert.match(text, /library `\.json`/);
        assert.match(text, /Never edit a `\.terrain` while its Terrain panel is open/);
    });
});

describe('QueryTerrain — per-block usage table', () => {
    it('shows the block table by default and joins channels to palette slots', async () => {
        const model = await json({ terrainPath: MOCK_TERRAIN }, MOCK_PROJECT);
        assert.strictEqual(model.blockCountTotal, 1);
        assert.strictEqual(model.blocks.length, 1);
        const b = model.blocks[0];
        assert.deepStrictEqual(b.block, [0, 0]);
        assert.deepStrictEqual(b.origin, [0, 0]);
        assert.deepStrictEqual(b.slots, [0, 1, -1, -1]);
        assert.strictEqual(b.channels[0].slot, 0);
        assert.strictEqual(b.channels[2].slot, -1);
        assert.ok(Math.abs(b.channels[0].coverage - 0.8076171875) < 1e-12);
        assert.strictEqual(b.ignoresWeights, false);

        const text = await ok({ terrainPath: MOCK_TERRAIN }, MOCK_PROJECT);
        assert.match(text, /## Blocks \(1\)/);
        assert.match(text, /^\[0,0\] +0,0 +0 \/ 80\.8% +1 \/ 19\.2% +- +-$/m);
    });

    // Regression: `blocks: false` used to print a "## Blocks (1)" heading whose only
    // content was "Table suppressed (blocks: false)" — an acknowledgement of the
    // caller's own argument. Below the auto limit it must render nothing at all.
    it('blocks: false suppresses the table without acknowledging itself', async () => {
        const text = await ok({ terrainPath: MOCK_TERRAIN, blocks: false }, MOCK_PROJECT);
        assert.doesNotMatch(text, /## Blocks/);
        assert.doesNotMatch(text, /Table suppressed/);
        const model = await json({ terrainPath: MOCK_TERRAIN, blocks: false }, MOCK_PROJECT);
        assert.strictEqual(model.blocks, null);
        assert.strictEqual(model.blockCountTotal, 1);
    });

    it('resolves layer textures to asset names when the project has them', async () => {
        const model = await json({ terrainPath: MOCK_TERRAIN }, MOCK_PROJECT);
        assert.strictEqual(model.layers[0].detailMapName, 'coin_bar.png@6c48a');
        assert.strictEqual(model.layers[1].detailMapName, 'panel.png@6c48a');
        assert.deepStrictEqual(model.warnings, []);
    });
});

describe('QueryTerrain — sampling', () => {
    it('samples heights at local metres and matches the binary layer', async () => {
        const data = readTerrain(fs.readFileSync(join(GOLDEN_DIR, 'terrain.terrain')));
        const points = [[0, 0], [16.5, 16.5], [31.99, 0.5]];
        const model = await json({ terrainPath: GOLDEN_REL, heightAt: points }, REPO_ROOT);
        assert.strictEqual(model.heightSamples.length, 3);
        points.forEach(([x, z], i) => {
            assert.strictEqual(model.heightSamples[i].x, x);
            assert.strictEqual(model.heightSamples[i].z, z);
            assert.strictEqual(model.heightSamples[i].height, heightAt(data, x, z));
            assert.strictEqual(model.heightSamples[i].reason, null);
        });
    });

    it('notes the engine\'s one-tile tolerance past the far edge', async () => {
        const model = await json({ terrainPath: GOLDEN_REL, heightAt: [[32.5, 1]] }, REPO_ROOT);
        const s = model.heightSamples[0];
        assert.ok(s.height !== null);
        assert.strictEqual(s.inside, false);
        assert.match(s.reason, /past the far edge/);
    });

    it('marks out-of-range height samples instead of failing', async () => {
        const model = await json({ terrainPath: GOLDEN_REL, heightAt: [[40, 2], [-1, 0]] }, REPO_ROOT);
        assert.deepStrictEqual(
            model.heightSamples.map((s) => [s.height, s.inside, s.reason]),
            [[null, false, 'outside the terrain'], [null, false, 'outside the terrain']]
        );
        const text = await ok({ terrainPath: GOLDEN_REL, heightAt: [[40, 2]] }, REPO_ROOT);
        assert.match(text, /outside the terrain/);
    });

    it('samples weights with the dominant layer resolved to a texture name', async () => {
        const model = await json({ terrainPath: MOCK_TERRAIN, weightAt: [[4, 4], [16, 16]] }, MOCK_PROJECT);
        for (const s of model.weightSamples) {
            assert.strictEqual(s.weights.length, 4);
            assert.deepStrictEqual(s.block, [0, 0]);
            assert.strictEqual(s.channels[0].slot, 0);
            assert.strictEqual(s.channels[0].layer, 'coin_bar.png@6c48a');
            assert.strictEqual(s.channels[3].slot, -1);
            assert.strictEqual(s.blockIgnoresWeights, false);
            assert.ok(s.dominantLayer === 0 || s.dominantLayer === 1);
            assert.ok(/coin_bar|panel/.test(s.dominantLayerName));
        }
        const text = await ok({ terrainPath: MOCK_TERRAIN, weightAt: [[4, 4]] }, MOCK_PROJECT);
        assert.match(text, /## Sampled weights \(1\)/);
        assert.match(text, /block \[0,0\] texel \[3,3\]/);
        assert.match(text, /R w=.* slot 0 coin_bar\.png@6c48a/);
        assert.match(text, /dominant: slot \d/);
    });

    it('reports out-of-range weight samples', async () => {
        const model = await json({ terrainPath: MOCK_TERRAIN, weightAt: [[100, 1]] }, MOCK_PROJECT);
        assert.strictEqual(model.weightSamples[0].weights, null);
        assert.strictEqual(model.weightSamples[0].reason, 'outside the terrain');
    });

    it('rejects malformed sample points with the offending index', async () => {
        assert.match(
            await fails({ terrainPath: MOCK_TERRAIN, heightAt: [[1, 2], [3]] }, MOCK_PROJECT),
            /heightAt\[1\] must be a pair of finite numbers/
        );
        // the schema catches the wrong element type before execute() does
        assert.match(
            await fails({ terrainPath: MOCK_TERRAIN, weightAt: [['a', 'b']] }, MOCK_PROJECT),
            /must be of type number/
        );
    });
});

describe('QueryTerrain — exportHeights', () => {
    it('dumps the full vertex grid of a 1-block terrain in metres', async () => {
        const model = await json({ terrainPath: MOCK_TERRAIN, exportHeights: {} }, MOCK_PROJECT);
        const g = model.heightGrid;
        assert.deepStrictEqual(g.samples, [33, 33]);
        assert.deepStrictEqual(g.spacing, [1, 1]);
        assert.strictEqual(g.stride, 1);
        assert.strictEqual(g.downsampled, false);
        assert.strictEqual(g.format, 'rows');
        assert.strictEqual(g.rows.length, 33);
        assert.strictEqual(g.rows[0].length, 33);
        assert.deepStrictEqual(g.region, { x: 0, z: 0, width: 32, depth: 32 });

        const data = readTerrain(fs.readFileSync(join(MOCK_PROJECT, MOCK_TERRAIN)));
        assert.strictEqual(g.rows[16][16], heightAt(data, 16, 16));

        const text = await ok({ terrainPath: MOCK_TERRAIN, exportHeights: {} }, MOCK_PROJECT);
        assert.match(text, /## Height grid/);
        assert.match(text, /Samples: 33 x 33 \(cols x rows\), spacing 1 x 1 m/);
        assert.strictEqual(text.split('\n').filter((l) => /^ *\d+ \| /.test(l)).length, 33);
    });

    it('defaults an omitted width/depth to the distance to the far edge', async () => {
        const model = await json(
            { terrainPath: MOCK_TERRAIN, exportHeights: { region: { x: 24, z: 28 } } },
            MOCK_PROJECT
        );
        assert.deepStrictEqual(model.heightGrid.region, { x: 24, z: 28, width: 8, depth: 4 });
        assert.deepStrictEqual(model.heightGrid.samples, [9, 5]);
        // nothing sampled outside the terrain
        for (const row of model.heightGrid.rows) {
            for (const v of row) assert.notStrictEqual(v, null);
        }
        assert.match(
            await fails({ terrainPath: MOCK_TERRAIN, exportHeights: { region: { x: 32 } } }, MOCK_PROJECT),
            /width defaults to the distance from x to the far edge, which is 0 m here/
        );
    });

    it('honours a region and reports its extent', async () => {
        const model = await json(
            { terrainPath: MOCK_TERRAIN, exportHeights: { region: { x: 4, z: 8, width: 2, depth: 3 } } },
            MOCK_PROJECT
        );
        const g = model.heightGrid;
        assert.deepStrictEqual(g.region, { x: 4, z: 8, width: 2, depth: 3 });
        assert.deepStrictEqual(g.samples, [3, 4]);
        assert.strictEqual(g.rows.length, 4);
        assert.strictEqual(g.rows[0].length, 3);

        const data = readTerrain(fs.readFileSync(join(MOCK_PROJECT, MOCK_TERRAIN)));
        assert.strictEqual(g.rows[0][0], heightAt(data, 4, 8));
        assert.strictEqual(g.rows[3][2], heightAt(data, 6, 11));
    });

    it('raw16 emits the stored u16 encoding', async () => {
        const model = await json(
            { terrainPath: MOCK_TERRAIN, exportHeights: { format: 'raw16', sampleCount: 5 } },
            MOCK_PROJECT
        );
        const g = model.heightGrid;
        assert.strictEqual(g.format, 'raw16');
        assert.deepStrictEqual(g.samples, [5, 5]);
        assert.deepStrictEqual(g.rows[0], [32768, 32768, 32768, 32768, 32768]);
        assert.strictEqual(g.rows[2][2], 33152); // the 3 m peak = 32768 + 3 * 128
        for (const row of g.rows) {
            for (const v of row) assert.ok(Number.isInteger(v) && v >= 0 && v <= 65535);
        }
        const text = await ok(
            { terrainPath: MOCK_TERRAIN, exportHeights: { format: 'raw16', sampleCount: 5 } },
            MOCK_PROJECT
        );
        assert.match(text, /metres = \(raw - 32768\) \/ 128/);
    });

    it('accepts sampleCount as [cols, rows]', async () => {
        const model = await json(
            { terrainPath: MOCK_TERRAIN, exportHeights: { sampleCount: [3, 9] } },
            MOCK_PROJECT
        );
        assert.deepStrictEqual(model.heightGrid.samples, [3, 9]);
        assert.strictEqual(model.heightGrid.rows.length, 9);
        assert.strictEqual(model.heightGrid.rows[0].length, 3);
    });

    it('rejects a bad exportHeights spec with an actionable message', async () => {
        const cases = [
            [{ region: { w: 4 } }, /unknown key "w"/],
            [{ region: { width: 0 } }, /region\.width must be > 0/],
            [{ region: { x: 'a' } }, /region\.x must be a finite number/],
            [{ format: 'png' }, /format must be one of "rows", "raw16", "map"/],
            [{ sampleCount: 1 }, /sampleCount must be an integer in 2\.\.513/],
            [{ sampleCount: 600 }, /sampleCount must be an integer in 2\.\.513/],
            [{ sampleCount: [513, 513] }, /exceeds 65536/],
            [{ grid: true }, /unknown key "grid"/]
        ];
        for (const [spec, re] of cases) {
            assert.match(await fails({ terrainPath: MOCK_TERRAIN, exportHeights: spec }, MOCK_PROJECT), re);
        }
        assert.match(
            await fails({ terrainPath: MOCK_TERRAIN, exportHeights: [1, 2] }, MOCK_PROJECT),
            /must be of type object/
        );
    });
});

describe('QueryTerrain — synthetic terrains', () => {
    let project;

    /** write `data` as assets/Maps/<name>.terrain in the temp project */
    function put(name, data) {
        const rel = `assets/Maps/${name}.terrain`;
        fs.writeFileSync(join(project, rel), writeTerrain(data));
        return rel;
    }

    before(() => {
        project = fs.mkdtempSync(join(os.tmpdir(), 'cocos-terrain-'));
        fs.cpSync(MOCK_PROJECT, project, { recursive: true });
        AssetIndex.invalidate(project);
    });

    after(() => {
        fs.rmSync(project, { recursive: true, force: true });
    });

    it('downsamples a big terrain by a power-of-two stride and says so', async () => {
        // 9x9 blocks = 289x289 vertices; stride 8 => 37x37 samples, spacing 8 m
        const rel = put('Big', materialize({
            blockCount: [9, 9], tileSize: 1, weightMapSize: 4, lightMapSize: 4, layers: []
        }));
        const model = await json({ terrainPath: rel, exportHeights: {} }, project);
        const g = model.heightGrid;
        assert.strictEqual(g.stride, 8);
        assert.deepStrictEqual(g.samples, [37, 37]);
        assert.deepStrictEqual(g.spacing, [8, 8]);
        assert.strictEqual(g.downsampled, true);
        assert.strictEqual(g.rows.length, 37);

        const text = await ok({ terrainPath: rel, exportHeights: {} }, project);
        assert.match(text, /downsampled 1:8 from the vertex grid/);
        // and a region gets full resolution back
        const zoom = await json(
            { terrainPath: rel, exportHeights: { region: { x: 0, z: 0, width: 8, depth: 8 } } },
            project
        );
        assert.deepStrictEqual(zoom.heightGrid.samples, [9, 9]);
        assert.strictEqual(zoom.heightGrid.downsampled, false);
    });

    it('omits the per-block table above the auto limit unless blocks: true', async () => {
        const rel = 'assets/Maps/Big.terrain';
        const auto = await ok({ terrainPath: rel }, project);
        assert.match(auto, /## Blocks \(81\)/);
        assert.match(auto, /Table omitted for 81 blocks — pass blocks: true to print it\./);
        assert.strictEqual((await json({ terrainPath: rel }, project)).blocks, null);

        const forced = await ok({ terrainPath: rel, blocks: true }, project);
        assert.strictEqual(forced.split('\n').filter((l) => /^\[\d+,\d+\] /.test(l)).length, 81);
        const model = await json({ terrainPath: rel, blocks: true }, project);
        assert.strictEqual(model.blocks.length, 81);
        assert.deepStrictEqual(model.blocks[0].block, [0, 0]);
        assert.deepStrictEqual(model.blocks[80].block, [8, 8]);
        assert.deepStrictEqual(model.blocks[80].origin, [256, 256]);
        // row-major, no duplicates
        assert.strictEqual(new Set(model.blocks.map((b) => b.index)).size, 81);
    });

    it('flags normal maps / PBR fields that the scene component would have to enable', async () => {
        const data = materialize({
            blockCount: [1, 1], tileSize: 1, weightMapSize: 8, lightMapSize: 8,
            layers: [
                {
                    slot: 0, tileSize: 1, roughness: 1, metallic: 0,
                    detailMapId: '35b97cf8-601e-4835-8a3e-0d29568af652@6c48a',
                    normalMapId: '11112222-3333-4444-8555-666677778888@6c48a'
                },
                {
                    slot: 1, tileSize: 1, roughness: 0.5, metallic: 0.25,
                    detailMapId: '11112222-3333-4444-8555-666677778888@6c48a',
                    normalMapId: ''
                }
            ]
        });
        setBlockLayers(data, 0, 0, [0, 1]);
        const rel = put('Pbr', data);
        const model = await json({ terrainPath: rel }, project);

        const normal = model.warnings.find((w) => /carry normal maps/.test(w));
        assert.ok(normal, model.warnings.join('\n'));
        assert.match(normal, /slot\(s\) 0/);
        assert.match(normal, /_useNormalmap: true/);

        const pbr = model.warnings.find((w) => /_usePBR: true/.test(w));
        assert.ok(pbr, model.warnings.join('\n'));
        assert.match(pbr, /slot\(s\) 1/);

        assert.strictEqual(model.layers[0].normalMapName, 'panel.png@6c48a');
    });

    it('surfaces the binary layer warnings (slot with no layer record, zero coverage)', async () => {
        const data = materialize({
            blockCount: [1, 1], tileSize: 1, weightMapSize: 4, lightMapSize: 4,
            layers: [{
                slot: 0, tileSize: 1, roughness: 1, metallic: 0,
                detailMapId: '35b97cf8-601e-4835-8a3e-0d29568af652@6c48a', normalMapId: ''
            }]
        });
        // channel G points at palette slot 3, which has no layer record, and no
        // weight was ever painted into it
        setBlockLayers(data, 0, 0, [0, 3]);
        const rel = put('Orphan', data);
        const model = await json({ terrainPath: rel }, project);

        assert.ok(model.warnings.some((w) => /references palette slot 3, which has no layer record/.test(w)),
            model.warnings.join('\n'));
        assert.ok(model.warnings.some((w) => /zero\s+weight coverage/.test(w)), model.warnings.join('\n'));

        const sample = await json({ terrainPath: rel, weightAt: [[16, 16]] }, project);
        assert.strictEqual(sample.weightSamples[0].channels[1].slot, 3);
        assert.strictEqual(sample.weightSamples[0].channels[1].layer, 'slot 3 (no layer record)');
    });

    it('reports a block that uses channel R only as ignoring the weight map', async () => {
        const data = materialize({
            blockCount: [1, 1], tileSize: 1, weightMapSize: 4, lightMapSize: 4,
            layers: [{
                slot: 0, tileSize: 1, roughness: 1, metallic: 0,
                detailMapId: '35b97cf8-601e-4835-8a3e-0d29568af652@6c48a', normalMapId: ''
            }]
        });
        setBlockLayers(data, 0, 0, [0]);
        const rel = put('SingleLayer', data);
        const text = await ok({ terrainPath: rel, weightAt: [[16, 16]] }, project);
        assert.match(text, /block\(s\) use only channel R/);
        assert.match(text, /the shader ignores the weight map here/);
        const model = await json({ terrainPath: rel }, project);
        assert.strictEqual(model.blocks[0].ignoresWeights, true);
    });

    it('samples a sculpted, painted terrain the way the binary layer does', async () => {
        const data = materialize({
            blockCount: [2, 1], tileSize: 0.5, weightMapSize: 8, lightMapSize: 8,
            layers: [
                {
                    slot: 0, tileSize: 1, roughness: 1, metallic: 0,
                    detailMapId: '35b97cf8-601e-4835-8a3e-0d29568af652@6c48a', normalMapId: ''
                },
                {
                    slot: 1, tileSize: 1, roughness: 1, metallic: 0,
                    detailMapId: '11112222-3333-4444-8555-666677778888@6c48a', normalMapId: ''
                }
            ]
        });
        // a 5 m spike on the vertex at (10 m, 4 m) => vertex (20, 8) with tileSize 0.5
        setVertexHeight(data, 20, 8, 5);
        setBlockLayers(data, 1, 0, [0, 1]);
        // Paint the second block's texels (2..3, 2..3) fully with the G layer.
        // Sampling in the middle of that 2x2 patch keeps the interpolation
        // kernel (which reads texel k and k+1 per axis) entirely inside it.
        for (const i of [2, 3]) for (const j of [2, 3]) setWeightAtTexel(data, 8 + i, j, [0, 1, 0, 0]);
        const rel = put('Painted', data);

        // block 1 spans x 16..32 m; block-local u = 2.5 / (weightMapSize - 1)
        const px = 16 + 16 * (2.5 / 7);
        const pz = 16 * (2.5 / 7);
        const model = await json({
            terrainPath: rel,
            heightAt: [[10, 4], [0, 0]],
            weightAt: [[px, pz]]
        }, project);

        assert.deepStrictEqual(model.terrain.size, [32, 16]);
        assert.deepStrictEqual(model.terrain.blockCount, [2, 1]);
        assert.strictEqual(model.terrain.height.max, 5);
        assert.strictEqual(model.heightSamples[0].height, 5);
        assert.strictEqual(model.heightSamples[1].height, 0);

        const w = model.weightSamples[0];
        assert.deepStrictEqual(w.block, [1, 0]);
        assert.deepStrictEqual(w.texel, [10, 2]);
        assert.strictEqual(w.dominantLayer, 1);
        assert.strictEqual(w.dominantLayerName, 'panel.png@6c48a');
        assert.strictEqual(w.weights[1], 1);
        assert.strictEqual(w.weights[0], 0);
        assert.strictEqual(w.channels[1].weight, 1);
    });

    it('handles the empty default sentinel without pretending to have data', async () => {
        const rel = 'assets/Maps/Empty.terrain';
        fs.writeFileSync(join(project, rel), defaultSentinel());
        const text = await ok({
            terrainPath: rel, heightAt: [[1, 1]], weightAt: [[1, 1]], exportHeights: {}
        }, project);
        assert.match(text, /Empty default terrain/);
        assert.match(text, /No layers/);
        assert.match(text, /empty default terrain — no height data yet/);
        assert.match(text, /empty default terrain — no weight data to dump yet|empty default terrain — no height data to dump yet/);

        const model = await json({ terrainPath: rel, exportHeights: {} }, project);
        assert.strictEqual(model.terrain.isDefaultSentinel, true);
        assert.strictEqual(model.terrain.height.min, null);
        assert.deepStrictEqual(model.layers, []);
        assert.strictEqual(model.blocks, null);
        assert.strictEqual(model.blockCountTotal, 0);
        assert.deepStrictEqual(model.heightGrid.rows, []);
        assert.strictEqual(model.heightSamples, null);
    });
});

describe('QueryTerrain — output stability', () => {
    it('is deterministic across runs (no timestamps, no Map ordering leaks)', async () => {
        const args = {
            terrainPath: MOCK_TERRAIN,
            heightAt: [[1, 2], [30, 30]],
            weightAt: [[1, 2]],
            exportHeights: { sampleCount: 4 },
            blocks: true
        };
        assert.strictEqual(await ok(args, MOCK_PROJECT), await ok(args, MOCK_PROJECT));
    });

    it('emits no ANSI escapes and no tabs', async () => {
        const text = await ok({
            terrainPath: GOLDEN_REL, heightAt: [[1, 1]], weightAt: [[1, 1]], exportHeights: {}
        }, REPO_ROOT);
        assert.ok(!/\u001b\[/.test(text), 'ANSI escape in the report');
        assert.ok(!text.includes('\t'), 'tab in the report');
    });

    it('json format carries every section as data', async () => {
        const model = await json({
            terrainPath: MOCK_TERRAIN, heightAt: [[1, 1]], weightAt: [[1, 1]], exportHeights: {}
        }, MOCK_PROJECT);
        for (const key of ['path', 'uuid', 'importer', 'file', 'terrain', 'layers', 'blocks',
            'heightSamples', 'weightSamples', 'heightGrid', 'warnings']) {
            assert.ok(key in model, `missing ${key} in the json model`);
        }
    });

    it('omits sampling sections that were not asked for', async () => {
        const text = await ok({ terrainPath: MOCK_TERRAIN }, MOCK_PROJECT);
        assert.ok(!text.includes('## Sampled heights'));
        assert.ok(!text.includes('## Sampled weights'));
        assert.ok(!text.includes('## Height grid'));
        const model = await json({ terrainPath: MOCK_TERRAIN }, MOCK_PROJECT);
        assert.strictEqual(model.heightSamples, null);
        assert.strictEqual(model.weightSamples, null);
        assert.strictEqual(model.heightGrid, null);
    });

    it('sentinel fixture and golden fixture both round-trip through the tool unchanged on disk', async () => {
        const before = [
            fs.readFileSync(join(GOLDEN_DIR, 'terrain.terrain')),
            fs.readFileSync(join(GOLDEN_DIR, 'default.terrain'))
        ];
        await ok({ terrainPath: GOLDEN_REL, exportHeights: {} }, REPO_ROOT);
        await ok({ terrainPath: SENTINEL_REL }, REPO_ROOT);
        assert.ok(before[0].equals(fs.readFileSync(join(GOLDEN_DIR, 'terrain.terrain'))));
        assert.ok(before[1].equals(fs.readFileSync(join(GOLDEN_DIR, 'default.terrain'))));
    });
});

describe('QueryTerrain — review regressions', () => {
    // heightAt/weightAt were the one unbounded surface in an otherwise carefully
    // budgeted tool: 5000 points rendered an 868 KB, 15 037-line response.
    it('caps the sample-point arrays and routes the bulk case at exportHeights', async () => {
        const many = Array.from({ length: 257 }, (_, i) => [i % 32, i % 32]);
        for (const key of ['heightAt', 'weightAt']) {
            const err = await fails({ terrainPath: MOCK_TERRAIN, [key]: many }, MOCK_PROJECT);
            assert.match(err, new RegExp(`${key} has 257 points, over the 256-point limit`));
            assert.match(err, /use exportHeights \{region, sampleCount\}/);
        }
        // the limit itself is accepted, and advertised
        const text = await ok({
            terrainPath: MOCK_TERRAIN, heightAt: many.slice(0, 256)
        }, MOCK_PROJECT);
        assert.match(text, /## Sampled heights \(256\)/);
        assert.match(tool.description, /max 256 points/);
        assert.match(tool.inputSchema.properties.heightAt.description, /max 256 points/);
    });

    // Two user-facing strings used to instruct the agent to call `edit_terrain`,
    // which is not a registered tool — a guaranteed failed tool call.
    it('never names the unimplemented edit_terrain tool', async () => {
        const sentinel = await ok({ terrainPath: SENTINEL_REL }, REPO_ROOT);
        assert.doesNotMatch(sentinel, /edit_terrain/);
        assert.match(sentinel, /build_terrain can materialize it offline/);

        // a terrain with an empty palette
        const dir = fs.mkdtempSync(join(os.tmpdir(), 'qt-nolayers-'));
        try {
            const data = materialize({ blockCount: [1, 1], tileSize: 1, weightMapSize: 4, lightMapSize: 4 });
            data.layers = [];
            fs.writeFileSync(join(dir, 'bare.terrain'), writeTerrain(data));
            const text = await ok({ terrainPath: 'bare.terrain' }, dir);
            assert.match(text, /## Layers \(palette, 0\)/);
            assert.doesNotMatch(text, /edit_terrain/);
            assert.match(text, /Rebuild with build_terrain/);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    // The sentinel stores a 4-byte payload and NONE of the geometry the card prints;
    // every number there is a TerrainAsset class default.
    it('marks the sentinel card geometry as class defaults, not file content', async () => {
        const text = await ok({ terrainPath: SENTINEL_REL }, REPO_ROOT);
        assert.match(text, /geometry numbers below are TerrainAsset class defaults/);
        assert.match(text, /4-byte payload stores none of them/);
        // "(0 heights)" / "(0 bytes)" contradicted the numbers on the same line
        assert.match(text, /Vertices: +33 x 33 \(none stored\)/);
        assert.match(text, /texels \(none stored\)/);
        assert.doesNotMatch(text, /\(0 heights\)/);
    });

    // inspect_node prints an asset NAME for cc.Terrain.__asset; the not-found error
    // used to leave the agent with no way to turn that into a path.
    it('explains a bare asset name in the not-found error', async () => {
        const err = await fails({ terrainPath: 'Terrain.terrain' }, MOCK_PROJECT);
        assert.match(err, /looks like an asset NAME/);
        assert.match(err, /list_assets \{type: "terrain", pattern: "Terrain\.terrain"\}/);
        // a path-shaped miss keeps the plain browse hint, with no name lecture
        const plain = await fails({ terrainPath: 'assets/Maps/Nope.terrain' }, MOCK_PROJECT);
        assert.doesNotMatch(plain, /looks like an asset NAME/);
        assert.match(plain, /Use list_assets \{type: "terrain"\} to browse/);
    });

    // ~25 lines of geometry/palette/notes preamble per call is the whole response
    // when the question is "how high is the ground at (x, z)".
    it('sections trims the report to the sections asked for', async () => {
        const args = { terrainPath: MOCK_TERRAIN, heightAt: [[16, 16]], weightAt: [[16, 16]] };
        const full = await ok(args, MOCK_PROJECT);
        const lean = await ok({ ...args, sections: ['samples'] }, MOCK_PROJECT);

        assert.ok(lean.length < full.length / 2, `lean ${lean.length} vs full ${full.length}`);
        for (const heading of ['## Terrain', '## Layers', '## Blocks', '## Notes']) {
            assert.ok(full.includes(heading), `full report lost ${heading}`);
            assert.ok(!lean.includes(heading), `lean report kept ${heading}`);
        }
        assert.match(lean, /## Sampled heights/);
        assert.match(lean, /## Sampled weights/);
        // dropping "geometry" still leaves the coordinate frame on one line
        assert.match(lean, /32 x 32 m, 1 x 1 blocks, tileSize 1 m, heights 0\.\.3 m — local metres/);
        assert.match(lean, /anchored at the node origin/);
        // the header (path/uuid/file) is never dropped
        assert.match(lean, /^# assets\/Maps\/Terrain\.terrain$/m);
        assert.match(lean, /UUID: a3c1b7d2/);
    });

    it('rejects an unknown or empty sections list', async () => {
        assert.match(
            await fails({ terrainPath: MOCK_TERRAIN, sections: ['geometry', 'bogus'] }, MOCK_PROJECT),
            /sections\[1\]" must be one of/);
        assert.match(
            await fails({ terrainPath: MOCK_TERRAIN, sections: [] }, MOCK_PROJECT),
            /sections must name at least one of geometry, layers, blocks, samples, notes/);
    });

    it('renders warnings even when every section is trimmed away', async () => {
        // the golden terrain's layer uuids do not resolve in this repo → warnings
        const text = await ok({ terrainPath: GOLDEN_REL, sections: ['samples'] }, REPO_ROOT);
        assert.match(text, /## Warnings/);
        assert.doesNotMatch(text, /## Terrain/);
    });

    it('labels the layer tileSize column with its unit', async () => {
        const text = await ok({ terrainPath: MOCK_TERRAIN }, MOCK_PROJECT);
        assert.match(text, /^slot +detailMap +tileSize\(m\) +normalMap/m);
        assert.match(text, /tileSize is metres per texture repeat/);
    });

    // The tool used to readTerrain() the buffer and then call readTerrainInfo(), which
    // reads and parses the very same file again. The card is now built off the first
    // parse — with the FILE's byte counts, not the ones a write would produce.
    it('reports the same card as readTerrainInfo from a single parse', async () => {
        for (const [rel, root] of [
            [GOLDEN_REL, REPO_ROOT],       // 131 072 bytes: payload + pow-2 zero padding
            [SENTINEL_REL, REPO_ROOT],     // 2048-byte sentinel, 4-byte payload
            [MOCK_TERRAIN, MOCK_PROJECT]
        ]) {
            const abs = join(root, rel);
            const card = readTerrainInfo(abs);
            const model = await json({ terrainPath: rel }, root);
            assert.strictEqual(model.file.size, card.fileSize, rel);
            assert.strictEqual(model.file.payloadLength, card.payloadLength, rel);
            assert.strictEqual(model.file.padding, card.padding, rel);
            assert.strictEqual(model.file.size, fs.statSync(abs).size, rel);
            assert.strictEqual(model.terrain.heightCount, card.heightCount, rel);
            assert.strictEqual(model.terrain.weightCount, card.weightCount, rel);
            assert.deepStrictEqual(model.warnings.slice(0, card.warnings.length), card.warnings, rel);
        }
    });

    // The per-block sweep is weightMapSize^2 * 4 reads per block; it used to run even
    // when the table was suppressed, where only the row COUNT is ever read.
    it('reports the block count without the table, in both suppressed modes', async () => {
        const dir = fs.mkdtempSync(join(os.tmpdir(), 'qt-blocks-'));
        try {
            const data = materialize({
                blockCount: [9, 9], tileSize: 1, weightMapSize: 4, lightMapSize: 4, layers: []
            });
            fs.writeFileSync(join(dir, 'big.terrain'), writeTerrain(data));

            // over BLOCK_TABLE_AUTO_LIMIT: budget-omitted, count still exact
            const auto = await json({ terrainPath: 'big.terrain' }, dir);
            assert.strictEqual(auto.blocks, null);
            assert.strictEqual(auto.blockCountTotal, 81);
            assert.strictEqual(auto.blocksOmitted, 'budget');
            assert.match(await ok({ terrainPath: 'big.terrain' }, dir),
                /Table omitted for 81 blocks/);

            // explicitly suppressed: same count, and the omission stays unacknowledged
            const off = await json({ terrainPath: 'big.terrain', blocks: false }, dir);
            assert.strictEqual(off.blocks, null);
            assert.strictEqual(off.blockCountTotal, 81);
            assert.strictEqual(off.blocksOmitted, 'requested');

            // and the forced table still carries every row
            const forced = await json({ terrainPath: 'big.terrain', blocks: true }, dir);
            assert.strictEqual(forced.blockCountTotal, 81);
            assert.strictEqual(forced.blocks.length, 81);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    // heightAt/weightAt return null for a mis-sized buffer as well as for an
    // out-of-range point; reporting "outside the terrain" for a point the same
    // record calls inside blamed the caller for a property of the FILE.
    it('names the file, not the coordinates, when an in-bounds sample has no data', async () => {
        const dir = fs.mkdtempSync(join(os.tmpdir(), 'qt-mis-sized-'));
        try {
            // A valid 1x1-block file whose header is then rewritten to claim 2x2 blocks:
            // every buffer is mis-sized for the declared geometry, which is exactly the
            // state the engine re-materializes on load. blockCount sits at bytes 12/16.
            const bytes = Buffer.from(writeTerrain(materialize({
                blockCount: [1, 1], tileSize: 1, weightMapSize: 4, lightMapSize: 4, layers: []
            })));
            bytes.writeInt32LE(2, 12);
            bytes.writeInt32LE(2, 16);
            fs.writeFileSync(join(dir, 'mis-sized.terrain'), bytes);

            const model = await json({
                terrainPath: 'mis-sized.terrain',
                heightAt: [[0.5, 0.5], [-1, 0.5]],
                weightAt: [[0.5, 0.5], [-1, 0.5]]
            }, dir);

            const [inBounds, outside] = model.heightSamples;
            assert.strictEqual(inBounds.inside, true);
            assert.strictEqual(inBounds.height, null);
            assert.doesNotMatch(inBounds.reason, /outside the terrain/);
            assert.match(inBounds.reason, /in bounds — the file has no usable height grid/);
            assert.match(inBounds.reason, /Warnings/);
            assert.strictEqual(outside.inside, false);
            assert.strictEqual(outside.reason, 'outside the terrain');

            const [wIn, wOut] = model.weightSamples;
            assert.strictEqual(wIn.weights, null);
            assert.match(wIn.reason, /in bounds — the file has no usable weight map/);
            assert.strictEqual(wOut.reason, 'outside the terrain');

            // the structural cause the reason points at
            assert.ok(model.warnings.some((w) => /heights count 1089 != 4225 expected/.test(w)),
                model.warnings.join('\n'));
            assert.ok(model.warnings.some((w) => /weights count 64 != 256 expected/.test(w)),
                model.warnings.join('\n'));

            // a mis-sized layerBuffer keeps the block table empty, silently
            assert.strictEqual(model.blockCountTotal, 0);
            assert.strictEqual(model.blocks, null);
            assert.strictEqual(model.blocksOmitted, null);
            assert.doesNotMatch(await ok({ terrainPath: 'mis-sized.terrain' }, dir), /## Blocks/);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    // The sentinel has no buffers at all, and says so in its own words
    it('keeps the sentinel wording for an in-bounds sample on an empty terrain', async () => {
        const model = await json({
            terrainPath: SENTINEL_REL, heightAt: [[1, 1]], weightAt: [[1, 1]]
        }, REPO_ROOT);
        assert.strictEqual(model.heightSamples[0].inside, true);
        assert.match(model.heightSamples[0].reason, /empty default terrain — no height data yet/);
        assert.match(model.weightSamples[0].reason, /empty default terrain — no weight data yet/);
    });
});

describe('QueryTerrain — contourAt / slope / land map', () => {
    let project;

    /** write a terrain whose heights come from `fn(x, z)` metres, 1 block at 1 m */
    function ramp(name, fn) {
        const data = materialize({
            blockCount: [1, 1], tileSize: 1, weightMapSize: 4, lightMapSize: 4, layers: []
        });
        for (let j = 0; j < 33; j++) {
            for (let i = 0; i < 33; i++) setVertexHeight(data, i, j, fn(i, j), true);
        }
        const rel = `assets/Maps/${name}.terrain`;
        fs.writeFileSync(join(project, rel), writeTerrain(data));
        return rel;
    }

    before(() => {
        project = fs.mkdtempSync(join(os.tmpdir(), 'cocos-contour-'));
        fs.cpSync(MOCK_PROJECT, project, { recursive: true });
        AssetIndex.invalidate(project);
    });

    after(() => {
        fs.rmSync(project, { recursive: true, force: true });
    });

    it('traces a diagonal contour at vertex resolution with continuity stats', async () => {
        // The 0 contour of h = (x - 2.5 z) / 10 runs diagonally: x = 2.5 z
        const rel = ramp('Diagonal', (i, j) => (i - 2.5 * j) / 10);
        const model = await json({ terrainPath: rel, contourAt: 0 }, project);
        assert.strictEqual(model.contours.length, 1);
        const c = model.contours[0];
        assert.strictEqual(c.threshold, 0);
        assert.strictEqual(c.axis, 'x');
        assert.deepStrictEqual(c.samples, [33, 33], 'the default is the vertex resolution');
        assert.strictEqual(c.stats.monotone, true);
        assert.ok(Math.abs(c.stats.maxJump.value - 2.5) < 0.05, 'the edge runs 2.5 m of x per m of z');
        const first = c.lines.find((l) => l.crossings.length === 1);
        assert.ok(Math.abs(first.crossings[0] - 2.5 * first.coord) < 0.05);

        const text = await ok({ terrainPath: rel, contourAt: 0, sections: ['samples'] }, project);
        assert.match(text, /## Contour at 0 m/);
        assert.match(text, /Scanned along x — one line per z/);
        assert.match(text, /Monotone: yes/);
        assert.match(text, /largest jump between adjacent lines 2\.5/);
        assert.match(text, /A jump much larger than the line spacing IS a step in the geometry/);
    });

    it('surfaces a step in the contour as a jump', async () => {
        const rel = ramp('Stepped', (i, j) => (i - (j < 16 ? 8 : 13)) / 10);
        const text = await ok({ terrainPath: rel, contourAt: 0, sections: ['samples'] }, project);
        assert.match(text, /largest jump between adjacent lines 5/);
    });

    it('takes several thresholds, an axis, a region and a "vertex" sampleCount', async () => {
        const rel = ramp('Multi', (i) => i / 10);
        const model = await json({
            terrainPath: rel,
            contourAt: {
                threshold: [1, 2],
                axis: 'z',
                region: { x: 4, z: 4, width: 20, depth: 20 },
                sampleCount: 'vertex'
            }
        }, project);
        assert.deepStrictEqual(model.contours.map((c) => c.threshold), [1, 2]);
        assert.strictEqual(model.contours[0].axis, 'z');
        assert.deepStrictEqual(model.contours[0].samples, [21, 21], '20 m at 1 m tiles + 1');
        assert.deepStrictEqual(model.contours[0].region, { x: 4, z: 4, width: 20, depth: 20 });
    });

    it('says so when the threshold misses the height range', async () => {
        const rel = ramp('Flat', () => 1);
        const text = await ok({ terrainPath: rel, contourAt: 9, sections: ['samples'] }, project);
        assert.match(text, /No crossing at all: the whole region is either above or below 9 m/);
    });

    it('reports slope, the crease metric and a walkability distribution', async () => {
        const rel = ramp('Slope45', (i) => i); // h = x → 45° everywhere
        const model = await json({ terrainPath: rel, slope: true }, project);
        assert.ok(Math.abs(model.slope.max.degrees - 45) < 0.01);
        assert.ok(Math.abs(model.slope.mean - 45) < 0.01);
        assert.ok(Math.abs(model.slope.maxStep.metres - 1) < 0.01);

        const text = await ok({ terrainPath: rel, slope: true, sections: ['samples'] }, project);
        assert.match(text, /## Slope/);
        assert.match(text, /Max 45°/);
        assert.match(text, /Steepest adjacent-sample step: 1 m/);
        assert.match(text, /the crease metric/);
        assert.match(text, /Distribution: <=15° 0/);
    });

    it('renders the land map with an explicit and a derived threshold', async () => {
        const rel = ramp('Island', (i, j) => (Math.hypot(i - 16, j - 16) < 6 ? 2 : -1));
        const text = await ok({
            terrainPath: rel,
            exportHeights: { format: 'map', threshold: 0, sampleCount: 33 },
            sections: ['samples']
        }, project);
        assert.match(text, /Map: "#" = height >= 0 m, "\." = below it/);
        const rows = text.split('\n').filter((l) => /^ *\d+ \| [#.?]+$/.test(l));
        assert.strictEqual(rows.length, 33);
        assert.ok(/^ *0 \| \.+$/.test(rows[0]), 'the near edge is all water');
        assert.ok(rows[16].includes('#'), 'the middle row crosses the island');

        const derived = await json({
            terrainPath: rel, exportHeights: { format: 'map', sampleCount: 9 }
        }, project);
        assert.strictEqual(derived.heightGrid.derivedThreshold, true);
        assert.strictEqual(derived.heightGrid.threshold, 0.5, 'midpoint of -1..2');
    });

    it('rejects a bad contourAt / slope / map spec', async () => {
        const rel = ramp('Bad', () => 0);
        const cases = [
            [{ contourAt: 'high' }, /contourAt must be a height in metres/],
            [{ contourAt: [] }, /give at least one threshold/],
            [{ contourAt: [1, 2, 3, 4, 5, 6, 7, 8, 9] }, /over the 8 limit/],
            [{ contourAt: { region: { x: 0 } } }, /"threshold" is required/],
            [{ contourAt: { threshold: 0, axis: 'y' } }, /axis must be "x" or "z"/],
            [{ contourAt: { threshold: 0, bogus: 1 } }, /unknown key "bogus"/],
            [{ slope: 'steep' }, /slope must be true or an object/],
            [{ slope: { bogus: 1 } }, /slope: unknown key "bogus"/],
            [{ exportHeights: { threshold: 1 } }, /threshold only applies to format: "map"/],
            [{ exportHeights: { format: 'map', threshold: 'zero' } }, /threshold must be a finite height/]
        ];
        for (const [args, pattern] of cases) {
            assert.match(await fails({ terrainPath: rel, ...args }, project), pattern);
        }
    });

    it('answers the sentinel without pretending it has geometry', async () => {
        const text = await ok({ terrainPath: SENTINEL_REL, contourAt: 0, slope: true }, REPO_ROOT);
        assert.match(text, /no height data to trace a contour through yet/);
        assert.match(text, /no height data to measure a slope on yet/);
    });
});
