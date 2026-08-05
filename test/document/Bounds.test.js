/**
 * Bounds tests - subtree AABB math against the mock project's real mesh data
 *
 * Coin mesh AABB (library cache): x/y ≈ ±0.0040921, z ≈ ±0.0007556.
 * Crate.prefab: Root → Visual (scale 2, pos y+0.5) with that mesh.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { defaultSentinel } from '../../src/utils/terrainBin.js';
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

/**
 * Golden scene + `/Holder/[…/]Terrain` carrying a cc.Terrain wired to the mock
 * project's 1x1-block terrain (32x32 m, heights 0..3 m). The Holder exists so a
 * query can start ABOVE the terrain node — a query root's own TRS is excluded.
 */
function terrainScene(ctx, parent = 'Holder', { wireAsset = true } = {}) {
    const doc = SceneDocument.load(GOLDEN('Main.scene_V2.scene'));
    const ops = [{ op: 'add_node', parent: '/', name: 'Holder' }];
    let parentPath = 'Holder';
    for (const segment of parent.split('/').slice(1)) {
        ops.push({ op: 'add_node', parent: parentPath, name: segment });
        parentPath = `${parentPath}/${segment}`;
    }
    ops.push({ op: 'add_node', parent: parentPath, name: 'Terrain' });
    ops.push({ op: 'add_component', node: `${parentPath}/Terrain`, type: 'cc.Terrain' });
    if (wireAsset) {
        ops.push({
            op: 'set_asset_ref', node: `${parentPath}/Terrain`, component: 'cc.Terrain',
            property: 'asset', asset: 'assets/Maps/Terrain.terrain'
        });
    }
    applyOperations(doc, ops, ctx);
    return doc;
}

/**
 * Mount a UITransform-carrying node on `stubIdx`, at `mountPath` inside the source prefab —
 * the golden MountedChildrenInfo shape (node with `_parent: null`), which no MCP op can create.
 */
