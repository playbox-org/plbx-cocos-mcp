/**
 * Mounted components — write side (Phase 2)
 *
 * A mounted component is a regular serialized object of the document, so
 * set_component_property / set_asset_ref (property paths, $node/$component,
 * merge logic) apply verbatim — these tests cover the ADDRESSING layer:
 * finding the component among the instance's MountedComponentsInfo records,
 * physical removal (no removedComponents entry), and reference semantics
 * (plain {__id__} to scene objects — golden [2074] shape; B1
 * TargetOverrideInfo for values pointing INTO instances).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { SceneDocument, isRef } from '../../src/document/SceneDocument.js';
import { mountedComponentEntries } from '../../src/document/instances.js';
import { applyOperations, OperationError } from '../../src/document/operations.js';
import { listTargetOverrides } from '../../src/document/targetOverrides.js';
import { Validator } from '../../src/document/Validator.js';
import { AssetIndex } from '../../src/core/AssetIndex.js';
import { compressUuid } from '../../src/utils/uuid.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = (f) => path.join(__dirname, '..', 'fixtures', 'golden', f);
const MOCK_PROJECT = path.join(__dirname, '..', 'fixtures', 'mock-project');

// PlayerController.ts in the mock project → compressed 34eedIT7YpDJIIjpHypi4aF
// (the same compressed uuid as the golden scene's mounted script components)
const SCRIPT_TYPE = '34eedIT7YpDJIIjpHypi4aF';
// TableCash.prefab fileIds (from the fixture file itself)
const TABLECASH_ROOT_FILE_ID = 'few/hn6kZBKbTUOTAK9uKh';
const MONITOR_NODE_FILE_ID = 'c3rQI1RexOv4KDgX/mR+fy';
const MONITOR_COMP_FILE_ID = '0eCp6WrEdAE68vfpoQ8Svt';

const GOLDEN_STUB = '[WORLD]/Zones/ButtonPurchaseZone';

const loadScene = () => SceneDocument.load(GOLDEN('Main.scene_V2.scene'));
const makeCtx = () => {
    const assetIndex = new AssetIndex(MOCK_PROJECT);
    const scriptNameByCompressed = new Map(assetIndex.list({ type: 'script' })
        .map(e => [compressUuid(e.uuid), e.name.replace(/\.[jt]s$/, '')]));
    return { assetIndex, projectRoot: MOCK_PROJECT, scriptNameByCompressed };
};

function assertValid(doc, ctx = null) {
    const { errors } = new Validator(doc, ctx?.assetIndex ?? null,
        ctx ? { projectRoot: MOCK_PROJECT } : {}).validate();
    assert.deepStrictEqual(errors, []);
}

function assertFixedPoint(doc) {
    doc.renumber();
    const first = doc.serialize();
    const reloaded = new SceneDocument(JSON.parse(first));
    reloaded.renumber();
    assert.strictEqual(reloaded.serialize(), first);
}

function stubInstance(doc, ref) {
    const stubIdx = doc.resolveNode(ref);
    return {
        stubIdx,
        instance: doc.getObject(doc.getObject(doc.getObject(stubIdx)._prefab.__id__).instance.__id__)
    };
}

/** The single golden mounted component on ButtonPurchaseZone */
function goldenMounted(doc) {
    const { stubIdx, instance } = stubInstance(doc, GOLDEN_STUB);
    const entry = mountedComponentEntries(doc, instance)[0];
    return { stubIdx, instance, entry, comp: doc.getObject(entry.componentIndices[0]) };
}

/** Mount a SCRIPT_TYPE component on a stub at the given source fileId */
function mount(doc, stubRef, fileId, extraProps = {}) {
    const { stubIdx, instance } = stubInstance(doc, stubRef);
    const compIdx = doc.addObject({
        __type__: SCRIPT_TYPE,
        _name: '',
        _objFlags: 0,
        __editorExtras__: { mountedRoot: { __id__: stubIdx } },
        node: { __id__: stubIdx },
        _enabled: true,
        __prefab: null,
        ...extraProps,
        _id: `mnt${doc.objects.length}x`
    });
    const targetIdx = doc.addObject({ __type__: 'cc.TargetInfo', localID: [fileId] });
    const mcIdx = doc.addObject({
        __type__: 'cc.MountedComponentsInfo',
        targetInfo: { __id__: targetIdx },
        components: [{ __id__: compIdx }]
    });
    instance.mountedComponents.push({ __id__: mcIdx });
    return compIdx;
}

/** Scene + TableCash.prefab instance named "Shop" */
function shopScene(ctx) {
    const doc = loadScene();
    applyOperations(doc, [
        { op: 'instantiate_prefab', parent: '/', prefab: 'Prefabs/TableCash.prefab', name: 'Shop' }
    ], ctx);
    return doc;
}

