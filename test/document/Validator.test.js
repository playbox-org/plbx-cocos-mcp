/**
 * Validator tests - invariants on golden files and hand-broken documents
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { SceneDocument } from '../../src/document/SceneDocument.js';
import { Validator } from '../../src/document/Validator.js';
import { applyOperations } from '../../src/document/operations.js';
import { AssetIndex } from '../../src/core/AssetIndex.js';
import { materialize, writeTerrain } from '../../src/utils/terrainBin.js';

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

    // The shape an editor leaves when a component referencing INTO an instance is deleted: a bare
    // cc.Node reachable only from a dead override, which must not block apply_edits
    const addShellOverride = (doc, { shellExtras = true } = {}) => {
        const shell = doc.addObject(shellExtras
            ? { __type__: 'cc.Node', __editorExtras__: {} }
            : { __type__: 'cc.Node' });
        const targetInfo = doc.addObject({ __type__: 'cc.TargetInfo', localID: ['3aXm1DEqxKvIQ+YbwSbjE1'] });
        const override = doc.addObject({
            __type__: 'cc.TargetOverrideInfo',
            source: null, // the referencing component is gone — what makes the record dead
            sourceInfo: null,
            propertyPath: ['animation'],
            target: { __id__: shell },
            targetInfo: { __id__: targetInfo }
        });
        const rootNode = doc.root.node;
        const registry = doc.getObject(rootNode._prefab.__id__);
        registry.targetOverrides = [...(registry.targetOverrides ?? []), { __id__: override }];
        return { shell, override };
    };

    test('an id-less serialization shell behind a dead override does not error', () => {
        const doc = load('Main.scene_V2.scene');
        addShellOverride(doc);
        const { errors, warnings } = new Validator(doc).validate();
        assert.deepStrictEqual(errors, []);
        assert.ok(warnings.some(w => /engine ignores this override.*source is null/.test(w)));
    });

    test('a real id-less scene node is still an error', () => {
        const doc = load('Main.scene_V2.scene');
        // Same dead record present, but the target carries scene state — a genuine defect
        const { shell } = addShellOverride(doc);
        doc.getObject(shell)._name = 'Ghost';
        const { errors } = new Validator(doc).validate();
        assert.ok(errors.some(e => /has no _id/.test(e)));
    });

    test('a shell something else also references is still an error', () => {
        const doc = load('Main.scene_V2.scene');
        const { shell } = addShellOverride(doc);
        // A second, live referrer means the object is load-bearing somewhere — the exemption is
        // only for objects nothing but a skipped record can reach
        doc.addObject({ __type__: 'cc.ModelBakeSettings', texture: { __id__: shell } });
        const { errors } = new Validator(doc).validate();
        assert.ok(errors.some(e => /has no _id/.test(e)));
    });

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

    // A sourceInfo (B2) override needs a SCRIPT component inside the instance:
    // @property reference fields live on scripts, and set_instance_property
    // shares set_component_property's resolver, so a property the source
    // component does not have is rejected instead of written as a dead
    // override. The mock prefabs carry no script — add one to a throwaway copy.
    let scriptProject;
    before(() => {
        scriptProject = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-validator-overrides-'));
        fs.cpSync(MOCK_PROJECT, scriptProject, { recursive: true });
        const srcPath = path.join(scriptProject, 'assets/Prefabs/TableCash.prefab');
        const src = SceneDocument.load(srcPath);
        applyOperations(src, [{ op: 'add_component', node: 'Table', type: 'PlayerController' }],
            { assetIndex: new AssetIndex(scriptProject), projectRoot: scriptProject });
        src.renumber();
        src.save(srcPath);
    });
    after(() => fs.rmSync(scriptProject, { recursive: true, force: true }));

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

    test('sourceInfo on a non-instance source is a warning; bad sourceInfo localID too', () => {
        const ctx = { assetIndex: new AssetIndex(scriptProject), projectRoot: scriptProject };
        const doc = load('Main.scene_V2.scene');
        applyOperations(doc, [
            { op: 'instantiate_prefab', parent: '/', prefab: 'Prefabs/TableCash.prefab', name: 'Desk' },
            {
                op: 'set_instance_property', node: 'Desk', target: 'Table',
                component: 'PlayerController', property: 'anchorNode',
                value: { $node: 'Desk/Table/CashRegister' }
            }
        ], ctx);
        const override = doc.objects.filter(o => o.__type__ === 'cc.TargetOverrideInfo').at(-1);

        const clean = new Validator(doc, ctx.assetIndex, { projectRoot: scriptProject }).validate();
        assert.deepStrictEqual(clean.errors, []);
        assert.ok(!clean.warnings.some(w => /sourceInfo/.test(w)));

        doc.getObject(override.sourceInfo.__id__).localID = ['bogusFileId0000000000'];
        const bad = new Validator(doc, ctx.assetIndex, { projectRoot: scriptProject }).validate();
        assert.deepStrictEqual(bad.errors, []);
        assert.ok(bad.warnings.some(w => /sourceInfo localID .* does not resolve/.test(w)));

        override.source = { __id__: doc.resolveNode('Main Light') }; // plain node, no instance
        const worse = new Validator(doc, ctx.assetIndex, { projectRoot: scriptProject }).validate();
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

/**
 * cc.Terrain / cc.TerrainCollider conventions — all WARNINGS (the golden
 * corpus, which carries no terrain, must stay at zero errors, and so must
 * every document these tests build).
 */
