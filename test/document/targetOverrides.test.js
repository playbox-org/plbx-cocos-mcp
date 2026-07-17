/**
 * targetOverrides tests — @property references INTO collapsed instances (M6 B1)
 *
 * The generated cc.TargetOverrideInfo / cc.TargetInfo shapes are asserted
 * against the golden corpus form: source = plain component, sourceInfo null,
 * target = the instance stub, single-hop localID, serialized value null.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { SceneDocument, isRef } from '../../src/document/SceneDocument.js';
import { applyOperations, OperationError } from '../../src/document/operations.js';
import { findDanglingOverrides } from '../../src/document/targetOverrides.js';
import { Validator } from '../../src/document/Validator.js';
import { AssetIndex } from '../../src/core/AssetIndex.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = (f) => path.join(__dirname, '..', 'fixtures', 'golden', f);
const MOCK_PROJECT = path.join(__dirname, '..', 'fixtures', 'mock-project');
const MOCK = (f) => path.join(MOCK_PROJECT, f);

const loadScene = () => SceneDocument.load(GOLDEN('Main.scene_V2.scene'));
const makeCtx = () => ({ assetIndex: new AssetIndex(MOCK_PROJECT), projectRoot: MOCK_PROJECT });

function assertValid(doc) {
    const { errors } = new Validator(doc).validate();
    assert.deepStrictEqual(errors, []);
}

/** renumber → serialize → reload must be a fixed point (editor-canonical form) */
function assertFixedPoint(doc) {
    doc.renumber();
    const first = doc.serialize();
    const reloaded = new SceneDocument(JSON.parse(first));
    reloaded.renumber();
    assert.strictEqual(reloaded.serialize(), first);
}

/**
 * Scene with a TableCash instance "Desk" and a plain node "Holder" carrying
 * a PlayerController script — the source component for reference tests.
 */
function sceneWithDeskAndHolder(ctx) {
    const doc = loadScene();
    applyOperations(doc, [
        { op: 'instantiate_prefab', parent: '/', prefab: 'Prefabs/TableCash.prefab', name: 'Desk' },
        { op: 'add_node', parent: '/', name: 'Holder' },
        { op: 'add_component', node: 'Holder', type: 'PlayerController' }
    ], ctx);
    return doc;
}

function scriptComponent(doc, ref) {
    const idx = doc.componentIndices(doc.resolveNode(ref))
        .find(i => !doc.getObject(i).__type__.startsWith('cc.'));
    return { compIdx: idx, component: doc.getObject(idx) };
}

/** Overrides sourced from a given component */
function overridesOf(doc, compIdx) {
    const registry = doc.getObject(doc.root.node._prefab.__id__);
    return registry.targetOverrides
        .filter(isRef)
        .map(r => doc.getObject(r.__id__))
        .filter(o => isRef(o.source) && o.source.__id__ === compIdx)
        .map(o => ({
            obj: o,
            path: o.propertyPath,
            localID: isRef(o.targetInfo) ? doc.getObject(o.targetInfo.__id__).localID : null,
            targetIdx: isRef(o.target) ? o.target.__id__ : null
        }));
}

/** fileId helpers over the mock source prefab */
const sourcePrefab = () => SceneDocument.load(MOCK('assets/Prefabs/TableCash.prefab'));
function sourceNodeFileId(ref) {
    const src = sourcePrefab();
    const idx = src.resolveNode(ref);
    return src.getObject(src.getObject(idx)._prefab.__id__).fileId;
}
function sourceComponentFileId(nodeRef, type) {
    const src = sourcePrefab();
    const compIdx = src.componentIndices(src.resolveNode(nodeRef))
        .find(i => src.getObject(i).__type__ === type);
    return src.getObject(src.getObject(compIdx).__prefab.__id__).fileId;
}

