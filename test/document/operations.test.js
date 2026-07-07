/**
 * operations tests - semantic edits over golden corpus documents
 *
 * The closing suite asserts the canonical fixed point: whatever a batch
 * produces must survive load → renumber → serialize unchanged, and pass
 * validation — that is what makes editor re-saves diff-clean.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { SceneDocument } from '../../src/document/SceneDocument.js';
import { applyOperations, OperationError } from '../../src/document/operations.js';
import { Validator } from '../../src/document/Validator.js';
import { AssetIndex } from '../../src/core/AssetIndex.js';
import { compressUuid } from '../../src/utils/uuid.js';
import { templateTypes } from '../../src/document/ComponentTemplates.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = (f) => path.join(__dirname, '..', 'fixtures', 'golden', f);
const MOCK_PROJECT = path.join(__dirname, '..', 'fixtures', 'mock-project');

const loadPrefab = () => SceneDocument.load(GOLDEN('TableCash.prefab'));
const loadGold = () => SceneDocument.load(GOLDEN('Gold.prefab'));
const loadScene = () => SceneDocument.load(GOLDEN('Main.scene_V2.scene'));
const assetIndex = new AssetIndex(MOCK_PROJECT);

function assertValid(doc) {
    const { errors } = new Validator(doc).validate();
    assert.deepStrictEqual(errors, []);
}

describe('set_node_property', () => {
    test('position merges partial vectors', () => {
        const doc = loadPrefab();
        applyOperations(doc, [
            { op: 'set_node_property', node: 'Table', property: 'position', value: { y: 5 } }
        ]);
        const node = doc.getObject(doc.resolveNode('Table'));
        assert.strictEqual(node._lpos.y, 5);
        assert.strictEqual(node._lpos.x, 0);
        assert.strictEqual(node._lpos.__type__, 'cc.Vec3');
    });

    test('rotation updates euler AND derives the quaternion', () => {
        const doc = loadPrefab();
        applyOperations(doc, [
            { op: 'set_node_property', node: 'Table/CashRegister', property: 'rotation', value: { y: -80 } }
        ]);
        const node = doc.getObject(doc.resolveNode('Table/CashRegister'));
        assert.strictEqual(node._euler.y, -80);
        // Editor-computed values for euler (0, -80, 0), from Monitor in the corpus
        assert.ok(Math.abs(node._lrot.y - (-0.6427876096865393)) < 1e-9);
        assert.ok(Math.abs(node._lrot.w - 0.766044443118978) < 1e-9);
        assert.strictEqual(node._lrot.__type__, 'cc.Quat');
    });

    test('renaming the prefab root syncs cc.Prefab._name', () => {
        const doc = loadPrefab();
        applyOperations(doc, [
            { op: 'set_node_property', node: '/', property: 'name', value: 'CashDesk' }
        ]);
        assert.strictEqual(doc.root.node._name, 'CashDesk');
        assert.strictEqual(doc.getObject(0)._name, 'CashDesk');
    });

    test('layer accepts builtin names and numbers', () => {
        const doc = loadPrefab();
        applyOperations(doc, [
            { op: 'set_node_property', node: 'Table', property: 'layer', value: 'ui_2d' }
        ]);
        assert.strictEqual(doc.getObject(doc.resolveNode('Table'))._layer, 1 << 25);
        applyOperations(doc, [
            { op: 'set_node_property', node: 'Table', property: 'layer', value: 1 << 30 }
        ]);
        assert.strictEqual(doc.getObject(doc.resolveNode('Table'))._layer, 1 << 30);
    });

    test('rejects unknown properties and bad values', () => {
        const doc = loadPrefab();
        assert.throws(() =>
            applyOperations(doc, [{ op: 'set_node_property', node: 'Table', property: 'velocity', value: 1 }]),
            /Unknown node property/);
        assert.throws(() =>
            applyOperations(doc, [{ op: 'set_node_property', node: 'Table', property: 'active', value: 'yes' }]),
            /must be a boolean/);
        assert.throws(() =>
            applyOperations(doc, [{ op: 'set_node_property', node: 'Table', property: 'position', value: { w: 1 } }]),
            /Unknown field "w"/);
    });

    test('prefab instance stubs are guarded', () => {
        const doc = loadGold();
        assert.throws(() =>
            applyOperations(doc, [{ op: 'set_node_property', node: 'Coin', property: 'active', value: false }]),
            /prefab instance/);
    });

    test('position/rotation/scale on the scene root are rejected', () => {
        const doc = loadScene();
        for (const property of ['position', 'rotation', 'scale']) {
            assert.throws(() =>
                applyOperations(doc, [{ op: 'set_node_property', node: '/', property, value: { x: 5 } }]),
                /cc\.Scene.*has no transform/);
        }
        // Non-transform properties still work on the scene root
        applyOperations(doc, [{ op: 'set_node_property', node: '/', property: 'name', value: 'Renamed' }]);
        assert.strictEqual(doc.root.node._name, 'Renamed');
    });
});

describe('add_node', () => {
    test('in a prefab: creates PrefabInfo and stays canonical', () => {
        const doc = loadPrefab();
        applyOperations(doc, [
            { op: 'add_node', parent: 'Table', name: 'Lamp', position: { x: 1, y: 2, z: 3 } }
        ]);
        const idx = doc.resolveNode('Table/Lamp');
        const node = doc.getObject(idx);
        assert.strictEqual(node._lpos.x, 1);
        assert.strictEqual(node._id, '');
        const info = doc.getObject(node._prefab.__id__);
        assert.strictEqual(info.__type__, 'cc.PrefabInfo');
        assert.deepStrictEqual(info.asset, { __id__: 0 });
        assert.match(info.fileId, /^[A-Za-z0-9+/]{22}$/);
        doc.renumber();
        assertValid(doc);
    });

    test('in a scene: generates _id, no PrefabInfo', () => {
        const doc = loadScene();
        applyOperations(doc, [
            { op: 'add_node', parent: '/', name: 'Marker' }
        ]);
        const node = doc.getObject(doc.resolveNode('Marker'));
        assert.match(node._id, /^[A-Za-z0-9+/]{22}$/);
        assert.strictEqual(node._prefab, null);
        doc.renumber();
        assertValid(doc);
    });

    test('inherits parent layer by default', () => {
        const doc = loadPrefab();
        applyOperations(doc, [
            { op: 'set_node_property', node: 'Table', property: 'layer', value: 'ui_2d' },
            { op: 'add_node', parent: 'Table', name: 'Child' }
        ]);
        assert.strictEqual(doc.getObject(doc.resolveNode('Table/Child'))._layer, 1 << 25);
    });

    test('index inserts among siblings', () => {
        const doc = loadPrefab();
        applyOperations(doc, [
            { op: 'add_node', parent: '/', name: 'First', index: 0 }
        ]);
        assert.strictEqual(doc.childIndices(doc.root.idx).map(i => doc.nodeName(i))[0], 'First');
    });

    test('negative index is rejected (no JS negative-splice surprises)', () => {
        const doc = loadPrefab();
        assert.throws(
            () => applyOperations(doc, [{ op: 'add_node', parent: 'Table', name: 'Bad', index: -1 }]),
            /non-negative integer/
        );
        assert.throws(
            () => applyOperations(doc, [{ op: 'add_node', parent: 'Table', name: 'Bad', index: 1.5 }]),
            /non-negative integer/
        );
    });
});

describe('remove_node', () => {
    test('drops the whole subtree on renumber', () => {
        const doc = loadPrefab();
        const before = doc.objects.length;
        applyOperations(doc, [{ op: 'remove_node', node: 'Table/CashRegister' }]);
        const { dropped } = doc.renumber();
        assert.ok(dropped >= 8, `expected ≥8 dropped, got ${dropped}`); // 2 nodes + comps + infos
        assert.strictEqual(doc.objects.length, before - dropped);
        assertValid(doc);
        assert.throws(() => doc.resolveNode('Table/CashRegister'), /Node not found/);
    });

    test('cannot remove the root', () => {
        const doc = loadPrefab();
        assert.throws(() =>
            applyOperations(doc, [{ op: 'remove_node', node: '/' }]), /Cannot remove the root/);
    });

    test('removing a prefab instance sweeps its machinery and registry entry', () => {
        const doc = loadGold();
        applyOperations(doc, [{ op: 'remove_node', node: 'Coin' }]);
        doc.renumber();
        assertValid(doc);
        assert.strictEqual(doc.objects.some(o => o.__type__ === 'cc.PrefabInstance'), false);
        assert.strictEqual(doc.objects.some(o => o.__type__ === 'CCPropertyOverrideInfo'), false);
        const rootInfo = doc.getObject(doc.root.node._prefab.__id__);
        assert.deepStrictEqual(rootInfo.nestedPrefabInstanceRoots, []);
    });

    test('external references block removal unless forced', () => {
        const doc = loadPrefab();
        // Wire a cross-reference: a script-ish component on Table pointing at Monitor
        applyOperations(doc, [
            { op: 'add_component', node: 'Table', type: 'cc.Animation' },
            {
                op: 'set_component_property', node: 'Table', component: 'cc.Animation',
                property: '_defaultClip', value: { $node: 'Table/CashRegister/Monitor' }
            }
        ]);
        assert.throws(() =>
            applyOperations(doc, [{ op: 'remove_node', node: 'Table/CashRegister' }]),
            /referenced from outside/);

        const doc2 = loadPrefab();
        applyOperations(doc2, [
            { op: 'add_component', node: 'Table', type: 'cc.Animation' },
            {
                op: 'set_component_property', node: 'Table', component: 'cc.Animation',
                property: '_defaultClip', value: { $node: 'Table/CashRegister/Monitor' }
            },
            { op: 'remove_node', node: 'Table/CashRegister', force: true }
        ]);
        doc2.renumber();
        assertValid(doc2);
        const anim = doc2.getObject(doc2.componentIndices(doc2.resolveNode('Table'))
            .find(i => doc2.getObject(i).__type__ === 'cc.Animation'));
        assert.strictEqual(anim._defaultClip, null);
    });

    test('scene: removing a prefab instance prunes scene-level registries', () => {
        const doc = loadScene();
        const sceneInfo = doc.getObject(doc.root.node._prefab.__id__);
        const instancesBefore = sceneInfo.nestedPrefabInstanceRoots.length;
        const overridesBefore = sceneInfo.targetOverrides.length;

        // Find an instance-root stub that appears in targetOverrides endpoints
        const stubIdx = sceneInfo.nestedPrefabInstanceRoots
            .map(r => r.__id__)
            .find(i => sceneInfo.targetOverrides.some(r => {
                const o = doc.getObject(r.__id__);
                return o.source?.__id__ === i || o.target?.__id__ === i;
            }));
        assert.ok(stubIdx !== undefined, 'corpus should have an instance participating in targetOverrides');

        applyOperations(doc, [{ op: 'remove_node', node: doc.nodePath(stubIdx), force: true }]);
        doc.renumber();
        assertValid(doc);
        const after = doc.getObject(doc.root.node._prefab.__id__);
        assert.ok(after.nestedPrefabInstanceRoots.length < instancesBefore);
        assert.ok(after.targetOverrides.length < overridesBefore);
    });
});

describe('reparent', () => {
    test('moves a node with its subtree', () => {
        const doc = loadPrefab();
        applyOperations(doc, [
            { op: 'reparent', node: 'Table/CashRegister/Monitor', newParent: '/' }
        ]);
        doc.renumber();
        assertValid(doc);
        assert.strictEqual(doc.nodePath(doc.resolveNode('Monitor')), 'Monitor');
        assert.strictEqual(doc.childIndices(doc.resolveNode('Table/CashRegister')).length, 0);
    });

    test('guards against cycles', () => {
        const doc = loadPrefab();
        assert.throws(() =>
            applyOperations(doc, [{ op: 'reparent', node: 'Table', newParent: 'Table/CashRegister' }]),
            /own subtree/);
    });
});

describe('add_component', () => {
    test('template component in a prefab gets CompPrefabInfo', () => {
        const doc = loadPrefab();
        applyOperations(doc, [
            { op: 'add_component', node: 'Table', type: 'BoxCollider', properties: { size: { x: 2, y: 1, z: 2 } } }
        ]);
        const idx = doc.componentIndices(doc.resolveNode('Table'))
            .find(i => doc.getObject(i).__type__ === 'cc.BoxCollider');
        const comp = doc.getObject(idx);
        assert.strictEqual(comp._size.x, 2);
        assert.strictEqual(comp._size.__type__, 'cc.Vec3');
        assert.strictEqual(comp._id, '');
        assert.strictEqual(doc.getObject(comp.__prefab.__id__).__type__, 'cc.CompPrefabInfo');
        doc.renumber();
        assertValid(doc);
    });

    test('MeshRenderer wires bakeSettings extras', () => {
        const doc = loadPrefab();
        applyOperations(doc, [
            { op: 'add_node', parent: '/', name: 'Visual' },
            { op: 'add_component', node: 'Visual', type: 'MeshRenderer' }
        ]);
        const idx = doc.componentIndices(doc.resolveNode('Visual'))[0];
        const comp = doc.getObject(idx);
        assert.strictEqual(doc.getObject(comp.bakeSettings.__id__).__type__, 'cc.ModelBakeSettings');
        doc.renumber();
        assertValid(doc);
    });

    test('SkinnedMeshRenderer template wires bakeSettings and skinning fields', () => {
        const doc = loadPrefab();
        applyOperations(doc, [
            { op: 'add_node', parent: '/', name: 'Visual' },
            {
                op: 'add_component', node: 'Visual', type: 'SkinnedMeshRenderer',
                properties: { _skinningRoot: { $node: '/' } }
            }
        ]);
        const idx = doc.componentIndices(doc.resolveNode('Visual'))[0];
        const comp = doc.getObject(idx);
        assert.strictEqual(comp.__type__, 'cc.SkinnedMeshRenderer');
        assert.strictEqual(doc.getObject(comp.bakeSettings.__id__).__type__, 'cc.ModelBakeSettings');
        assert.deepStrictEqual(comp._materials, []);
        assert.strictEqual(comp._skeleton, null);
        assert.strictEqual(comp._skinningRoot.__id__, doc.root.idx);
        doc.renumber();
        assertValid(doc);
    });

    test('RenderRoot2D + UIOpacity build the 2D-in-3D pattern', () => {
        const doc = loadPrefab();
        applyOperations(doc, [
            { op: 'add_node', parent: '/', name: 'RenderRoot', layer: 'ui_3d', rotation: { x: -90, y: 0, z: 0 }, scale: { x: 0.01, y: 0.01, z: 0.01 } },
            { op: 'add_component', node: 'RenderRoot', type: 'UITransform' },
            { op: 'add_component', node: 'RenderRoot', type: 'RenderRoot2D' },
            { op: 'add_node', parent: 'RenderRoot', name: 'Icon', layer: 'ui_3d' },
            { op: 'add_component', node: 'RenderRoot/Icon', type: 'UITransform' },
            { op: 'add_component', node: 'RenderRoot/Icon', type: 'Sprite' },
            { op: 'add_component', node: 'RenderRoot/Icon', type: 'UIOpacity', properties: { opacity: 128 } }
        ]);
        const rootNode = doc.getObject(doc.resolveNode('RenderRoot'));
        assert.strictEqual(rootNode._layer, 1 << 23);
        const rr2d = doc.getObject(doc.componentIndices(doc.resolveNode('RenderRoot'))
            .find(i => doc.getObject(i).__type__ === 'cc.RenderRoot2D'));
        assert.strictEqual(rr2d._enabled, true);
        assert.strictEqual(doc.getObject(rr2d.__prefab.__id__).__type__, 'cc.CompPrefabInfo');
        const opacity = doc.getObject(doc.componentIndices(doc.resolveNode('RenderRoot/Icon'))
            .find(i => doc.getObject(i).__type__ === 'cc.UIOpacity'));
        assert.strictEqual(opacity._opacity, 128);
        doc.renumber();
        assertValid(doc);
    });

    test('scene component gets an _id, Button targets its own node', () => {
        const doc = loadScene();
        applyOperations(doc, [
            { op: 'add_node', parent: '/', name: 'Btn', layer: 'ui_2d' },
            { op: 'add_component', node: 'Btn', type: 'UITransform' },
            { op: 'add_component', node: 'Btn', type: 'Button' }
        ]);
        const btnNode = doc.resolveNode('Btn');
        const btn = doc.getObject(doc.componentIndices(btnNode)
            .find(i => doc.getObject(i).__type__ === 'cc.Button'));
        assert.match(btn._id, /^[A-Za-z0-9+/]{22}$/);
        assert.deepStrictEqual(btn._target, { __id__: btnNode });
        assert.strictEqual(btn.__prefab, null);
        doc.renumber();
        assertValid(doc);
    });

    test('duplicate builtin components are rejected', () => {
        const doc = loadPrefab();
        assert.throws(() =>
            applyOperations(doc, [
                { op: 'add_component', node: 'Table', type: 'BoxCollider' },
                { op: 'add_component', node: 'Table', type: 'cc.BoxCollider' }
            ]), /already has/);
    });

    test('custom script resolves through the asset index', () => {
        const doc = loadPrefab();
        applyOperations(doc, [
            {
                op: 'add_component', node: 'Table', type: 'PlayerController',
                properties: { speed: 4.5 }
            }
        ], { assetIndex });
        const comp = doc.getObject(doc.componentIndices(doc.resolveNode('Table')).at(-1));
        assert.strictEqual(comp.__type__, compressUuid('34eed213-ed8a-4324-8223-a47ca98b8685'));
        assert.strictEqual(comp.speed, 4.5);
        doc.renumber();
        assertValid(doc);
    });

    test('unknown cc.* type lists available templates', () => {
        const doc = loadPrefab();
        assert.throws(() =>
            applyOperations(doc, [{ op: 'add_component', node: 'Table', type: 'cc.TiledMap' }]),
            /Available cc\.\* templates/);
    });
});

describe('set_component_property / set_asset_ref', () => {
    test('typed values merge preserving __type__', () => {
        const doc = loadScene();
        applyOperations(doc, [
            { op: 'add_node', parent: '/', name: 'Panel', layer: 'ui_2d' },
            { op: 'add_component', node: 'Panel', type: 'UITransform' },
            {
                op: 'set_component_property', node: 'Panel', component: 'UITransform',
                property: 'contentSize', value: { width: 300 }
            }
        ]);
        const comp = doc.getObject(doc.componentIndices(doc.resolveNode('Panel'))[0]);
        assert.deepStrictEqual(comp._contentSize, { __type__: 'cc.Size', width: 300, height: 100 });
    });

    test('unknown property on cc.* lists available fields', () => {
        const doc = loadPrefab();
        assert.throws(() =>
            applyOperations(doc, [{
                op: 'set_component_property', node: 'Table/CashRegister',
                component: 'MeshRenderer', property: 'nonsense', value: 1
            }]), /Available: .*_materials/);
    });

    test('set_asset_ref resolves path → sprite-frame sub-asset', () => {
        const doc = loadScene();
        applyOperations(doc, [
            { op: 'add_node', parent: '/', name: 'Icon', layer: 'ui_2d' },
            { op: 'add_component', node: 'Icon', type: 'Sprite' },
            {
                op: 'set_asset_ref', node: 'Icon', component: 'Sprite',
                property: 'spriteFrame', asset: 'assets/Sprites/panel.png@f9941'
            }
        ], { assetIndex });
        const sprite = doc.getObject(doc.componentIndices(doc.resolveNode('Icon'))[0]);
        assert.deepStrictEqual(sprite._spriteFrame, {
            __uuid__: '11112222-3333-4444-8555-666677778888@f9941',
            __expectedType__: 'cc.SpriteFrame'
        });
    });

    test('componentIndex out of range for a matched type is rejected', () => {
        const doc = loadPrefab();
        assert.throws(() =>
            applyOperations(doc, [{
                op: 'set_component_property', node: 'Table',
                component: 'cc.MeshRenderer', componentIndex: 2,
                property: 'shadowCastingMode', value: 1
            }]),
            /componentIndex 2 out of range.*1 "cc\.MeshRenderer"/);
    });

    test('$node forms nested inside plain objects are resolved', () => {
        const doc = loadScene();
        applyOperations(doc, [
            { op: 'add_node', parent: '/', name: 'Btn', layer: 'ui_2d' },
            { op: 'add_component', node: 'Btn', type: 'UITransform' },
            { op: 'add_component', node: 'Btn', type: 'Button' },
            {
                op: 'set_component_property', node: 'Btn', component: 'Button',
                property: 'clickEvents', value: [{
                    __type__: 'cc.ClickEvent', target: { $node: 'Btn' },
                    component: '', _componentId: '', handler: 'onClick', customEventData: ''
                }]
            }
        ]);
        const btn = doc.getObject(doc.componentIndices(doc.resolveNode('Btn'))
            .find(i => doc.getObject(i).__type__ === 'cc.Button'));
        assert.deepStrictEqual(btn.clickEvents[0].target, { __id__: doc.resolveNode('Btn') });
        assert.strictEqual(btn.clickEvents[0].handler, 'onClick');
    });

    test('dotted numeric segments behave like bracket indices', () => {
        const doc = loadPrefab();
        applyOperations(doc, [{
            op: 'set_asset_ref', node: 'Table', component: 'MeshRenderer',
            property: 'materials.0', asset: 'assets/Materials/Dynamite.mtl'
        }], { assetIndex });
        const comp = doc.getObject(doc.componentIndices(doc.resolveNode('Table'))[0]);
        assert.strictEqual(comp._materials[0].__uuid__, '7650cf04-45c9-4325-91b7-0b3bd68e4a08');
        // Out-of-bounds guard must fire for the dotted form too (no sparse arrays)
        assert.throws(() =>
            applyOperations(doc, [{
                op: 'set_asset_ref', node: 'Table', component: 'MeshRenderer',
                property: 'materials.5', asset: 'assets/Materials/Dynamite.mtl'
            }], { assetIndex }),
            /out of bounds/);
    });

    test('set_asset_ref on array elements', () => {
        const doc = loadPrefab();
        applyOperations(doc, [
            {
                op: 'set_asset_ref', node: 'Table', component: 'MeshRenderer',
                property: 'materials[0]', asset: 'assets/Materials/Dynamite.mtl'
            }
        ], { assetIndex });
        const comp = doc.getObject(doc.componentIndices(doc.resolveNode('Table'))[0]);
        assert.strictEqual(comp._materials[0].__uuid__, '7650cf04-45c9-4325-91b7-0b3bd68e4a08');
        assert.strictEqual(comp._materials[0].__expectedType__, 'cc.Material');
    });

    test('missing asset fails with a clear message', () => {
        const doc = loadPrefab();
        assert.throws(() =>
            applyOperations(doc, [{
                op: 'set_asset_ref', node: 'Table', component: 'MeshRenderer',
                property: 'mesh', asset: 'assets/Models/Missing.glb'
            }], { assetIndex }), /Asset not found/);
    });

    test('negative array "index" is rejected, not silently written as a string key', () => {
        const doc = loadPrefab();
        assert.throws(() =>
            applyOperations(doc, [{
                op: 'set_asset_ref', node: 'Table', component: 'MeshRenderer',
                property: 'materials.-1', asset: 'assets/Materials/Dynamite.mtl'
            }], { assetIndex }),
            /negative array index/);
        assert.throws(() =>
            applyOperations(doc, [{
                op: 'set_asset_ref', node: 'Table', component: 'MeshRenderer',
                property: 'materials[-1]', asset: 'assets/Materials/Dynamite.mtl'
            }], { assetIndex }),
            /Bad property path/);
    });
});

describe('OperationError', () => {
    test('carries its own name (tools match on err.name)', () => {
        assert.strictEqual(new OperationError('x').name, 'OperationError');
    });
});

describe('cc.animation.AnimationController', () => {
    const GRAPH_UUID = '0e51b40e-aaaa-4bbb-8ccc-0123456789ab';
    const GRAPH_REF = { __uuid__: GRAPH_UUID, __expectedType__: 'cc.animation.AnimationGraph' };

    test('template matches the golden-scene component shape (both graph fields)', () => {
        const doc = loadScene();
        applyOperations(doc, [
            { op: 'add_node', parent: '/', name: 'Skeleton' },
            { op: 'add_component', node: 'Skeleton', type: 'AnimationController' }
        ]);
        const comp = doc.getObject(doc.componentIndices(doc.resolveNode('Skeleton'))[0]);
        assert.strictEqual(comp.__type__, 'cc.animation.AnimationController');
        // Key order verified against the editor-saved controller in the golden scene
        const goldenSample = doc.objects.find(o =>
            o.__type__ === 'cc.animation.AnimationController' && o._id === 'e6Zmhz5ctPR75SXku43LFz');
        assert.ok(goldenSample, 'golden scene should contain the reference controller');
        assert.deepStrictEqual(Object.keys(comp), Object.keys(goldenSample));
        assert.strictEqual(comp._graph, null);
        assert.strictEqual(comp.graph, null);
    });

    test('type aliases resolve with and without the cc.animation prefix', () => {
        for (const alias of ['AnimationController', 'animationcontroller',
            'cc.AnimationController', 'cc.animation.AnimationController']) {
            const doc = loadScene();
            applyOperations(doc, [
                { op: 'add_node', parent: '/', name: 'N' },
                { op: 'add_component', node: 'N', type: alias }
            ]);
            const comp = doc.getObject(doc.componentIndices(doc.resolveNode('N'))[0]);
            assert.strictEqual(comp.__type__, 'cc.animation.AnimationController', alias);
        }
    });

    test('set_asset_ref graph writes BOTH _graph and graph (no aliasing)', () => {
        const doc = loadScene();
        applyOperations(doc, [
            { op: 'add_node', parent: '/', name: 'Skeleton' },
            { op: 'add_component', node: 'Skeleton', type: 'AnimationController' },
            {
                op: 'set_asset_ref', node: 'Skeleton', component: 'AnimationController',
                property: 'graph', asset: 'assets/Anims/Empty.animgraph'
            }
        ], { assetIndex });
        const comp = doc.getObject(doc.componentIndices(doc.resolveNode('Skeleton'))[0]);
        assert.deepStrictEqual(comp._graph, GRAPH_REF);
        assert.deepStrictEqual(comp.graph, GRAPH_REF);
        assert.notStrictEqual(comp._graph, comp.graph, 'twins must be separate objects');
    });

    test('writing _graph (or via set_component_property/add properties) mirrors too', () => {
        const doc = loadScene();
        applyOperations(doc, [
            { op: 'add_node', parent: '/', name: 'A' },
            { op: 'add_component', node: 'A', type: 'AnimationController' },
            {
                op: 'set_asset_ref', node: 'A', component: 'AnimationController',
                property: '_graph', asset: GRAPH_UUID
            },
            { op: 'add_node', parent: '/', name: 'B' },
            {
                op: 'add_component', node: 'B', type: 'AnimationController',
                properties: { graph: { $asset: GRAPH_UUID } }
            }
        ], { assetIndex });
        for (const name of ['A', 'B']) {
            const comp = doc.getObject(doc.componentIndices(doc.resolveNode(name))[0]);
            assert.deepStrictEqual(comp._graph, GRAPH_REF, name);
            assert.deepStrictEqual(comp.graph, GRAPH_REF, name);
        }
        // Clearing follows the same pairing
        applyOperations(doc, [{
            op: 'set_asset_ref', node: 'A', component: 'AnimationController',
            property: 'graph', asset: null
        }], { assetIndex });
        const cleared = doc.getObject(doc.componentIndices(doc.resolveNode('A'))[0]);
        assert.strictEqual(cleared._graph, null);
        assert.strictEqual(cleared.graph, null);
    });

    test('controller edit keeps the canonical fixed point and validates clean', () => {
        const doc = loadScene();
        applyOperations(doc, [
            { op: 'add_node', parent: '/', name: 'Skeleton' },
            { op: 'add_component', node: 'Skeleton', type: 'AnimationController' },
            {
                op: 'set_asset_ref', node: 'Skeleton', component: 'AnimationController',
                property: 'graph', asset: 'assets/Anims/Empty.animgraph'
            }
        ], { assetIndex });
        doc.renumber();
        assertValid(doc);
        const first = doc.serialize();
        const reloaded = new SceneDocument(JSON.parse(first));
        reloaded.renumber();
        assert.strictEqual(reloaded.serialize(), first);
    });
});

describe('cc.Line', () => {
    /** Prefab with a Line on a fresh child node; returns the component */
    function prefabWithLine(props) {
        const doc = loadPrefab();
        applyOperations(doc, [
            { op: 'add_node', parent: '/', name: 'RopeVisual' },
            { op: 'add_component', node: 'RopeVisual', type: 'Line', ...(props ? { properties: props } : {}) }
        ]);
        const compIdx = doc.componentIndices(doc.resolveNode('RopeVisual'))[0];
        return { doc, compIdx, comp: doc.getObject(compIdx) };
    }

    test('template wires standalone CurveRange/GradientRange (editor shape from Rope.prefab)', () => {
        const { doc, comp } = prefabWithLine();
        assert.strictEqual(comp.__type__, 'cc.Line');
        assert.deepStrictEqual(doc.getObject(comp._width.__id__),
            { __type__: 'cc.CurveRange', mode: 0, constant: 1, multiplier: 1 });
        const gradient = doc.getObject(comp._color.__id__);
        assert.deepStrictEqual(Object.keys(gradient), ['__type__', '_mode', 'color']);
        assert.deepStrictEqual(gradient.color, { __type__: 'cc.Color', r: 255, g: 255, b: 255, a: 255 });
        assert.deepStrictEqual(comp._materials, []);
        assert.strictEqual(comp._worldSpace, false);
        assert.deepStrictEqual(comp._positions, []);
        assert.strictEqual(doc.getObject(comp.__prefab.__id__).__type__, 'cc.CompPrefabInfo');
        doc.renumber();
        assertValid(doc);
    });

    test('canonical layout: CompPrefabInfo → CurveRange → GradientRange follow the component', () => {
        const { doc } = prefabWithLine();
        doc.renumber();
        const lineIdx = doc.objects.findIndex(o => o.__type__ === 'cc.Line');
        assert.strictEqual(doc.objects[lineIdx + 1].__type__, 'cc.CompPrefabInfo');
        assert.strictEqual(doc.objects[lineIdx + 2].__type__, 'cc.CurveRange');
        assert.strictEqual(doc.objects[lineIdx + 3].__type__, 'cc.GradientRange');
        // fixed point: renumber must already be an identity
        const first = doc.serialize();
        const reloaded = new SceneDocument(JSON.parse(first));
        reloaded.renumber();
        assert.strictEqual(reloaded.serialize(), first);
    });

    test('"width.constant" writes into the referenced CurveRange, keeping the reference', () => {
        const { doc, comp } = prefabWithLine();
        const widthIdx = comp._width.__id__;
        applyOperations(doc, [{
            op: 'set_component_property', node: 'RopeVisual', component: 'cc.Line',
            property: 'width.constant', value: 0.08
        }]);
        assert.deepStrictEqual(comp._width, { __id__: widthIdx }, 'reference must stay intact');
        assert.strictEqual(doc.getObject(widthIdx).constant, 0.08);
        doc.renumber();
        assertValid(doc);
    });

    test('object value for "width" merges through the reference', () => {
        const { doc, comp } = prefabWithLine({ width: { constant: 0.05 } });
        const width = doc.getObject(comp._width.__id__);
        assert.strictEqual(width.constant, 0.05);
        assert.strictEqual(width.mode, 0, 'unset CurveRange fields survive the merge');
        assert.strictEqual(width.multiplier, 1);
        doc.renumber();
        assertValid(doc);
    });

    test('primitive write to a standalone value object is rejected with a hint', () => {
        const { doc } = prefabWithLine();
        assert.throws(() => applyOperations(doc, [{
            op: 'set_component_property', node: 'RopeVisual', component: 'cc.Line',
            property: 'width', value: 0.08
        }]), /standalone cc\.CurveRange.*width\.constant/s);
    });

    test('color.color merges Color channels through the reference', () => {
        const { doc, comp } = prefabWithLine();
        applyOperations(doc, [{
            op: 'set_component_property', node: 'RopeVisual', component: 'Line',
            property: 'color.color', value: { r: 87, g: 45, b: 0 }
        }]);
        const gradient = doc.getObject(comp._color.__id__);
        assert.deepStrictEqual(gradient.color, { __type__: 'cc.Color', r: 87, g: 45, b: 0, a: 255 });
        doc.renumber();
        assertValid(doc);
    });
});

