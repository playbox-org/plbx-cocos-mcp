/**
 * instances tests - collapsed prefab-instance operations (Phase 2)
 *
 * Stub/PrefabInfo/PrefabInstance shapes are asserted against the golden
 * corpus conventions; every mutating batch must keep the canonical fixed
 * point (load → renumber → serialize stable) and pass validation.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { SceneDocument, isRef } from '../../src/document/SceneDocument.js';
import { loadSourcePrefab } from '../../src/document/instances.js';
import { applyOperations, OperationError } from '../../src/document/operations.js';
import { Validator } from '../../src/document/Validator.js';
import { AssetIndex } from '../../src/core/AssetIndex.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = (f) => path.join(__dirname, '..', 'fixtures', 'golden', f);
const MOCK_PROJECT = path.join(__dirname, '..', 'fixtures', 'mock-project');
const MOCK = (f) => path.join(MOCK_PROJECT, f);

// Root-node fileIds of the source prefabs (from the fixture files themselves)
const GOLD_ROOT_FILE_ID = 'd3kyhLOepHhoa/4h0Nq0pc';
const TABLECASH_ROOT_FILE_ID = 'few/hn6kZBKbTUOTAK9uKh';
const COIN_GLTF_ROOT_FILE_ID = '0auORVX99QSYHjxYweQevA';

const loadScene = () => SceneDocument.load(GOLDEN('Main.scene_V2.scene'));
const loadPrefab = () => SceneDocument.load(GOLDEN('TableCash.prefab'));
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

function stubParts(doc, ref) {
    const stubIdx = doc.resolveNode(ref);
    const stub = doc.getObject(stubIdx);
    const info = doc.getObject(stub._prefab.__id__);
    const instance = doc.getObject(info.instance.__id__);
    return { stubIdx, stub, info, instance };
}

function overrides(doc, instance) {
    return instance.propertyOverrides.map(r => {
        const o = doc.getObject(r.__id__);
        return { path: o.propertyPath, value: o.value, localID: doc.getObject(o.targetInfo.__id__).localID };
    });
}

describe('instantiate_prefab', () => {
    test('creates a collapsed stub with editor-shaped machinery in a scene', () => {
        const doc = loadScene();
        const [result] = applyOperations(doc, [
            { op: 'instantiate_prefab', parent: '/', prefab: 'Prefabs/Gold.prefab', position: { x: 2, z: -3 } }
        ], makeCtx());

        const { stubIdx, stub, info, instance } = stubParts(doc, 'Gold');
        assert.strictEqual(result.nodeIdx, stubIdx);

        // Stub: exactly the golden key set, no _name/_children/_components
        assert.deepStrictEqual(Object.keys(stub),
            ['__type__', '_objFlags', '_parent', '_prefab', '__editorExtras__']);

        // PrefabInfo: asset by uuid, fileId = source prefab root fileId
        assert.strictEqual(info.asset.__uuid__, '836478c3-ffde-4110-8347-cfda26288652');
        assert.strictEqual(info.asset.__expectedType__, 'cc.Prefab');
        assert.strictEqual(info.fileId, GOLD_ROOT_FILE_ID);
        assert.strictEqual(info.targetOverrides, null);
        // Gold.prefab contains a nested instance (Coin) → editor omits the key
        // on the scene stub (verified via editor re-save)
        assert.ok(!('nestedPrefabInstanceRoots' in info));

        // PrefabInstance: scene instances have prefabRootNode null
        assert.strictEqual(instance.prefabRootNode, null);
        assert.deepStrictEqual(instance.mountedChildren, []);
        assert.deepStrictEqual(instance.removedComponents, []);
        assert.match(instance.fileId, /^[A-Za-z0-9+/]{22}$/);

        // Default override set: _name, _lpos, _lrot, _euler @ root fileId
        const ovs = overrides(doc, instance);
        assert.deepStrictEqual(ovs.map(o => o.path.join('.')), ['_name', '_lpos', '_lrot', '_euler']);
        assert.ok(ovs.every(o => o.localID.length === 1 && o.localID[0] === GOLD_ROOT_FILE_ID));
        assert.strictEqual(ovs[0].value, 'Gold');
        assert.deepStrictEqual(ovs[1].value, { __type__: 'cc.Vec3', x: 2, y: 0, z: -3 });

        // Scene registry lists the new stub
        const registry = doc.getObject(doc.root.node._prefab.__id__);
        assert.ok(registry.nestedPrefabInstanceRoots.some(r => isRef(r) && r.__id__ === stubIdx));

        assertValid(doc);
        assertFixedPoint(doc);
    });

    test('rotation/scale/name options become overrides', () => {
        const doc = loadScene();
        applyOperations(doc, [{
            op: 'instantiate_prefab', parent: '/', prefab: 'Prefabs/Gold.prefab',
            name: 'Coin7', rotation: { y: 90 }, scale: { x: 2, y: 2, z: 2 }
        }], makeCtx());

        const { instance } = stubParts(doc, 'Coin7');
        const ovs = overrides(doc, instance);
        assert.deepStrictEqual(ovs.map(o => o.path.join('.')),
            ['_name', '_lpos', '_lrot', '_euler', '_lscale']);
        assert.strictEqual(ovs[0].value, 'Coin7');
        assert.deepStrictEqual(ovs[3].value, { __type__: 'cc.Vec3', x: 0, y: 90, z: 0 });
        assert.ok(Math.abs(ovs[2].value.y - Math.SQRT1_2) < 1e-9);
        assert.ok(Math.abs(ovs[2].value.w - Math.SQRT1_2) < 1e-9);
        assert.deepStrictEqual(ovs[4].value, { __type__: 'cc.Vec3', x: 2, y: 2, z: 2 });
    });

    test('scene stub of a plain source keeps nestedPrefabInstanceRoots: null', () => {
        const doc = loadScene();
        applyOperations(doc, [
            { op: 'instantiate_prefab', parent: '/', prefab: 'Prefabs/TableCash.prefab', name: 'Desk' }
        ], makeCtx());
        const { info } = stubParts(doc, 'Desk');
        assert.strictEqual(info.nestedPrefabInstanceRoots, null);
    });

    test('scene registry stays in hierarchy DFS order, not insertion order', () => {
        const ctx = makeCtx();
        const doc = loadScene();
        // Instantiate into a LATE subtree first, then into an EARLY one —
        // the registry must still list them in hierarchy order.
        applyOperations(doc, [
            { op: 'instantiate_prefab', parent: 'Dummies', prefab: 'Prefabs/Crate.prefab', name: 'LateBox' },
            { op: 'instantiate_prefab', parent: '[WORLD]', prefab: 'Prefabs/Crate.prefab', name: 'EarlyBox' }
        ], ctx);

        const registry = doc.getObject(doc.root.node._prefab.__id__).nestedPrefabInstanceRoots;
        const early = registry.findIndex(r => isRef(r) && r.__id__ === doc.resolveNode('[WORLD]/EarlyBox'));
        const late = registry.findIndex(r => isRef(r) && r.__id__ === doc.resolveNode('Dummies/LateBox'));
        assert.ok(early !== -1 && late !== -1);
        assert.ok(early < late, `registry order: EarlyBox @${early} must precede LateBox @${late}`);
        assertValid(doc);
        assertFixedPoint(doc);
    });

    test('model file sugar resolves the gltf-scene prefab from library/', () => {
        const doc = loadScene();
        applyOperations(doc, [
            { op: 'instantiate_prefab', parent: '/', prefab: 'Models/Coin.fbx' }
        ], makeCtx());

        const { info } = stubParts(doc, 'Coin');
        assert.strictEqual(info.asset.__uuid__, '65522416-77c3-44a9-afb1-f22a7090b129@4b8b9');
        assert.strictEqual(info.fileId, COIN_GLTF_ROOT_FILE_ID);
        assertValid(doc);
        assertFixedPoint(doc);
    });

    test('nesting into a prefab wires prefabRootNode and the root registry', () => {
        const doc = loadPrefab();
        applyOperations(doc, [
            { op: 'instantiate_prefab', parent: 'Table', prefab: 'Prefabs/Gold.prefab' }
        ], makeCtx());

        const { stubIdx, info, instance } = stubParts(doc, 'Table/Gold');
        // Nested-in-prefab stubs omit nestedPrefabInstanceRoots (golden Gold.prefab shape)
        assert.ok(!('nestedPrefabInstanceRoots' in info));
        assert.deepStrictEqual(instance.prefabRootNode, { __id__: doc.root.idx });

        const rootInfo = doc.getObject(doc.root.node._prefab.__id__);
        assert.ok(rootInfo.nestedPrefabInstanceRoots.some(r => isRef(r) && r.__id__ === stubIdx));

        assertValid(doc);
        assertFixedPoint(doc);
    });

    test('rejects cycles, unknown assets and non-prefab targets', () => {
        const ctx = makeCtx();
        const own = SceneDocument.load(MOCK('assets/Prefabs/TableCash.prefab'));
        assert.throws(() =>
            applyOperations(own, [
                { op: 'instantiate_prefab', parent: '/', prefab: 'Prefabs/TableCash.prefab' }
            ], ctx),
            /cycle/);

        const doc = loadScene();
        assert.throws(() =>
            applyOperations(doc, [
                { op: 'instantiate_prefab', parent: '/', prefab: 'Prefabs/Missing.prefab' }
            ], makeCtx()),
            /not found/);
        assert.throws(() =>
            applyOperations(doc, [
                { op: 'instantiate_prefab', parent: '/', prefab: 'Materials/Dynamite.mtl' }
            ], makeCtx()),
            /not a prefab/);
    });

    test('reparenting an instance stub restores registry DFS order', () => {
        const ctx = makeCtx();
        const doc = loadScene();
        applyOperations(doc, [
            { op: 'instantiate_prefab', parent: '[WORLD]', prefab: 'Prefabs/Crate.prefab', name: 'EarlyBox' },
            { op: 'instantiate_prefab', parent: 'Dummies', prefab: 'Prefabs/Crate.prefab', name: 'LateBox' }
        ], ctx);
        // Move LateBox into the EARLY subtree ahead of EarlyBox — the registry
        // must follow the new hierarchy order, not keep insertion order.
        applyOperations(doc, [
            { op: 'reparent', node: 'Dummies/LateBox', newParent: '[WORLD]', index: 0 }
        ], ctx);

        const registry = doc.getObject(doc.root.node._prefab.__id__).nestedPrefabInstanceRoots;
        const late = registry.findIndex(r => isRef(r) && r.__id__ === doc.resolveNode('[WORLD]/LateBox'));
        const early = registry.findIndex(r => isRef(r) && r.__id__ === doc.resolveNode('[WORLD]/EarlyBox'));
        assert.ok(late !== -1 && early !== -1);
        assert.ok(late < early, `registry order: LateBox @${late} must precede EarlyBox @${early}`);
        assertValid(doc);
        assertFixedPoint(doc);
    });

    test('reparenting a plain node whose subtree holds a stub re-sorts too', () => {
        const ctx = makeCtx();
        const doc = loadScene();
        applyOperations(doc, [
            { op: 'instantiate_prefab', parent: '[WORLD]', prefab: 'Prefabs/Crate.prefab', name: 'EarlyBox' },
            { op: 'add_node', parent: 'Dummies', name: 'Group' },
            { op: 'instantiate_prefab', parent: 'Dummies/Group', prefab: 'Prefabs/Crate.prefab', name: 'LateBox' },
            { op: 'reparent', node: 'Dummies/Group', newParent: '[WORLD]', index: 0 }
        ], ctx);

        const registry = doc.getObject(doc.root.node._prefab.__id__).nestedPrefabInstanceRoots;
        const late = registry.findIndex(r => isRef(r) && r.__id__ === doc.resolveNode('[WORLD]/Group/LateBox'));
        const early = registry.findIndex(r => isRef(r) && r.__id__ === doc.resolveNode('[WORLD]/EarlyBox'));
        assert.ok(late !== -1 && early !== -1 && late < early,
            `registry order: LateBox @${late} must precede EarlyBox @${early}`);
        assertValid(doc);
        assertFixedPoint(doc);
    });

    test('instance stub can then be removed cleanly (registry pruned)', () => {
        const doc = loadScene();
        const ctx = makeCtx();
        applyOperations(doc, [
            { op: 'instantiate_prefab', parent: '/', prefab: 'Prefabs/Gold.prefab', name: 'Doomed' }
        ], ctx);
        const before = doc.getObject(doc.root.node._prefab.__id__).nestedPrefabInstanceRoots.length;
        applyOperations(doc, [{ op: 'remove_node', node: 'Doomed' }], ctx);
        const after = doc.getObject(doc.root.node._prefab.__id__).nestedPrefabInstanceRoots.length;
        assert.strictEqual(after, before - 1);
        assertFixedPoint(doc); // renumber drops the detached subtree
        assertValid(doc);
    });
});

describe('set_instance_property', () => {
    /** Scene with a TableCash instance named "Desk" at the scene root */
    const sceneWithDesk = (ctx) => {
        const doc = loadScene();
        applyOperations(doc, [{
            op: 'instantiate_prefab', parent: '/', prefab: 'Prefabs/TableCash.prefab',
            name: 'Desk', position: { x: 1 }
        }], ctx);
        return doc;
    };

    test('root position updates the existing override in place (merged)', () => {
        const ctx = makeCtx();
        const doc = sceneWithDesk(ctx);
        applyOperations(doc, [
            { op: 'set_instance_property', node: 'Desk', property: 'position', value: { y: 5 } }
        ], ctx);

        const { instance } = stubParts(doc, 'Desk');
        const ovs = overrides(doc, instance);
        const lpos = ovs.filter(o => o.path.join('.') === '_lpos');
        assert.strictEqual(lpos.length, 1); // updated, not duplicated
        assert.deepStrictEqual(lpos[0].value, { __type__: 'cc.Vec3', x: 1, y: 5, z: 0 });
        assertValid(doc);
        assertFixedPoint(doc);
    });

    test('rename changes the resolvable node name', () => {
        const ctx = makeCtx();
        const doc = sceneWithDesk(ctx);
        applyOperations(doc, [
            { op: 'set_instance_property', node: 'Desk', property: 'name', value: 'CashDesk' }
        ], ctx);
        assert.ok(doc.resolveNode('CashDesk'));
        assert.throws(() => doc.resolveNode('Desk'), /not found/i);
    });

    test('rotation writes paired _euler and _lrot overrides', () => {
        const ctx = makeCtx();
        const doc = sceneWithDesk(ctx);
        applyOperations(doc, [
            { op: 'set_instance_property', node: 'Desk', property: 'rotation', value: { y: 180 } }
        ], ctx);
        const { instance } = stubParts(doc, 'Desk');
        const byPath = Object.fromEntries(overrides(doc, instance).map(o => [o.path.join('.'), o.value]));
        assert.strictEqual(byPath._euler.y, 180);
        assert.ok(Math.abs(byPath._lrot.y - 1) < 1e-9);
        assert.ok(Math.abs(byPath._lrot.w) < 1e-9);
        assertFixedPoint(doc);
    });

    test('targets internal nodes of the source prefab via their fileId', () => {
        const ctx = makeCtx();
        const doc = sceneWithDesk(ctx);
        applyOperations(doc, [{
            op: 'set_instance_property', node: 'Desk', target: 'Table/CashRegister',
            property: 'active', value: false
        }], ctx);

        // fileId of Table/CashRegister inside the source prefab
        const source = SceneDocument.load(MOCK('assets/Prefabs/TableCash.prefab'));
        const srcIdx = source.resolveNode('Table/CashRegister');
        const srcFileId = source.getObject(source.getObject(srcIdx)._prefab.__id__).fileId;

        const { instance } = stubParts(doc, 'Desk');
        const ov = overrides(doc, instance).find(o => o.path.join('.') === '_active');
        assert.deepStrictEqual(ov.localID, [srcFileId]);
        assert.strictEqual(ov.value, false);
        assert.notStrictEqual(srcFileId, TABLECASH_ROOT_FILE_ID);
        assertValid(doc);
        assertFixedPoint(doc);
    });

    test('component overrides use the CompPrefabInfo fileId and string paths', () => {
        const ctx = makeCtx();
        const doc = sceneWithDesk(ctx);
        applyOperations(doc, [
            {
                op: 'set_instance_property', node: 'Desk', target: 'Table',
                component: 'cc.MeshRenderer', property: 'shadowCastingMode', value: 1
            },
            {
                op: 'set_instance_property', node: 'Desk', target: 'Table',
                component: 'cc.MeshRenderer', property: 'materials[0]',
                value: { $asset: 'Materials/Dynamite.mtl' }
            }
        ], ctx);

        const source = SceneDocument.load(MOCK('assets/Prefabs/TableCash.prefab'));
        const tableIdx = source.resolveNode('Table');
        const comp = source.getObject(source.componentIndices(tableIdx)[0]);
        const compFileId = source.getObject(comp.__prefab.__id__).fileId;

        const { instance } = stubParts(doc, 'Desk');
        const ovs = overrides(doc, instance);
        const shadow = ovs.find(o => o.path.join('.') === '_shadowCastingMode');
        assert.deepStrictEqual(shadow.localID, [compFileId]);
        assert.strictEqual(shadow.value, 1);

        const material = ovs.find(o => o.path.join('.') === '_materials.0');
        assert.deepStrictEqual(material.path, ['_materials', '0']); // strings, editor-style
        assert.strictEqual(material.value.__uuid__.length > 0, true);
        assert.strictEqual(material.value.__expectedType__, 'cc.Material');
        assertValid(doc);
        assertFixedPoint(doc);
    });

    test('overrides an embedded material inside a model instance (editor shape)', () => {
        const ctx = makeCtx();
        const doc = loadScene();
        applyOperations(doc, [
            { op: 'instantiate_prefab', parent: '/', prefab: 'Models/Coin.fbx', name: 'Coin3D' },
            {
                op: 'set_instance_property', node: 'Coin3D', target: 'CoinLP',
                component: 'cc.MeshRenderer', property: 'materials[0]',
                value: { $asset: 'Materials/Dynamite.mtl' }
            }
        ], ctx);

        // fileId of the renderer's CompPrefabInfo inside the compiled gltf-scene
        const { doc: source } = loadSourcePrefab(ctx, 'Models/Coin.fbx');
        const rendererIdx = source.componentIndices(source.resolveNode('CoinLP'))
            .find(i => source.getObject(i).__type__ === 'cc.MeshRenderer');
        const compFileId = source.getObject(source.getObject(rendererIdx).__prefab.__id__).fileId;

        const { instance } = stubParts(doc, 'Coin3D');
        const ov = overrides(doc, instance).find(o => o.path.join('.') === '_materials.0');
        assert.deepStrictEqual(ov.path, ['_materials', '0']); // string segments, editor-style
        assert.deepStrictEqual(ov.localID, [compFileId]);
        assert.strictEqual(ov.value.__expectedType__, 'cc.Material');
        assert.ok(!ov.value.__uuid__.includes('@'), 'project material, not an embedded sub-asset');
        assertValid(doc);
        assertFixedPoint(doc);
    });

    test('addressing instance internals as a path explains the override workflow', () => {
        const ctx = makeCtx();
        const doc = sceneWithDesk(ctx);
        assert.throws(() =>
            applyOperations(doc, [{
                op: 'set_component_property', node: 'Desk/Table',
                component: 'cc.MeshRenderer', property: 'shadowCastingMode', value: 1
            }], ctx),
            /collapsed prefab instance[\s\S]*inspect_node[\s\S]*set_instance_property/);
    });

    test('rejects non-stub nodes, unknown properties and multi-hop targets', () => {
        const ctx = makeCtx();
        const doc = sceneWithDesk(ctx);
        assert.throws(() =>
            applyOperations(doc, [
                { op: 'set_instance_property', node: 'Main Light', property: 'name', value: 'X' }
            ], ctx),
            /not a prefab instance/);
        assert.throws(() =>
            applyOperations(doc, [
                { op: 'set_instance_property', node: 'Desk', property: 'velocity', value: 1 }
            ], ctx),
            /Unknown node property/);

        // Gold.prefab's own child is a nested instance stub → multi-hop not supported yet
        applyOperations(doc, [
            { op: 'instantiate_prefab', parent: '/', prefab: 'Prefabs/Gold.prefab', name: 'Nugget' }
        ], ctx);
        assert.throws(() =>
            applyOperations(doc, [
                { op: 'set_instance_property', node: 'Nugget', target: 'Coin', property: 'active', value: false }
            ], ctx),
            /multi-hop|nested prefab instance/);
    });

    test('set_node_property on a stub still points to set_instance_property', () => {
        const ctx = makeCtx();
        const doc = sceneWithDesk(ctx);
        assert.throws(() =>
            applyOperations(doc, [
                { op: 'set_node_property', node: 'Desk', property: 'active', value: false }
            ], ctx),
            /set_instance_property/);
    });
});