describe('$component into a collapsed instance', () => {
    test('serializes null + golden-shaped TargetOverrideInfo', () => {
        const ctx = makeCtx();
        const doc = sceneWithDeskAndHolder(ctx);
        applyOperations(doc, [{
            op: 'set_component_property', node: 'Holder', component: 'PlayerController',
            property: 'tableView',
            value: { $component: { node: 'Desk', target: 'Table', type: 'cc.MeshRenderer' } }
        }], ctx);

        const { compIdx, component } = scriptComponent(doc, 'Holder');
        assert.strictEqual(component.tableView, null, 'serialized value must be null');

        const ovs = overridesOf(doc, compIdx);
        assert.strictEqual(ovs.length, 1);
        const { obj } = ovs[0];
        // Exact golden key set and order
        assert.deepStrictEqual(Object.keys(obj),
            ['__type__', 'source', 'sourceInfo', 'propertyPath', 'target', 'targetInfo']);
        assert.strictEqual(obj.sourceInfo, null);
        assert.deepStrictEqual(obj.propertyPath, ['tableView']);
        assert.strictEqual(obj.target.__id__, doc.resolveNode('Desk'));
        const targetInfo = doc.getObject(obj.targetInfo.__id__);
        assert.deepStrictEqual(Object.keys(targetInfo), ['__type__', 'localID']);
        assert.deepStrictEqual(targetInfo.localID,
            [sourceComponentFileId('Table', 'cc.MeshRenderer')]);

        assertValid(doc);
        assertFixedPoint(doc);
        // Canonical position after renumber: TargetInfo directly follows its override
        const oIdx = doc.objects.findIndex(o =>
            o.__type__ === 'cc.TargetOverrideInfo' && o.propertyPath[0] === 'tableView');
        assert.strictEqual(doc.objects[oIdx + 1].__type__, 'cc.TargetInfo');
    });

    test('$component without target addresses the instance root', () => {
        const ctx = makeCtx();
        const doc = loadScene();
        applyOperations(doc, [
            { op: 'instantiate_prefab', parent: '/', prefab: 'Prefabs/Sprite(2).prefab', name: 'Box' },
            { op: 'add_node', parent: '/', name: 'Holder' },
            {
                op: 'add_component', node: 'Holder', type: 'PlayerController',
                properties: { crate: { $component: { node: 'Box', type: 'cc.MeshRenderer' } } }
            }
        ], ctx);
        const { compIdx, component } = scriptComponent(doc, 'Holder');
        assert.strictEqual(component.crate, null);
        assert.strictEqual(overridesOf(doc, compIdx).length, 1);
        assertValid(doc);
        assertFixedPoint(doc);
    });

    test('component missing in the source prefab names the prefab', () => {
        const ctx = makeCtx();
        const doc = sceneWithDeskAndHolder(ctx);
        assert.throws(() => applyOperations(doc, [{
            op: 'set_component_property', node: 'Holder', component: 'PlayerController',
            property: 'x',
            value: { $component: { node: 'Desk', target: 'Table', type: 'cc.Sprite' } }
        }], ctx), /In source prefab .*TableCash[\s\S]*has no "cc\.Sprite"/);
    });

    test('insert_array_element into an instance → null hole + TargetOverrideInfo (review #1)', () => {
        const ctx = makeCtx();
        const doc = sceneWithDeskAndHolder(ctx);
        const { compIdx, component } = scriptComponent(doc, 'Holder');
        component.pipeControllers = []; // empty array of references

        applyOperations(doc, [{
            op: 'insert_array_element', node: 'Holder', component: 'PlayerController',
            property: 'pipeControllers',
            value: { $component: { node: 'Desk', target: 'Table', type: 'cc.MeshRenderer' } }
        }], ctx);

        // The slot serializes as a null hole (not an inline object / dangling
        // ref); the wiring lives in the TargetOverrideInfo.
        assert.deepStrictEqual(component.pipeControllers, [null]);
        const ovs = overridesOf(doc, compIdx);
        assert.strictEqual(ovs.length, 1);
        assert.deepStrictEqual(ovs[0].path, ['pipeControllers', '0']);
        assert.deepStrictEqual(ovs[0].localID, [sourceComponentFileId('Table', 'cc.MeshRenderer')]);
        assert.strictEqual(ovs[0].targetIdx, doc.resolveNode('Desk'));

        assertValid(doc);
        assertFixedPoint(doc);
    });
});

