/**
 * Bounds tests - subtree AABB math against the mock project's real mesh data
 *
 * Coin mesh AABB (library cache): x/y ≈ ±0.0040921, z ≈ ±0.0007556.
 * Crate.prefab: Root → Visual (scale 2, pos y+0.5) with that mesh.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { SceneDocument } from '../../src/document/SceneDocument.js';
import { BoundsCalculator } from '../../src/document/Bounds.js';
import { applyOperations } from '../../src/document/operations.js';
import { loadSourcePrefabByUuid } from '../../src/document/instances.js';
import { AssetIndex } from '../../src/core/AssetIndex.js';
import { AssetInspector } from '../../src/core/AssetInspector.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = (f) => path.join(__dirname, '..', 'fixtures', 'golden', f);
const MOCK_PROJECT = path.join(__dirname, '..', 'fixtures', 'mock-project');
const MOCK = (f) => path.join(MOCK_PROJECT, f);

const MESH_X = 0.004092095419764519 + 0.004092094488441944; // coin mesh size
const MESH_Z = 0.0007555921329185367 * 2;

function makeCtx() {
    const assetIndex = new AssetIndex(MOCK_PROJECT);
    return { assetIndex, assetInspector: new AssetInspector(MOCK_PROJECT, assetIndex), projectRoot: MOCK_PROJECT };
}

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} !≈ ${b}`);

describe('BoundsCalculator', () => {
    test('prefab root: child transforms applied, own frame kept', () => {
        const doc = SceneDocument.load(MOCK('assets/Prefabs/Crate.prefab'));
        const { local, world, contributors } = new BoundsCalculator(makeCtx())
            .computeSubtree(doc, doc.root.idx);

        near(local.size.x, MESH_X * 2);
        near(local.size.z, MESH_Z * 2);
        near(local.center.y, 0.5); // Visual sits at y+0.5
        // Root has identity TRS → world equals local here
        assert.deepStrictEqual(world, local);
        assert.strictEqual(contributors.length, 1);
        assert.strictEqual(contributors[0].type, 'cc.MeshRenderer');
        assert.strictEqual(contributors[0].path, '/Visual');
    });

    test('rotation swaps axes conservatively', () => {
        const doc = SceneDocument.load(MOCK('assets/Prefabs/Crate.prefab'));
        applyOperations(doc, [
            { op: 'set_node_property', node: 'Visual', property: 'rotation', value: { y: 90 } }
        ]);
        const { local } = new BoundsCalculator(makeCtx()).computeSubtree(doc, doc.root.idx);
        near(local.size.x, MESH_Z * 2, 1e-9); // depth now lies along X
        near(local.size.z, MESH_X * 2, 1e-9);
    });

    test('UITransform rects contribute (golden HUD prefab)', () => {
        const doc = SceneDocument.load(GOLDEN('HUD.prefab'));
        const { local, contributors } = new BoundsCalculator(makeCtx())
            .computeSubtree(doc, doc.root.idx);
        assert.ok(local, 'HUD must be measurable via UITransforms');
        assert.ok(local.size.x > 0 && local.size.y > 0);
        assert.ok(contributors.some(c => c.type === 'cc.UITransform'));
    });

    test('instance stubs measure through the source prefab with overrides', () => {
        const ctx = makeCtx();
        const doc = SceneDocument.load(GOLDEN('Main.scene_V2.scene'));
        applyOperations(doc, [{
            op: 'instantiate_prefab', parent: '/', prefab: 'Prefabs/Crate.prefab',
            name: 'Box', position: { x: 10 }, scale: { x: 3, y: 3, z: 3 }
        }], ctx);

        const calc = new BoundsCalculator(ctx);
        const { local, world } = calc.computeSubtree(doc, doc.resolveNode('Box'));

        // Local frame: stub's own TRS excluded → plain crate bounds
        near(local.size.x, MESH_X * 2);
        near(local.center.y, 0.5);
        // World: scale 3 + x offset 10 applied
        near(world.size.x, MESH_X * 2 * 3);
        near(world.center.x, 10);
        near(world.center.y, 1.5);
    });

    test('world frame falls back to the source root TRS when a stub has no override', () => {
        const ctx = makeCtx();
        const doc = SceneDocument.load(GOLDEN('Main.scene_V2.scene'));
        applyOperations(doc, [{
            op: 'instantiate_prefab', parent: '/', prefab: 'Prefabs/Crate.prefab',
            name: 'Box', position: { x: 10 } // no scale ⇒ no _lscale override on the stub
        }], ctx);

        // Give the SOURCE root a scale through the shared prefab cache: with no
        // _lscale override the stub transform must fall back to it, not identity
        const stub = doc.getObject(doc.resolveNode('Box'));
        const assetUuid = doc.getObject(stub._prefab.__id__).asset.__uuid__;
        applyOperations(loadSourcePrefabByUuid(ctx, assetUuid).doc, [
            { op: 'set_node_property', node: '/', property: 'scale', value: { x: 3, y: 3, z: 3 } }
        ]);

        const { local, world } = new BoundsCalculator(ctx).computeSubtree(doc, doc.resolveNode('Box'));
        near(local.size.x, MESH_X * 2);     // local frame: stub TRS excluded
        near(local.center.y, 0.5);
        near(world.size.x, MESH_X * 2 * 3); // world frame: source root scale applied
        near(world.center.x, 10);
        near(world.center.y, 0.5 * 3);
    });

    test('cyclic _children graph is skipped, not a stack overflow', () => {
        const doc = SceneDocument.load(MOCK('assets/Prefabs/Crate.prefab'));
        // Corrupt the file: Visual points back at Root as its child
        const rootIdx = doc.root.idx;
        const visualIdx = doc.resolveNode('Visual');
        doc.getObject(visualIdx)._children.push({ __id__: rootIdx });

        const { local, skipped } = new BoundsCalculator(makeCtx())
            .computeSubtree(doc, rootIdx);
        assert.ok(local, 'the measurable part must still be measured');
        assert.ok(skipped.some(s => /cycle/.test(s.reason)),
            `expected a cycle skip entry, got ${JSON.stringify(skipped)}`);
    });

    test('two stubs of the same prefab both measure (shared source doc is not a false cycle)', () => {
        const ctx = makeCtx();
        const doc = SceneDocument.load(GOLDEN('Main.scene_V2.scene'));
        applyOperations(doc, [
            { op: 'instantiate_prefab', parent: '/', prefab: 'Prefabs/Crate.prefab', name: 'BoxA' },
            { op: 'instantiate_prefab', parent: '/', prefab: 'Prefabs/Crate.prefab', name: 'BoxB', position: { x: 5 } }
        ], ctx);

        const calc = new BoundsCalculator(ctx);
        const { world, skipped } = calc.computeSubtree(doc, doc.root.idx);
        assert.ok(world, 'scene with two crates must be measurable');
        assert.ok(!skipped.some(s => /cycle/.test(s.reason)),
            `no false cycle reports expected, got ${JSON.stringify(skipped)}`);
        // Both crates contribute: the merged AABB spans BoxA (x≈0) to BoxB (x≈5)
        assert.ok(world.size.x > 4.9, `expected span > 4.9, got ${world.size.x}`);
    });

    test('unmeasurable meshes are reported as skipped, not silently dropped', () => {
        const doc = SceneDocument.load(GOLDEN('TableCash.prefab'));
        const { local, skipped } = new BoundsCalculator(makeCtx())
            .computeSubtree(doc, doc.root.idx);
        // TableCash meshes are not in the mock project's library
        assert.strictEqual(local, null);
        assert.ok(skipped.length >= 3);
        assert.match(skipped[0].reason, /AABB unavailable/);
    });
});