describe('set_component_property on mounted components', () => {
    test('addresses a golden mounted component by script name', () => {
        const doc = loadScene();
        const ctx = makeCtx();
        const [result] = applyOperations(doc, [{
            op: 'set_component_property', node: GOLDEN_STUB,
            component: 'PlayerController', property: '_enabled', value: false
        }], ctx);

        assert.match(result.summary, /\(mounted\)\._enabled = false/);
        assert.strictEqual(goldenMounted(doc).comp._enabled, false);
        assertValid(doc);
        assertFixedPoint(doc);
    });

    test('$node/$component to plain scene objects become direct {__id__} (golden [2074] shape)', () => {
        const doc = loadScene();
        const ctx = makeCtx();
        applyOperations(doc, [{
            op: 'set_component_property', node: GOLDEN_STUB,
            component: 'PlayerController', property: 'pipeNodes',
            value: [{ $node: '[WORLD]/Button' }, { $node: '[WORLD]/Zones' }]
        }], ctx);

        const { comp } = goldenMounted(doc);
        const expected = [doc.resolveNode('[WORLD]/Button'), doc.resolveNode('[WORLD]/Zones')];
        assert.deepStrictEqual(comp.pipeNodes.map(r => r.__id__), expected);
        assertValid(doc);
        assertFixedPoint(doc);
    });

    test('$node INTO an instance becomes null + B1 TargetOverrideInfo sourced at the mounted component', () => {
        const ctx = makeCtx();
        const doc = shopScene(ctx);
        const compIdx = mount(doc, 'Shop', TABLECASH_ROOT_FILE_ID, { monitorNode: null });

        applyOperations(doc, [{
            op: 'set_component_property', node: 'Shop',
            component: 'PlayerController', property: 'monitorNode',
            value: { $node: 'Shop/Table/CashRegister/Monitor' }
        }], ctx);

        // Serialized value stays null; the wiring is a registry record
        assert.strictEqual(doc.getObject(compIdx).monitorNode, null);
        const records = listTargetOverrides(doc).filter(({ obj }) =>
            isRef(obj.source) && obj.source.__id__ === compIdx);
        assert.strictEqual(records.length, 1);
        const record = records[0].obj;
        assert.strictEqual(record.sourceInfo, null); // B1: plain-object source
        assert.deepStrictEqual(record.propertyPath, ['monitorNode']);
        assert.strictEqual(record.target.__id__, doc.resolveNode('Shop'));
        assert.deepStrictEqual(
            doc.getObject(record.targetInfo.__id__).localID, [MONITOR_NODE_FILE_ID]);
        assertValid(doc, ctx);
        assertFixedPoint(doc);
    });

    test('$component pointing at a mounted component resolves to a direct {__id__}', () => {
        const ctx = makeCtx();
        const doc = shopScene(ctx);
        const mountedIdx = mount(doc, 'Shop', TABLECASH_ROOT_FILE_ID);
        const { stubIdx } = stubInstance(doc, GOLDEN_STUB);

        applyOperations(doc, [{
            op: 'set_component_property', node: GOLDEN_STUB,
            component: 'PlayerController', property: 'buttonNode',
            value: { $component: { node: 'Shop', type: 'PlayerController' } }
        }], ctx);

        const { comp } = goldenMounted(doc);
        assert.deepStrictEqual(comp.buttonNode, { __id__: mountedIdx });
        // No targetOverride record — it is a plain reference
        assert.ok(!listTargetOverrides(doc).some(({ obj }) =>
            isRef(obj.source) && isRef(obj.target) && obj.target.__id__ === stubIdx &&
            obj.propertyPath.join('.') === 'buttonNode'));
        assertValid(doc, ctx);
        assertFixedPoint(doc);
    });

    test('set_asset_ref works on a mounted component', () => {
        const ctx = makeCtx();
        const doc = shopScene(ctx);
        const compIdx = mount(doc, 'Shop', TABLECASH_ROOT_FILE_ID);

        applyOperations(doc, [{
            op: 'set_asset_ref', node: 'Shop', component: 'PlayerController',
            property: 'goldPrefab', asset: 'Prefabs/Gold.prefab'
        }], ctx);

        const value = doc.getObject(compIdx).goldPrefab;
        assert.strictEqual(value.__uuid__, '836478c3-ffde-4110-8347-cfda26288652');
        assert.strictEqual(value.__expectedType__, 'cc.Prefab');
        assertValid(doc, ctx);
    });

    test('source-prefab components are still rejected, listing mounted ones', () => {
        const doc = loadScene();
        const ctx = makeCtx();
        assert.throws(
            () => applyOperations(doc, [{
                op: 'set_component_property', node: GOLDEN_STUB,
                component: 'cc.BoxCollider', property: '_isTrigger', value: true
            }], ctx),
            (err) => {
                assert.ok(err instanceof OperationError);
                assert.match(err.message, /no mounted "cc\.BoxCollider" component/);
                assert.match(err.message, /Mounted components: PlayerController \(script\)/);
                assert.match(err.message, /set_instance_property/);
                return true;
            }
        );
    });

    test('same type mounted twice needs target/componentIndex, target picks the right one', () => {
        const ctx = makeCtx();
        const doc = shopScene(ctx);
        const rootComp = mount(doc, 'Shop', TABLECASH_ROOT_FILE_ID);
        const monitorComp = mount(doc, 'Shop', MONITOR_NODE_FILE_ID);

        assert.throws(
            () => applyOperations(doc, [{
                op: 'set_component_property', node: 'Shop',
                component: 'PlayerController', property: '_enabled', value: false
            }], ctx),
            /2 "PlayerController" components are mounted.*disambiguate with target/s
        );

        applyOperations(doc, [{
            op: 'set_component_property', node: 'Shop', target: 'Table/CashRegister/Monitor',
            component: 'PlayerController', property: '_enabled', value: false
        }], ctx);
        assert.strictEqual(doc.getObject(monitorComp)._enabled, false);
        assert.strictEqual(doc.getObject(rootComp)._enabled, true);
        assertValid(doc, ctx);
    });
});

