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
import * as path from 'path';
import { fileURLToPath } from 'url';
import { FindAssetReferences } from '../../src/tools/FindAssetReferences.js';
import { GetAssetInfo } from '../../src/tools/GetAssetInfo.js';
import { resolveBuiltin, builtinLabel, isBuiltin } from '../../src/core/builtins.js';
import { AssetIndex } from '../../src/core/AssetIndex.js';
import { Validator } from '../../src/document/Validator.js';
import { SceneDocument } from '../../src/document/SceneDocument.js';

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
        assert.match(missing, /not known 3\.8 engine built-ins/);
    });
});

describe('find_asset_references', () => {
    // The golden scene lives outside assets/ — copy it in for the scan
    const sceneCopy = path.join(MOCK_PROJECT, 'assets', '__refs_test.scene');

    test('project asset: file → node ▸ component .property attribution', async (t) => {
        fs.copyFileSync(GOLDEN_SCENE, sceneCopy);
        t.after(() => fs.rmSync(sceneCopy, { force: true }));
        AssetIndex.invalidate(MOCK_PROJECT);

        const result = await tool.execute({ asset: 'Prefabs/Gold.prefab' }, MOCK_PROJECT);
        const text = result.content[0].text;
        assert.ok(!result.isError, text);
        assert.match(text, /Asset: project file "assets\/Prefabs\/Gold\.prefab"/);
        // The golden scene instantiates Gold.prefab → PrefabInfo.asset refs
        assert.match(text, /## assets\/__refs_test\.scene \(\d+\)/);
        assert.match(text, /_prefab\.asset|asset/);
        AssetIndex.invalidate(MOCK_PROJECT);
    });

    test('builtin uuid: classified as engine built-in with references listed', async (t) => {
        fs.copyFileSync(GOLDEN_SCENE, sceneCopy);
        t.after(() => fs.rmSync(sceneCopy, { force: true }));
        AssetIndex.invalidate(MOCK_PROJECT);

        const result = await tool.execute({ asset: PRIMITIVES_UUID }, MOCK_PROJECT);
        const text = result.content[0].text;
        assert.match(text, /engine built-in db:\/\/internal\/primitives\.fbx/);
        assert.match(text, /▸ cc\.MeshRenderer \._mesh/);
        AssetIndex.invalidate(MOCK_PROJECT);
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

    test('folder filter narrows the scan', async (t) => {
        fs.copyFileSync(GOLDEN_SCENE, sceneCopy);
        t.after(() => fs.rmSync(sceneCopy, { force: true }));
        AssetIndex.invalidate(MOCK_PROJECT);

        const result = await tool.execute(
            { asset: PRIMITIVES_UUID, folder: 'Prefabs' }, MOCK_PROJECT);
        const text = result.content[0].text;
        assert.ok(!text.includes('__refs_test.scene'), 'scene outside Prefabs/ is not scanned');
        AssetIndex.invalidate(MOCK_PROJECT);
    });
});
