/**
 * edit_terrain tool tests (Phase T4)
 *
 * Everything runs against a throwaway copy of the mock project, so the real path
 * (resolve → read → apply → validate → atomic write → re-read card) is exercised end to end.
 * Results are asserted by parsing the file back with `readTerrain`, never by trusting a
 * summary string.
 *
 * Two hard invariants live here:
 * - a batch whose LAST op fails leaves the file byte-identical, and so does `dryRun`;
 * - the GOLDEN editor-saved terrain survives a no-op batch byte-for-byte, all 131072 bytes
 *   including the power-of-two zero padding.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

import { EditTerrain } from '../../src/tools/EditTerrain.js';
import { createTools } from '../../src/tools/index.js';
import { AssetIndex } from '../../src/core/AssetIndex.js';
import {
    readTerrain,
    getVertexHeight,
    weightTexelIndex,
    blockLayers,
} from '../../src/utils/terrainBin.js';
import { section } from './reportSection.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_PROJECT = path.join(__dirname, '..', 'fixtures', 'mock-project');
const GOLDEN_DIR = path.join(__dirname, '..', 'fixtures', 'golden', 'terrain');
const MOCK_TERRAIN = 'assets/Maps/Terrain.terrain';
const MOCK_TERRAIN_UUID = 'a3c1b7d2-4e58-4f0a-9b6c-1d2e3f405060';

const tool = new EditTerrain();
let root;
let seq = 0;

before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-terrain-'));
    // `test/tools/FindAssetReferences.test.js` creates and deletes a transient scene inside
    // the SHARED fixture while node:test runs files in parallel — skip it (BuildTerrain does
    // the same).
    fs.cpSync(MOCK_PROJECT, root, {
        recursive: true,
        filter: (src) => !path.basename(src).startsWith('__refs_test'),
    });
    AssetIndex.invalidate(root);
});

after(() => {
    AssetIndex.invalidate(root);
    fs.rmSync(root, { recursive: true, force: true });
});

const text = (result) => result.content[0].text;

/** run() (aliases + schema validation), asserting success */
async function ok(args) {
    const result = await tool.run(args, root);
    assert.ok(!result.isError, text(result));
    return text(result);
}

async function fails(args) {
    const result = await tool.run(args, root);
    assert.strictEqual(result.isError, true, `expected an error, got:\n${text(result)}`);
    return text(result);
}

/**
 * A private copy of a fixture terrain inside the project, with its own .meta uuid so the
 * asset index stays unambiguous. Returns `{rel, abs, before}`.
 */
function fresh(name, {
    source = path.join(MOCK_PROJECT, MOCK_TERRAIN),
    meta = path.join(MOCK_PROJECT, `${MOCK_TERRAIN}.meta`),
} = {}) {
    seq += 1;
    const rel = `assets/Maps/${name}.terrain`;
    const abs = path.join(root, rel);
    fs.copyFileSync(source, abs);
    if (meta) {
        const parsed = JSON.parse(fs.readFileSync(meta, 'utf-8'));
        parsed.uuid = `a3c1b7d2-4e58-4f0a-9b6c-1d2e3f4${String(50000 + seq)}`;
        fs.writeFileSync(`${abs}.meta`, `${JSON.stringify(parsed, null, 2)}\n`);
    }
    AssetIndex.invalidate(root);
    return { rel, abs, before: fs.readFileSync(abs) };
}

const load = (abs) => readTerrain(fs.readFileSync(abs));

/**
 * The `## Warnings (N — <composition>)` header. `section()` reads a bare `(N)` only, and this
 * header names WHAT it counts (see the header-unit test below).
 */