describe('remove_component on mounted components', () => {
    test('physically removes the component and the emptied record — no removedComponents entry', () => {
        const doc = loadScene();
        const ctx = makeCtx();
        const { instance } = stubInstance(doc, GOLDEN_STUB);
        const before = instance.mountedComponents.length;

        const [result] = applyOperations(doc, [{
            op: 'remove_component', node: GOLDEN_STUB, component: 'PlayerController'
        }], ctx);

        assert.match(result.summary, /removed mounted PlayerController \(script\)/);
        assert.match(result.summary, /dropped the MountedComponentsInfo record/);
        assert.strictEqual(instance.mountedComponents.length, before - 1);
        assert.deepStrictEqual(instance.removedComponents, []);
        assert.strictEqual(mountedComponentEntries(doc, instance).length, 0);

        // The component object and its TargetInfo are GC'd on renumber
        const dropped = doc.objects.length;
        doc.renumber();
        assert.ok(doc.objects.length < dropped);
        assert.ok(!doc.objects.some(o => o.__type__ === SCRIPT_TYPE &&
            o._id === '4b9KmjK99KKpEjCY7vGnJF'));
        assertValid(doc);
        assertFixedPoint(doc);
    });

    test('blocked by external references unless force', () => {
        const ctx = makeCtx();
        const doc = shopScene(ctx);
        mount(doc, 'Shop', TABLECASH_ROOT_FILE_ID);
        // The golden mounted component references the new one directly
        applyOperations(doc, [{
            op: 'set_component_property', node: GOLDEN_STUB,
            component: 'PlayerController', property: 'buttonNode',
            value: { $component: { node: 'Shop', type: 'PlayerController' } }
        }], ctx);

        assert.throws(
            () => applyOperations(doc, [{
                op: 'remove_component', node: 'Shop', component: 'PlayerController'
            }], ctx),
            /referenced from outside/
        );

        const doc2 = shopScene(ctx);
        mount(doc2, 'Shop', TABLECASH_ROOT_FILE_ID);
        applyOperations(doc2, [{
            op: 'set_component_property', node: GOLDEN_STUB,
            component: 'PlayerController', property: 'buttonNode',
            value: { $component: { node: 'Shop', type: 'PlayerController' } }
        }], ctx);
        applyOperations(doc2, [{
            op: 'remove_component', node: 'Shop', component: 'PlayerController', force: true
        }], ctx);
        assert.strictEqual(goldenMounted(doc2).comp.buttonNode, null);
        assertValid(doc2, ctx);
        assertFixedPoint(doc2);
    });

    test('falls back to removedComponents semantics for source-prefab components', () => {
        const ctx = makeCtx();
        const doc = shopScene(ctx);
        mount(doc, 'Shop', TABLECASH_ROOT_FILE_ID);

        // cc.MeshRenderer is not mounted — it lives in the source prefab
        const [result] = applyOperations(doc, [{
            op: 'remove_component', node: 'Shop', target: 'Table/CashRegister/Monitor',
            component: 'cc.MeshRenderer'
        }], ctx);

        assert.match(result.summary, /recorded in removedComponents/);
        const { instance } = stubInstance(doc, 'Shop');
        assert.strictEqual(instance.removedComponents.length, 1);
        assert.deepStrictEqual(
            doc.getObject(instance.removedComponents[0].__id__).localID,
            [MONITOR_COMP_FILE_ID]);
        // The mounted component is untouched
        assert.strictEqual(mountedComponentEntries(doc, instance).length, 1);
        assertValid(doc, ctx);
    });
});