describe('every component template', () => {
    // Companions the editor would have added before the type is allowed
    const PRE = (type) => {
        if (type === 'cc.UITransform') return [];
        const pre = ['cc.UITransform'];
        if (type === 'cc.SafeArea') pre.push('cc.Widget');
        if (type === 'cc.LabelOutline') pre.push('cc.Label');
        return pre;
    };
    const opsForAllTemplates = () => templateTypes().flatMap((type, i) => {
        const name = `Holder${i}`;
        return [
            { op: 'add_node', parent: '/', name },
            ...PRE(type).map(t => ({ op: 'add_component', node: name, type: t })),
            { op: 'add_component', node: name, type }
        ];
    });

    test('adds cleanly to a prefab, validates, keeps the canonical fixed point', () => {
        const doc = loadPrefab();
        applyOperations(doc, opsForAllTemplates());
        doc.renumber();
        assertValid(doc);
        const first = doc.serialize();
        const reloaded = new SceneDocument(JSON.parse(first));
        reloaded.renumber();
        assert.strictEqual(reloaded.serialize(), first);
        // every component got a CompPrefabInfo and an empty _id
        for (const obj of doc.objects) {
            if (obj.__type__ && templateTypes().includes(obj.__type__)) {
                assert.strictEqual(obj._id, '', obj.__type__);
                assert.ok(obj.__prefab?.__id__ !== undefined, `${obj.__type__} missing __prefab`);
            }
        }
    });

    test('adds cleanly to a scene, validates, keeps the canonical fixed point', () => {
        const doc = loadScene();
        applyOperations(doc, opsForAllTemplates());
        doc.renumber();
        assertValid(doc);
        const first = doc.serialize();
        const reloaded = new SceneDocument(JSON.parse(first));
        reloaded.renumber();
        assert.strictEqual(reloaded.serialize(), first);
        for (const obj of doc.objects) {
            if (obj.__type__ && templateTypes().includes(obj.__type__)) {
                assert.match(obj._id, /^[A-Za-z0-9+/]{22,23}$/, obj.__type__);
                assert.strictEqual(obj.__prefab, null, obj.__type__);
            }
        }
    });

    test('no template leaves an unwired __ref__ or __self_node__ placeholder', () => {
        const doc = loadPrefab();
        applyOperations(doc, opsForAllTemplates());
        doc.renumber();
        const flat = JSON.stringify(doc.objects);
        assert.ok(!flat.includes('__ref__'), 'unwired __ref__ placeholder');
        assert.ok(!flat.includes('__self_node__'), 'unwired __self_node__ placeholder');
    });
});

