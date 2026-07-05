/**
 * remove_component tests — component removal from plain nodes (M6 phase A1)
 * and from collapsed prefab instances via removedComponents (phase A2).
 *
 * Plain nodes mirror remove_node semantics: detach + reachability-based
 * external-ref check + GC via renumber(). On an instance stub the removal
 * is recorded as cc.TargetInfo{localID: [CompPrefabInfo.fileId]} in
 * cc.PrefabInstance.removedComponents — the form the 3.8.7 engine reads in
 * applyRemovedComponents (editor re-save verification pending, §4 V2).
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { SceneDocument, isRef } from '../../src/document/SceneDocument.js';
import { applyOperations, OperationError } from '../../src/document/operations.js';
import { Validator } from '../../src/document/Validator.js';
import { AssetIndex } from '../../src/core/AssetIndex.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = (f) => path.join(__dirname, '..', 'fixtures', 'golden', f);
const MOCK_PROJECT = path.join(__dirname, '..', 'fixtures', 'mock-project');

const loadPrefab = () => SceneDocument.load(GOLDEN('TableCash.prefab'));
const loadHud = () => SceneDocument.load(GOLDEN('HUD.prefab'));
const loadScene = () => SceneDocument.load(GOLDEN('Main.scene_V2.scene'));
const makeCtx = () => ({ assetIndex: new AssetIndex(MOCK_PROJECT), projectRoot: MOCK_PROJECT });

// GameEntryPoint script on the [SERVICES] node — source of 7 of the golden
// scene's 43 targetOverrides, referenced from nowhere else
const GAME_ENTRY_POINT = '5c8bc2CY4FB2L97SHUNiN+j';

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

function componentTypes(doc, ref) {
    return doc.componentIndices(doc.resolveNode(ref)).map(i => doc.getObject(i).__type__);
}

describe('remove_component', () => {
    test('removes a builtin component and GCs its CompPrefabInfo', () => {
        const doc = loadPrefab();
        assert.ok(componentTypes(doc, 'Table').includes('cc.MeshRenderer'));
        const before = doc.objects.length;

        const [result] = applyOperations(doc, [
            { op: 'remove_component', node: 'Table', component: 'cc.MeshRenderer' }
        ]);
        assert.match(result.summary, /removed cc\.MeshRenderer from "Table"/);
        assert.ok(!componentTypes(doc, 'Table').includes('cc.MeshRenderer'));

        const { dropped } = doc.renumber();
        assert.ok(dropped >= 2, `component + CompPrefabInfo must be GC'd (dropped ${dropped})`);
        assert.ok(doc.objects.length < before);
        assert.ok(!componentTypes(doc, 'Table').includes('cc.MeshRenderer'));
        assertValid(doc);
        assertFixedPoint(doc);
    });

    test('removes a script component by name-agnostic compressed-uuid type', () => {
        const doc = loadScene();
        const [result] = applyOperations(doc, [
            { op: 'remove_component', node: '[SERVICES]', component: GAME_ENTRY_POINT }
        ], makeCtx());
        assert.match(result.summary, /removed/);
        assert.ok(!componentTypes(doc, '[SERVICES]').includes(GAME_ENTRY_POINT));
        assertValid(doc);
        assertFixedPoint(doc);
    });

    test('prunes targetOverrides whose source is the removed component', () => {
        const doc = loadScene();
        const registry = () => doc.getObject(doc.root.node._prefab.__id__).targetOverrides;
        assert.strictEqual(registry().length, 43);

        applyOperations(doc, [
            { op: 'remove_component', node: '[SERVICES]', component: GAME_ENTRY_POINT }
        ], makeCtx());

        assert.strictEqual(registry().length, 36); // 7 GameEntryPoint-sourced entries pruned
        assertValid(doc);
        assertFixedPoint(doc);
        // The pruned TargetOverrideInfo/TargetInfo objects are gone after GC
        const overrideCount = doc.objects.filter(o => o.__type__ === 'cc.TargetOverrideInfo').length;
        assert.strictEqual(overrideCount, 36);
    });

    test('componentIndex disambiguates same-typed components', () => {
        const doc = loadPrefab();
        const nodeIdx = doc.resolveNode('Table');
        const total = doc.componentIndices(nodeIdx).length;
        applyOperations(doc, [
            { op: 'remove_component', node: 'Table', componentIndex: 0 }
        ]);
        assert.strictEqual(doc.componentIndices(nodeIdx).length, total - 1);
        assertValid(doc);
    });

    test('blocks on external references; force nulls them', () => {
        const ctx = makeCtx();
        const build = () => {
            const doc = loadPrefab();
            applyOperations(doc, [
                { op: 'add_node', parent: 'Table', name: 'Probe' },
                { op: 'add_component', node: 'Table/Probe', type: 'cc.UITransform' },
                {
                    op: 'add_component', node: 'Table', type: 'PlayerController',
                    properties: { buddy: { $component: { node: 'Table/Probe', type: 'cc.UITransform' } } }
                }
            ], ctx);
            return doc;
        };

        assert.throws(() => applyOperations(build(), [
            { op: 'remove_component', node: 'Table/Probe', component: 'cc.UITransform' }
        ], ctx), /referenced from outside[\s\S]*force: true[\s\S]*discard/);

        const doc = build();
        const [result] = applyOperations(doc, [
            { op: 'remove_component', node: 'Table/Probe', component: 'cc.UITransform', force: true }
        ], ctx);
        assert.match(result.summary, /nulled 1 external ref/);
        const script = doc.componentIndices(doc.resolveNode('Table'))
            .map(i => doc.getObject(i)).find(c => !c.__type__.startsWith('cc.'));
        assert.strictEqual(script.buddy, null);
        assertValid(doc);
        assertFixedPoint(doc);
    });

    test('REQUIRED_COMPANIONS: cc.UITransform stays while a UI component needs it', () => {
        const doc = loadHud();
        // HUD "Logo" node carries cc.UITransform + cc.Sprite + cc.Widget
        assert.throws(() => applyOperations(doc, [
            { op: 'remove_component', node: 'Logo', component: 'cc.UITransform' }
        ]), /required by cc\.Sprite, cc\.Widget/);
        // force does NOT bypass the companion rule (the editor forbids it too)
        assert.throws(() => applyOperations(loadHud(), [
            { op: 'remove_component', node: 'Logo', component: 'cc.UITransform', force: true }
        ]), /required by/);

        // Removing the dependents first unlocks the UITransform
        const doc2 = loadHud();
        applyOperations(doc2, [
            { op: 'remove_component', node: 'Logo', component: 'cc.Sprite', force: true },
            { op: 'remove_component', node: 'Logo', component: 'cc.Widget', force: true },
            { op: 'remove_component', node: 'Logo', component: 'cc.UITransform', force: true }
        ]);
        assert.deepStrictEqual(componentTypes(doc2, 'Logo'), []);
        assertValid(doc2);
        assertFixedPoint(doc2);
    });

    test('unknown component and bad componentIndex produce helpful errors', () => {
        const doc = loadPrefab();
        assert.throws(() => applyOperations(doc, [
            { op: 'remove_component', node: 'Table', component: 'cc.Camera' }
        ]), /has no "cc\.Camera" component\. Present:/);
        assert.throws(() => applyOperations(doc, [
            { op: 'remove_component', node: 'Table', componentIndex: 99 }
        ]), /out of range/);
        assert.throws(() => applyOperations(doc, [
            { op: 'remove_component', node: 'Table' }
        ]), /"component" .* or "componentIndex" is required/);
    });
});

// -------------------------------------------------------------- phase A2

const MOCK = (f) => path.join(MOCK_PROJECT, f);

/** fileId of a component inside the mock TableCash source prefab */
function tableCashComponentFileId(nodeRef, type) {
    const src = SceneDocument.load(MOCK('assets/Prefabs/TableCash.prefab'));
    const compIdx = src.componentIndices(src.resolveNode(nodeRef))
        .find(i => src.getObject(i).__type__ === type);
    return src.getObject(src.getObject(compIdx).__prefab.__id__).fileId;
}