function mountNode(doc, ctx, stubIdx, mountPath, pos, size) {
    const info = doc.getObject(doc.getObject(stubIdx)._prefab.__id__);
    const src = loadSourcePrefabByUuid(ctx, info.asset.__uuid__).doc;
    const mountIdx = src.resolveNode(mountPath);
    const fileId = src.getObject(src.getObject(mountIdx)._prefab.__id__).fileId;

    const nodeIdx = doc.addObject({
        __type__: 'cc.Node', _name: 'tag', _parent: null, _children: [], _components: [],
        _prefab: null, _lpos: { __type__: 'cc.Vec3', ...pos }
    });
    const compIdx = doc.addObject({
        __type__: 'cc.UITransform', node: { __id__: nodeIdx }, __prefab: null,
        _contentSize: { __type__: 'cc.Size', ...size },
        _anchorPoint: { __type__: 'cc.Vec2', x: 0.5, y: 0.5 }
    });
    doc.getObject(nodeIdx)._components.push({ __id__: compIdx });
    const targetIdx = doc.addObject({ __type__: 'cc.TargetInfo', localID: [fileId] });
    const recordIdx = doc.addObject({
        __type__: 'cc.MountedChildrenInfo',
        targetInfo: { __id__: targetIdx }, nodes: [{ __id__: nodeIdx }]
    });
    const instance = doc.instanceOf(stubIdx);
    (instance.mountedChildren ??= []).push({ __id__: recordIdx });
    return nodeIdx;
}

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

    test('mounted children contribute to the stub\'s and its ancestors\' bounds', () => {
        // The golden [WORLD]/Zones/GoldStackZone carries one mounted child ("icon", a 187x165
        // UITransform at the instance origin) in no `_children` list — and its source prefab is
        // not in the mock project, which must cost the prefab half only
        const ctx = makeCtx();
        const doc = SceneDocument.load(GOLDEN('Main.scene_V2.scene'));
        const calc = new BoundsCalculator(ctx);
        const stubIdx = doc.resolveNode('[WORLD]/Zones/GoldStackZone');

        const stub = calc.computeSubtree(doc, stubIdx);
        assert.deepStrictEqual(
            stub.contributors.map(c => [c.path, c.source]),
            [['[WORLD]/Zones/GoldStackZone/icon', '187x165']]
        );
        near(stub.world.center.x, -2, 1e-9); // the instance origin, reached through the mount hop
        near(stub.world.center.z, 7.7, 1e-9);

        const zones = calc.computeSubtree(doc, doc.resolveNode('[WORLD]/Zones'));
        assert.strictEqual(
            zones.contributors.filter(c => c.path.endsWith('/icon')).length, 1,
            `exactly one contribution per mounted node: ${JSON.stringify(zones.contributors)}`
        );
        near(zones.world.min.x, -2, 1e-9); // without the icon the group starts at x 1.25

        // perChild: a real node of THIS document, so not `inPrefab`
        const rows = calc.computeChildren(doc, stubIdx);
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(rows[0].mounted, true);
        assert.strictEqual(rows[0].inPrefab, false);
        assert.match(rows[0].name, /^icon \(mounted\)$/);
    });

    test('a mounted child rides the source-prefab TRS chain down to its mount node', () => {
        const ctx = makeCtx();
        const doc = SceneDocument.load(GOLDEN('Main.scene_V2.scene'));
        applyOperations(doc, [{
            op: 'instantiate_prefab', parent: '/', prefab: 'Prefabs/Crate.prefab',
            name: 'Box', position: { x: 10 }
        }], ctx);
        const stubIdx = doc.resolveNode('Box');
        // Mount a 4x2 node at local (1,0,0) onto the prefab's Visual (pos y+0.5, scale 2). MCP
        // cannot create mounted records, so build the golden shape by hand.
        mountNode(doc, ctx, stubIdx, 'Visual', { x: 1, y: 0, z: 0 }, { width: 4, height: 2 });

        const calc = new BoundsCalculator(ctx);
        const { world } = calc.computeSubtree(doc, stubIdx);
        // 10 + 2*1 along X, y 0.5 up, the rect scaled by 2 → 8x4 (it swallows the tiny crate mesh)
        near(world.center.x, 12, 1e-9);
        near(world.center.y, 0.5, 1e-9);
        near(world.size.x, 8, 1e-9);
        near(world.size.y, 4, 1e-9);
        // The perChild walk resolves the same chain through its own mount hop
        const row = calc.computeChildren(doc, stubIdx).find(r => r.mounted);
        near(row.world.center.x, 12, 1e-9);
        near(row.world.center.y, 0.5, 1e-9);
        near(row.world.size.x, 8, 1e-9);
    });

    test('mounted children are dropped by skipUI like any other UITransform', () => {
        const ctx = makeCtx();
        const doc = SceneDocument.load(GOLDEN('Main.scene_V2.scene'));
        const { world } = new BoundsCalculator(ctx)
            .computeSubtree(doc, doc.resolveNode('[WORLD]/Zones/GoldStackZone'), { skipUI: true });
        assert.strictEqual(world, null);
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

    test('cc.Terrain contributes an analytic box anchored at the node origin', () => {
        const ctx = makeCtx();
        const doc = terrainScene(ctx);
        const { local, contributors, skipped } = new BoundsCalculator(ctx)
            .computeSubtree(doc, doc.resolveNode('Holder/Terrain'));

        assert.deepStrictEqual(skipped, []);
        // 1x1 blocks * 32 tiles * tileSize 1 = 32x32 m; heights span 0..3 m
        assert.deepStrictEqual(local.min, { x: 0, y: 0, z: 0 });
        assert.deepStrictEqual(local.max, { x: 32, y: 3, z: 32 });
        assert.strictEqual(contributors.length, 1);
        assert.strictEqual(contributors[0].type, 'cc.Terrain');
        assert.match(contributors[0].source, /terrain 32x32m, height 0\.\.3/);
    });

    test('the terrain node\'s own rotation/scale do not inflate its box', () => {
        const ctx = makeCtx();
        const doc = terrainScene(ctx);
        applyOperations(doc, [
            { op: 'set_node_property', node: 'Holder/Terrain', property: 'position', value: { x: 5 } },
            { op: 'set_node_property', node: 'Holder/Terrain', property: 'rotation', value: { y: 90 } },
            { op: 'set_node_property', node: 'Holder/Terrain', property: 'scale', value: { x: 3, y: 3, z: 3 } }
        ]);
        const { local } = new BoundsCalculator(ctx).computeSubtree(doc, doc.resolveNode('Holder'));

        // The terrain shader offsets vertices by cc_matWorld[3] only
        assert.deepStrictEqual(local.size, { x: 32, y: 3, z: 32 });
        assert.deepStrictEqual(local.min, { x: 5, y: 0, z: 0 });
    });

    test('ancestor rotation/scale only move the terrain box, never resize it', () => {
        const ctx = makeCtx();
        const doc = terrainScene(ctx, 'Holder/Rot');
        applyOperations(doc, [
            { op: 'set_node_property', node: 'Holder/Rot', property: 'position', value: { x: 10 } },
            { op: 'set_node_property', node: 'Holder/Rot', property: 'rotation', value: { y: 90 } },
            { op: 'set_node_property', node: 'Holder/Rot', property: 'scale', value: { x: 2, y: 2, z: 2 } },
            { op: 'set_node_property', node: 'Holder/Rot/Terrain', property: 'position', value: { x: 5 } }
        ]);
        const { local } = new BoundsCalculator(ctx).computeSubtree(doc, doc.resolveNode('Holder'));

        // Ancestor translation still reaches the terrain THROUGH the rotation
        // and scale (that is what the composed matrix's translation column is):
        // (10,0,0) + Ry90 * 2 * (5,0,0) = (10,0,-10)
        assert.deepStrictEqual(local.size, { x: 32, y: 3, z: 32 });
        near(local.min.x, 10, 1e-9);
        near(local.min.y, 0, 1e-9);
        near(local.min.z, -10, 1e-9);
    });

    test('a terrain without an asset is skipped with a reason', () => {
        const ctx = makeCtx();
        const doc = terrainScene(ctx, 'Holder', { wireAsset: false });
        const { local, skipped } = new BoundsCalculator(ctx)
            .computeSubtree(doc, doc.resolveNode('Holder/Terrain'));
        assert.strictEqual(local, null);
        assert.deepStrictEqual(skipped, [{ path: 'Holder/Terrain', reason: 'cc.Terrain has no __asset' }]);
    });

    test('a terrain asset outside the project is skipped with a reason', () => {
        const ctx = makeCtx();
        const doc = terrainScene(ctx, 'Holder', { wireAsset: false });
        const compIdx = doc.componentIndices(doc.resolveNode('Holder/Terrain'))[0];
        doc.getObject(compIdx).__asset = {
            __uuid__: 'deadbeef-0000-4000-8000-000000000000',
            __expectedType__: 'cc.TerrainAsset'
        };
        const { local, skipped } = new BoundsCalculator(ctx)
            .computeSubtree(doc, doc.resolveNode('Holder/Terrain'));
        assert.strictEqual(local, null);
        assert.match(skipped[0].reason, /terrain asset deadbeef-.* not found under assets\//);
    });

    test('a never-sculpted (sentinel) terrain is still measurable with a flat Y span', () => {
        // Minimal disposable project (one .terrain + its meta) rather than a
        // copy of the shared mock project, which other suites write into.
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-bounds-terrain-'));
        try {
            fs.mkdirSync(path.join(tmp, 'assets', 'Maps'), { recursive: true });
            fs.copyFileSync(
                MOCK('assets/Maps/Terrain.terrain.meta'),
                path.join(tmp, 'assets/Maps/Terrain.terrain.meta')
            );
            fs.writeFileSync(path.join(tmp, 'assets/Maps/Terrain.terrain'), defaultSentinel());
            const assetIndex = new AssetIndex(tmp);
            const ctx = {
                assetIndex,
                assetInspector: new AssetInspector(tmp, assetIndex),
                projectRoot: tmp
            };

            const doc = terrainScene(ctx);
            const { local, contributors, skipped } = new BoundsCalculator(ctx)
                .computeSubtree(doc, doc.resolveNode('Holder/Terrain'));

            assert.deepStrictEqual(skipped, []);
            assert.deepStrictEqual(local.min, { x: 0, y: 0, z: 0 });
            assert.deepStrictEqual(local.max, { x: 32, y: 0, z: 32 });
            assert.match(contributors[0].source, /empty default terrain/);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
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