describe('cc.ParticleSystem', () => {
    const addPS = () => {
        const doc = loadPrefab();
        applyOperations(doc, [
            { op: 'add_node', parent: '/', name: 'FX' },
            { op: 'add_component', node: 'FX', type: 'ParticleSystem' }
        ]);
        const compIdx = doc.componentIndices(doc.resolveNode('FX'))[0];
        return { doc, compIdx, comp: doc.getObject(compIdx) };
    };

    test('template wires modules, aliased curves and the renderer (editor shape)', () => {
        const { doc, compIdx, comp } = addPS();
        // startSize aliases startSizeX; startRotation aliases startRotationZ
        assert.strictEqual(comp.startSize.__id__, comp.startSizeX.__id__);
        assert.strictEqual(comp.startRotation.__id__, comp.startRotationZ.__id__);
        assert.strictEqual(doc.getObject(comp.startSizeX.__id__).constant, 1);
        // renderer is a headless data object
        const renderer = doc.getObject(comp.renderer.__id__);
        assert.strictEqual(renderer.__type__, 'cc.ParticleSystemRenderer');
        assert.strictEqual(renderer.node, undefined);
        // trail module points back at the owning component
        const trail = doc.getObject(comp._trailModule.__id__);
        assert.strictEqual(trail._particleSystem.__id__, compIdx);
        // module → own curve (nested extras→extras wiring)
        const shape = doc.getObject(comp._shapeModule.__id__);
        assert.strictEqual(doc.getObject(shape.arcSpeed.__id__).__type__, 'cc.CurveRange');
        doc.renumber();
        assertValid(doc);
    });

    test('nested segments map the underscore prefix and reject typos', () => {
        const { doc, comp } = addPS();
        applyOperations(doc, [
            { op: 'set_component_property', node: 'FX', component: 'cc.ParticleSystem', property: 'shapeModule.enable', value: true }
        ]);
        const shape = doc.getObject(comp._shapeModule.__id__);
        assert.strictEqual(shape._enable, true);
        assert.ok(!('enable' in shape), 'no stray "enable" key created');
        assert.throws(() =>
            applyOperations(doc, [
                { op: 'set_component_property', node: 'FX', component: 'cc.ParticleSystem', property: 'shapeModule.radiuss', value: 1 }
            ]), /has no property "radiuss".*Available/s);
    });

    test('writes through refs edit the shared curve and sync getter pairs', () => {
        const { doc, comp } = addPS();
        applyOperations(doc, [
            { op: 'set_component_property', node: 'FX', component: 'cc.ParticleSystem', property: 'startSizeX.constant', value: 3.5 },
            { op: 'set_component_property', node: 'FX', component: 'cc.ParticleSystem', property: '_shapeModule.shapeType', value: 1 },
            { op: 'set_component_property', node: 'FX', component: 'cc.ParticleSystem', property: 'enableCulling', value: true }
        ]);
        // shared object → the alias sees the same value
        assert.strictEqual(doc.getObject(comp.startSize.__id__).constant, 3.5);
        // getter/setter pair inside the module mirrored
        const shape = doc.getObject(comp._shapeModule.__id__);
        assert.strictEqual(shape.shapeType, 1);
        assert.strictEqual(shape._shapeType, 1);
        // deprecated alias pair on the component itself mirrored
        assert.strictEqual(comp._dataCulling, true);
        doc.renumber();
        assertValid(doc);
    });
});

