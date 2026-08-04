/**
 * build_terrain tool tests (Phase T3)
 *
 * Every test runs against a throwaway copy of the mock project, so the tool's real write
 * sequence (mkdir → atomic binary write → .meta → parent-dir metas → AssetIndex.invalidate)
 * is exercised end to end. The tool is instantiated directly: registration in
 * `src/tools/index.js` lands with a later change.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { fileURLToPath } from 'url';

import { BuildTerrain } from '../../src/tools/BuildTerrain.js';
import { EditTerrain } from '../../src/tools/EditTerrain.js';
import { AssetIndex } from '../../src/core/AssetIndex.js';
import { readTerrain, readTerrainInfo } from '../../src/utils/terrainBin.js';
import { writeFileAtomic } from '../../src/utils/fsAtomic.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_PROJECT = path.resolve(__dirname, '../fixtures/mock-project');
const COIN_UUID = '35b97cf8-601e-4835-8a3e-0d29568af652';

describe('BuildTerrain tool', () => {
    const tool = new BuildTerrain();
    let root;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'build-terrain-'));
        // `test/tools/FindAssetReferences.test.js` writes and deletes
        // `assets/__refs_test.scene` inside this SHARED fixture, and node:test runs the
        // files in parallel — a recursive copy that enumerates the transient and then
        // lstats it after the delete fails with ENOENT. Skip it: nothing here needs it.
        fs.cpSync(MOCK_PROJECT, root, {
            recursive: true,
            filter: (src) => !path.basename(src).startsWith('__refs_test'),
        });
        AssetIndex.invalidate(root);
    });

    afterEach(() => {
        AssetIndex.invalidate(root);
        fs.rmSync(root, { recursive: true, force: true });
    });

    const build = (args) => tool.run(args, root);
    const text = (result) => result.content[0].text;

    it('should have correct metadata', () => {
        assert.strictEqual(tool.name, 'build_terrain');
        assert.deepStrictEqual(tool.inputSchema.required, ['outputPath', 'spec']);
        assert.strictEqual(tool.aliases.terrainPath, 'outputPath');
        assert.strictEqual(tool.aliases.path, 'outputPath');
        assert.match(tool.description, /set_asset_ref \{property: "asset"\}/);
    });

    it('writes a .terrain plus a .meta and reports the re-read card', async () => {
        const result = await build({
            outputPath: 'assets/Maps/Ground.terrain',
            spec: {
                blockCount: [2, 1],
                weightMapSize: 32,
                baseHeight: 1.5,
                layers: [{ detailMap: 'Sprites/coin_bar.png', tileSize: 4 }],
            },
        });
        assert.ok(!result.isError, text(result));

        const file = path.join(root, 'assets/Maps/Ground.terrain');
        const info = readTerrainInfo(file);
        assert.deepStrictEqual(info.blockCount, [2, 1]);
        assert.deepStrictEqual(info.size, [64, 32]);
        assert.strictEqual(info.weightMapSize, 32);
        assert.strictEqual(info.heightMin, 1.5);
        assert.strictEqual(info.layers[0].detailMapId, `${COIN_UUID}@6c48a`);
        assert.strictEqual(info.fileSize & (info.fileSize - 1), 0); // power-of-two padded

        const meta = JSON.parse(fs.readFileSync(`${file}.meta`, 'utf-8'));
        assert.strictEqual(meta.importer, 'terrain');
        assert.strictEqual(meta.ver, '1.1.50');
        assert.deepStrictEqual(meta.files, ['.bin', '.json']);
        assert.deepStrictEqual(meta.userData, {});

        const report = text(result);
        assert.match(report, /^# Built assets\/Maps\/Ground\.terrain/);
        assert.match(report, new RegExp(`UUID: ${meta.uuid} \\(new \\.meta written\\)`));
        assert.match(report, /Size: 64 x 32 m \(2 x 1 blocks, 65 x 33 vertices\)/);
        assert.match(report, /coin_bar\.png@6c48a \(tileSize 4 m/);
        assert.match(report, /used by 2 block\(s\)/);
        assert.match(report, /library\/ stays stale until then/);
        assert.match(report, /Terrain panel/);
        assert.match(report, /add_component cc\.TerrainCollider/);
    });

    it('leaves no temp file behind and makes the asset resolvable immediately', async () => {
        await build({ outputPath: 'assets/Maps/Ground.terrain', spec: {} });
        const dir = fs.readdirSync(path.join(root, 'assets/Maps'));
        assert.ok(!dir.some(n => n.includes('.tmp-')), dir.join(', '));

        const index = AssetIndex.shared(root);
        const resolved = index.resolve('assets/Maps/Ground.terrain');
        assert.ok(resolved, 'the fresh terrain must be in the (invalidated) asset index');
        assert.strictEqual(resolved.entry.importer, 'terrain');
    });

    it('creates parent folder metas for a new directory', async () => {
        const result = await build({ outputPath: 'assets/World/Terrains/A.terrain', spec: {} });
        assert.ok(!result.isError, text(result));
        assert.ok(fs.existsSync(path.join(root, 'assets/World.meta')));
        assert.ok(fs.existsSync(path.join(root, 'assets/World/Terrains.meta')));
    });

    it('refuses to overwrite without the flag, and keeps the UUID with it', async () => {
        const existing = path.join(root, 'assets/Maps/Terrain.terrain');
        const before = fs.readFileSync(existing);
        const uuid = JSON.parse(fs.readFileSync(`${existing}.meta`, 'utf-8')).uuid;

        const refused = await build({ outputPath: 'assets/Maps/Terrain.terrain', spec: {} });
        assert.ok(refused.isError);
        assert.match(text(refused), /already exists — pass overwrite: true/);
        assert.ok(fs.readFileSync(existing).equals(before), 'the file must be untouched');

        const done = await build({
            outputPath: 'assets/Maps/Terrain.terrain', spec: { baseHeight: 3 }, overwrite: true,
        });
        assert.ok(!done.isError, text(done));
        assert.match(text(done), new RegExp(`UUID: ${uuid} \\(existing \\.meta kept\\)`));
        assert.strictEqual(
            JSON.parse(fs.readFileSync(`${existing}.meta`, 'utf-8')).uuid, uuid,
            'the meta (and therefore every scene reference) must survive');
        assert.strictEqual(readTerrainInfo(existing).heightMin, 3);
        assert.ok(!fs.readFileSync(existing).equals(before));
    });

    it('aborts with nothing written when the existing meta is corrupt', async () => {
        const existing = path.join(root, 'assets/Maps/Terrain.terrain');
        const before = fs.readFileSync(existing);
        fs.writeFileSync(`${existing}.meta`, '{ this is not json');

        const result = await build({
            outputPath: 'assets/Maps/Terrain.terrain', spec: { baseHeight: 9 }, overwrite: true,
        });
        assert.ok(result.isError);
        assert.match(text(result), /Cannot parse existing assets\/Maps\/Terrain\.terrain\.meta/);
        assert.match(text(result), /Nothing was written\.$/);
        assert.ok(fs.readFileSync(existing).equals(before), 'the binary must be untouched');
    });

    it('rejects a bad output path', async () => {
        for (const [outputPath, re] of [
            ['assets/Maps/Ground.bin', /must end with \.terrain/],
            ['Maps/Ground.terrain', /inside the project's assets\/ directory/],
            ['../escape.terrain', /must end with \.terrain|assets\/ directory/],
        ]) {
            const result = await build({ outputPath, spec: {} });
            assert.ok(result.isError, outputPath);
            assert.match(text(result), re);
        }
        assert.ok(!fs.existsSync(path.join(root, 'assets/Maps/Ground.bin')));

        // a parent path that is a FILE must not escape as a raw ENOTDIR/EEXIST
        const nested = await build({ outputPath: 'assets/Maps/Terrain.terrain/x.terrain', spec: {} });
        assert.ok(nested.isError);
        assert.match(text(nested), /exists but is not a directory/);
    });

    it('refuses a symlink under assets/ that escapes the project', async () => {
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
        try {
            fs.symlinkSync(outside, path.join(root, 'assets', 'Linked'));
            const result = await build({ outputPath: 'assets/Linked/Evil.terrain', spec: {} });
            assert.ok(result.isError, text(result));
            assert.match(text(result), /inside the project's assets\/ directory/);
            assert.deepStrictEqual(fs.readdirSync(outside), []);
        } finally {
            fs.rmSync(outside, { recursive: true, force: true });
        }
    });

    it('writes nothing when the spec is invalid', async () => {
        for (const spec of [
            { layers: [{ detailMap: 'Sprites/nope.png' }] },
            { weightMapSize: 100 },
            { blockCount: [0, 1] },
            { heightmap: { rows: [[1, 2], [3]] } },
            { nonsense: true },
        ]) {
            const result = await build({ outputPath: 'assets/Maps/Ground.terrain', spec });
            assert.ok(result.isError, JSON.stringify(spec));
            assert.match(text(result), /Nothing was written\.$/);
            assert.ok(!fs.existsSync(path.join(root, 'assets/Maps/Ground.terrain')));
            assert.ok(!fs.existsSync(path.join(root, 'assets/Maps/Ground.terrain.meta')));
        }
    });

    it('validates its arguments before touching the project', async () => {
        const missing = await build({ spec: {} });
        assert.ok(missing.isError);
        assert.match(text(missing), /outputPath/);
        const unknown = await build({ outputPath: 'assets/Maps/G.terrain', spec: {}, force: true });
        assert.ok(unknown.isError);
        assert.match(text(unknown), /force/);
    });

    it('builds from a PNG heightmap living in the project', async () => {
        const png = grayPng(32, 32, Uint8Array.from({ length: 32 * 32 }, (_, k) => (k % 32) * 8));
        fs.writeFileSync(path.join(root, 'assets', 'Maps', 'h.png'), png);
        const result = await build({
            outputPath: 'assets/Maps/Hills.terrain',
            spec: { heightmap: { source: 'Maps/h.png', min: 0, max: 25.5 } },
        });
        assert.ok(!result.isError, text(result));
        const info = readTerrainInfo(path.join(root, 'assets/Maps/Hills.terrain'));
        assert.strictEqual(info.heightMin, 0);
        assert.strictEqual(Math.round(info.heightMax * 100) / 100, 24.8);
        assert.strictEqual(info.isFlat, false);
    });

    it('round-trips the compiled data through the file it wrote', async () => {
        await build({
            outputPath: 'assets/Maps/Ground.terrain',
            spec: {
                blockCount: [1, 2], tileSize: 2, weightMapSize: 8, lightMapSize: 64,
                layers: [
                    { detailMap: 'Sprites/coin_bar.png', roughness: 0.5 },
                    { detailMap: 'Sprites/panel.png', tileSize: 3, metallic: 1 },
                ],
                fillLayer: 1,
            },
        });
        const data = readTerrain(fs.readFileSync(path.join(root, 'assets/Maps/Ground.terrain')));
        assert.deepStrictEqual(data.blockCount, [1, 2]);
        assert.strictEqual(data.tileSize, 2);
        assert.strictEqual(data.lightMapSize, 64);
        assert.strictEqual(data.layers.length, 2);
        assert.strictEqual(data.layers[1].tileSize, 3);
        assert.strictEqual(data.layers[1].metallic, 1);
        assert.strictEqual(data.layers[0].roughness, 0.5);
        assert.deepStrictEqual([...data.layerBuffer], [1, -1, -1, -1, 1, -1, -1, -1]);
    });

    // --- review regressions ------------------------------------------------

    // An existing .meta that parses but carries no "uuid" used to yield
    // `uuid === undefined`, print "UUID: undefined (existing .meta kept)" and land a
    // binary next to a meta the importer cannot honour.
    it('refuses an existing .meta with no uuid, writing nothing', async () => {
        const metaPath = path.join(root, 'assets/Maps/NoUuid.terrain.meta');
        fs.writeFileSync(metaPath, JSON.stringify({ ver: '1.1.50', importer: 'terrain' }));
        const result = await build({
            outputPath: 'assets/Maps/NoUuid.terrain', spec: {}, overwrite: true,
        });
        assert.strictEqual(result.isError, true);
        assert.match(text(result), /has no "uuid"/);
        assert.match(text(result), /Nothing was written\./);
        assert.ok(!text(result).includes('undefined'));
        assert.strictEqual(fs.existsSync(path.join(root, 'assets/Maps/NoUuid.terrain')), false);
        // the unusable meta is left exactly as found, for the user to delete or fix
        assert.strictEqual(fs.readFileSync(metaPath, 'utf-8'),
            JSON.stringify({ ver: '1.1.50', importer: 'terrain' }));
    });

    // The binary used to land before the .meta write, so a failing meta write left an
    // orphan .terrain with no meta and no report.
    it('removes the binary when the .meta write fails', async () => {
        fs.mkdirSync(path.join(root, 'assets/Locked'));
        // Trigger: the ".meta" companion blows the 255-BYTE filename limit while the binary fits
        // (254 vs 259), so the binary lands and the meta write is the step that throws.
        const name = `${'x'.repeat(246)}.terrain`;
        assert.strictEqual(name.length, 254);

        const result = await build({ outputPath: `assets/Locked/${name}`, spec: {} });
        assert.strictEqual(result.isError, true);
        assert.match(text(result), /Cannot write assets\/Locked\//);
        assert.match(text(result), /Nothing was written\./);
        assert.strictEqual(fs.existsSync(path.join(root, 'assets/Locked', name)), false);
        assert.deepStrictEqual(fs.readdirSync(path.join(root, 'assets/Locked')), []);
    });

    // A plain writeFileSync FOLLOWS a symlink, so a symlinked `<asset>.meta` took the meta out of
    // the project (verified); temp+rename replaces the link instead.
    it('replaces a symlinked .meta path instead of writing through it', async () => {
        const outside = path.join(root, '..', 'escape-target');
        fs.mkdirSync(outside, { recursive: true });
        fs.mkdirSync(path.join(root, 'assets/Sym'));
        const metaPath = path.join(root, 'assets/Sym/S.terrain.meta');
        // existsSync is false (dangling), so a fresh meta is minted for this path
        fs.symlinkSync(path.join(outside, 'escaped.meta'), metaPath);

        const result = await build({ outputPath: 'assets/Sym/S.terrain', spec: {} });
        assert.strictEqual(result.isError, undefined);
        assert.strictEqual(fs.existsSync(path.join(outside, 'escaped.meta')), false,
            'the .meta must not be written outside the project through the link');
        assert.strictEqual(fs.lstatSync(metaPath).isSymbolicLink(), false, 'the link is replaced');
        assert.strictEqual(JSON.parse(fs.readFileSync(metaPath, 'utf-8')).importer, 'terrain');
    });

    // mkdirSync ran before the write, so a failing write left freshly created,
    // meta-less folders behind in assets/ for the editor's asset-db to find.
    it('removes freshly created directories when the write fails', async () => {
        // Failure trigger: a basename over the 255-character filesystem limit, so the
        // TARGET itself is unwritable (writeFileAtomic middle-truncates its own temp name,
        // which is why a merely long-but-legal 240-char name now writes fine).
        const longName = `${'x'.repeat(250)}.terrain`;
        const result = await build({
            outputPath: `assets/Fresh/Nested/${longName}`, spec: {},
        });
        assert.strictEqual(result.isError, true);
        assert.match(text(result), /Nothing was written\./);
        assert.strictEqual(fs.existsSync(path.join(root, 'assets/Fresh')), false);
        assert.strictEqual(fs.existsSync(path.join(root, 'assets/Fresh.meta')), false);
    });

    // The rollback must never unlink a file it did not create: on an overwrite the
    // existing .meta is reused, so the binary on disk is the user's own data.
    it('leaves the victim alone when an overwrite write fails', async () => {
        const victim = path.join(root, 'assets/Maps/Terrain.terrain');
        const before = fs.readFileSync(victim);
        const dir = path.join(root, 'assets/Maps');
        fs.chmodSync(dir, 0o555); // no new temp file may be created here
        try {
            const result = await build({
                outputPath: 'assets/Maps/Terrain.terrain', spec: { baseHeight: 7 }, overwrite: true,
            });
            assert.strictEqual(result.isError, true);
            assert.match(text(result), /Cannot write assets\/Maps\/Terrain\.terrain/);
            // writeFileAtomic failed BEFORE the rename, so the promise really does hold
            assert.match(text(result), /Nothing was written\./);
            assert.ok(!text(result).includes('WARNING'));
        } finally {
            fs.chmodSync(dir, 0o755);
        }
        assert.deepStrictEqual(fs.readFileSync(victim), before);
        assert.strictEqual(fs.existsSync(`${victim}.meta`), true);
        // no stray temp file from the aborted atomic write
        assert.deepStrictEqual(fs.readdirSync(dir).filter(f => f.includes('.tmp-')), []);
    });

    // An overwrite is the one step that cannot be undone. Reporting "left untouched" after the
    // rename told the agent the asset was intact while the user's heights were already gone.
    it('reports the overwrite honestly when a step AFTER the rename fails', async () => {
        const victim = path.join(root, 'assets/Maps/Terrain.terrain');
        const before = fs.readFileSync(victim);
        // Last step in the try block is the folder metas: assets/ read-only (so assets/Maps.meta
        // cannot be created) while assets/Maps stays writable, so the binary lands and that throws.
        fs.rmSync(path.join(root, 'assets/Maps.meta'));
        fs.chmodSync(path.join(root, 'assets'), 0o555);
        let result;
        try {
            result = await build({
                outputPath: 'assets/Maps/Terrain.terrain', spec: { baseHeight: 7 }, overwrite: true,
            });
        } finally {
            fs.chmodSync(path.join(root, 'assets'), 0o755);
        }
        assert.strictEqual(result.isError, true);
        assert.match(text(result), /WARNING: assets\/Maps\/Terrain\.terrain had ALREADY been replaced/);
        assert.match(text(result), /previous heights, layers and weights are gone/);
        assert.ok(!text(result).includes('Nothing was written.'));
        assert.ok(!text(result).includes('left untouched'));
        // the report is truthful: the bytes really did change
        assert.notDeepEqual(fs.readFileSync(victim), before);
    });

    // The undo entry for a folder meta used to be `fs.unlinkSync(<parsed meta object>)`, which
    // threw ERR_INVALID_ARG_TYPE into the swallowing catch — the rollback was inert. And the
    // entries were only registered after ensureParentDirMetas returned in full, so a failure
    // part-way up the chain orphaned the metas it had already written.
    it('rolls back folder metas written before a later failure', async () => {
        // assets/Deep/<252 chars>/x.terrain: both dirs are created (252 < 255) and
        // assets/Deep.meta is written, then the inner folder's own ".meta" name needs 257 bytes
        // and blows the 255-byte filename limit — a failure part-way up the chain.
        const longDir = 'y'.repeat(252);
        const result = await build({
            outputPath: `assets/Deep/${longDir}/x.terrain`, spec: {},
        });
        assert.strictEqual(result.isError, true);
        assert.match(text(result), /Nothing was written\./);
        assert.strictEqual(fs.existsSync(path.join(root, 'assets/Deep')), false);
        assert.strictEqual(fs.existsSync(path.join(root, 'assets/Deep.meta')), false,
            'the folder meta written before the failure must not be orphaned');
    });

    // A leftover .meta with no binary reuses the uuid, so `newMeta` is null there — using it as
    // a proxy for "the binary pre-existed" left the freshly created .terrain on disk.
    it('removes a binary it created next to a reused .meta', async () => {
        const dir = path.join(root, 'assets/Orphan');
        fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, 'Ghost.terrain.meta'),
            JSON.stringify({ ver: '1.1.50', importer: 'terrain', uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }));
        // make the folder meta write fail, i.e. a failure after the binary landed
        fs.chmodSync(path.join(root, 'assets'), 0o555);
        let result;
        try {
            result = await build({ outputPath: 'assets/Orphan/Ghost.terrain', spec: {} });
        } finally {
            fs.chmodSync(path.join(root, 'assets'), 0o755);
        }
        assert.strictEqual(result.isError, true);
        assert.match(text(result), /Nothing was written\./);
        assert.strictEqual(fs.existsSync(path.join(dir, 'Ghost.terrain')), false,
            'the binary this call created must be unlinked even though the .meta was reused');
    });

    // blockCount x weightMapSize is the one knob that silently costs tens of MB.
    it('flags a large asset in the card with the cheaper weightMapSize', async () => {
        const result = await build({
            outputPath: 'assets/Maps/Big.terrain', spec: { blockCount: [16, 16] },
        });
        assert.notStrictEqual(result.isError, true);
        const card = text(result);
        assert.match(card, /Large asset: 32\.0 MB/);
        assert.match(card, /pow-2 padding/);
        assert.match(card, /weightMapSize 32 would need about/);
        // and the description warns BEFORE the call
        assert.match(tool.description, /blockCount\[0\]\*blockCount\[1\]\*weightMapSize\^2\*4 bytes/);
        assert.match(tool.description, /use weightMapSize 32 or 64 for large maps/);
    });

    // build_terrain and edit_terrain rendered near-identical PRIVATE copies of the same
    // readTerrainInfo card, already diverged in number formatting, per-layer detail and the
    // "no layers" wording — so building a terrain and then editing nothing described the
    // very same bytes two different ways.
    it('prints the same card as edit_terrain over the same bytes', async () => {
        await build({
            outputPath: 'assets/Maps/Shared.terrain',
            spec: {
                blockCount: [2, 1], tileSize: 2, weightMapSize: 16, baseHeight: 1.25,
                layers: [
                    { detailMap: 'Sprites/coin_bar.png', tileSize: 3, roughness: 0.5 },
                    { detailMap: 'Sprites/panel.png', metallic: 0.25 },
                ],
                fillLayer: 0,
            },
        });
        const built = fs.readFileSync(path.join(root, 'assets/Maps/Shared.terrain'));

        // set_info with the terrain's own numbers is the documented no-op batch
        const edited = await new EditTerrain().run({
            terrainPath: 'assets/Maps/Shared.terrain',
            ops: [{ op: 'set_info', tileSize: 2, blockCount: [2, 1], weightMapSize: 16 }],
        }, root);
        assert.ok(!edited.isError, text(edited));
        assert.ok(fs.readFileSync(path.join(root, 'assets/Maps/Shared.terrain')).equals(built),
            'the edit must be a no-op, else the two cards describe different bytes');

        const card = cardOf(text(edited));
        assert.strictEqual(cardOf(await buildText('assets/Maps/Shared.terrain')), card);
        // and the card really carries the union of what the two copies used to print
        assert.match(card, /Size: 128 x 64 m \(2 x 1 blocks, 65 x 33 vertices\)/);
        assert.match(card, /tileSize: 2 m \| weightMapSize: 16 \(32 x 16 texels\)/);
        assert.match(card, /0\. coin_bar\.png@6c48a \(tileSize 3 m, roughness 0\.5, metallic 0\) — used by 2 block\(s\), coverage 100\.0%/);
        assert.match(card, /Block slots: \[0,-1,-1,-1\] \[0,-1,-1,-1\]/);
        assert.match(card, /2 block\(s\) assign only channel R/);
    });

    /** The report of a rebuild over the same path, for a card-to-card comparison */
    async function buildText(outputPath) {
        const result = await build({
            outputPath,
            spec: {
                blockCount: [2, 1], tileSize: 2, weightMapSize: 16, baseHeight: 1.25,
                layers: [
                    { detailMap: 'Sprites/coin_bar.png', tileSize: 3, roughness: 0.5 },
                    { detailMap: 'Sprites/panel.png', metallic: 0.25 },
                ],
                fillLayer: 0,
            },
            overwrite: true,
        });
        assert.ok(!result.isError, text(result));
        return text(result);
    }

    it('keeps a small terrain free of the size note', async () => {
        const result = await build({ outputPath: 'assets/Maps/Small.terrain', spec: {} });
        assert.doesNotMatch(text(result), /Large asset/);
    });

    // One fact used to produce N+1 warnings, and an explicit fillLayer was echoed back
    // under "## Warnings" as if the caller's own argument were a problem.
    it('reports fillLayer exactly once', async () => {
        const off = await build({
            outputPath: 'assets/Maps/Off.terrain',
            spec: { layers: [{ detailMap: 'Sprites/coin_bar.png' }], fillLayer: -1 },
        });
        const offText = text(off);
        assert.match(offText, /fillLayer is off/);
        assert.doesNotMatch(offText, /layer slot 0 is defined but no block uses it/);
        assert.doesNotMatch(offText, /edit_terrain/);

        const explicit = await build({
            outputPath: 'assets/Maps/On.terrain',
            spec: { layers: [{ detailMap: 'Sprites/coin_bar.png' }], fillLayer: 0 },
        });
        assert.doesNotMatch(text(explicit), /every block is painted/);
        // the card still says which blocks use the layer
        assert.match(text(explicit), /used by 1 block\(s\)/);
    });

    it('speaks of depth, not height, for the Z axis and gives the metre formula', () => {
        assert.match(tool.description, /x = width, z = depth, heights are Y in metres/);
        assert.match(tool.description, /blockCount \* 32 \* tileSize/);
        assert.match(tool.description, /tileSize\?: 1 \(metres per tile\)/);
        assert.match(tool.description, /weightMapSize\?: 128 \(texels per block side/);
        assert.match(tool.description, /metres per\s*texture repeat/);
    });
});

