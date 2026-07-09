/**
 * Validator tests - invariants on golden files and hand-broken documents
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { SceneDocument } from '../../src/document/SceneDocument.js';
import { Validator } from '../../src/document/Validator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = path.join(__dirname, '..', 'fixtures', 'golden');

const load = (f) => SceneDocument.load(path.join(GOLDEN_DIR, f));

describe('Validator on editor-authored files', () => {
    for (const file of fs.readdirSync(GOLDEN_DIR).filter(f => /\.(scene|prefab)$/.test(f))) {
        test(`${file} has zero errors`, () => {
            const { errors } = new Validator(load(file)).validate();
            assert.deepStrictEqual(errors, []);
        });
    }
});

describe('Validator catches corruption', () => {
    test('dangling __id__', () => {
        const doc = load('TableCash.prefab');
        doc.getObject(doc.resolveNode('Table'))._components.push({ __id__: 9999 });
        const { errors } = new Validator(doc).validate();
        assert.ok(errors.some(e => /dangling __id__ 9999/.test(e)));
    });

    test('broken parent/children symmetry', () => {
        const doc = load('TableCash.prefab');
        const monitorIdx = doc.resolveNode('Table/CashRegister/Monitor');
        doc.getObject(monitorIdx)._parent = { __id__: doc.root.idx };
        const { errors } = new Validator(doc).validate();
        assert.ok(errors.some(e => /missing from parent's _children/.test(e)));
    });

    test('component .node backref mismatch', () => {
        const doc = load('TableCash.prefab');
        const monitorIdx = doc.resolveNode('Table/CashRegister/Monitor');
        const compIdx = doc.componentIndices(monitorIdx)[0];
        doc.getObject(compIdx).node = { __id__: doc.root.idx };
        const { errors } = new Validator(doc).validate();
        assert.ok(errors.some(e => /does not point back via \.node/.test(e)));
    });

    test('duplicate definition fileId', () => {
        const doc = load('TableCash.prefab');
        const infos = doc.objects.filter(o =>
            o.__type__ === 'cc.PrefabInfo' && o.asset?.__id__ === 0);
        infos[1].fileId = infos[0].fileId;
        const { errors } = new Validator(doc).validate();
        assert.ok(errors.some(e => /duplicate definition fileId/.test(e)));
    });

    test('duplicate node _id in scene', () => {
        const doc = load('Main.scene_V2.scene');
        const nodes = doc.objects.filter(o => o.__type__ === 'cc.Node' && o._id);
        nodes[1]._id = nodes[0]._id;
        const { errors } = new Validator(doc).validate();
        assert.ok(errors.some(e => /duplicate _id/.test(e)));
    });

    test('wrapper rule warning for renderer on prefab root', () => {
        const doc = load('TableCash.prefab');
        // Move the Table MeshRenderer ref onto the root (contrived but structural)
        const tableIdx = doc.resolveNode('Table');
        const compIdx = doc.componentIndices(tableIdx)[0];
        doc.getObject(tableIdx)._components = [];
        doc.root.node._components.push({ __id__: compIdx });
        doc.getObject(compIdx).node = { __id__: doc.root.idx };
        const { warnings } = new Validator(doc).validate();
        assert.ok(warnings.some(w => /wrapper rule/.test(w)));
    });

    // A1 — the wrapper rule must cover every world-space renderer, not just
    // cc.Sprite/cc.MeshRenderer (SpriteRenderer/Billboard/ParticleSystem added).
    for (const type of ['cc.SpriteRenderer', 'cc.Billboard', 'cc.ParticleSystem']) {
        test(`wrapper rule warning for ${type} on prefab root`, () => {
            const doc = load('TableCash.prefab');
            const tableIdx = doc.resolveNode('Table');
            const compIdx = doc.componentIndices(tableIdx)[0];
            doc.getObject(tableIdx)._components = [];
            doc.root.node._components.push({ __id__: compIdx });
            const comp = doc.getObject(compIdx);
            comp.node = { __id__: doc.root.idx };
            comp.__type__ = type;
            const { warnings } = new Validator(doc).validate();
            assert.ok(warnings.some(w => /wrapper rule/.test(w)),
                `${type} on a prefab root must trip the wrapper rule`);
        });
    }

    test('unreachable objects produce a warning', () => {
        const doc = load('TableCash.prefab');
        doc.addObject({ __type__: 'cc.ModelBakeSettings', texture: null });
        const { errors, warnings } = new Validator(doc).validate();
        assert.ok(warnings.some(w => /unreachable objects/.test(w)));
        assert.deepStrictEqual(errors, []);
    });
});

describe('Validator targetOverride checks', () => {
    const MOCK_PROJECT = path.join(__dirname, '..', 'fixtures', 'mock-project');

    const firstOverride = (doc) =>
        doc.objects.find(o => o.__type__ === 'cc.TargetOverrideInfo');

    // Structurally-dead records (broken propertyPath/targetInfo/source/target)
    // are ones the engine skips on load, so they are warnings, not blocking
    // errors — the editor even regenerates some of them on save.
    test('empty/non-string propertyPath is a non-blocking warning', () => {
        const doc = load('Main.scene_V2.scene');
        firstOverride(doc).propertyPath = [];
        const { errors, warnings } = new Validator(doc).validate();
        assert.deepStrictEqual(errors, []);
        assert.ok(warnings.some(w => /engine ignores this override.*propertyPath is empty or invalid/.test(w)));
    });

    test('bad targetInfo is a non-blocking warning', () => {
        const doc = load('Main.scene_V2.scene');
        firstOverride(doc).targetInfo = null;
        const { errors, warnings } = new Validator(doc).validate();
        assert.deepStrictEqual(errors, []);
        assert.ok(warnings.some(w => /engine ignores this override.*targetInfo is missing or invalid/.test(w)));
    });

    test('sourceInfo null with a node source is an error', () => {
        const doc = load('ZombieBuyer.prefab');
        const override = doc.objects.find(o =>
            o.__type__ === 'cc.TargetOverrideInfo' && o.sourceInfo === null);
        override.source = { __id__: doc.root.idx };
        const { errors } = new Validator(doc).validate();
        assert.ok(errors.some(e => /source .* is not a component/.test(e)));
    });

    test('target referencing a non-node is a non-blocking warning', () => {
        const doc = load('Main.scene_V2.scene');
        const override = firstOverride(doc);
        override.target = { __id__: 0 }; // the cc.SceneAsset head
        const { errors, warnings } = new Validator(doc).validate();
        assert.deepStrictEqual(errors, []);
        assert.ok(warnings.some(w => /engine ignores this override.*target is not a node/.test(w)));
    });

    test('shadowed non-null serialized value is a warning', () => {
        const doc = load('Main.scene_V2.scene');
        const override = doc.objects.find(o =>
            o.__type__ === 'cc.TargetOverrideInfo' && o.sourceInfo === null);
        const source = doc.getObject(override.source.__id__);
        source[override.propertyPath[0]] = 42;
        const { errors, warnings } = new Validator(doc).validate();
        assert.deepStrictEqual(errors, []);
        assert.ok(warnings.some(w => /non-null serialized value/.test(w)));
    });

    test('unresolvable localID against the source prefab is a warning', async () => {
        // Build a scene with a real instance + override, then corrupt localID
        const { AssetIndex } = await import('../../src/core/AssetIndex.js');
        const { applyOperations } = await import('../../src/document/operations.js');
        const ctx = { assetIndex: new AssetIndex(MOCK_PROJECT), projectRoot: MOCK_PROJECT };
        const doc = load('Main.scene_V2.scene');
        applyOperations(doc, [
            { op: 'instantiate_prefab', parent: '/', prefab: 'Prefabs/TableCash.prefab', name: 'Desk' },
            { op: 'add_node', parent: '/', name: 'Holder' },
            {
                op: 'add_component', node: 'Holder', type: 'PlayerController',
                properties: { view: { $node: 'Desk/Table' } }
            }
        ], ctx);

        const clean = new Validator(doc, ctx.assetIndex, { projectRoot: MOCK_PROJECT }).validate();
        assert.ok(!clean.warnings.some(w => /does not resolve in the source prefab/.test(w)));

        const override = doc.objects.filter(o => o.__type__ === 'cc.TargetOverrideInfo').at(-1);
        doc.getObject(override.targetInfo.__id__).localID = ['bogusFileId0000000000'];
        const { errors, warnings } =
            new Validator(doc, ctx.assetIndex, { projectRoot: MOCK_PROJECT }).validate();
        assert.deepStrictEqual(errors, []);
        assert.ok(warnings.some(w => /does not resolve in the source prefab/.test(w)));
    });

    test('sourceInfo on a non-instance source is a warning; bad sourceInfo localID too', async () => {
        const { AssetIndex } = await import('../../src/core/AssetIndex.js');
        const { applyOperations } = await import('../../src/document/operations.js');
        const ctx = { assetIndex: new AssetIndex(MOCK_PROJECT), projectRoot: MOCK_PROJECT };
        const doc = load('Main.scene_V2.scene');
        applyOperations(doc, [
            { op: 'instantiate_prefab', parent: '/', prefab: 'Prefabs/TableCash.prefab', name: 'Desk' },
            {
                op: 'set_instance_property', node: 'Desk', target: 'Table',
                component: 'cc.MeshRenderer', property: 'anchorNode',
                value: { $node: 'Desk/Table/CashRegister' }
            }
        ], ctx);
        const override = doc.objects.filter(o => o.__type__ === 'cc.TargetOverrideInfo').at(-1);

        const clean = new Validator(doc, ctx.assetIndex, { projectRoot: MOCK_PROJECT }).validate();
        assert.deepStrictEqual(clean.errors, []);
        assert.ok(!clean.warnings.some(w => /sourceInfo/.test(w)));

        doc.getObject(override.sourceInfo.__id__).localID = ['bogusFileId0000000000'];
        const bad = new Validator(doc, ctx.assetIndex, { projectRoot: MOCK_PROJECT }).validate();
        assert.deepStrictEqual(bad.errors, []);
        assert.ok(bad.warnings.some(w => /sourceInfo localID .* does not resolve/.test(w)));

        override.source = { __id__: doc.resolveNode('Main Light') }; // plain node, no instance
        const worse = new Validator(doc, ctx.assetIndex, { projectRoot: MOCK_PROJECT }).validate();
        assert.deepStrictEqual(worse.errors, []);
        assert.ok(worse.warnings.some(w => /source .* is not a prefab instance/.test(w)));
    });
});

describe('Validator removedComponents checks', () => {
    const MOCK_PROJECT = path.join(__dirname, '..', 'fixtures', 'mock-project');

    async function sceneWithRemoval() {
        const { AssetIndex } = await import('../../src/core/AssetIndex.js');
        const { applyOperations } = await import('../../src/document/operations.js');
        const ctx = { assetIndex: new AssetIndex(MOCK_PROJECT), projectRoot: MOCK_PROJECT };
        const doc = load('Main.scene_V2.scene');
        applyOperations(doc, [
            { op: 'instantiate_prefab', parent: '/', prefab: 'Prefabs/TableCash.prefab', name: 'Desk' },
            { op: 'remove_component', node: 'Desk', target: 'Table', component: 'cc.MeshRenderer' }
        ], ctx);
        const instance = doc.instanceOf(doc.resolveNode('Desk'));
        return { doc, ctx, instance };
    }

    test('well-formed entry: zero errors, zero warnings with a project', async () => {
        const { doc, ctx } = await sceneWithRemoval();
        const { errors, warnings } =
            new Validator(doc, ctx.assetIndex, { projectRoot: MOCK_PROJECT }).validate();
        assert.deepStrictEqual(errors, []);
        assert.ok(!warnings.some(w => /removedComponents/.test(w)));
    });

    test('non-TargetInfo entry is an error', async () => {
        const { doc, instance } = await sceneWithRemoval();
        instance.removedComponents.push({ __id__: 0 }); // the cc.SceneAsset head
        const { errors } = new Validator(doc).validate();
        assert.ok(errors.some(e =>
            /removedComponents\[1\]: must reference a cc\.TargetInfo/.test(e)));
    });

    test('unresolvable localID is a warning; node localID too', async () => {
        const { doc, ctx, instance } = await sceneWithRemoval();
        const entry = doc.getObject(instance.removedComponents[0].__id__);

        entry.localID = ['bogusFileId0000000000'];
        let { errors, warnings } =
            new Validator(doc, ctx.assetIndex, { projectRoot: MOCK_PROJECT }).validate();
        assert.deepStrictEqual(errors, []);
        assert.ok(warnings.some(w => /removedComponents\[0\].*does not resolve/.test(w)));

        // A node fileId is structurally valid but removes nothing
        const src = load('../mock-project/assets/Prefabs/TableCash.prefab');
        const tableIdx = src.resolveNode('Table');
        entry.localID = [src.getObject(src.getObject(tableIdx)._prefab.__id__).fileId];
        ({ errors, warnings } =
            new Validator(doc, ctx.assetIndex, { projectRoot: MOCK_PROJECT }).validate());
        assert.deepStrictEqual(errors, []);
        assert.ok(warnings.some(w => /resolves to node .* not a component/.test(w)));
    });
});