describe('$node through a collapsed instance', () => {
    test('path continuing inside the stub becomes null + node-fileId override', () => {
        const ctx = makeCtx();
        const doc = sceneWithDeskAndHolder(ctx);
        applyOperations(doc, [{
            op: 'set_component_property', node: 'Holder', component: 'PlayerController',
            property: 'anchor', value: { $node: 'Desk/Table/CashRegister' }
        }], ctx);

        const { compIdx, component } = scriptComponent(doc, 'Holder');
        assert.strictEqual(component.anchor, null);
        const [ov] = overridesOf(doc, compIdx);
        assert.deepStrictEqual(ov.path, ['anchor']);
        assert.deepStrictEqual(ov.localID, [sourceNodeFileId('Table/CashRegister')]);
        assert.strictEqual(ov.targetIdx, doc.resolveNode('Desk'));
        assertValid(doc);
        assertFixedPoint(doc);
    });

    test('path landing exactly on the stub stays a regular {__id__}', () => {
        const ctx = makeCtx();
        const doc = sceneWithDeskAndHolder(ctx);
        applyOperations(doc, [{
            op: 'set_component_property', node: 'Holder', component: 'PlayerController',
            property: 'stubRef', value: { $node: 'Desk' }
        }], ctx);
        const { compIdx, component } = scriptComponent(doc, 'Holder');
        assert.deepStrictEqual(component.stubRef, { __id__: doc.resolveNode('Desk') });
        assert.strictEqual(overridesOf(doc, compIdx).length, 0);
        assertValid(doc);
    });

    test('missing internal node reports the source prefab context', () => {
        const ctx = makeCtx();
        const doc = sceneWithDeskAndHolder(ctx);
        assert.throws(() => applyOperations(doc, [{
            op: 'set_component_property', node: 'Holder', component: 'PlayerController',
            property: 'x', value: { $node: 'Desk/Table/Nope' }
        }], ctx), /In source prefab .*TableCash/);
        // A genuinely missing plain node keeps the original error
        assert.throws(() => applyOperations(doc, [{
            op: 'set_component_property', node: 'Holder', component: 'PlayerController',
            property: 'x', value: { $node: 'NoSuch/Node' }
        }], ctx), /Node not found/);
    });

    test('references into NESTED instances are rejected with guidance', () => {
        const ctx = makeCtx();
        const doc = sceneWithDeskAndHolder(ctx);
        // Gold.prefab's child "Coin" is itself a collapsed instance
        applyOperations(doc, [
            { op: 'instantiate_prefab', parent: '/', prefab: 'Prefabs/Gold.prefab', name: 'Nugget' }
        ], ctx);
        assert.throws(() => applyOperations(doc, [{
            op: 'set_component_property', node: 'Holder', component: 'PlayerController',
            property: 'x', value: { $node: 'Nugget/Coin/CoinLP' }
        }], ctx), /nested prefab instance[\s\S]*source asset/);
        assert.throws(() => applyOperations(doc, [{
            op: 'set_component_property', node: 'Holder', component: 'PlayerController',
            property: 'x', value: { $component: { node: 'Nugget', target: 'Coin', type: 'cc.MeshRenderer' } }
        }], ctx), /nested prefab instance/);
    });
});