describe('writeFileAtomic', () => {
    let dir;

    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-')); });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('writes buffers and strings, replacing existing content', () => {
        const target = path.join(dir, 'a.bin');
        writeFileAtomic(target, Buffer.from([1, 2, 3]));
        assert.deepStrictEqual([...fs.readFileSync(target)], [1, 2, 3]);
        writeFileAtomic(target, 'text');
        assert.strictEqual(fs.readFileSync(target, 'utf-8'), 'text');
        assert.deepStrictEqual(fs.readdirSync(dir), ['a.bin']);
    });

    it('removes the temp file when the rename fails', () => {
        const target = path.join(dir, 'busy');
        fs.mkdirSync(target); // renaming a file onto a directory fails
        assert.throws(() => writeFileAtomic(target, Buffer.from([1])));
        assert.deepStrictEqual(fs.readdirSync(dir), ['busy']);
    });

    it('rejects bad arguments', () => {
        assert.throws(() => writeFileAtomic('', Buffer.alloc(1)), /non-empty string/);
        assert.throws(() => writeFileAtomic(path.join(dir, 'x'), { a: 1 }), /Buffer, a TypedArray or a string/);
    });
});

// --- helpers -----------------------------------------------------------------

/** The `## Terrain` block of a report: contiguous lines up to the next blank one */
function cardOf(report) {
    const lines = report.split('\n');
    const start = lines.indexOf('## Terrain');
    assert.notStrictEqual(start, -1, `no card in:\n${report}`);
    const end = lines.indexOf('', start);
    return lines.slice(start, end === -1 ? undefined : end).join('\n');
}

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
