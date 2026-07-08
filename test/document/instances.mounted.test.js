/**
 * Mounted components/children — read side (Phase 1)
 *
 * Shapes verified on the golden scene (8 × cc.MountedComponentsInfo,
 * 1 × cc.MountedChildrenInfo): mounted components are regular serialized
 * components of the scene file (`node` → stub, `__prefab: null`,
 * `__editorExtras__.mountedRoot` → stub); mounted children are regular
 * cc.Node objects with `_parent: null`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { SceneDocument, isRef } from '../../src/document/SceneDocument.js';
import {
    mountedComponentEntries, mountedChildrenEntries
} from '../../src/document/instances.js';
import { applyOperations } from '../../src/document/operations.js';
import { Validator } from '../../src/document/Validator.js';
import { AssetIndex } from '../../src/core/AssetIndex.js';
import { InspectNode } from '../../src/tools/InspectNode.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = (f) => path.join(__dirname, '..', 'fixtures', 'golden', f);
const MOCK_PROJECT = path.join(__dirname, '..', 'fixtures', 'mock-project');

const loadScene = () => SceneDocument.load(GOLDEN('Main.scene_V2.scene'));
const makeCtx = () => ({ assetIndex: new AssetIndex(MOCK_PROJECT), projectRoot: MOCK_PROJECT });

/** All PrefabInstance objects of a document */
function instances(doc) {
    return doc.objects.filter(o => o.__type__ === 'cc.PrefabInstance');
}

/** First golden instance that actually carries mounted components */
function mountedInstance(doc) {
    return instances(doc).find(i => (i.mountedComponents ?? []).length > 0);
}

describe('mounted entries helpers (golden scene)', () => {
    test('finds every MountedComponentsInfo record (8 entries, 10 components)', () => {
        const doc = loadScene();
        const entries = instances(doc).flatMap(i => mountedComponentEntries(doc, i));
        assert.strictEqual(entries.length, 8);
        assert.strictEqual(entries.flatMap(e => e.componentIndices).length, 10);

        for (const e of entries) {
            // Single-hop localID addressing the mount node in the source prefab
            assert.ok(Array.isArray(e.localID) && e.localID.length === 1);
            assert.strictEqual(typeof e.localID[0], 'string');
            for (const idx of e.componentIndices) {
                const comp = doc.getObject(idx);
                assert.ok(comp && !doc.isNode(comp));
                assert.ok(isRef(comp.node), 'mounted component points back at the stub');
                assert.strictEqual(comp.__prefab, null);
                assert.ok(isRef(comp.__editorExtras__?.mountedRoot));
            }
        }
    });

    test('finds the MountedChildrenInfo record (1 entry, 1 detached node)', () => {
        const doc = loadScene();
        const entries = instances(doc).flatMap(i => mountedChildrenEntries(doc, i));
        assert.strictEqual(entries.length, 1);
        assert.strictEqual(entries[0].nodeIndices.length, 1);

        const node = doc.getObject(entries[0].nodeIndices[0]);
        assert.strictEqual(node.__type__, 'cc.Node');
        assert.strictEqual(node._parent, null);
        assert.strictEqual(node._name, 'icon');
    });

    test('malformed entries are filtered, not crashed on', () => {
        const doc = loadScene();
        const instance = mountedInstance(doc);
        const entries = mountedComponentEntries(doc, {
            ...instance,
            mountedComponents: [null, 'junk', { __id__: 1 }, ...instance.mountedComponents]
        });
        assert.strictEqual(entries.length, 1);
    });
});