function warningsHeader(report) {
    const m = report.match(/^## Warnings \((\d+) — (.+)\)$/m);
    return m ? { total: Number(m[1]), split: m[2] } : null;
}

/** The four channel bytes of one global texel */
function texel(data, i, j) {
    const base = weightTexelIndex(data, i, j);
    return [data.weights[base], data.weights[base + 1], data.weights[base + 2], data.weights[base + 3]];
}

// ---------------------------------------------------------------------------

describe('EditTerrain — tool contract', () => {
    it('is registered in createTools() under the documented name', () => {
        const names = createTools().map((t) => t.name);
        assert.ok(names.includes('edit_terrain'), names.join(', '));
        const registered = createTools().find((t) => t.name === 'edit_terrain');
        assert.ok(registered instanceof EditTerrain);
    });

    it('declares the BaseTool surface', () => {
        assert.strictEqual(tool.name, 'edit_terrain');
        assert.deepStrictEqual(tool.inputSchema.required, ['terrainPath', 'ops']);
        assert.strictEqual(tool.inputSchema.properties.ops.minItems, 1);
        assert.strictEqual(tool.inputSchema.properties.dryRun.default, false);
        for (const key of tool.inputSchema.required) {
            assert.ok(key in tool.inputSchema.properties, key);
        }
        // the description is the LLM's only contract for the op shapes
        for (const op of ['set_info', 'set_layer', 'remove_layer', 'set_heights',
            'adjust_heights', 'smooth_heights', 'paint_layer', 'set_block_layers']) {
            assert.ok(tool.description.includes(`- ${op} `), `${op} missing from the description`);
        }
        assert.match(tool.description, /LOCAL METRES/);
    });

    it('accepts both "ops" and the "operations" alias, and the path aliases', async () => {
        const a = fresh('AliasA');
        const b = fresh('AliasB');
        const viaOps = await ok({ terrainPath: a.rel, ops: [{ op: 'adjust_heights', delta: 1 }], dryRun: true });
        const viaOperations = await ok({ filePath: b.rel, operations: [{ op: 'adjust_heights', delta: 1 }], dryRun: true });
        assert.match(viaOps, /1\. \[adjust_heights\] Raised 1089 vertices by 1 m/);
        assert.strictEqual(
            viaOperations.replace(/AliasB/g, 'AliasA'), viaOps,
            'the alias must produce the identical report'
        );
    });

    it('addresses the terrain by UUID as well as by path', async () => {
        const report = await ok({
            terrainPath: MOCK_TERRAIN_UUID, ops: [{ op: 'adjust_heights', delta: 1 }], dryRun: true,
        });
        assert.match(report, /# DRY RUN — assets\/Maps\/Terrain\.terrain NOT modified/);
    });

    it('rejects hostile arguments through validateArgs before any I/O', async () => {
        assert.match(await fails({ ops: [{ op: 'adjust_heights', delta: 1 }] }),
            /missing required parameter "terrainPath"/);
        assert.match(await fails({ terrainPath: MOCK_TERRAIN }), /missing required parameter "ops"/);
        assert.match(await fails({ terrainPath: MOCK_TERRAIN, ops: [] }), /at least 1/);
        assert.match(await fails({ terrainPath: MOCK_TERRAIN, ops: 'adjust_heights' }),
            /parameter "ops" must be of type array, got string/);
        assert.match(await fails({ terrainPath: MOCK_TERRAIN, ops: [{ op: 'adjust_heights', delta: 1 }], dryRun: 'yes' }),
            /parameter "dryRun" must be of type boolean, got string/);
        assert.match(await fails({ terrainPath: MOCK_TERRAIN, ops: [{ op: 'adjust_heights', delta: 1 }], region: {} }),
            /unknown parameter "region"/);
        assert.match(await fails({ terrainPath: 42, ops: [{ op: 'adjust_heights', delta: 1 }] }),
            /parameter "terrainPath" must be of type string, got number/);
        // the fixture is untouched by any of the above
        assert.ok(fs.readFileSync(path.join(root, MOCK_TERRAIN))
            .equals(fs.readFileSync(path.join(MOCK_PROJECT, MOCK_TERRAIN))));
    });
});

describe('EditTerrain — the eight ops, verified by re-reading the file', () => {
    it('set_info resizes the block grid, preserving the overlap', async () => {
        const { rel, abs } = fresh('Resize');
        const original = load(abs);

        const report = await ok({ terrainPath: rel, ops: [{ op: 'set_info', blockCount: [2, 1] }] });

        const data = load(abs);
        assert.deepStrictEqual(data.blockCount, [2, 1]);
        assert.strictEqual(data.heights.length, 65 * 33);
        // the old 33x33 heights survive in place, the new half is 0 m
        for (let j = 0; j < 33; j++) {
            for (let i = 0; i < 33; i++) {
                assert.strictEqual(data.heights[j * 65 + i], original.heights[j * 33 + i], `vertex (${i},${j})`);
            }
        }
        assert.strictEqual(getVertexHeight(data, 40, 10), 0);
        // layer assignment: block 0 kept, block 1 unassigned
        assert.deepStrictEqual([...data.layerBuffer], [0, 1, -1, -1, -1, -1, -1, -1]);
        // weights: block 0 copied texel-for-texel, block 1 reset
        assert.strictEqual(data.weights.length, 64 * 32 * 4);
        assert.deepStrictEqual(texel(data, 16, 16), texel(original, 16, 16));
        assert.deepStrictEqual(texel(data, 48, 16), [255, 0, 0, 0]);

        assert.match(report, /^# Applied 1 op\(s\) to assets\/Maps\/Resize\.terrain/);
        assert.match(report, /Size: 64 x 32 m \(2 x 1 blocks, 65 x 33 vertices\)/);
    });

    it('set_layer appends a palette entry', async () => {
        const { rel, abs } = fresh('AddLayer');
        await ok({
            terrainPath: rel,
            ops: [{ op: 'set_layer', slot: 2, detailMap: 'Sprites/coin_bar.png', tileSize: 4, metallic: 0.5 }],
        });
        const data = load(abs);
        assert.strictEqual(data.layers.length, 3);
        assert.deepStrictEqual(data.layers[2], {
            slot: 2,
            tileSize: 4,
            detailMapId: '35b97cf8-601e-4835-8a3e-0d29568af652@6c48a',
            normalMapId: '',
            roughness: 1,
            metallic: 0.5,
        });
    });

    it('remove_layer drops the refs, zeroes the channel and renormalizes', async () => {
        const { rel, abs } = fresh('DropLayer');
        const report = await ok({ terrainPath: rel, ops: [{ op: 'remove_layer', slot: 1 }] });

        const data = load(abs);
        assert.strictEqual(data.layers.length, 1);
        assert.deepStrictEqual([...data.layerBuffer], [0, -1, -1, -1]);
        // the fixture's texels were (r, 255 - r, 0, 0); with layer 1 gone the survivor
        // carries the whole 255 and channels G/B/A are zero
        for (let j = 0; j < 32; j++) {
            for (let i = 0; i < 32; i++) {
                assert.deepStrictEqual(texel(data, i, j), [255, 0, 0, 0], `texel (${i},${j})`);
            }
        }
        assert.match(report, /unassigned in 1 block/);
        assert.match(report, /Layers:\n {2}0\. coin_bar\.png@6c48a/);
    });

    it('set_heights flattens a metre region', async () => {
        const { rel, abs } = fresh('Flatten');
        const original = load(abs);
        await ok({
            terrainPath: rel,
            ops: [{ op: 'set_heights', region: { x: 4, z: 4, width: 4, depth: 4 }, value: 2.5 }],
        });
        const data = load(abs);
        for (let j = 4; j <= 8; j++) {
            for (let i = 4; i <= 8; i++) assert.strictEqual(getVertexHeight(data, i, j), 2.5);
        }
        // the vertices just outside the region keep the fixture's terraced heights
        for (const [i, j] of [[3, 4], [4, 3], [9, 8], [8, 9]]) {
            assert.strictEqual(
                getVertexHeight(data, i, j), getVertexHeight(original, i, j), `vertex (${i},${j})`
            );
        }
    });

    it('adjust_heights shifts every vertex of the region', async () => {
        const { rel, abs } = fresh('Raise');
        const original = load(abs);
        await ok({ terrainPath: rel, ops: [{ op: 'adjust_heights', delta: -0.5 }] });
        const data = load(abs);
        for (const [i, j] of [[0, 0], [1, 1], [16, 16], [32, 32]]) {
            assert.strictEqual(
                getVertexHeight(data, i, j),
                getVertexHeight(original, i, j) - 0.5,
                `vertex (${i},${j})`
            );
        }
    });

    it('smooth_heights box-blurs with clamp-to-edge taps', async () => {
        const { rel, abs } = fresh('Smooth');
        const original = load(abs);
        await ok({ terrainPath: rel, ops: [{ op: 'smooth_heights' }] });
        const data = load(abs);

        // An independent 3x3 mean over the ORIGINAL raws, taps clamped to the grid edge
        // (the `HeightField.getClamp` rule) and rounded — the documented box blur.
        const clampIdx = (v) => Math.min(Math.max(v, 0), 32);
        const expected = (i, j) => {
            let sum = 0;
            for (let dj = -1; dj <= 1; dj++) {
                for (let di = -1; di <= 1; di++) {
                    sum += original.heights[clampIdx(j + dj) * 33 + clampIdx(i + di)];
                }
            }
            return Math.round(sum / 9);
        };
        for (const [i, j] of [[0, 0], [1, 1], [16, 16], [32, 32], [0, 16], [5, 30]]) {
            assert.strictEqual(data.heights[j * 33 + i], expected(i, j), `vertex (${i},${j})`);
        }
        // Worked out by hand for the corner: the fixture's border ring is 0 m, so (0,0) sees
        // eight taps of raw 32768 through the clamp and one of 32792 (its 0.1875 m
        // neighbour) — round((8 * 32768 + 32792) / 9) = 32771 = 3/128 m. A zero-padded
        // kernel would have produced 1/128 m of that.
        assert.strictEqual(getVertexHeight(data, 0, 0), 3 / 128);
    });

    it('paint_layer writes weights and keeps the sum at 255', async () => {
        const { rel, abs } = fresh('Paint');
        const report = await ok({
            terrainPath: rel,
            ops: [{ op: 'paint_layer', layer: 1, weight: 1, region: { x: 0, z: 0, width: 8, depth: 8 } }],
        });
        const data = load(abs);
        assert.deepStrictEqual(texel(data, 0, 0), [0, 255, 0, 0]);
        assert.deepStrictEqual(texel(data, 7, 7), [0, 255, 0, 0]);
        assert.deepStrictEqual(texel(data, 8, 8), texel(load(path.join(MOCK_PROJECT, MOCK_TERRAIN)), 8, 8));
        for (let j = 0; j < 32; j++) {
            for (let i = 0; i < 32; i++) {
                assert.strictEqual(texel(data, i, j).reduce((a, b) => a + b, 0), 255, `texel (${i},${j})`);
            }
        }
        assert.match(report, /over 64 texels in 1 block/);
    });

    it('set_block_layers rewrites the block slots, the weights following their layer', async () => {
        const { rel, abs } = fresh('Slots');
        const original = load(abs);
        await ok({ terrainPath: rel, ops: [{ op: 'set_block_layers', block: 'all', layers: [1, 0] }] });
        const data = load(abs);
        assert.deepStrictEqual(blockLayers(data, 0, 0), [1, 0, -1, -1]);
        // The two channels swap, so their bytes swap with them: what each LAYER covers is untouched,
        // which is the only reading of a reorder that is not a silent repaint
        const swapped = [...original.weights];
        for (let n = 0; n < swapped.length; n += 4) {
            [swapped[n], swapped[n + 1]] = [swapped[n + 1], swapped[n]];
        }
        assert.deepStrictEqual([...data.weights], swapped);
    });

    it('applies a multi-op batch in order', async () => {
        const { rel, abs } = fresh('Batch');
        const report = await ok({
            terrainPath: rel,
            ops: [
                { op: 'set_heights', value: 0 },
                { op: 'adjust_heights', delta: 3, region: { x: 8, z: 8, width: 8, depth: 8 } },
                { op: 'set_layer', slot: 2, detailMap: 'Sprites/panel.png' },
                { op: 'paint_layer', layer: 2, weight: 1, region: { x: 8, z: 8, width: 8, depth: 8 } },
            ],
        });
        const data = load(abs);
        assert.strictEqual(getVertexHeight(data, 12, 12), 3);
        assert.strictEqual(getVertexHeight(data, 0, 0), 0);
        assert.strictEqual(data.layers.length, 3);
        assert.deepStrictEqual([...data.layerBuffer], [0, 1, 2, -1]);
        assert.deepStrictEqual(texel(data, 10, 10), [0, 0, 255, 0]);
        assert.match(report, /^# Applied 4 op\(s\)/);
        assert.match(report, /1\. \[set_heights\]/);
        assert.match(report, /4\. \[paint_layer\]/);
    });
});

describe('EditTerrain — atomicity, dryRun and error paths', () => {
    it('writes nothing when the LAST op of a batch fails', async () => {
        const { rel, abs, before } = fresh('Atomic');
        const report = await fails({
            terrainPath: rel,
            ops: [
                { op: 'set_heights', value: 4 },
                { op: 'set_block_layers', block: 'all', layers: [1, 0] },
                { op: 'paint_layer', layer: 9, weight: 1 },
            ],
        });
        assert.match(report, /op\[2\] paint_layer: no palette layer with slot 9/);
        assert.match(report, /Nothing was written\.$/);
        assert.ok(fs.readFileSync(abs).equals(before), 'the file must be byte-identical');
    });

    it('dryRun reports the resulting terrain but writes nothing', async () => {
        const { rel, abs, before } = fresh('Dry');
        const report = await ok({
            terrainPath: rel, dryRun: true,
            ops: [{ op: 'set_heights', value: 9 }, { op: 'set_info', blockCount: [2, 2] }],
        });
        assert.match(report, /^# DRY RUN — assets\/Maps\/Dry\.terrain NOT modified/);
        assert.match(report, /Size: 64 x 64 m \(2 x 2 blocks, 65 x 65 vertices\)/);
        assert.match(report, /Height: 0 \.\. 9 m/); // the new blocks are 0 m
        assert.match(report, /Re-run with dryRun: false to write\.$/);
        assert.ok(fs.readFileSync(abs).equals(before), 'dryRun must not write');
        assert.deepStrictEqual(load(abs).blockCount, [1, 1]);
    });

    it('leaves no temp file behind and never rewrites the .meta', async () => {
        const { rel, abs } = fresh('Meta');
        const metaBefore = fs.readFileSync(`${abs}.meta`, 'utf-8');
        const uuid = JSON.parse(metaBefore).uuid;

        await ok({ terrainPath: rel, ops: [{ op: 'set_info', blockCount: [2, 2] }] });

        assert.deepStrictEqual(
            fs.readdirSync(path.dirname(abs)).filter((f) => f.includes('.tmp-')), [],
            'the atomic write must clean up after itself'
        );
        assert.strictEqual(fs.readFileSync(`${abs}.meta`, 'utf-8'), metaBefore,
            'the .meta is never rewritten — the UUID every scene reference uses must not churn');
        assert.strictEqual(JSON.parse(fs.readFileSync(`${abs}.meta`, 'utf-8')).uuid, uuid);
    });

    it('rejects an unknown op by listing the valid ones, writing nothing', async () => {
        const { rel, abs, before } = fresh('Unknown');
        const report = await fails({ terrainPath: rel, ops: [{ op: 'sculpt', radius: 3 }] });
        assert.match(report, /Unknown op "sculpt"\. Supported: set_info, set_layer, remove_layer, set_heights, adjust_heights, smooth_heights, paint_layer, set_block_layers/);
        assert.match(report, /Nothing was written\.$/);
        assert.ok(fs.readFileSync(abs).equals(before));
    });

    it('refuses a path that is not a terrain asset', async () => {
        assert.match(await fails({ terrainPath: 'assets/Maps/Nope.terrain', ops: [{ op: 'smooth_heights' }] }),
            /Terrain not found: assets\/Maps\/Nope\.terrain/);
        assert.match(await fails({ terrainPath: 'assets/Prefabs/Gold.prefab', ops: [{ op: 'smooth_heights' }] }),
            /is not a terrain — its importer is "prefab"/);
        assert.match(await fails({ terrainPath: 'assets/Maps/Terrain.bin', ops: [{ op: 'smooth_heights' }] }),
            /terrainPath must point at a \.terrain file/);
    });

    it('refuses a .terrain outside assets/, symlinks included', async () => {
        fs.copyFileSync(path.join(MOCK_PROJECT, MOCK_TERRAIN), path.join(root, 'Outside.terrain'));
        assert.match(await fails({ terrainPath: 'Outside.terrain', ops: [{ op: 'smooth_heights' }] }),
            /must be inside the project's assets\/ directory/);

        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-terrain-'));
        try {
            fs.copyFileSync(path.join(MOCK_PROJECT, MOCK_TERRAIN), path.join(outside, 'Evil.terrain'));
            const before = fs.readFileSync(path.join(outside, 'Evil.terrain'));
            fs.symlinkSync(outside, path.join(root, 'assets', 'Linked'));
            assert.match(await fails({ terrainPath: 'assets/Linked/Evil.terrain', ops: [{ op: 'smooth_heights' }] }),
                /must be inside the project's assets\/ directory/);
            assert.ok(fs.readFileSync(path.join(outside, 'Evil.terrain')).equals(before));
        } finally {
            fs.rmSync(path.join(root, 'assets', 'Linked'), { force: true });
            fs.rmSync(outside, { recursive: true, force: true });
            AssetIndex.invalidate(root);
        }
    });

    it('refuses a file that is not a terrain binary', async () => {
        const abs = path.join(root, 'assets', 'Maps', 'Garbage.terrain');
        fs.writeFileSync(abs, Buffer.from('not a terrain at all, really'));
        const report = await fails({ terrainPath: 'assets/Maps/Garbage.terrain', ops: [{ op: 'smooth_heights' }] });
        assert.match(report, /is not a Cocos Creator \.terrain binary/);
        assert.match(report, /Nothing was written\.$/);
    });
});

describe('EditTerrain — T4 review regressions', () => {
    it('attaches per-op notes to their op line, keeping ## Warnings for file-level items', async () => {
        // "layer N was assigned to channel B" is the op doing exactly what it advertises; bucketing
        // it under `## Warnings (3)` next to real cross-file pairing warnings made success details
        // read as problems. apply_edits reserves `## Warnings` for validator output.
        const { rel } = fresh('Notes');
        // slot 2 is an APPEND (the fixture palette holds 0 and 1), so paint_layer has to assign it
        // into the block and emits its "was assigned to channel B" note.
        const report = await ok({
            terrainPath: rel,
            ops: [
                { op: 'set_layer', slot: 2, detailMap: 'assets/Sprites/panel.png', roughness: 0.4 },
                { op: 'paint_layer', layer: 2, weight: 0.5, region: { x: 0, z: 0, width: 4, depth: 4 } },
            ],
        });
        const lines = report.split('\n');
        const opLine = lines.findIndex((l) => /^2\. \[paint_layer\]/.test(l));
        assert.ok(opLine >= 0, report);
        // the note is indented directly under its own op line, not bucketed under ## Warnings
        assert.match(lines[opLine + 1], /^ {3}- layer 2 was assigned to channel B of block \[0,0\]/);
        // …and the flat `- [paint_layer] …` bullet form is gone from the Warnings section
        assert.doesNotMatch(report, /^- \[paint_layer\] /m);
        assert.doesNotMatch(report, /^- \[set_layer\] /m);
    });

    it('flags a single-layer block in the card, like query_terrain does', async () => {
        // The one signal that would show a paint spilled over a whole neighbouring block was
        // missing from the edit report entirely.
        const { rel } = fresh('Sole');
        const report = await ok({
            terrainPath: rel,
            ops: [
                { op: 'set_info', blockCount: [2, 1] },
                { op: 'set_layer', slot: 1, detailMap: 'assets/Sprites/panel.png' },
                { op: 'paint_layer', layer: 1, weight: 1, region: { x: 0, z: 0, width: 32, depth: 32 } },
            ],
        });
        assert.match(report, /became the ONLY layer of 1 block \(\[1,0\]\)/);
        assert.match(report, /render it over their WHOLE 32x32-tile/);
        assert.match(report, /block\(s\) assign only channel R — the shader draws that layer flat over the whole block there/);
    });

    // The large-asset advice lived only in build_terrain's private copy of the card, so a
    // set_info that grew a terrain into tens of MB said nothing about the cost.
    it('flags a large asset in the card, like build_terrain does', async () => {
        const { rel, abs, before } = fresh('Grown');
        const report = await ok({
            terrainPath: rel,
            ops: [{ op: 'set_info', blockCount: [16, 16], weightMapSize: 128 }],
            dryRun: true,
        });
        assert.match(report, /Large asset: 32\.0 MB/);
        assert.match(report, /pow-2 padding/);
        assert.match(report, /weightMapSize 32 would need about/);
        assert.ok(fs.readFileSync(abs).equals(before), 'dryRun must not write');
    });

    it('labels rows-sourced errors and notes as "rows", never "heightmap"', async () => {
        const { rel } = fresh('Rows');
        const err = await fails({ terrainPath: rel, ops: [{ op: 'set_heights', rows: [[0, 1, 2], [1, 2]] }] });
        assert.match(err, /rows\[1\] has 2 value\(s\), expected 3/);
        assert.doesNotMatch(err, /heightmap/);

        const report = await ok({
            terrainPath: rel,
            ops: [{ op: 'set_heights', region: { x: 5, z: 5, width: 3, depth: 3 }, rows: [[0, 4], [4, 0]] }],
        });
        assert.match(report, /inline rows 2x2 resampled onto the 4x4 vertex grid/);
        assert.doesNotMatch(report, /heightmap \d+x\d+ resampled/);
    });

    it('shapes a height op with shape + falloff instead of pointing at a workaround', async () => {
        const { rel } = fresh('Hill');
        const report = await ok({
            terrainPath: rel,
            ops: [{
                op: 'adjust_heights',
                region: { x: 7, z: 7, width: 6, depth: 6, shape: 'ellipse' },
                delta: 4,
                falloff: 2,
                profile: 'smooth',
            }],
        });
        assert.match(report, /ellipse/);
        assert.match(report, /2 m smooth falloff/);
        assert.match(report, /mask covers \d+ of \d+ vertices/);
        // A tapered edit leaves no step, so the step note must NOT fire
        assert.doesNotMatch(report, /ends in a STEP/);

        // `shape` on the OP (rather than inside region) is the one near-miss worth naming
        const misplaced = await fails({
            terrainPath: rel,
            ops: [{ op: 'adjust_heights', region: { x: 7, z: 7, width: 6, depth: 6 }, delta: 4, shape: 'ellipse' }],
        });
        assert.match(misplaced, /shape is a REGION key/);
    });

    it('documents the paint-weight-0 erase and the height clamp/reject split', () => {
        const desc = tool.description;
        assert.match(desc, /weight 0 ERASES this layer where the factor is 1/);
        assert.match(desc, /that is the local undo, NOT remove_layer/);
        assert.match(desc, /an explicit out-of-range set_heights "value" is REJECTED/);
        assert.match(desc, /rows\/heightmap samples and adjust_heights results are clamped/);
        // the second block axis is called z everywhere, never y
        assert.match(desc, /set_block_layers \{block: \[x,z\]\|"all"/);
        assert.doesNotMatch(desc, /block: \[x,y\]/);
        assert.match(desc, /power of two in 4\.\.1024/);
        // what the mask factor does to a painted weight (terrainOps' paintLayer): it BLENDS,
        // it does not scale — a doc that says `weight * t` describes the bug that was fixed
        assert.match(desc, /current \+ \(weight\*255 - current\) \* t/);
        assert.match(desc, /two overlapping strokes JOIN/);
        // and where a slot change moves the stored bytes (terrainOps' remapBlockWeights)
        assert.match(desc, /the stored weights FOLLOW their layer through the change/);
        assert.match(desc, /a channel whose layer the block did not carry starts at 0/);
    });

    // The doc claim above, measured end to end: the mask edge must leave coverage that is
    // already there alone, or continuous painting shows a bare stripe down every seam.
    it('joins two overlapping paint strokes instead of eroding the overlap', async () => {
        const { rel, abs } = fresh('Strokes');
        const stroke = (x) => ({
            op: 'paint_layer', layer: 1, weight: 1, falloff: 4,
            region: { x, z: 0, width: 20, depth: 32 },
        });
        // texel 14 sits at x 14.45 m: inside the first stroke's plateau, inside the SECOND
        // stroke's 4 m ramp (12..16 m), so its factor there is 0.61
        const at = (data) => texel(data, 14, 8)[1];

        await ok({ terrainPath: rel, ops: [stroke(0)] });
        assert.strictEqual(at(load(abs)), 255, 'the first stroke paints it full');

        await ok({ terrainPath: rel, ops: [stroke(12)] });
        assert.strictEqual(at(load(abs)), 255, 'a factor of 0.61 over full coverage changes nothing');
    });

    it('rejects an op name inherited from Object.prototype instead of writing a no-op', async () => {
        const { rel, before } = fresh('Proto');
        const err = await fails({ terrainPath: rel, ops: [{ op: 'constructor' }] });
        assert.match(err, /Unknown op "constructor"\. Supported: set_info, set_layer/);
        assert.match(err, /Nothing was written\./);
        assert.deepStrictEqual(fs.readFileSync(path.join(root, rel)), before);
    });
});

describe('EditTerrain — report surfaces the hazards', () => {
    it('states the standing hazards in the description, not on every call', () => {
        // Paid once per session (the model already has the tool list) instead of 614 chars of
        // every report — apply_edits has no static footer at all.
        const desc = tool.description;
        assert.match(desc, /never edit a \.terrain while the editor has it open in its Terrain panel/);
        assert.match(desc, /silently discarding the edit/);
        assert.match(desc, /library\/ keeps the pre-edit import/);
        assert.match(desc, /never touches library\/ or the \.meta/);
    });

    it('omits "## Next steps" entirely when there is nothing specific to say', async () => {
        const { rel } = fresh('Hazards');
        const report = await ok({ terrainPath: rel, ops: [{ op: 'smooth_heights' }] });
        assert.doesNotMatch(report, /## Next steps/);
        assert.doesNotMatch(report, /Never edit a \.terrain while the editor/);
        assert.doesNotMatch(report, /Verify with query_terrain/);
    });

    it('hints at _lightmapInfos after any resize — blockCount OR tileSize', async () => {
        const resized = await ok({
            terrainPath: fresh('Lightmaps').rel, ops: [{ op: 'set_info', blockCount: [2, 2] }],
        });
        assert.match(resized, /## Next steps/);
        assert.match(resized, /blockCount changed \[1,1\] -> \[2,2\]: clear `_lightmapInfos`/);
        assert.match(resized, /apply_edits \{op: "set_component_property"/);
        assert.match(resized, /find_asset_references on this \.terrain/);
        assert.match(resized, /_lightmapInfos` is keyed by block index/);

        // `Terrain.rebuild` calls `_resetLightmap(false)` unconditionally (terrain.ts:1576), so a
        // tileSize-only change invalidates the bake too — and it is the SILENT case, because the
        // block count still matches and no structural check notices.
        const rescaled = await ok({
            terrainPath: fresh('NoLightmaps').rel, ops: [{ op: 'set_info', tileSize: 2 }],
        });
        assert.match(rescaled, /tileSize changed: any baked lightmap/);
        assert.match(rescaled, /the terrain changed physical size, so the bake no longer matches/);
        assert.match(rescaled, /the editor clears the bake on any resize too \(terrain\.ts:1576\)/);
        // …but a change that resizes nothing must stay quiet
        const relabelled = await ok({
            terrainPath: fresh('Quiet').rel, ops: [{ op: 'set_info', lightMapSize: 64 }],
        });
        assert.doesNotMatch(relabelled, /_lightmapInfos/);
        assert.doesNotMatch(relabelled, /baked lightmap/);
    });

    // `## Warnings (N)` counted the batch's preparation notes too, so materializing the empty
    // "Create > Terrain" sentinel — what the tool DID, exactly like the editor's first save —
    // was reported as a problem with the file. build_terrain now splits the two the same way.
    it('counts only real problems under ## Warnings, notes in their own section', async () => {
        const sentinel = {
            source: path.join(GOLDEN_DIR, 'default.terrain'),
            meta: path.join(MOCK_PROJECT, `${MOCK_TERRAIN}.meta`),
        };
        const informational = await ok({
            terrainPath: fresh('NotesOnly', sentinel).rel, ops: [{ op: 'adjust_heights', delta: 1 }],
        });
        assert.match(section(informational, 'Notes').bullets[0], /empty "Create > Terrain" sentinel/);
        assert.strictEqual(section(informational, 'Warnings'), null, informational);

        // both kinds at once: the same note, plus the missing .meta which IS a real problem
        const mixed = await ok({
            terrainPath: fresh('NotesAndWarning', { ...sentinel, meta: null }).rel,
            ops: [{ op: 'adjust_heights', delta: 1 }],
        });
        assert.match(section(mixed, 'Notes').bullets[0], /empty "Create > Terrain" sentinel/);
        const warnings = section(mixed, 'Warnings');
        assert.strictEqual(warnings.bullets.length, 1, mixed);
        assert.match(warnings.bullets[0], /has no \.meta/);
        const header = warningsHeader(mixed);
        assert.strictEqual(header.total, warnings.bullets.length, mixed);
        assert.strictEqual(header.split, 'all about the file', mixed);
    });

    it('warns that a .terrain without a .meta is not an addressable asset yet', async () => {
        const { rel, abs } = fresh('Orphan', { meta: null });
        assert.strictEqual(fs.existsSync(`${abs}.meta`), false);

        const report = await ok({ terrainPath: rel, ops: [{ op: 'set_heights', value: 6 }] });

        assert.match(report, /has no \.meta, so it is not an addressable asset yet/);
        assert.match(report, /create_asset_meta \{path: "assets\/Maps\/Orphan\.terrain"\}/);
        assert.match(report, /The edit itself was applied normally\./);
        // …and it really was applied, and no meta was invented
        assert.strictEqual(getVertexHeight(load(abs), 0, 0), 6);
        assert.strictEqual(fs.existsSync(`${abs}.meta`), false);
    });

    it('flags a freshly appended palette slot that nothing references yet', async () => {
        const { rel } = fresh('Unused');
        const report = await ok({
            terrainPath: rel, ops: [{ op: 'set_layer', slot: 2, detailMap: 'Sprites/panel.png' }],
        });
        assert.match(report, /palette slot 2 exists now but no block references it yet/);
        assert.match(report, /assign it with paint_layer/);

        // a paint_layer in the same batch silences it
        const painted = await ok({
            terrainPath: fresh('Used').rel,
            ops: [
                { op: 'set_layer', slot: 2, detailMap: 'Sprites/panel.png' },
                { op: 'paint_layer', layer: 2, weight: 0.5 },
            ],
        });
        assert.doesNotMatch(painted, /no block references it yet/);
    });

    // The hint is per OCCURRENCE. Rewriting the whole aggregated family (what matching its prose
    // amounts to) either claimed one dangling slot where there were several, or — when the batch
    // appended a slot the aggregate does not lead with — never mentioned the new one at all.
    it('annotates exactly the slots this batch appended and counts the rest truthfully', async () => {
        const both = await ok({
            terrainPath: fresh('TwoNew').rel,
            ops: [
                { op: 'set_layer', slot: 2, detailMap: 'Sprites/panel.png' },
                { op: 'set_layer', slot: 3, detailMap: 'Sprites/coin_bar.png' },
            ],
        });
        assert.match(both, /palette slot 2 exists now but no block references it yet/);
        assert.match(both, /palette slot 3 exists now but no block references it yet/);
        assert.doesNotMatch(both, /no block uses it/, 'both are this batch\'s doing');
        assert.match(both, /## Warnings \(2 — all for palette slots this batch appended\)/);

        // slots 2 and 3 are ALREADY dangling; this batch appends 4 only
        const { rel } = fresh('Inherited');
        await ok({
            terrainPath: rel,
            ops: [
                { op: 'set_layer', slot: 2, detailMap: 'Sprites/panel.png' },
                { op: 'set_layer', slot: 3, detailMap: 'Sprites/coin_bar.png' },
            ],
        });
        const report = await ok({
            terrainPath: rel, ops: [{ op: 'set_layer', slot: 4, detailMap: 'Sprites/panel.png' }],
        });
        assert.match(report, /palette slot 4 exists now but no block references it yet/);
        assert.doesNotMatch(report, /palette slot [23] exists now/);
        // the two it inherited are still reported, still as two, and the head is one of THEM
        assert.match(report, /layer slot 2 is defined but no block uses it … and 1 more occurrence \(2 total\)/);
        assert.match(report, /## Warnings \(2 — 1 about the file, 1 for palette slots this batch appended\)/);
    });

    // The elided count used to be pushed as another list element, so the header counted it as a
    // problem: 8 named out of 11 printed "## Warnings (9)".
    it('caps the warning list without counting the elision as a warning', async () => {
        const ops = [];
        for (let slot = 2; slot < 12; slot++) {
            ops.push({ op: 'set_layer', slot, detailMap: 'Sprites/panel.png' });
        }
        const report = await ok({ terrainPath: fresh('ManyUnused').rel, ops });

        const named = report.split('\n').filter((l) => /^- palette slot \d+ exists now/.test(l));
        assert.strictEqual(named.length, 8, `${named.length} named:\n${report}`);
        assert.match(
            report,
            /## Warnings \(10 — all for palette slots this batch appended\)/,
            '10 dangling slots, not 8 and not 9');
        assert.match(report, /^… and 2 more warnings \(10 total\)$/m);
    });

    // The hints used to be rendered in the place of the family they replace, i.e. BEFORE the
    // warnings terrainBin emits after it: appending 10 slots filled the 8-line cap with this
    // batch's own hints and pushed the file's zero-coverage layer into the elision — the section
    // hiding exactly what it exists for. The file's own warnings now come first.
    it('never lets the appended-slot hints push a genuine file warning past the cap', async () => {
        // painting slot 0 at full weight leaves slot 1 assigned in the block with no coverage
        // anywhere: a file warning terrainBin emits AFTER the unused-slot family
        const ops = [{ op: 'paint_layer', layer: 0, weight: 1 }];
        for (let slot = 2; slot < 12; slot++) {
            ops.push({ op: 'set_layer', slot, detailMap: 'Sprites/panel.png' });
        }
        const report = await ok({ terrainPath: fresh('CapOrder').rel, ops });

        const warnings = section(report, 'Warnings');
        assert.strictEqual(warningsHeader(report).total, 11, report);
        assert.strictEqual(warnings.bullets.length, 8, report);
        assert.match(warnings.bullets[0], /zero\s+weight coverage/, report);
        assert.strictEqual(
            warnings.bullets.filter((b) => /^palette slot \d+ exists now/.test(b)).length, 7, report);
        assert.match(report, /^… and 3 more warnings \(11 total\)$/m);
    });

    // For the SAME file state query_terrain's header counted warning ENTRIES ("1 — all in the
    // file") while this one counted LINES ("17") — two numbers for one file, because a file family
    // is one line whatever it covers while the appended-slot hints are one line per slot. The
    // header now names that composition, so its "about the file" part IS query_terrain's count.
    it('names what the warning header counts, so its parts add up to its total', async () => {
        const ops = [];
        for (let slot = 2; slot < 22; slot++) {
            ops.push({ op: 'set_layer', slot, detailMap: 'Sprites/panel.png' });
        }
        const report = await ok({ terrainPath: fresh('HeaderUnit').rel, ops });

        const header = warningsHeader(report);
        assert.strictEqual(header.total, 17, report);
        const parts = header.split.match(/^(\d+) about the file, (\d+) for palette slots this batch appended$/);
        assert.ok(parts, header.split);
        assert.strictEqual(Number(parts[1]) + Number(parts[2]), header.total, report);
        // 20 appended slots, 16 of them named per slot (the rest past the subject cap the file's
        // own family still counts) — and 16 is what the header's per-slot part claims
        assert.strictEqual(Number(parts[2]), 16, report);
        const warnings = section(report, 'Warnings');
        const perSlot = warnings.bullets.filter((b) => /^palette slot \d+ exists now/.test(b));
        assert.strictEqual(warnings.bullets.length - perSlot.length, Number(parts[1]), report);
        assert.match(warnings.bullets[0], /4 more "unusedLayer" occurrences past the 16 a card retains/);
        // …and the whole section still accounts for the header: bullets printed + elided
        const elided = report.match(/^… and (\d+) more warnings \((\d+) total\)$/m);
        assert.strictEqual(warnings.bullets.length + Number(elided[1]), header.total, report);
        assert.strictEqual(Number(elided[2]), header.total, report);
    });

    it('materializes the empty "Create > Terrain" sentinel and says so', async () => {
        const { rel, abs } = fresh('Empty', {
            source: path.join(GOLDEN_DIR, 'default.terrain'),
            meta: path.join(MOCK_PROJECT, `${MOCK_TERRAIN}.meta`),
        });
        assert.strictEqual(fs.statSync(abs).size, 2048);

        const report = await ok({ terrainPath: rel, ops: [{ op: 'adjust_heights', delta: 1 }] });

        const data = load(abs);
        assert.strictEqual(data.isDefaultSentinel, false);
        assert.deepStrictEqual(data.blockCount, [1, 1]);
        assert.strictEqual(data.weightMapSize, 128);
        assert.strictEqual(data.heights.length, 1089);
        assert.ok([...data.heights].every((h) => h === 32768 + 128), 'every vertex is 1 m');
        assert.strictEqual(fs.statSync(abs).size, 131072);
        assert.match(report, /empty "Create > Terrain" sentinel/);
        assert.match(report, /Height: 1 \.\. 1 m/);
        assert.match(report, /File: 131072 bytes \(67766 payload \+ 63306 zero padding\), V8/);
    });
});

describe('EditTerrain — the golden terrain stays byte-identical', () => {
    const golden = () => fresh('Golden', {
        source: path.join(GOLDEN_DIR, 'terrain.terrain'),
        meta: path.join(GOLDEN_DIR, 'terrain.terrain.meta'),
    });

    it('survives a no-op batch, all 131072 bytes including the padding', async () => {
        const { rel, abs, before } = golden();
        assert.strictEqual(before.length, 131072);

        const report = await ok({
            terrainPath: rel,
            ops: [{ op: 'set_info', tileSize: 1, blockCount: [1, 1], weightMapSize: 128, lightMapSize: 128 }],
        });

        assert.match(report, /nothing changed/);
        const after = fs.readFileSync(abs);
        assert.strictEqual(after.length, 131072);
        assert.ok(after.equals(before), 'a no-op batch must not change a single byte');
        assert.match(report, /File: 131072 bytes \(67922 payload \+ 63150 zero padding\), V8/);
    });

    it('survives a dryRun of a real edit untouched', async () => {
        const { rel, abs, before } = golden();
        const report = await ok({
            terrainPath: rel, dryRun: true,
            ops: [{ op: 'adjust_heights', delta: 5 }, { op: 'paint_layer', layer: 1, weight: 1 }],
        });
        assert.ok(fs.readFileSync(abs).equals(before));
        assert.match(report, /# DRY RUN/);
        // the card describes what WOULD be written
        assert.match(report, /Height: 3\.313 \.\. 7\.797 m/);
    });

    it('rewrites the same terrain byte-identically after a write-back of no change', async () => {
        // A batch that changes nothing semantically (setting the heights it already has)
        // must still reproduce the file exactly — proof that the writer round-trips the
        // editor's own bytes, padding and unsnapped tileSize included.
        const { rel, abs, before } = golden();
        await ok({ terrainPath: rel, ops: [{ op: 'adjust_heights', delta: 0 }] });
        assert.ok(fs.readFileSync(abs).equals(before));
    });
});