describe('override lifecycle', () => {
    test('upsert replaces the entry for the same (source, propertyPath)', () => {
        const ctx = makeCtx();
        const doc = sceneWithDeskAndHolder(ctx);
        applyOperations(doc, [
            {
                op: 'set_component_property', node: 'Holder', component: 'PlayerController',
                property: 'view', value: { $node: 'Desk/Table/CashRegister' }
            },
            {
                op: 'set_component_property', node: 'Holder', component: 'PlayerController',
                property: 'view', value: { $node: 'Desk/Table' }
            }
        ], ctx);
        const { compIdx } = scriptComponent(doc, 'Holder');
        const ovs = overridesOf(doc, compIdx);
        assert.strictEqual(ovs.length, 1, 'no duplicates');
        assert.deepStrictEqual(ovs[0].localID, [sourceNodeFileId('Table')]);
        assertValid(doc);
        assertFixedPoint(doc);
    });

    test('overwriting with a plain value drops the override (no silent revert)', () => {
        const ctx = makeCtx();
        const doc = sceneWithDeskAndHolder(ctx);
        applyOperations(doc, [
            {
                op: 'set_component_property', node: 'Holder', component: 'PlayerController',
                property: 'view', value: { $node: 'Desk/Table' }
            },
            {
                op: 'set_component_property', node: 'Holder', component: 'PlayerController',
                property: 'view', value: null
            }
        ], ctx);
        const { compIdx, component } = scriptComponent(doc, 'Holder');
        assert.strictEqual(component.view, null);
        assert.strictEqual(overridesOf(doc, compIdx).length, 0);
        assertValid(doc);
        assertFixedPoint(doc); // dropped TargetOverrideInfo/TargetInfo are GC'd
    });

    test('set_asset_ref on an overridden property drops the override too', () => {
        const ctx = makeCtx();
        const doc = sceneWithDeskAndHolder(ctx);
        applyOperations(doc, [
            {
                op: 'set_component_property', node: 'Holder', component: 'PlayerController',
                property: 'view', value: { $node: 'Desk/Table' }
            },
            {
                op: 'set_asset_ref', node: 'Holder', component: 'PlayerController',
                property: 'view', asset: 'Materials/Dynamite.mtl'
            }
        ], ctx);
        const { compIdx, component } = scriptComponent(doc, 'Holder');
        assert.ok(component.view.__uuid__);
        assert.strictEqual(overridesOf(doc, compIdx).length, 0);
        assertValid(doc);
    });

    test('remove_node of the stub prunes overrides pointing at it', () => {
        const ctx = makeCtx();
        const doc = sceneWithDeskAndHolder(ctx);
        applyOperations(doc, [{
            op: 'set_component_property', node: 'Holder', component: 'PlayerController',
            property: 'view', value: { $node: 'Desk/Table' }
        }], ctx);
        const { compIdx, component } = scriptComponent(doc, 'Holder');
        applyOperations(doc, [{ op: 'remove_node', node: 'Desk' }], ctx);
        assert.strictEqual(overridesOf(doc, compIdx).length, 0);
        assert.strictEqual(component.view, null, 'serialized value already null');
        assertFixedPoint(doc); // renumber drops the detached subtree
        assertValid(doc);
    });
});

describe('arrays', () => {
    test('mixed array: plain refs serialize, instance refs become element overrides', () => {
        const ctx = makeCtx();
        const doc = sceneWithDeskAndHolder(ctx);
        applyOperations(doc, [{
            op: 'set_component_property', node: 'Holder', component: 'PlayerController',
            property: 'points',
            value: [
                { $node: 'Desk/Table/CashRegister' },
                { $node: 'Main Light' }
            ]
        }], ctx);

        const { compIdx, component } = scriptComponent(doc, 'Holder');
        assert.strictEqual(component.points.length, 2);
        assert.strictEqual(component.points[0], null);
        assert.deepStrictEqual(component.points[1], { __id__: doc.resolveNode('Main Light') });

        const ovs = overridesOf(doc, compIdx);
        assert.strictEqual(ovs.length, 1);
        assert.deepStrictEqual(ovs[0].path, ['points', '0']); // segments are strings
        assert.deepStrictEqual(ovs[0].localID, [sourceNodeFileId('Table/CashRegister')]);
        assertValid(doc);
        assertFixedPoint(doc);
    });

    test('element write "points[1]" creates a per-index override', () => {
        const ctx = makeCtx();
        const doc = sceneWithDeskAndHolder(ctx);
        applyOperations(doc, [
            {
                op: 'set_component_property', node: 'Holder', component: 'PlayerController',
                property: 'points', value: [{ $node: 'Main Light' }, null]
            },
            {
                op: 'set_component_property', node: 'Holder', component: 'PlayerController',
                property: 'points[1]', value: { $node: 'Desk/Table' }
            }
        ], ctx);
        const { compIdx, component } = scriptComponent(doc, 'Holder');
        assert.strictEqual(component.points[1], null);
        const ovs = overridesOf(doc, compIdx);
        assert.deepStrictEqual(ovs.map(o => o.path), [['points', '1']]);
        assertValid(doc);
    });

    test('whole-array rewrite with plain values drops element overrides', () => {
        const ctx = makeCtx();
        const doc = sceneWithDeskAndHolder(ctx);
        applyOperations(doc, [
            {
                op: 'set_component_property', node: 'Holder', component: 'PlayerController',
                property: 'points',
                value: [{ $node: 'Desk/Table' }, { $node: 'Desk/Table/CashRegister' }]
            },
            {
                op: 'set_component_property', node: 'Holder', component: 'PlayerController',
                property: 'points', value: [{ $node: 'Main Light' }]
            }
        ], ctx);
        const { compIdx, component } = scriptComponent(doc, 'Holder');
        assert.strictEqual(overridesOf(doc, compIdx).length, 0);
        assert.deepStrictEqual(component.points, [{ __id__: doc.resolveNode('Main Light') }]);
        assertValid(doc);
        assertFixedPoint(doc);
    });
});