describe('remove_instance_override', () => {
    test('drops the override and garbage-collects its objects', () => {
        const ctx = makeCtx();
        const doc = loadScene();
        applyOperations(doc, [
            { op: 'instantiate_prefab', parent: '/', prefab: 'Prefabs/Gold.prefab', name: 'Nugget', scale: { x: 3, y: 3, z: 3 } }
        ], ctx);

        const countBefore = doc.objects.length;
        applyOperations(doc, [
            { op: 'remove_instance_override', node: 'Nugget', property: 'scale' }
        ], ctx);
        const { instance } = stubParts(doc, 'Nugget');
        assert.ok(!overrides(doc, instance).some(o => o.path.join('.') === '_lscale'));

        const { dropped } = doc.renumber();
        assert.strictEqual(dropped, 2); // CCPropertyOverrideInfo + cc.TargetInfo
        assert.ok(doc.objects.length < countBefore);
        assertValid(doc);
        assertFixedPoint(doc);
    });

    test('rotation removes both _euler and _lrot; missing override errors', () => {
        const ctx = makeCtx();
        const doc = loadScene();
        applyOperations(doc, [
            { op: 'instantiate_prefab', parent: '/', prefab: 'Prefabs/Gold.prefab', name: 'Nugget', rotation: { y: 45 } }
        ], ctx);
        const [result] = applyOperations(doc, [
            { op: 'remove_instance_override', node: 'Nugget', property: 'rotation' }
        ], ctx);
        assert.match(result.summary, /2 override/);

        assert.throws(() =>
            applyOperations(doc, [
                { op: 'remove_instance_override', node: 'Nugget', property: 'scale' }
            ], ctx),
            /nothing to remove/);
    });
});

describe('existing golden instances stay editable', () => {
    test('overriding a scene instance that came from the editor (by _id path)', () => {
        // Golden scene instances reference real-game prefabs that are not in
        // the mock project — resolution must fail with a clear message.
        const ctx = makeCtx();
        const doc = loadScene();
        const stubIdx = doc.objects.findIndex((o, i) => doc.isNode(o) && doc.isInstanceStub(i));
        const name = doc.nodeName(stubIdx);
        assert.ok(name);
        assert.throws(() =>
            applyOperations(doc, [
                { op: 'set_instance_property', node: doc.nodePath(stubIdx), property: 'active', value: false }
            ], ctx),
            /not found in the project/);
    });
});