describe('Validator terrain checks', () => {
    const MOCK_PROJECT = path.join(__dirname, '..', 'fixtures', 'mock-project');
    // Mock project terrain: 1x1 blocks, plain layers (no normal maps, defaults)
    const PLAIN = 'assets/Maps/Terrain.terrain';
    const FANCY = 'assets/Maps/Fancy.terrain';
    const FANCY_UUID = 'f0f0f0f0-1111-4222-8333-444455556666';

    let projectRoot;
    let assetIndex;

    before(() => {
        // Minimal disposable project: the plain terrain + a prefab (for the
        // wrong-importer case), copied file by file. A recursive copy of the
        // shared mock project races with suites that write into it.
        projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-validator-terrain-'));
        for (const rel of [
            'assets/Maps/Terrain.terrain', 'assets/Maps/Terrain.terrain.meta',
            'assets/Prefabs/Gold.prefab', 'assets/Prefabs/Gold.prefab.meta'
        ]) {
            fs.mkdirSync(path.dirname(path.join(projectRoot, rel)), { recursive: true });
            fs.copyFileSync(path.join(MOCK_PROJECT, rel), path.join(projectRoot, rel));
        }

        // A second terrain whose layer carries a normal map AND non-default
        // roughness/metallic — the two component flags that must be paired.
        const data = materialize({
            blockCount: [1, 1], tileSize: 1, weightMapSize: 4, lightMapSize: 4,
            layers: [{
                slot: 0, tileSize: 1,
                detailMapId: '35b97cf8-601e-4835-8a3e-0d29568af652@6c48a',
                normalMapId: '11112222-3333-4444-8555-666677778888@6c48a',
                roughness: 0.5, metallic: 0.25
            }]
        });
        fs.writeFileSync(path.join(projectRoot, FANCY), writeTerrain(data));
        fs.writeFileSync(path.join(projectRoot, `${FANCY}.meta`), JSON.stringify({
            ver: '1.1.50', importer: 'terrain', imported: true, uuid: FANCY_UUID,
            files: ['.bin', '.json'], subMetas: {}, userData: {}
        }, null, 2) + '\n');

        assetIndex = new AssetIndex(projectRoot);
    });

    after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));

    /** Golden scene + a "Terrain" node with cc.Terrain (+ optional extra ops) */
    function terrainDoc(extraOps = [], { asset = PLAIN } = {}) {
        const doc = load('Main.scene_V2.scene');
        const ops = [
            { op: 'add_node', parent: '/', name: 'Terrain' },
            { op: 'add_component', node: 'Terrain', type: 'cc.Terrain' }
        ];
        if (asset) {
            ops.push({
                op: 'set_asset_ref', node: 'Terrain', component: 'cc.Terrain',
                property: 'asset', asset
            });
        }
        applyOperations(doc, [...ops, ...extraOps], { assetIndex, projectRoot });
        return doc;
    }

    const check = (doc) => new Validator(doc, assetIndex, { projectRoot }).validate();

    /** A specific component of a node (the golden scene has its own RigidBodies) */
    const componentOf = (doc, node, type) => doc.componentIndices(doc.resolveNode(node))
        .map(i => doc.getObject(i))
        .find(c => c.__type__ === type);

    /** Warnings mentioning a terrain component (ignores unrelated scene noise) */
    const terrainWarnings = (result) => result.warnings.filter(w => /cc\.Terrain/.test(w));

    test('a correctly wired terrain produces no terrain warnings', () => {
        const { errors, warnings } = check(terrainDoc());
        assert.deepStrictEqual(errors, []);
        assert.deepStrictEqual(terrainWarnings({ warnings }), []);
    });

    test('__asset null is a warning, never an error', () => {
        const { errors, warnings } = check(terrainDoc([], { asset: null }));
        assert.deepStrictEqual(errors, []);
        assert.ok(warnings.some(w => /cc\.Terrain on "Terrain": __asset is null/.test(w)),
            JSON.stringify(warnings));
    });

    test('an asset that is not a terrain importer is a warning', () => {
        const doc = terrainDoc([], { asset: null });
        const comp = doc.getObject(doc.componentIndices(doc.resolveNode('Terrain'))[0]);
        comp.__asset = {
            __uuid__: '836478c3-ffde-4110-8347-cfda26288652', // Gold.prefab
            __expectedType__: 'cc.TerrainAsset'
        };
        const { errors, warnings } = check(doc);
        assert.deepStrictEqual(errors, []);
        assert.ok(warnings.some(w => /is a prefab asset, not a terrain/.test(w)), JSON.stringify(warnings));
    });

    test('_lightmapInfos length must be 0 or one per block', () => {
        const doc = terrainDoc();
        const comp = doc.getObject(doc.componentIndices(doc.resolveNode('Terrain'))[0]);

        comp._lightmapInfos = [{}, {}, {}]; // asset has 1x1 = 1 block
        let result = check(doc);
        assert.deepStrictEqual(result.errors, []);
        assert.ok(result.warnings.some(w => /_lightmapInfos has 3 entries but the asset has 1 block/.test(w)),
            JSON.stringify(result.warnings));

        comp._lightmapInfos = [{}]; // one per block — a normal bake
        result = check(doc);
        assert.deepStrictEqual(terrainWarnings(result), []);
    });

    test('layer normal maps require _useNormalmap', () => {
        let result = check(terrainDoc([], { asset: FANCY }));
        assert.deepStrictEqual(result.errors, []);
        assert.ok(result.warnings.some(w => /carry a normal map but _useNormalmap is false/.test(w)),
            JSON.stringify(result.warnings));

        result = check(terrainDoc([{
            op: 'set_component_property', node: 'Terrain', component: 'cc.Terrain',
            property: '_useNormalmap', value: true
        }], { asset: FANCY }));
        assert.ok(!result.warnings.some(w => /_useNormalmap/.test(w)));
    });

    test('layer roughness/metallic require _usePBR', () => {
        let result = check(terrainDoc([], { asset: FANCY }));
        assert.ok(result.warnings.some(w => /roughness\/metallic but _usePBR is false/.test(w)),
            JSON.stringify(result.warnings));

        result = check(terrainDoc([{
            op: 'set_component_property', node: 'Terrain', component: 'cc.Terrain',
            property: '_usePBR', value: true
        }], { asset: FANCY }));
        assert.ok(!result.warnings.some(w => /_usePBR/.test(w)));

        // The plain terrain uses the engine defaults (roughness 1, metallic 0)
        assert.ok(!check(terrainDoc()).warnings.some(w => /_usePBR/.test(w)));
    });

    test('the layer checks are silent without a readable asset', () => {
        // No projectRoot ⇒ the binary cannot be read; the flag pairing must not
        // be guessed, and nothing may crash.
        const doc = terrainDoc([], { asset: FANCY });
        const { errors, warnings } = new Validator(doc, assetIndex).validate();
        assert.deepStrictEqual(errors, []);
        assert.ok(!warnings.some(w => /_useNormalmap|_usePBR/.test(w)));
    });

    describe('cc.TerrainCollider', () => {
        const colliderDoc = (extraOps = []) => terrainDoc([
            { op: 'add_component', node: 'Terrain', type: 'cc.TerrainCollider' },
            {
                op: 'set_asset_ref', node: 'Terrain', component: 'cc.TerrainCollider',
                property: 'terrain', asset: PLAIN
            },
            ...extraOps
        ]);

        test('a wired collider without a body is clean', () => {
            const result = check(colliderDoc());
            assert.deepStrictEqual(result.errors, []);
            assert.deepStrictEqual(terrainWarnings(result), []);
        });

        test('_terrain null is a warning', () => {
            const doc = terrainDoc([{ op: 'add_component', node: 'Terrain', type: 'cc.TerrainCollider' }]);
            const { errors, warnings } = check(doc);
            assert.deepStrictEqual(errors, []);
            assert.ok(warnings.some(w => /cc\.TerrainCollider on "Terrain": _terrain is null/.test(w)),
                JSON.stringify(warnings));
        });

        test('a DYNAMIC cc.RigidBody next to it is warnID 9630', () => {
            // The engine default is DYNAMIC (ERigidBodyType.DYNAMIC = 1), so an
            // ABSENT _type must be treated as dynamic
            const doc = colliderDoc([{ op: 'add_component', node: 'Terrain', type: 'cc.RigidBody' }]);
            const body = componentOf(doc, 'Terrain', 'cc.RigidBody');

            delete body._type;
            let result = check(doc);
            assert.deepStrictEqual(result.errors, []);
            assert.ok(result.warnings.some(w => /DYNAMIC cc\.RigidBody.*9630/.test(w)),
                JSON.stringify(result.warnings));

            body._type = 1; // explicit DYNAMIC
            assert.ok(check(doc).warnings.some(w => /9630/.test(w)));
        });

        test('a STATIC or KINEMATIC cc.RigidBody is fine', () => {
            const doc = colliderDoc([{ op: 'add_component', node: 'Terrain', type: 'cc.RigidBody' }]);
            const body = componentOf(doc, 'Terrain', 'cc.RigidBody');

            body._type = 2; // STATIC
            assert.deepStrictEqual(terrainWarnings(check(doc)), []);
            body._type = 4; // KINEMATIC
            assert.deepStrictEqual(terrainWarnings(check(doc)), []);
        });

        test('a dynamic body without a terrain collider is not flagged', () => {
            const doc = terrainDoc([{ op: 'add_component', node: 'Terrain', type: 'cc.RigidBody' }]);
            componentOf(doc, 'Terrain', 'cc.RigidBody')._type = 1;
            assert.deepStrictEqual(terrainWarnings(check(doc)), []);
        });
    });
});