// ------------------------------------------------------------ phase B2

/** Overrides whose source is a stub with the given sourceInfo localID */
function instanceSourcedOverrides(doc, stubIdx) {
    const registry = doc.getObject(doc.root.node._prefab.__id__);
    return (registry.targetOverrides ?? [])
        .filter(isRef)
        .map(r => doc.getObject(r.__id__))
        .filter(o => isRef(o.source) && o.source.__id__ === stubIdx && o.sourceInfo !== null)
        .map(o => ({
            obj: o,
            path: o.propertyPath,
            sourceLocalID: isRef(o.sourceInfo) ? doc.getObject(o.sourceInfo.__id__).localID : null,
            localID: isRef(o.targetInfo) ? doc.getObject(o.targetInfo.__id__).localID : null,
            targetIdx: isRef(o.target) ? o.target.__id__ : null
        }));
}

function deskOverridesFor(doc, localId) {
    const instance = doc.instanceOf(doc.resolveNode('Desk'));
    return instance.propertyOverrides
        .filter(isRef)
        .map(r => doc.getObject(r.__id__))
        .filter(o => doc.getObject(o.targetInfo.__id__).localID[0] === localId);
}

describe('set_instance_property with reference values (sourceInfo form)', () => {
    const MESH_RENDERER = () => sourceComponentFileId('Table', 'cc.MeshRenderer');

    test('$node into the SAME instance: no property override, golden-shaped TargetOverrideInfo', () => {
        const ctx = makeCtx();
        const doc = sceneWithDeskAndHolder(ctx);
        applyOperations(doc, [{
            op: 'set_instance_property', node: 'Desk', target: 'Table',
            component: 'cc.MeshRenderer', property: 'anchorNode',
            value: { $node: 'Desk/Table/CashRegister' }
        }], ctx);

        const stubIdx = doc.resolveNode('Desk');
        // The editor writes NO CCPropertyOverrideInfo for a whole-value
        // reference — the TargetOverrideInfo alone carries the wiring
        assert.strictEqual(deskOverridesFor(doc, MESH_RENDERER())
            .filter(o => o.propertyPath[0] === 'anchorNode').length, 0);

        const ovs = instanceSourcedOverrides(doc, stubIdx);
        assert.strictEqual(ovs.length, 1);
        const { obj } = ovs[0];
        // Exact golden key set and order (Main.scene_V2: trigger/progressFill/…)
        assert.deepStrictEqual(Object.keys(obj),
            ['__type__', 'source', 'sourceInfo', 'propertyPath', 'target', 'targetInfo']);
        assert.strictEqual(obj.source.__id__, stubIdx);
        assert.deepStrictEqual(ovs[0].sourceLocalID, [MESH_RENDERER()]);
        assert.deepStrictEqual(ovs[0].path, ['anchorNode']);
        assert.strictEqual(ovs[0].targetIdx, stubIdx);
        assert.deepStrictEqual(ovs[0].localID, [sourceNodeFileId('Table/CashRegister')]);

        assertValid(doc);
        assertFixedPoint(doc);
        // Canonical order: override, its sourceInfo TargetInfo, its targetInfo
        const oIdx = doc.objects.findIndex(o =>
            o.__type__ === 'cc.TargetOverrideInfo' && o.propertyPath[0] === 'anchorNode');
        assert.strictEqual(doc.objects[oIdx].sourceInfo.__id__, oIdx + 1);
        assert.strictEqual(doc.objects[oIdx].targetInfo.__id__, oIdx + 2);
    });

    test('$component into ANOTHER instance (cross-instance wiring)', () => {
        const ctx = makeCtx();
        const doc = sceneWithDeskAndHolder(ctx);
        applyOperations(doc, [
            { op: 'instantiate_prefab', parent: '/', prefab: 'Prefabs/Sprite(2).prefab', name: 'Box' },
            {
                op: 'set_instance_property', node: 'Desk', target: 'Table',
                component: 'cc.MeshRenderer', property: 'other',
                value: { $component: { node: 'Box', type: 'cc.MeshRenderer' } }
            }
        ], ctx);

        const [ov] = instanceSourcedOverrides(doc, doc.resolveNode('Desk'));
        assert.deepStrictEqual(ov.sourceLocalID, [MESH_RENDERER()]);
        assert.strictEqual(ov.targetIdx, doc.resolveNode('Box'));
        assertValid(doc);
        assertFixedPoint(doc);
    });

    test('plain scene reference stays {__id__} in the override value (golden playerGoldStorage form)', () => {
        const ctx = makeCtx();
        const doc = sceneWithDeskAndHolder(ctx);
        applyOperations(doc, [{
            op: 'set_instance_property', node: 'Desk', target: 'Table',
            component: 'cc.MeshRenderer', property: 'lightRef',
            value: { $node: 'Main Light' }
        }], ctx);

        const [ov] = deskOverridesFor(doc, MESH_RENDERER())
            .filter(o => o.propertyPath[0] === 'lightRef');
        assert.deepStrictEqual(ov.value, { __id__: doc.resolveNode('Main Light') });
        assert.strictEqual(instanceSourcedOverrides(doc, doc.resolveNode('Desk')).length, 0);
        assertValid(doc);
        assertFixedPoint(doc);
    });

    test('upsert replaces the entry; a plain overwrite drops it', () => {
        const ctx = makeCtx();
        const doc = sceneWithDeskAndHolder(ctx);
        const setRef = (target) => ({
            op: 'set_instance_property', node: 'Desk', target: 'Table',
            component: 'cc.MeshRenderer', property: 'anchorNode', value: { $node: target }
        });
        applyOperations(doc, [setRef('Desk/Table/CashRegister'), setRef('Desk/Table')], ctx);
        const stubIdx = doc.resolveNode('Desk');
        let ovs = instanceSourcedOverrides(doc, stubIdx);
        assert.strictEqual(ovs.length, 1, 'no duplicates');
        assert.deepStrictEqual(ovs[0].localID, [sourceNodeFileId('Table')]);

        applyOperations(doc, [{
            op: 'set_instance_property', node: 'Desk', target: 'Table',
            component: 'cc.MeshRenderer', property: 'anchorNode', value: 5
        }], ctx);
        assert.strictEqual(instanceSourcedOverrides(doc, stubIdx).length, 0);
        const [plain] = deskOverridesFor(doc, MESH_RENDERER())
            .filter(o => o.propertyPath[0] === 'anchorNode');
        assert.strictEqual(plain.value, 5);
        assertValid(doc);
        assertFixedPoint(doc);
    });

    test('remove_instance_override drops the reference override too', () => {
        const ctx = makeCtx();
        const doc = sceneWithDeskAndHolder(ctx);
        applyOperations(doc, [{
            op: 'set_instance_property', node: 'Desk', target: 'Table',
            component: 'cc.MeshRenderer', property: 'anchorNode',
            value: { $node: 'Desk/Table/CashRegister' }
        }], ctx);
        const [result] = applyOperations(doc, [{
            op: 'remove_instance_override', node: 'Desk', target: 'Table',
            component: 'cc.MeshRenderer', property: 'anchorNode'
        }], ctx);
        assert.match(result.summary, /removed 1 override/);
        assert.strictEqual(instanceSourcedOverrides(doc, doc.resolveNode('Desk')).length, 0);
        assertValid(doc);
        assertFixedPoint(doc);
    });

    test('mixed array: plain elements serialize, instance elements become element overrides', () => {
        const ctx = makeCtx();
        const doc = sceneWithDeskAndHolder(ctx);
        applyOperations(doc, [{
            op: 'set_instance_property', node: 'Desk', target: 'Table',
            component: 'cc.MeshRenderer', property: 'points',
            value: [{ $node: 'Desk/Table/CashRegister' }, { $node: 'Main Light' }]
        }], ctx);

        const [ov] = deskOverridesFor(doc, MESH_RENDERER())
            .filter(o => o.propertyPath[0] === 'points');
        assert.deepStrictEqual(ov.value,
            [null, { __id__: doc.resolveNode('Main Light') }]);

        const refs = instanceSourcedOverrides(doc, doc.resolveNode('Desk'));
        assert.strictEqual(refs.length, 1);
        assert.deepStrictEqual(refs[0].path, ['points', '0']); // segments are strings
        assert.deepStrictEqual(refs[0].localID, [sourceNodeFileId('Table/CashRegister')]);
        assertValid(doc);
        assertFixedPoint(doc);
    });

    test('golden sourceInfo overrides pass validation with a project', () => {
        // The real scene carries 24 editor-authored sourceInfo entries; the
        // structural checks must accept them all (their prefabs are not in
        // the mock project, so resolution warnings are skipped).
        const doc = loadScene();
        const { errors } = new Validator(doc, makeCtx().assetIndex, { projectRoot: MOCK_PROJECT }).validate();
        assert.deepStrictEqual(errors, []);
    });
});