describe('light components', () => {
    test('illuminance twins stay in sync and StaticLightSettings is wired', () => {
        const doc = loadScene();
        applyOperations(doc, [
            { op: 'add_node', parent: '/', name: 'Sun' },
            { op: 'add_component', node: 'Sun', type: 'DirectionalLight' },
            { op: 'set_component_property', node: 'Sun', component: 'cc.DirectionalLight', property: '_illuminanceHDR', value: 90000 }
        ]);
        const comp = doc.getObject(doc.componentIndices(doc.resolveNode('Sun'))[0]);
        assert.strictEqual(comp._illuminance, 90000);
        assert.strictEqual(doc.getObject(comp._staticSettings.__id__).__type__, 'cc.StaticLightSettings');
        doc.renumber();
        assertValid(doc);
    });
});

describe('canonical fixed point after editing', () => {
    test('edited prefab survives load→renumber→serialize unchanged', () => {
        const doc = loadPrefab();
        applyOperations(doc, [
            { op: 'add_node', parent: '/', name: 'Extras', position: { x: 1 } },
            { op: 'add_component', node: 'Extras', type: 'BoxCollider' },
            { op: 'set_node_property', node: 'Table', property: 'rotation', value: { y: 15 } },
            { op: 'reparent', node: 'Table/CashRegister/Monitor', newParent: 'Extras' }
        ], { assetIndex });
        doc.renumber();
        assertValid(doc);

        const first = doc.serialize();
        const reloaded = new SceneDocument(JSON.parse(first));
        reloaded.renumber();
        assert.strictEqual(reloaded.serialize(), first);
    });

    test('edited scene survives load→renumber→serialize unchanged', () => {
        const doc = loadScene();
        applyOperations(doc, [
            { op: 'add_node', parent: '/', name: 'SpawnPoints' },
            { op: 'add_node', parent: 'SpawnPoints', name: 'P1', position: { x: -2, z: 3 } }
        ]);
        doc.renumber();
        assertValid(doc);
        const first = doc.serialize();
        const reloaded = new SceneDocument(JSON.parse(first));
        reloaded.renumber();
        assert.strictEqual(reloaded.serialize(), first);
    });

    test('failing mid-batch surfaces the op index', () => {
        const doc = loadPrefab();
        assert.throws(() =>
            applyOperations(doc, [
                { op: 'add_node', parent: '/', name: 'Ok' },
                { op: 'add_node', parent: 'Nope', name: 'Fails' }
            ]), (err) => err instanceof OperationError && /op\[1\] add_node/.test(err.message));
    });
});
