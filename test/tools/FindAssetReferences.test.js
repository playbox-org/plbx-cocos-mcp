/**
 * FindAssetReferences + builtins table tests (Phase 5)
 *
 * The mock project's golden scene references both project assets
 * (Gold.prefab etc. via instances) and engine builtins (primitives,
 * default UI sprites) — reverse lookup must attribute scene/prefab hits
 * to node ▸ component .property and classify unknown UUIDs.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { FindAssetReferences } from '../../src/tools/FindAssetReferences.js';
import { GetAssetInfo } from '../../src/tools/GetAssetInfo.js';
import { resolveBuiltin, builtinLabel, isBuiltin } from '../../src/core/builtins.js';
import { AssetIndex } from '../../src/core/AssetIndex.js';
import { Validator } from '../../src/document/Validator.js';
import { SceneDocument } from '../../src/document/SceneDocument.js';
import { readTerrain, writeTerrain, materialize } from '../../src/utils/terrainBin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_PROJECT = path.join(__dirname, '..', 'fixtures', 'mock-project');
const GOLDEN_SCENE = path.join(__dirname, '..', 'fixtures', 'golden', 'Main.scene_V2.scene');

const PRIMITIVES_UUID = '1263d74c-8167-4928-91a6-4e2672411f47';
const GOLD_UUID = '836478c3-ffde-4110-8347-cfda26288652'; // Prefabs/Gold.prefab

const tool = new FindAssetReferences();

describe('builtins table', () => {
    test('resolves the primitives fbx and its sub-meshes', () => {
        const hit = resolveBuiltin(PRIMITIVES_UUID);
        assert.strictEqual(hit.entry.path, 'primitives.fbx');
        assert.strictEqual(hit.engine, '3.8.7');

        const sub = resolveBuiltin(`${PRIMITIVES_UUID}@fc873`);
        assert.strictEqual(sub.subAsset.name, 'quad.mesh');
        assert.strictEqual(builtinLabel(`${PRIMITIVES_UUID}@fc873`), 'builtin:quad.mesh');
        assert.ok(isBuiltin(PRIMITIVES_UUID));
        assert.ok(!isBuiltin('00000000-0000-0000-0000-000000000000'));
    });

    test('AssetIndex.label falls back to builtin labels', () => {
        const index = new AssetIndex(MOCK_PROJECT);
        assert.strictEqual(index.label(`${PRIMITIVES_UUID}@fc873`), 'builtin:quad.mesh');
        assert.strictEqual(index.label('00000000-0000-0000-0000-000000000000'), null);
    });

    test('get_asset_info returns an engine built-in card, not "not found"', async () => {
        const result = await new GetAssetInfo().execute(
            { asset: PRIMITIVES_UUID }, MOCK_PROJECT);
        const text = result.content[0].text;
        assert.ok(!result.isError, text);
        assert.match(text, /Engine built-in: db:\/\/internal\/primitives\.fbx/);
        assert.match(text, /sphere\.mesh/);
    });

    test('validator no longer reports known builtins as missing', () => {
        const doc = SceneDocument.load(GOLDEN_SCENE);
        const { warnings } = new Validator(doc, new AssetIndex(MOCK_PROJECT)).validate();
        const missing = warnings.find(w => /not found under assets/.test(w));
        assert.ok(missing, 'the golden scene does reference assets outside the mock project');
        assert.ok(!missing.includes(PRIMITIVES_UUID),
            'builtin uuids must not appear in the missing-assets warning');
        assert.match(missing, /not in the 3\.8 engine built-in table/);
    });
});

describe('find_asset_references', () => {
    /**
     * The golden scene lives outside assets/, so the scan needs a copy INSIDE it. That copy goes
     * into a throwaway project, never into the shared fixture: other test files (GetAssetInfo,
     * LintAssets, …) `cpSync` `mock-project` concurrently, and a file appearing and vanishing
     * mid-copy makes their `cpSync` fail with ENOENT — a real, reproducible cross-file flake.
     * @returns {string} project root containing assets/__refs_test.scene
     */
    function projectWithScene(t) {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-refs-scene-'));
        t.after(() => {
            AssetIndex.invalidate(root);
            fs.rmSync(root, { recursive: true, force: true });
        });
        fs.cpSync(MOCK_PROJECT, root, { recursive: true });
        fs.copyFileSync(GOLDEN_SCENE, path.join(root, 'assets', '__refs_test.scene'));
        return root;
    }

    test('project asset: file → node ▸ component .property attribution', async (t) => {
        const root = projectWithScene(t);

        const result = await tool.execute({ asset: 'Prefabs/Gold.prefab' }, root);
        const text = result.content[0].text;
        assert.ok(!result.isError, text);
        assert.match(text, /Asset: project file "assets\/Prefabs\/Gold\.prefab"/);
        // The golden scene instantiates Gold.prefab → PrefabInfo.asset refs
        assert.match(text, /## assets\/__refs_test\.scene \(\d+\)/);
        assert.match(text, /_prefab\.asset|asset/);
    });

    test('builtin uuid: classified as engine built-in with references listed', async (t) => {
        const root = projectWithScene(t);

        const result = await tool.execute({ asset: PRIMITIVES_UUID }, root);
        const text = result.content[0].text;
        assert.match(text, /engine built-in db:\/\/internal\/primitives\.fbx/);
        assert.match(text, /▸ cc\.MeshRenderer \._mesh/);
    });

    test('unknown uuid: flagged as likely broken', async () => {
        const result = await tool.execute(
            { asset: '99999999-9999-9999-9999-999999999999' }, MOCK_PROJECT);
        const text = result.content[0].text;
        assert.match(text, /NOT a project asset and NOT an engine built-in/);
        assert.match(text, /No references/);
    });

    test('non-uuid garbage is rejected with guidance', async () => {
        const result = await tool.execute({ asset: 'certainly/not/an/asset.xyz' }, MOCK_PROJECT);
        assert.ok(result.isError);
        assert.match(result.content[0].text, /not UUID-shaped/);
    });

    test('script asset: references found via compressed __type__, not __uuid__', async (t) => {
        const root = projectWithScene(t);

        const result = await tool.execute({ asset: 'Scripts/PlayerController.ts' }, root);
        const text = result.content[0].text;
        assert.ok(!result.isError, text);
        // A script is referenced as a component's __type__ (compressed uuid) —
        // must be found and attributed, never reported as unused.
        assert.ok(!/No references — the asset is unused/.test(text),
            'script attached to nodes must not report as unused');
        assert.match(text, /## assets\/__refs_test\.scene \(\d+\)/);
        assert.match(text, /PlayerController.*\(attached component\)/);
    });

    test('folder outside the project is rejected (no prefix-sharing escape)', async () => {
        const result = await tool.execute(
            { asset: PRIMITIVES_UUID, folder: '../mock-project-sibling' }, MOCK_PROJECT);
        assert.ok(result.isError);
        assert.match(result.content[0].text, /Folder not found/);
    });

    test('terrain layer texture: structural hit naming the layer and the map', async () => {
        // Maps/Terrain.terrain layer 0 = Sprites/coin_bar.png@6c48a, layer 1 = panel.png@6c48a.
        // A bare image target must still match the "<uuid>@6c48a" texture sub-asset id.
        const result = await tool.execute({ asset: 'Sprites/coin_bar.png' }, MOCK_PROJECT);
        const text = result.content[0].text;
        assert.ok(!result.isError, text);
        assert.match(text, /## assets\/Maps\/Terrain\.terrain \(1\)/);
        assert.match(text, /- terrain layer 0 \.detailMap \[sub-asset @6c48a\]/);
        // the count and the file count include the binary hit
        assert.match(text, /Found 1 reference\(s\) in 1 file\(s\)/);
    });

    test('terrain hit found for the exact sub-asset target too', async () => {
        const result = await tool.execute(
            { asset: '11112222-3333-4444-8555-666677778888@6c48a' }, MOCK_PROJECT);
        const text = result.content[0].text;
        // exact-match target: no "[sub-asset …]" suffix, since the id IS the needle
        assert.match(text, /- terrain layer 1 \.detailMap$/m);
    });

    test('an unreferenced uuid gets no terrain hit (no byte-coincidence counting)', async () => {
        const result = await tool.execute(
            { asset: '99999999-9999-9999-9999-999999999999' }, MOCK_PROJECT);
        const text = result.content[0].text;
        assert.ok(!text.includes('Terrain.terrain'), text);
        assert.match(text, /No references/);
    });

    test('a script target skips the binary pass entirely', async () => {
        // A script is referenced only as a component __type__, which no binary can
        // hold — the terrain is not scanned at all, so the scanned count drops by one.
        const withImage = await tool.execute({ asset: 'Sprites/coin_bar.png' }, MOCK_PROJECT);
        const withScript = await tool.execute({ asset: 'Scripts/PlayerController.ts' }, MOCK_PROJECT);
        const scanned = (text) => Number(text.match(/scanned (\d+) serialized/)[1]);
        assert.strictEqual(scanned(withImage.content[0].text),
            scanned(withScript.content[0].text) + 1);
    });

    test('a dangling terrain layer uuid is still located and flagged as broken', async (t) => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-refs-terrain-'));
        t.after(() => fs.rmSync(root, { recursive: true, force: true }));
        fs.cpSync(MOCK_PROJECT, root, { recursive: true });
        const file = path.join(root, 'assets/Maps/Terrain.terrain');
        const data = readTerrain(fs.readFileSync(file));
        data.layers[0].detailMapId = 'deadbeef-1111-4222-8333-444455556666@6c48a';
        fs.writeFileSync(file, writeTerrain(data));

        // Bare uuid target (no @subId): the sub-asset-tolerant predicate must still hit
        const result = await tool.execute(
            { asset: 'deadbeef-1111-4222-8333-444455556666' }, root);
        const text = result.content[0].text;
        assert.match(text, /NOT a project asset and NOT an engine built-in/);
        assert.match(text, /## assets\/Maps\/Terrain\.terrain \(1\)/);
        assert.match(text, /- terrain layer 0 \.detailMap \[sub-asset @6c48a\]/);
        assert.ok(!/No references/.test(text), text);
    });

    test('the terrain pass parses the layer palette only, never the payload', async (t) => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-refs-payload-'));
        t.after(() => {
            AssetIndex.invalidate(root);
            fs.rmSync(root, { recursive: true, force: true });
        });
        fs.mkdirSync(path.join(root, 'assets'));
        const uuid = 'deadbeef-1111-4222-8333-444455556666';
        const data = materialize({
            blockCount: [1, 1], tileSize: 1, weightMapSize: 128, lightMapSize: 128,
            layers: [{ slot: 0, tileSize: 1, detailMapId: `${uuid}@6c48a`, normalMapId: '', roughness: 1, metallic: 0 }],
        });
        fs.writeFileSync(path.join(root, 'assets', 'Big.terrain'), writeTerrain(data));

        // The heights/weights copies are the only big typed arrays a full parse makes.
        const real = [Uint8Array, Uint16Array, Int16Array, Float32Array];
        let biggest = 0;
        for (const T of real) {
            globalThis[T.name] = new Proxy(T, {
                construct: (target, args) => {
                    if (typeof args[0] === 'number') biggest = Math.max(biggest, args[0]);
                    return Reflect.construct(target, args);
                }
            });
        }
        let text;
        try {
            text = (await tool.execute({ asset: uuid }, root)).content[0].text;
        } finally {
            for (const T of real) globalThis[T.name] = T;
        }

        // attribution is unchanged by reading the layout only
        assert.match(text, /## assets\/Big\.terrain \(1\)/);
        assert.match(text, /- terrain layer 0 \.detailMap \[sub-asset @6c48a\]/);
        assert.ok(biggest < 1024, `allocated a ${biggest}-element array — the ` +
            `${data.weights.length}-byte payload is being decoded`);
    });

    test('an unsearchable .terrain is reported as skipped, never counted as scanned', async (t) => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-refs-broken-'));
        t.after(() => {
            AssetIndex.invalidate(root);
            fs.rmSync(root, { recursive: true, force: true });
        });
        fs.mkdirSync(path.join(root, 'assets'));
        const uuid = 'deadbeef-1111-4222-8333-444455556666';
        const data = materialize({
            blockCount: [1, 1], tileSize: 1, weightMapSize: 128, lightMapSize: 128,
            layers: [{ slot: 0, tileSize: 1, detailMapId: `${uuid}@6c48a`, normalMapId: '', roughness: 1, metallic: 0 }],
        });
        const bytes = writeTerrain(data);
        fs.writeFileSync(path.join(root, 'assets', 'Good.terrain'), bytes);
        fs.writeFileSync(path.join(root, 'assets', 'Truncated.terrain'), bytes.subarray(0, 40));
        fs.writeFileSync(path.join(root, 'assets', 'Alien.terrain'), Buffer.from('not a terrain at all'));

        const text = (await tool.execute({ asset: uuid }, root)).content[0].text;
        // exactly one file was searched; the two that could not be parsed are named instead
        assert.match(text, /scanned 1 serialized asset files, 2 skipped\)/);
        assert.match(text, /## Skipped — not searched \(2\)/);
        assert.match(text, /LOWER bound/);
        assert.match(text, /- assets\/Truncated\.terrain: unreadable \.terrain binary — terrain: /);
        assert.match(text, /- assets\/Alien\.terrain: not a recognized \.terrain \(unknown version magic\)/);
        // the readable one still answers
        assert.match(text, /Found 1 reference\(s\) in 1 file\(s\)/);
        assert.match(text, /## assets\/Good\.terrain \(1\)/);
    });

    test('an all-unreadable scan does not claim the asset is unused', async (t) => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-refs-blind-'));
        t.after(() => {
            AssetIndex.invalidate(root);
            fs.rmSync(root, { recursive: true, force: true });
        });
        fs.mkdirSync(path.join(root, 'assets'));
        fs.writeFileSync(path.join(root, 'assets', 'Alien.terrain'), Buffer.from('not a terrain at all'));

        const text = (await tool.execute(
            { asset: '99999999-9999-9999-9999-999999999999' }, root)).content[0].text;
        assert.match(text, /scanned 0 serialized asset files, 1 skipped\)/);
        assert.match(text, /No references — the asset is unused in the serialized files that could be read/);
    });

    /** Throwaway project holding assets/Good.scene (a golden copy that references PRIMITIVES_UUID) */
    function projectWithGoodScene(t, prefix) {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
        t.after(() => {
            AssetIndex.invalidate(root);
            fs.rmSync(root, { recursive: true, force: true });
        });
        fs.mkdirSync(path.join(root, 'assets'));
        fs.copyFileSync(GOLDEN_SCENE, path.join(root, 'assets', 'Good.scene'));
        return root;
    }

    test('an unreadable scene is skipped, never fatal for the whole query', async (t) => {
        // The binary branch got this bucket first; a chmod-000 .scene used to throw out of
        // readFileSync into the outer catch and lose every hit in every OTHER file.
        const root = projectWithGoodScene(t, 'cocos-refs-locked-');
        const locked = path.join(root, 'assets', 'Locked.scene');
        fs.copyFileSync(GOLDEN_SCENE, locked);
        fs.chmodSync(locked, 0);
        try {
            fs.readFileSync(locked, 'utf-8');
            return t.skip('mode 000 is still readable here'); // root, or a mode-ignoring fs
        } catch { /* expected: EACCES */ }

        const result = await tool.execute({ asset: PRIMITIVES_UUID }, root);
        const text = result.content[0].text;
        assert.ok(!result.isError, text);
        assert.match(text, /scanned 1 serialized asset files, 1 skipped\)/);
        assert.match(text, /## Skipped — not searched \(1\)/);
        assert.match(text, /- assets\/Locked\.scene: unreadable file — EACCES/);
        assert.match(text, /## assets\/Good\.scene \(\d+\)/); // the readable half still answers
    });

    test('a scene whose JSON is truncated is skipped, never fatal', async (t) => {
        const root = projectWithGoodScene(t, 'cocos-refs-cut-');
        // Cut AFTER the first hit: the pre-filter finds the needle, the JSON walk cannot run
        const golden = fs.readFileSync(GOLDEN_SCENE, 'utf-8');
        const cut = golden.indexOf(PRIMITIVES_UUID) + PRIMITIVES_UUID.length + 4;
        assert.ok(cut > PRIMITIVES_UUID.length, 'the golden scene must reference the primitives fbx');
        fs.writeFileSync(path.join(root, 'assets', 'Broken.scene'), golden.slice(0, cut));

        const result = await tool.execute({ asset: PRIMITIVES_UUID }, root);
        const text = result.content[0].text;
        assert.ok(!result.isError, text);
        assert.match(text, /scanned 1 serialized asset files, 1 skipped\)/);
        assert.match(text, /- assets\/Broken\.scene: unparsable \.scene — /);
        assert.match(text, /## assets\/Good\.scene \(\d+\)/);
    });

    test('a directory that cannot be listed is reported, not fatal', async (t) => {
        const root = projectWithGoodScene(t, 'cocos-refs-dir-');
        const locked = path.join(root, 'assets', 'Locked');
        fs.mkdirSync(locked);
        fs.copyFileSync(GOLDEN_SCENE, path.join(locked, 'Hidden.scene'));
        // Warm the shared index BEFORE the chmod (5 s TTL): the tool's own tree walk is then
        // what meets the locked directory, exactly as it would in a long-lived server.
        AssetIndex.shared(root);
        fs.chmodSync(locked, 0);
        try {
            fs.readdirSync(locked);
            return t.skip('mode 000 is still listable here');
        } catch { /* expected: EACCES */ }

        let result;
        try {
            result = await tool.execute({ asset: PRIMITIVES_UUID }, root);
        } finally {
            fs.chmodSync(locked, 0o755); // or the cleanup rm cannot descend
        }
        const text = result.content[0].text;
        assert.ok(!result.isError, text);
        assert.match(text, /scanned 1 serialized asset files, 1 skipped\)/);
        assert.match(text, /- assets\/Locked\/: unlistable directory — EACCES/);
        assert.match(text, /## assets\/Good\.scene \(\d+\)/);
    });

    test('the skipped list is capped, and the header still counts every one', async (t) => {
        // One line carries a full errno message with an absolute path, so a whole
        // unreadable subtree would otherwise print one per file.
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-refs-many-'));
        t.after(() => {
            AssetIndex.invalidate(root);
            fs.rmSync(root, { recursive: true, force: true });
        });
        fs.mkdirSync(path.join(root, 'assets'));
        for (let i = 0; i < 25; i++) {
            fs.writeFileSync(path.join(root, 'assets', `Alien${i}.terrain`),
                Buffer.from('not a terrain at all'));
        }

        const text = (await tool.execute({ asset: PRIMITIVES_UUID }, root)).content[0].text;
        assert.match(text, /scanned 0 serialized asset files, 25 skipped\)/);
        assert.match(text, /## Skipped — not searched \(25\)/);
        const listed = text.split('\n').filter((l) => /^- assets\/Alien\d+\.terrain: /.test(l));
        assert.strictEqual(listed.length, 20);
        assert.match(text, /^… and 5 more not shown — the header counts every one\.$/m);
    });

    test('folder filter narrows the scan', async (t) => {
        const root = projectWithScene(t);

        const result = await tool.execute(
            { asset: PRIMITIVES_UUID, folder: 'Prefabs' }, root);
        const text = result.content[0].text;
        assert.ok(!text.includes('__refs_test.scene'), 'scene outside Prefabs/ is not scanned');
    });
});
