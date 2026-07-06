/**
 * SceneDocument tests
 *
 * The round-trip suite is the load-bearing wall of the write layer:
 * load + renumber + serialize must reproduce every golden corpus file
 * byte-for-byte before any edit operation is trustworthy.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { SceneDocument, isRef } from '../../src/document/SceneDocument.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = path.join(__dirname, '..', 'fixtures', 'golden');

const goldenFiles = fs.readdirSync(GOLDEN_DIR)
    .filter(f => f.endsWith('.scene') || f.endsWith('.prefab'));

describe('SceneDocument round-trip (golden corpus)', () => {
    assert.ok(goldenFiles.length >= 4, 'golden corpus should hold the scene + prefabs');

    for (const file of goldenFiles) {
        test(`load + serialize is byte-identical: ${file}`, () => {
            const raw = fs.readFileSync(path.join(GOLDEN_DIR, file), 'utf-8');
            const doc = SceneDocument.load(path.join(GOLDEN_DIR, file));
            assert.strictEqual(doc.serialize(), raw);
        });

        test(`load + renumber + serialize is byte-identical: ${file}`, () => {
            const raw = fs.readFileSync(path.join(GOLDEN_DIR, file), 'utf-8');
            const doc = SceneDocument.load(path.join(GOLDEN_DIR, file));
            const { dropped } = doc.renumber();
            assert.strictEqual(dropped, 0, 'no objects should be dropped from an editor-saved file');
            assert.strictEqual(doc.serialize(), raw);
        });

        test(`save writes byte-identical file: ${file}`, () => {
            const doc = SceneDocument.load(path.join(GOLDEN_DIR, file));
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scenedoc-'));
            const outPath = path.join(tmpDir, file);
            try {
                doc.renumber();
                doc.save(outPath);
                const raw = fs.readFileSync(path.join(GOLDEN_DIR, file), 'utf-8');
                assert.strictEqual(fs.readFileSync(outPath, 'utf-8'), raw);
            } finally {
                fs.rmSync(tmpDir, { recursive: true, force: true });
            }
        });
    }
});

describe('SceneDocument basics', () => {
    const scenePath = path.join(GOLDEN_DIR, 'Main.scene_V2.scene');
    const prefabPath = path.join(GOLDEN_DIR, 'TableCash.prefab');
    const goldPath = path.join(GOLDEN_DIR, 'Gold.prefab');

    test('detects scene vs prefab', () => {
        assert.strictEqual(SceneDocument.load(scenePath).isScene, true);
        assert.strictEqual(SceneDocument.load(scenePath).isPrefab, false);
        assert.strictEqual(SceneDocument.load(prefabPath).isPrefab, true);
    });

    test('root resolves to scene / prefab data node', () => {
        const scene = SceneDocument.load(scenePath);
        assert.strictEqual(scene.root.node.__type__, 'cc.Scene');
        const prefab = SceneDocument.load(prefabPath);
        assert.strictEqual(prefab.root.node.__type__, 'cc.Node');
        assert.strictEqual(prefab.root.node._name, 'TableCash');
    });

    test('isRef identifies pure __id__ objects', () => {
        assert.strictEqual(isRef({ __id__: 3 }), true);
        assert.strictEqual(isRef({ __id__: 3, extra: 1 }), false);
        assert.strictEqual(isRef(null), false);
        assert.strictEqual(isRef([{ __id__: 3 }]), false);
    });

    test('resolveNode walks paths', () => {
        const prefab = SceneDocument.load(prefabPath);
        const idx = prefab.resolveNode('Table/CashRegister/Monitor');
        assert.strictEqual(prefab.getObject(idx)._name, 'Monitor');
        assert.strictEqual(prefab.nodePath(idx), 'Table/CashRegister/Monitor');
    });

    test('resolveNode returns root for "/" and ""', () => {
        const prefab = SceneDocument.load(prefabPath);
        assert.strictEqual(prefab.resolveNode('/'), prefab.root.idx);
        assert.strictEqual(prefab.resolveNode(''), prefab.root.idx);
    });

    test('resolveNode fails with helpful message', () => {
        const prefab = SceneDocument.load(prefabPath);
        assert.throws(() => prefab.resolveNode('Table/Nope'), /children: CashRegister/);
    });

    test('resolveNode suggests full paths for a partial-path miss', () => {
        const prefab = SceneDocument.load(prefabPath);
        // "CashRegister/Monitor" is a suffix — the root-anchored path is
        // "Table/CashRegister/Monitor"; the error must suggest it.
        assert.throws(
            () => prefab.resolveNode('CashRegister/Monitor'),
            /Did you mean: "Table\/CashRegister\/Monitor"/
        );
    });

    test('resolveNode explains that a bare number is not an address', () => {
        const prefab = SceneDocument.load(prefabPath);
        assert.throws(
            () => prefab.resolveNode('8'),
            /looks like a #N node index from inspect_node output/
        );
    });

    test('resolveNode by node _id (scene)', () => {
        const scene = SceneDocument.load(scenePath);
        // Find some node with a real _id
        const obj = scene.objects.find(o => o.__type__ === 'cc.Node' && o._id);
        const idx = scene.resolveNode(obj._id);
        assert.strictEqual(scene.getObject(idx), obj);
    });

    test('instance stubs are detected and named via overrides', () => {
        const gold = SceneDocument.load(goldPath);
        const rootIdx = gold.root.idx;
        const [stubIdx] = gold.childIndices(rootIdx);
        assert.strictEqual(gold.isInstanceStub(stubIdx), true);
        assert.strictEqual(gold.isInstanceStub(rootIdx), false);
        // Gold.prefab overrides the instance _name to "Coin"
        assert.strictEqual(gold.nodeName(stubIdx), 'Coin');
        const idx = gold.resolveNode('Coin');
        assert.strictEqual(idx, stubIdx);
    });

    test('subtreeObjectIds owns components but not cross-referenced nodes', () => {
        const prefab = SceneDocument.load(prefabPath);
        const tableIdx = prefab.resolveNode('Table');
        const owned = prefab.subtreeObjectIds(tableIdx);
        // Table subtree: nodes 2,3,4 + MeshRenderers + CompPrefabInfos +
        // BakeSettings + PrefabInfos = everything except cc.Prefab(0),
        // root node(1) and root's PrefabInfo(17)
        assert.strictEqual(owned.has(0), false);
        assert.strictEqual(owned.has(1), false);
        assert.strictEqual(owned.has(17), false);
        assert.strictEqual(owned.size, prefab.objects.length - 3);
    });

    test('externalRefsInto finds incoming references', () => {
        const prefab = SceneDocument.load(prefabPath);
        const tableIdx = prefab.resolveNode('Table');
        const owned = prefab.subtreeObjectIds(tableIdx);
        const refs = prefab.externalRefsInto(owned);
        // Root node's _children holds the only outside reference
        assert.strictEqual(refs.length, 1);
        assert.strictEqual(refs[0].fromIdx, 1);
        assert.match(refs[0].path, /_children/);
    });

    test('renumber drops detached subtrees', () => {
        const prefab = SceneDocument.load(prefabPath);
        const before = prefab.objects.length;
        const tableIdx = prefab.resolveNode('Table');
        const root = prefab.root.node;
        root._children = root._children.filter(r => r.__id__ !== tableIdx);
        const { dropped } = prefab.renumber();
        assert.strictEqual(dropped, before - 3);
        assert.strictEqual(prefab.objects.length, 3);
    });
});