describe('inspect_node mounted sections (mock project fixture)', () => {
    /**
     * Scene with a Gold.prefab instance + a hand-mounted script component and
     * mounted child, in the exact golden serialization shape. The source
     * prefab resolves in the mock project, so mount targets render as paths.
     */
    function buildFixture() {
        const doc = loadScene();
        const ctx = makeCtx();
        const [result] = applyOperations(doc, [
            { op: 'instantiate_prefab', parent: '/', prefab: 'Prefabs/Gold.prefab', name: 'MountedGold' }
        ], ctx);
        const stubIdx = result.nodeIdx;
        const instance = doc.getObject(doc.getObject(doc.getObject(stubIdx)._prefab.__id__).instance.__id__);

        // Gold.prefab root fileId (mount target = instance root)
        const rootFileId = doc.getObject(doc.getObject(stubIdx)._prefab.__id__).fileId;

        // Mounted script component referencing a scene node ([WORLD]/Button)
        const buttonIdx = doc.resolveNode('[WORLD]/Button');
        const compIdx = doc.addObject({
            __type__: '34eedIT7YpDJIIjpHypi4aF',
            _name: '',
            _objFlags: 0,
            __editorExtras__: { mountedRoot: { __id__: stubIdx } },
            node: { __id__: stubIdx },
            _enabled: true,
            __prefab: null,
            buttonNode: { __id__: buttonIdx },
            _id: 'testMountedComp01'
        });
        const mcTargetIdx = doc.addObject({ __type__: 'cc.TargetInfo', localID: [rootFileId] });
        const mcIdx = doc.addObject({
            __type__: 'cc.MountedComponentsInfo',
            targetInfo: { __id__: mcTargetIdx },
            components: [{ __id__: compIdx }]
        });
        instance.mountedComponents.push({ __id__: mcIdx });

        // Mounted child node (detached, editor shape)
        const childIdx = doc.addObject({
            __type__: 'cc.Node',
            _name: 'mountedIcon',
            _objFlags: 0,
            __editorExtras__: { mountedRoot: { __id__: stubIdx } },
            _parent: null,
            _children: [],
            _active: true,
            _components: [],
            _prefab: null,
            _lpos: { __type__: 'cc.Vec3', x: 0, y: 0, z: 0 },
            _lrot: { __type__: 'cc.Quat', x: 0, y: 0, z: 0, w: 1 },
            _lscale: { __type__: 'cc.Vec3', x: 1, y: 1, z: 1 },
            _mobility: 0,
            _layer: 1073741824,
            _euler: { __type__: 'cc.Vec3', x: 0, y: 0, z: 0 },
            _id: 'testMountedNode01'
        });
        const chTargetIdx = doc.addObject({ __type__: 'cc.TargetInfo', localID: [rootFileId] });
        const chIdx = doc.addObject({
            __type__: 'cc.MountedChildrenInfo',
            targetInfo: { __id__: chTargetIdx },
            nodes: [{ __id__: childIdx }]
        });
        instance.mountedChildren.push({ __id__: chIdx });

        doc.renumber();
        const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mounted-')), 'Mounted.scene');
        doc.save(file);
        return file;
    }

    test('renders mounted sections with resolved mount targets and node addresses', async () => {
        const file = buildFixture();
        const tool = new InspectNode();
        const result = await tool.execute({ filePath: file, nodeName: 'MountedGold' }, MOCK_PROJECT);
        const text = result.content[0].text;

        assert.ok(!result.isError, text);
        assert.match(text, /## Mounted components \(1\)/);
        assert.match(text, /mounted at "\/"/);
        assert.match(text, /\.buttonNode = →\[WORLD\]\/Button/);
        assert.match(text, /## Mounted children \(1\)/);
        assert.match(text, /"mountedIcon" mounted under "\/"/);
    });

    test('json format carries mountedComponents/mountedChildren keys', async () => {
        const file = buildFixture();
        const tool = new InspectNode();
        const result = await tool.execute(
            { filePath: file, nodeName: 'MountedGold', format: 'json' }, MOCK_PROJECT);
        const parsed = JSON.parse(result.content[0].text);

        assert.strictEqual(parsed.mountedComponents.length, 1);
        assert.strictEqual(parsed.mountedComponents[0].target, '/');
        assert.strictEqual(parsed.mountedComponents[0].components.length, 1);
        assert.strictEqual(
            parsed.mountedComponents[0].components[0].properties.buttonNode, '→[WORLD]/Button');
        assert.strictEqual(parsed.mountedChildren.length, 1);
        assert.strictEqual(parsed.mountedChildren[0].nodes[0].name, 'mountedIcon');
    });

    test('fixture passes validation with zero errors', () => {
        const file = buildFixture();
        const doc = SceneDocument.load(file);
        const { errors } = new Validator(doc, new AssetIndex(MOCK_PROJECT),
            { projectRoot: MOCK_PROJECT }).validate();
        assert.deepStrictEqual(errors, []);
    });
});

describe('validator mounted invariants', () => {
    test('broken MountedComponentsInfo shapes are errors', () => {
        const doc = loadScene();
        const instance = mountedInstance(doc);
        const badIdx = doc.addObject({
            __type__: 'cc.MountedComponentsInfo',
            targetInfo: null,
            components: 'junk'
        });
        instance.mountedComponents.push({ __id__: badIdx });

        const { errors } = new Validator(doc).validate();
        assert.ok(errors.some(e => /targetInfo must reference a cc\.TargetInfo/.test(e)));
        assert.ok(errors.some(e => /components must be an array/.test(e)));
    });

    test('a components entry that is not a component is an error', () => {
        const doc = loadScene();
        const instance = mountedInstance(doc);
        const entry = mountedComponentEntries(doc, instance)[0];
        entry.obj.components.push({ __id__: doc.root.idx }); // a node, not a component

        const { errors } = new Validator(doc).validate();
        assert.ok(errors.some(e => /must reference a component object/.test(e)));
    });

    test('unresolvable mount localID is a warning with a project', () => {
        const doc = loadScene();
        const ctx = makeCtx();
        applyOperations(doc, [
            { op: 'instantiate_prefab', parent: '/', prefab: 'Prefabs/Gold.prefab', name: 'G1' }
        ], ctx);
        const stubIdx = doc.resolveNode('G1');
        const instance = doc.getObject(doc.getObject(doc.getObject(stubIdx)._prefab.__id__).instance.__id__);
        const tIdx = doc.addObject({ __type__: 'cc.TargetInfo', localID: ['bogusFileId0000000000x'] });
        const mcIdx = doc.addObject({
            __type__: 'cc.MountedComponentsInfo', targetInfo: { __id__: tIdx }, components: []
        });
        instance.mountedComponents.push({ __id__: mcIdx });

        const { errors, warnings } = new Validator(doc, ctx.assetIndex,
            { projectRoot: MOCK_PROJECT }).validate();
        assert.deepStrictEqual(errors, []);
        assert.ok(warnings.some(w => /bogusFileId0000000000x.*does not resolve/.test(w)));
    });

    test('golden scene mounted records validate clean', () => {
        const { errors, warnings } = new Validator(loadScene()).validate();
        assert.deepStrictEqual(errors, []);
        assert.ok(!warnings.some(w => /mounted/i.test(w)));
    });
});
