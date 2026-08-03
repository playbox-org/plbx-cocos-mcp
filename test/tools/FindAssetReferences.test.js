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
import { readTerrain, writeTerrain } from '../../src/utils/terrainBin.js';

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

    test('folder filter narrows the scan', async (t) => {
        const root = projectWithScene(t);

        const result = await tool.execute(
            { asset: PRIMITIVES_UUID, folder: 'Prefabs' }, root);
        const text = result.content[0].text;
        assert.ok(!text.includes('__refs_test.scene'), 'scene outside Prefabs/ is not scanned');
    });
});
