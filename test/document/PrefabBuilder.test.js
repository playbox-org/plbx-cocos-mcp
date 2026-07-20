/**
 * PrefabBuilder tests - spec compilation with the wrapper convention
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { SceneDocument } from '../../src/document/SceneDocument.js';
import { PrefabBuilder, PrefabBuildError } from '../../src/document/PrefabBuilder.js';
import { Validator } from '../../src/document/Validator.js';
import { AssetIndex } from '../../src/core/AssetIndex.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_PROJECT = path.join(__dirname, '..', 'fixtures', 'mock-project');
const assetIndex = new AssetIndex(MOCK_PROJECT);

describe('PrefabBuilder', () => {
    test('minimal spec compiles to a valid empty prefab', () => {
        const { doc } = new PrefabBuilder().compile({}, 'Empty');
        const { errors, warnings } = new Validator(doc).validate();
        assert.deepStrictEqual(errors, []);
        assert.deepStrictEqual(warnings, []);
        assert.strictEqual(doc.getObject(0)._name, 'Empty');
        assert.strictEqual(doc.root.node._name, 'Empty');
        assert.strictEqual(doc.objects.length, 3);
        // Editor-canonical root PrefabInfo shape (verified via editor re-save):
        // no nestedPrefabInstanceRoots key while there are no nested instances
        assert.deepStrictEqual(Object.keys(doc.getObject(2)),
            ['__type__', 'root', 'asset', 'fileId', 'instance', 'targetOverrides']);
    });

    test('visual.mesh lands on a Visual child (wrapper convention)', () => {
        const { doc } = new PrefabBuilder(assetIndex).compile({
            name: 'Rock',
            visual: { mesh: 'assets/Models/Rock.glb', scale: 0.5 },
            root: { components: [{ type: 'BoxCollider', properties: { size: { x: 2, y: 2, z: 2 } } }] }
        }, 'Rock');

        const { errors, warnings } = new Validator(doc, assetIndex).validate();
        assert.deepStrictEqual(errors, []);
        assert.deepStrictEqual(warnings.filter(w => /wrapper/.test(w)), []);

        // Root: collider only, scale 1
        const rootComps = doc.componentIndices(doc.root.idx).map(i => doc.getObject(i).__type__);
        assert.deepStrictEqual(rootComps, ['cc.BoxCollider']);

        // Visual child: MeshRenderer with resolved mesh + corrective scale
        const visualIdx = doc.resolveNode('Visual');
        const visual = doc.getObject(visualIdx);
        assert.strictEqual(visual._lscale.x, 0.5);
        const mr = doc.getObject(doc.componentIndices(visualIdx)[0]);
        assert.strictEqual(mr.__type__, 'cc.MeshRenderer');
        assert.strictEqual(mr._mesh.__uuid__, 'aaaabbbb-cccc-4ddd-8eee-ffff00001111@11111');
        assert.strictEqual(mr._mesh.__expectedType__, 'cc.Mesh');
        // Rock.glb has no material sub-assets → null slot + loud note
        assert.deepStrictEqual(mr._materials, [null]);
    });

    test('mesh without materials produces an explicit note', () => {
        const { notes } = new PrefabBuilder(assetIndex).compile({
            name: 'Rock',
            visual: { mesh: 'assets/Models/Rock.glb' }
        }, 'Rock');
        assert.strictEqual(notes.length, 1);
        assert.match(notes[0], /INVISIBLE/);
        assert.match(notes[0], /set_asset_ref/);

        // Explicit material → no note
        const withMat = new PrefabBuilder(assetIndex).compile({
            name: 'Rock',
            visual: { mesh: 'assets/Models/Rock.glb', material: 'assets/Materials/Dynamite.mtl' }
        }, 'Rock');
        assert.deepStrictEqual(withMat.notes, []);
    });

    test('primitive alias resolves to the db://internal mesh + default material', () => {
        const { doc, notes } = new PrefabBuilder(assetIndex).compile({
            name: 'Box',
            visual: { mesh: 'box' }
        }, 'Box');

        const { errors } = new Validator(doc, assetIndex).validate();
        assert.deepStrictEqual(errors, []);

        const visualIdx = doc.resolveNode('Visual');
        const mr = doc.getObject(doc.componentIndices(visualIdx)[0]);
        assert.strictEqual(mr.__type__, 'cc.MeshRenderer');
        assert.strictEqual(mr._mesh.__uuid__, '1263d74c-8167-4928-91a6-4e2672411f47@a804a');
        // Default material auto-assigned → no INVISIBLE note
        assert.strictEqual(mr._materials.length, 1);
        assert.strictEqual(mr._materials[0].__uuid__, 'd3c7820c-2a98-4429-8bc7-b8453bc9ac41');
        assert.deepStrictEqual(notes, []);
    });

    test('full builtin mesh reference resolves; explicit material overrides default', () => {
        // Reference by full "<uuid>@<subId>" (plane) with a project material
        const { doc } = new PrefabBuilder(assetIndex).compile({
            name: 'Plane',
            visual: { mesh: '1263d74c-8167-4928-91a6-4e2672411f47@2e76e', material: 'assets/Materials/Dynamite.mtl' }
        }, 'Plane');

        const visualIdx = doc.resolveNode('Visual');
        const mr = doc.getObject(doc.componentIndices(visualIdx)[0]);
        assert.strictEqual(mr._mesh.__uuid__, '1263d74c-8167-4928-91a6-4e2672411f47@2e76e');
        assert.notStrictEqual(mr._materials[0].__uuid__, 'd3c7820c-2a98-4429-8bc7-b8453bc9ac41');
    });

    test('sprite visual gets UITransform + Sprite with the sprite-frame', () => {
        const { doc } = new PrefabBuilder(assetIndex).compile({
            name: 'Panel',
            layer: 'ui_2d',
            visual: { sprite: 'assets/Sprites/panel.png' }
        }, 'Panel');
        const { errors } = new Validator(doc, assetIndex).validate();
        assert.deepStrictEqual(errors, []);

        const visualIdx = doc.resolveNode('Visual');
        const types = doc.componentIndices(visualIdx).map(i => doc.getObject(i).__type__);
        assert.deepStrictEqual(types, ['cc.UITransform', 'cc.Sprite']);
        const sprite = doc.getObject(doc.componentIndices(visualIdx)[1]);
        assert.strictEqual(sprite._spriteFrame.__uuid__, '11112222-3333-4444-8555-666677778888@f9941');
        assert.strictEqual(doc.root.node._layer, 1 << 25);
    });

    test('nested children with scripts compile', () => {
        const { doc } = new PrefabBuilder(assetIndex).compile({
            name: 'Zone',
            root: {
                children: [
                    {
                        name: 'Trigger',
                        components: [
                            { type: 'BoxCollider', properties: { isTrigger: true } },
                            { type: 'PlayerController', properties: { speed: 2 } }
                        ],
                        children: [{ name: 'Marker', position: { y: 1 } }]
                    }
                ]
            }
        }, 'Zone');
        const { errors } = new Validator(doc, assetIndex).validate();
        assert.deepStrictEqual(errors, []);
        assert.ok(doc.resolveNode('Trigger/Marker') > 0);
        const trigger = doc.getObject(doc.componentIndices(doc.resolveNode('Trigger'))[0]);
        assert.strictEqual(trigger._isTrigger, true);
    });

    test('compiled prefab is a canonical fixed point', () => {
        const { doc } = new PrefabBuilder(assetIndex).compile({
            name: 'Rock',
            visual: { mesh: 'assets/Models/Rock.glb' }
        }, 'Rock');
        const first = doc.serialize();
        const reloaded = new SceneDocument(JSON.parse(first));
        reloaded.renumber();
        assert.strictEqual(reloaded.serialize(), first);
    });

    test('renderer on the root triggers the wrapper warning', () => {
        const { doc } = new PrefabBuilder(assetIndex).compile({
            name: 'Bad',
            root: { components: [{ type: 'Sprite' }] }
        }, 'Bad');
        const { warnings } = new Validator(doc, assetIndex).validate();
        assert.ok(warnings.some(w => /wrapper rule/.test(w)));
    });

    test('mesh without assetIndex fails clearly', () => {
        assert.throws(() =>
            new PrefabBuilder().compile({ visual: { mesh: 'x.glb' } }, 'X'),
            PrefabBuildError);
    });

    test('sprite without a sprite-frame sub-asset fails clearly', () => {
        assert.throws(() =>
            new PrefabBuilder(assetIndex).compile(
                { visual: { sprite: 'assets/Models/Rock.glb' } }, 'X'),
            /no sprite-frame sub-asset/);
    });

    test('createMeta produces an importable prefab meta', () => {
        const meta = PrefabBuilder.createMeta('Crate');
        assert.strictEqual(meta.importer, 'prefab');
        assert.match(meta.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        assert.strictEqual(meta.userData.syncNodeName, 'Crate');
    });
});