/** Scene with a TableCash instance "Desk" */
function sceneWithDesk(ctx) {
    const doc = loadScene();
    applyOperations(doc, [
        { op: 'instantiate_prefab', parent: '/', prefab: 'Prefabs/TableCash.prefab', name: 'Desk' }
    ], ctx);
    return doc;
}

function deskInstance(doc) {
    const stubIdx = doc.resolveNode('Desk');
    return { stubIdx, instance: doc.instanceOf(stubIdx) };
}

function removedLocalIds(doc, instance) {
    return instance.removedComponents
        .filter(isRef)
        .map(r => doc.getObject(r.__id__))
        .filter(o => o?.__type__ === 'cc.TargetInfo')
        .map(o => o.localID);
}

describe('remove_component on a prefab instance (removedComponents)', () => {
    test('records a cc.TargetInfo with the CompPrefabInfo fileId', () => {
        const ctx = makeCtx();
        const doc = sceneWithDesk(ctx);
        const [result] = applyOperations(doc, [
            { op: 'remove_component', node: 'Desk', target: 'Table', component: 'cc.MeshRenderer' }
        ], ctx);
        assert.match(result.summary, /removed cc\.MeshRenderer from "Desk→Table" \(recorded in removedComponents/);

        const { instance } = deskInstance(doc);
        assert.deepStrictEqual(removedLocalIds(doc, instance),
            [[tableCashComponentFileId('Table', 'cc.MeshRenderer')]]);
        const entry = doc.getObject(instance.removedComponents[0].__id__);
        assert.deepStrictEqual(Object.keys(entry), ['__type__', 'localID']);

        assertValid(doc);
        assertFixedPoint(doc);
    });

    test('duplicate removal is rejected', () => {
        const ctx = makeCtx();
        const doc = sceneWithDesk(ctx);
        applyOperations(doc, [
            { op: 'remove_component', node: 'Desk', target: 'Table', component: 'cc.MeshRenderer' }
        ], ctx);
        assert.throws(() => applyOperations(doc, [
            { op: 'remove_component', node: 'Desk', target: 'Table', component: 'cc.MeshRenderer' }
        ], ctx), /already removed/);
    });

    test('restore_instance_component deletes the entry; nothing to restore errors', () => {
        const ctx = makeCtx();
        const doc = sceneWithDesk(ctx);
        applyOperations(doc, [
            { op: 'remove_component', node: 'Desk', target: 'Table', component: 'cc.MeshRenderer' },
            { op: 'restore_instance_component', node: 'Desk', target: 'Table', component: 'cc.MeshRenderer' }
        ], ctx);
        const { instance } = deskInstance(doc);
        assert.deepStrictEqual(instance.removedComponents, []);
        assertValid(doc);
        assertFixedPoint(doc); // the orphaned TargetInfo is GC'd

        assert.throws(() => applyOperations(doc, [
            { op: 'restore_instance_component', node: 'Desk', target: 'Table', component: 'cc.MeshRenderer' }
        ], ctx), /not removed on this instance/);
    });

    test('drops the dying component\'s property overrides and outgoing references', () => {
        const ctx = makeCtx();
        const doc = sceneWithDesk(ctx);
        applyOperations(doc, [
            {
                op: 'set_instance_property', node: 'Desk', target: 'Table',
                component: 'cc.MeshRenderer', property: 'enabled', value: false
            },
            {
                op: 'set_instance_property', node: 'Desk', target: 'Table',
                component: 'cc.MeshRenderer', property: 'buddy',
                value: { $node: 'Desk/Table/CashRegister' }
            }
        ], ctx);
        const { instance } = deskInstance(doc);
        const localId = tableCashComponentFileId('Table', 'cc.MeshRenderer');
        const overridesFor = () => instance.propertyOverrides
            .filter(isRef)
            .map(r => doc.getObject(r.__id__))
            .filter(o => doc.getObject(o.targetInfo.__id__).localID[0] === localId);
        assert.strictEqual(overridesFor().length, 1); // _enabled (the reference lives in the registry)

        const [result] = applyOperations(doc, [
            { op: 'remove_component', node: 'Desk', target: 'Table', component: 'cc.MeshRenderer' }
        ], ctx);
        assert.match(result.summary, /dropped 1 stale override/);
        assert.strictEqual(overridesFor().length, 0);
        assertValid(doc);
        assertFixedPoint(doc); // unlinked TargetOverrideInfo/TargetInfo are GC'd here
        assert.strictEqual(doc.objects.filter(o => o.__type__ === 'cc.TargetOverrideInfo').length, 43,
            'only the golden entries remain');
    });

    test('incoming target overrides block the removal unless force', () => {
        const ctx = makeCtx();
        const doc = sceneWithDesk(ctx);
        applyOperations(doc, [
            { op: 'add_node', parent: '/', name: 'Holder' },
            {
                op: 'add_component', node: 'Holder', type: 'PlayerController',
                properties: {
                    tableView: { $component: { node: 'Desk', target: 'Table', type: 'cc.MeshRenderer' } }
                }
            }
        ], ctx);

        assert.throws(() => applyOperations(doc, [
            { op: 'remove_component', node: 'Desk', target: 'Table', component: 'cc.MeshRenderer' }
        ], ctx), /referenced by target overrides[\s\S]*Holder ▸ [\w+/]+ \.tableView[\s\S]*force: true/);

        const [result] = applyOperations(doc, [
            { op: 'remove_component', node: 'Desk', target: 'Table', component: 'cc.MeshRenderer', force: true }
        ], ctx);
        assert.match(result.summary, /dropped 1 incoming reference/);
        assertValid(doc);
        assertFixedPoint(doc); // unlinked entries are GC'd here
        assert.strictEqual(doc.objects.filter(o =>
            o.__type__ === 'cc.TargetOverrideInfo' && o.propertyPath[0] === 'tableView').length, 0);
    });

    test('root component removal works without target ("/" = instance root)', () => {
        const ctx = makeCtx();
        const doc = sceneWithDesk(ctx);
        // TableCash root has no components — findComponent reports that clearly
        assert.throws(() => applyOperations(doc, [
            { op: 'remove_component', node: 'Desk', component: 'cc.MeshRenderer' }
        ], ctx), /has no "cc\.MeshRenderer" component/);
    });
});

describe('REQUIRED_COMPANIONS on a prefab instance', () => {
    let projectRoot;

    before(() => {
        // The mock prefabs carry no UI components — build a disposable
        // project with a UiPanel.prefab (Visual: MeshRenderer + UITransform
        // + Sprite) to exercise the companion guard through an instance.
        projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-removed-components-'));
        fs.cpSync(MOCK_PROJECT, projectRoot, { recursive: true });

        const ctx = { assetIndex: new AssetIndex(projectRoot), projectRoot };
        const doc = SceneDocument.load(path.join(projectRoot, 'assets/Prefabs/Crate.prefab'));
        applyOperations(doc, [
            { op: 'add_component', node: 'Visual', type: 'cc.UITransform' },
            { op: 'add_component', node: 'Visual', type: 'cc.Sprite' }
        ], ctx);
        doc.renumber();
        doc.save(path.join(projectRoot, 'assets/Prefabs/UiPanel.prefab'));
        const meta = JSON.parse(
            fs.readFileSync(path.join(projectRoot, 'assets/Prefabs/Crate.prefab.meta'), 'utf-8'));
        meta.uuid = 'aaaa2222-3333-4444-8555-666677778888';
        meta.userData.syncNodeName = 'UiPanel';
        fs.writeFileSync(
            path.join(projectRoot, 'assets/Prefabs/UiPanel.prefab.meta'),
            JSON.stringify(meta, null, 2));
    });

    after(() => {
        fs.rmSync(projectRoot, { recursive: true, force: true });
    });

    test('cc.UITransform stays while cc.Sprite needs it; removal order unlocks', () => {
        const ctx = { assetIndex: new AssetIndex(projectRoot), projectRoot };
        const doc = loadScene();
        applyOperations(doc, [
            { op: 'instantiate_prefab', parent: '/', prefab: 'Prefabs/UiPanel.prefab', name: 'Panel' }
        ], ctx);

        assert.throws(() => applyOperations(doc, [
            { op: 'remove_component', node: 'Panel', target: 'Visual', component: 'cc.UITransform' }
        ], ctx), /required by cc\.Sprite/);
        // force does NOT bypass the companion rule
        assert.throws(() => applyOperations(doc, [
            { op: 'remove_component', node: 'Panel', target: 'Visual', component: 'cc.UITransform', force: true }
        ], ctx), /required by/);

        applyOperations(doc, [
            { op: 'remove_component', node: 'Panel', target: 'Visual', component: 'cc.Sprite' },
            { op: 'remove_component', node: 'Panel', target: 'Visual', component: 'cc.UITransform' }
        ], ctx);
        const instance = doc.instanceOf(doc.resolveNode('Panel'));
        assert.strictEqual(instance.removedComponents.length, 2);
        assertValid(doc);
        assertFixedPoint(doc);
    });
});