describe('registry bootstrap', () => {
    test('a prefab document stores overrides on its root PrefabInfo', () => {
        const ctx = makeCtx();
        const doc = SceneDocument.load(GOLDEN('TableCash.prefab'));
        applyOperations(doc, [
            { op: 'instantiate_prefab', parent: 'Table', prefab: 'Prefabs/Crate.prefab', name: 'Box' },
            { op: 'add_component', node: 'Table', type: 'PlayerController' },
            {
                op: 'set_component_property', node: 'Table', component: 'PlayerController',
                property: 'crate',
                value: { $component: { node: 'Table/Box', target: 'Visual', type: 'cc.MeshRenderer' } }
            }
        ], ctx);

        const rootInfo = doc.getObject(doc.root.node._prefab.__id__);
        assert.strictEqual(rootInfo.targetOverrides.length, 1);
        const ov = doc.getObject(rootInfo.targetOverrides[0].__id__);
        assert.strictEqual(ov.__type__, 'cc.TargetOverrideInfo');
        assert.strictEqual(ov.target.__id__, doc.resolveNode('Table/Box'));
        assertValid(doc);
        assertFixedPoint(doc);
    });

    test('golden editor-authored overrides survive unrelated edits untouched', () => {
        const ctx = makeCtx();
        const doc = loadScene();
        const before = JSON.stringify(
            doc.objects.filter(o => o.__type__ === 'cc.TargetOverrideInfo'));
        applyOperations(doc, [
            { op: 'add_node', parent: '/', name: 'Extra' }
        ], ctx);
        const after = JSON.stringify(
            doc.objects.filter(o => o.__type__ === 'cc.TargetOverrideInfo'));
        assert.strictEqual(after, before);
        assertValid(doc);
    });
});

describe('prune_dangling_overrides', () => {
    /**
     * Corrupt a document the way editor reworks do (observed in the real
     * game scene): a TargetOverrideInfo with source: null whose target is a
     * bare leftover node, parked on an instance stub's own PrefabInfo.
     */
    function corrupt(doc, stubRef) {
        const stubIdx = doc.resolveNode(stubRef);
        const info = doc.getObject(doc.getObject(stubIdx)._prefab.__id__);
        const orphanIdx = doc.addObject({ __type__: 'cc.Node', __editorExtras__: {} });
        const tiIdx = doc.addObject({ __type__: 'cc.TargetInfo', localID: ['deadbeafdeadbeafdead'] });
        const ovIdx = doc.addObject({
            __type__: 'cc.TargetOverrideInfo',
            source: null,
            sourceInfo: null,
            propertyPath: ['animation'],
            target: { __id__: orphanIdx },
            targetInfo: { __id__: tiIdx }
        });
        info.targetOverrides = [{ __id__: ovIdx }];
        return { orphanIdx, ovIdx };
    }

    test('detects the corruption; prune + renumber leave a valid document', () => {
        const ctx = makeCtx();
        const doc = sceneWithDeskAndHolder(ctx);
        corrupt(doc, 'Desk');

        const { errors, warnings } = new Validator(doc).validate();
        // The dead override itself is only a warning (engine ignores it); the
        // orphan target node it left behind is the genuine blocking error.
        assert.ok(warnings.some(w => /engine ignores this override.*source is null/.test(w)), warnings.join('\n'));
        assert.ok(errors.some(e => /has no _id/.test(e)), errors.join('\n'));

        const dangling = findDanglingOverrides(doc);
        assert.strictEqual(dangling.length, 1);
        assert.strictEqual(dangling[0].propertyPath, 'animation');
        assert.ok(dangling[0].reasons.some(r => /source is null/.test(r)));
        assert.ok(dangling[0].reasons.some(r => /target node is detached/.test(r)));

        const results = applyOperations(doc, [{ op: 'prune_dangling_overrides' }], ctx);
        assert.match(results[0].summary, /removed 1 dangling target-override record/);
        doc.renumber();
        assertValid(doc);

        // The orphan node and its TargetInfo were garbage-collected
        assert.ok(!doc.objects.some(o =>
            o.__type__ === 'cc.TargetInfo' && o.localID?.[0] === 'deadbeafdeadbeafdead'));
        // The stub PrefabInfo is back to the editor's no-overrides form
        const info = doc.getObject(doc.getObject(doc.resolveNode('Desk'))._prefab.__id__);
        assert.strictEqual(info.targetOverrides, null);
        assertFixedPoint(doc);
    });

    test('live overrides survive pruning', () => {
        const ctx = makeCtx();
        const doc = sceneWithDeskAndHolder(ctx);
        applyOperations(doc, [{
            op: 'set_component_property', node: 'Holder', component: 'PlayerController',
            property: 'tableView',
            value: { $component: { node: 'Desk', target: 'Table', type: 'cc.MeshRenderer' } }
        }], ctx);
        corrupt(doc, 'Desk');

        applyOperations(doc, [{ op: 'prune_dangling_overrides' }], ctx);
        doc.renumber();
        assertValid(doc);

        const { compIdx } = scriptComponent(doc, 'Holder');
        assert.strictEqual(overridesOf(doc, compIdx).length, 1,
            'the live tableView override must survive');
    });

    test('live override sourced from a mounted-child node is not pruned (#2)', () => {
        const ctx = makeCtx();
        const doc = sceneWithDeskAndHolder(ctx);
        const stubIdx = doc.resolveNode('Desk');
        const instance = doc.instanceOf(stubIdx);
        const rootFileId = doc.getObject(doc.getObject(stubIdx)._prefab.__id__).fileId;

        // Mounted-child node: serialized with _parent: null, so nodePath() is
        // null even though the engine resolves it at load.
        const childIdx = doc.addObject({
            __type__: 'cc.Node', _name: 'MountedChild', _parent: null,
            _children: [], _components: [], _prefab: null
        });
        const compIdx = doc.addObject({
            __type__: 'cc.MeshRenderer', node: { __id__: childIdx }, __prefab: null
        });
        doc.getObject(childIdx)._components.push({ __id__: compIdx });

        // A well-formed, LIVE B1 override sourced from that mounted-child comp.
        const ovIdx = doc.addObject({
            __type__: 'cc.TargetOverrideInfo',
            source: { __id__: compIdx },
            sourceInfo: null,
            propertyPath: ['someRef'],
            target: { __id__: stubIdx },
            targetInfo: {
                __id__: doc.addObject({ __type__: 'cc.TargetInfo', localID: ['innerFileId00000000'] })
            }
        });
        const registry = doc.getObject(doc.root.node._prefab.__id__);
        (registry.targetOverrides ??= []).push({ __id__: ovIdx });

        // Sanity: without a MountedChildrenInfo, the _parent:null source reads
        // as detached and IS flagged — proving the check still fires.
        assert.ok(findDanglingOverrides(doc).some(d => d.idx === ovIdx),
            'sanity: an unregistered _parent:null source is flagged');

        // Register the node as a mounted child of the instance.
        const mciIdx = doc.addObject({
            __type__: 'cc.MountedChildrenInfo',
            targetInfo: {
                __id__: doc.addObject({ __type__: 'cc.TargetInfo', localID: [rootFileId] })
            },
            nodes: [{ __id__: childIdx }]
        });
        (instance.mountedChildren ??= []).push({ __id__: mciIdx });

        assert.ok(!findDanglingOverrides(doc).some(d => d.idx === ovIdx),
            'a live override sourced from a mounted-child node must survive pruning');
    });

    test('idempotent: clean document is a no-op', () => {
        const ctx = makeCtx();
        const doc = sceneWithDeskAndHolder(ctx);
        const results = applyOperations(doc, [{ op: 'prune_dangling_overrides' }], ctx);
        assert.match(results[0].summary, /no dangling target-override records found/);
        assertValid(doc);
    });

    test('golden corpus is never flagged (editor forms like target: null stay)', () => {
        for (const file of ['Main.scene_V2.scene', 'TableCash.prefab', 'ZombieBuyer.prefab',
            'Gold.prefab', 'HUD.prefab']) {
            const doc = SceneDocument.load(GOLDEN(file));
            assert.deepStrictEqual(findDanglingOverrides(doc), [], file);
        }
    });
});
