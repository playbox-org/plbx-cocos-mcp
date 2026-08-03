/**
 * cc.Terrain / cc.TerrainCollider write-side tests
 *
 * Pins the two new component templates against the editor-saved shape, the
 * three accepted spellings of the terrain-asset property (the serialized key
 * is the DOUBLE-underscore `__asset`) and the read-side visibility of that
 * key — without which every read tool would render a terrain component with
 * no asset at all.
 *
 * Own file rather than an extra describe() in operations.test.js: the suite
 * needs its own disposable project (no .terrain asset exists in the shared
 * mock project) plus an end-to-end inspect_node pass, which operations.test.js
 * deliberately has no fixtures/imports for.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { SceneDocument } from '../../src/document/SceneDocument.js';
import { applyOperations } from '../../src/document/operations.js';
import { Validator } from '../../src/document/Validator.js';
import { AssetIndex } from '../../src/core/AssetIndex.js';
import { templateTypes, resolveTemplateType } from '../../src/document/ComponentTemplates.js';
import { ApplyEdits } from '../../src/tools/ApplyEdits.js';
import { InspectNode } from '../../src/tools/InspectNode.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = (f) => path.join(__dirname, '..', 'fixtures', 'golden', f);
const MOCK_PROJECT = path.join(__dirname, '..', 'fixtures', 'mock-project');

const loadScene = () => SceneDocument.load(GOLDEN('Main.scene_V2.scene'));
const loadPrefab = () => SceneDocument.load(GOLDEN('TableCash.prefab'));

/**
 * The only editor-saved cc.Terrain available on this machine, copied verbatim:
 * project-example/guligames-legendale-c7/assets/scene.scene, array index 65
 * (owner node index 64, _name "Terrain"), Cocos Creator 3.8.8 save.
 * Inlined as a literal because project-example/ is gitignored and no test
 * reads from it — this is the provenance record for the template's key order.
 *
 * `_receiveShadow: true` here is a USER FLIP: the engine default (and the
 * value in the engine's own editor/assets/default_prefab/Terrain.prefab) is
 * false, which is what the template must ship.
 */
const EDITOR_SAVED_TERRAIN = {
    __type__: 'cc.Terrain',
    _name: '',
    _objFlags: 0,
    __editorExtras__: {},
    node: { __id__: 64 },
    _enabled: true,
    __prefab: null,
    __asset: {
        __uuid__: '665a0471-f644-43e9-95c8-3415f2590ef5',
        __expectedType__: 'cc.TerrainAsset'
    },
    _effectAsset: null,
    _lightmapInfos: [],
    _receiveShadow: true,
    _useNormalmap: false,
    _usePBR: false,
    _lodEnable: false,
    _lodBias: 0,
    _id: '91etTnOcxA65CYXOCvdkvm'
};

// Same asset as the scene above; the disposable project below carries a
// .terrain.meta with this uuid so path/uuid resolution has something to hit.
const TERRAIN_UUID = '665a0471-f644-43e9-95c8-3415f2590ef5';
const TERRAIN_PATH = 'assets/Terrain/hills.terrain';
const TERRAIN_REF = { __uuid__: TERRAIN_UUID, __expectedType__: 'cc.TerrainAsset' };

let projectRoot;
let assetIndex;

before(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-terrain-'));
    fs.cpSync(MOCK_PROJECT, projectRoot, { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'assets', 'Terrain'), { recursive: true });
    // AssetIndex is meta-driven, so the payload next to the meta is irrelevant
    // here (T3's build_terrain is what produces real binaries). The meta is the
    // editor's own shape for a .terrain, verified against
    // project-example/guligames-legendale-c7/assets/Art/terrain.terrain.meta.
    fs.writeFileSync(path.join(projectRoot, 'assets', 'Terrain', 'hills.terrain'), '');
    fs.writeFileSync(
        path.join(projectRoot, 'assets', 'Terrain', 'hills.terrain.meta'),
        JSON.stringify({
            ver: '1.1.50',
            importer: 'terrain',
            imported: true,
            uuid: TERRAIN_UUID,
            files: ['.bin', '.json'],
            subMetas: {},
            userData: {}
        }, null, 2) + '\n'
    );
    fs.copyFileSync(
        GOLDEN('TableCash.prefab'),
        path.join(projectRoot, 'assets', 'Prefabs', 'TableCash.prefab')
    );
    assetIndex = new AssetIndex(projectRoot);
});

after(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
});

function assertValid(doc) {
    const { errors } = new Validator(doc).validate();
    assert.deepStrictEqual(errors, []);
}

/** The single component of a freshly added node */
function soleComponent(doc, nodePath) {
    const indices = doc.componentIndices(doc.resolveNode(nodePath));
    assert.strictEqual(indices.length, 1, `expected exactly one component on ${nodePath}`);
    return doc.getObject(indices[0]);
}

/** Scene doc with a "Terrain" node carrying just a cc.Terrain */
function sceneWithTerrain(extraOps = []) {
    const doc = loadScene();
    applyOperations(doc, [
        { op: 'add_node', parent: '/', name: 'Terrain' },
        { op: 'add_component', node: 'Terrain', type: 'cc.Terrain' },
        ...extraOps
    ], { assetIndex });
    return doc;
}

describe('add_component cc.Terrain', () => {
    test('key set AND order match the editor-saved component', () => {
        const comp = soleComponent(sceneWithTerrain(), 'Terrain');
        assert.deepStrictEqual(Object.keys(comp), Object.keys(EDITOR_SAVED_TERRAIN));
    });

    test('values are the engine defaults (asset wired → identical to the editor save)', () => {
        const doc = sceneWithTerrain([{
            op: 'set_asset_ref', node: 'Terrain', component: 'cc.Terrain',
            property: 'asset', asset: TERRAIN_PATH
        }]);
        const comp = soleComponent(doc, 'Terrain');
        // Everything but the file-local bits and the user's shadow flip must
        // equal the editor save byte-for-byte (same asset uuid on both sides).
        const expected = {
            ...EDITOR_SAVED_TERRAIN,
            node: comp.node,
            _id: comp._id,
            _receiveShadow: false // engine default; the real scene's `true` is a user flip
        };
        assert.deepStrictEqual(comp, expected);
        assert.deepStrictEqual(comp.__editorExtras__, {});
        assert.match(comp._id, /^[A-Za-z0-9+/]{22}$/);
        assert.strictEqual(comp.__prefab, null); // scene component — no CompPrefabInfo
    });

    test('no companions are auto-added and duplicates are rejected', () => {
        const doc = sceneWithTerrain();
        const types = doc.componentIndices(doc.resolveNode('Terrain'))
            .map(i => doc.getObject(i).__type__);
        assert.deepStrictEqual(types, ['cc.Terrain']);
        assert.throws(() =>
            applyOperations(doc, [{ op: 'add_component', node: 'Terrain', type: 'cc.Terrain' }]),
            /already has a cc\.Terrain/);
    });

    test('validates clean and keeps the canonical fixed point', () => {
        const doc = sceneWithTerrain([{
            op: 'set_asset_ref', node: 'Terrain', component: 'cc.Terrain',
            property: 'asset', asset: TERRAIN_PATH
        }]);
        doc.renumber();
        assertValid(doc);
        const first = doc.serialize();
        const reloaded = new SceneDocument(JSON.parse(first));
        reloaded.renumber();
        assert.strictEqual(reloaded.serialize(), first);
    });

    test('in a prefab it gets a CompPrefabInfo like every other component', () => {
        const doc = loadPrefab();
        applyOperations(doc, [
            { op: 'add_node', parent: '/', name: 'Ground' },
            { op: 'add_component', node: 'Ground', type: 'Terrain' }
        ]);
        const comp = soleComponent(doc, 'Ground');
        assert.strictEqual(comp.__type__, 'cc.Terrain');
        assert.strictEqual(comp._id, '');
        assert.strictEqual(doc.getObject(comp.__prefab.__id__).__type__, 'cc.CompPrefabInfo');
        doc.renumber();
        assertValid(doc);
    });
});

describe('add_component cc.TerrainCollider', () => {
    // No editor-saved TerrainCollider exists anywhere on this machine — the
    // expected shape is the Collider base (_material/_isTrigger/_center, in
    // collider.ts declaration order, as in 260+ real Box/Sphere samples) plus
    // the subclass's single @serializable `_terrain`. PENDING an editor
    // re-save check, same lane as cc.CylinderCollider / cc.MeshCollider.
    const EXPECTED_KEYS = [
        '__type__', '_name', '_objFlags', '__editorExtras__', 'node', '_enabled', '__prefab',
        '_material', '_isTrigger', '_center', '_terrain', '_id'
    ];

    test('field set/order follows the collider base-then-subclass layout', () => {
        const doc = loadScene();
        applyOperations(doc, [
            { op: 'add_node', parent: '/', name: 'Terrain' },
            { op: 'add_component', node: 'Terrain', type: 'cc.TerrainCollider' }
        ]);
        const comp = soleComponent(doc, 'Terrain');
        assert.deepStrictEqual(Object.keys(comp), EXPECTED_KEYS);
        assert.strictEqual(comp._material, null);
        assert.strictEqual(comp._isTrigger, false);
        assert.deepStrictEqual(comp._center, { __type__: 'cc.Vec3', x: 0, y: 0, z: 0 });
        assert.strictEqual(comp._terrain, null);
        // The prefix is literally the one every other 3D collider template uses
        const box = (() => {
            const d = loadScene();
            applyOperations(d, [
                { op: 'add_node', parent: '/', name: 'Box' },
                { op: 'add_component', node: 'Box', type: 'cc.BoxCollider' }
            ]);
            return soleComponent(d, 'Box');
        })();
        assert.deepStrictEqual(Object.keys(comp).slice(0, 10), Object.keys(box).slice(0, 10));
    });

    test('alongside cc.Terrain the node validates clean', () => {
        const doc = sceneWithTerrain([
            { op: 'add_component', node: 'Terrain', type: 'cc.TerrainCollider' },
            {
                op: 'set_asset_ref', node: 'Terrain', component: 'cc.Terrain',
                property: 'asset', asset: TERRAIN_PATH
            },
            {
                op: 'set_asset_ref', node: 'Terrain', component: 'cc.TerrainCollider',
                property: 'terrain', asset: TERRAIN_PATH
            }
        ]);
        const types = doc.componentIndices(doc.resolveNode('Terrain'))
            .map(i => doc.getObject(i).__type__);
        assert.deepStrictEqual(types, ['cc.Terrain', 'cc.TerrainCollider']);
        doc.renumber();
        assertValid(doc);
    });
});

describe('set_asset_ref — the terrain asset property spellings', () => {
    // The serialized member is `protected __asset` (terrain.ts); `_asset` is
    // only a getter/setter facade, so there is exactly ONE serialized key and
    // three accepted spellings, each reaching it by a different mechanism.
    const CASES = [
        ['asset', 'PROPERTY_ALIASES (cc.Terrain: asset → __asset)'],
        ['_asset', "locateProperty's pre-existing one-underscore retry (_asset → __asset)"],
        ['__asset', 'the exact serialized key']
    ];

    for (const [property, mechanism] of CASES) {
        test(`property "${property}" writes __asset — ${mechanism}`, () => {
            const doc = sceneWithTerrain([{
                op: 'set_asset_ref', node: 'Terrain', component: 'cc.Terrain',
                property, asset: TERRAIN_PATH
            }]);
            const comp = soleComponent(doc, 'Terrain');
            assert.deepStrictEqual(comp.__asset, TERRAIN_REF);
            // __expectedType__ comes from IMPORTER_TO_TYPE['terrain'], not from
            // an explicit expectedType arg.
            assert.strictEqual(comp.__asset.__expectedType__, 'cc.TerrainAsset');
            // No stray sibling key: locateProperty rewrites the segment IN
            // PLACE, so the write (and any propertyPath derived from it) lands
            // on the serialized name.
            assert.ok(!('asset' in comp), 'must not create a bare "asset" key');
            assert.ok(!('_asset' in comp), 'must not create a single-underscore "_asset" key');
            assert.deepStrictEqual(Object.keys(comp), Object.keys(EDITOR_SAVED_TERRAIN));
        });
    }

    test('the same spellings work by uuid and through set_component_property/$asset', () => {
        const doc = sceneWithTerrain([
            {
                op: 'set_asset_ref', node: 'Terrain', component: 'cc.Terrain',
                property: 'asset', asset: TERRAIN_UUID
            }
        ]);
        assert.deepStrictEqual(soleComponent(doc, 'Terrain').__asset, TERRAIN_REF);

        const viaProperty = loadScene();
        applyOperations(viaProperty, [
            { op: 'add_node', parent: '/', name: 'Terrain' },
            {
                op: 'add_component', node: 'Terrain', type: 'cc.Terrain',
                properties: { asset: { $asset: TERRAIN_PATH } }
            }
        ], { assetIndex });
        assert.deepStrictEqual(soleComponent(viaProperty, 'Terrain').__asset, TERRAIN_REF);

        const viaSet = sceneWithTerrain([{
            op: 'set_component_property', node: 'Terrain', component: 'cc.Terrain',
            property: 'asset', value: { $asset: TERRAIN_UUID }
        }]);
        assert.deepStrictEqual(soleComponent(viaSet, 'Terrain').__asset, TERRAIN_REF);
    });

    test('clearing with asset: null leaves the key in place', () => {
        const doc = sceneWithTerrain([
            {
                op: 'set_asset_ref', node: 'Terrain', component: 'cc.Terrain',
                property: 'asset', asset: TERRAIN_PATH
            },
            {
                op: 'set_asset_ref', node: 'Terrain', component: 'cc.Terrain',
                property: 'asset', asset: null
            }
        ]);
        const comp = soleComponent(doc, 'Terrain');
        assert.strictEqual(comp.__asset, null);
        assert.deepStrictEqual(Object.keys(comp), Object.keys(EDITOR_SAVED_TERRAIN));
    });

    test('cc.TerrainCollider: property "terrain" writes _terrain (plain underscore retry)', () => {
        const doc = loadScene();
        applyOperations(doc, [
            { op: 'add_node', parent: '/', name: 'Terrain' },
            { op: 'add_component', node: 'Terrain', type: 'cc.TerrainCollider' },
            {
                op: 'set_asset_ref', node: 'Terrain', component: 'cc.TerrainCollider',
                property: 'terrain', asset: TERRAIN_PATH
            }
        ], { assetIndex });
        const comp = soleComponent(doc, 'Terrain');
        assert.deepStrictEqual(comp._terrain, TERRAIN_REF);
        assert.ok(!('terrain' in comp), 'must not create a bare "terrain" key');
        // Same __expectedType__ as cc.Terrain — one IMPORTER_TO_TYPE entry serves both
        assert.strictEqual(comp._terrain.__expectedType__, 'cc.TerrainAsset');
        doc.renumber();
        assertValid(doc);
    });

    test('the alias does not swallow typos', () => {
        const doc = sceneWithTerrain();
        assert.throws(() =>
            applyOperations(doc, [{
                op: 'set_asset_ref', node: 'Terrain', component: 'cc.Terrain',
                property: 'assset', asset: TERRAIN_PATH
            }], { assetIndex }),
            (err) => {
                assert.match(err.message, /Component cc\.Terrain has no property "assset"/);
                assert.match(err.message, /Available: .*__asset/); // the real spelling is offered
                return true;
            });
        // and nothing was written
        assert.strictEqual(soleComponent(doc, 'Terrain').__asset, null);
    });

    test('the alias is scoped to cc.Terrain — "asset" stays unknown elsewhere', () => {
        const doc = loadScene();
        applyOperations(doc, [
            { op: 'add_node', parent: '/', name: 'Rock' },
            { op: 'add_component', node: 'Rock', type: 'cc.MeshCollider' }
        ]);
        assert.throws(() =>
            applyOperations(doc, [{
                op: 'set_asset_ref', node: 'Rock', component: 'cc.MeshCollider',
                property: 'asset', asset: TERRAIN_PATH
            }], { assetIndex }),
            /Component cc\.MeshCollider has no property "asset"/);
    });
});

describe('set_instance_property — the alias reaches prefab-instance overrides', () => {
    // Regression: overridePathForComponent (instances.js) is a SECOND
    // top-segment resolver next to locateProperty. Before it consulted
    // aliasTopSegment, `property: "asset"` recorded a dead
    // propertyPath ["asset"] — the engine applies an override with a bare
    // `targetPropOwner[name] = value` (scene-graph/prefab/utils.ts), and
    // cc.Terrain has no `asset` member, so the terrain silently kept the
    // source-prefab asset while validate_document reported nothing.
    const SRC_UUID = '11111111-2222-4333-8444-555555555555';
    const SRC_REL = 'Prefabs/TerrainSrc.prefab';
    let localIndex;

    before(() => {
        // Own source prefab so no other test in this file is disturbed
        const abs = path.join(projectRoot, 'assets', SRC_REL);
        fs.copyFileSync(GOLDEN('TableCash.prefab'), abs);
        fs.writeFileSync(`${abs}.meta`, JSON.stringify({
            ver: '1.1.50', importer: 'prefab', imported: true,
            uuid: SRC_UUID, files: ['.json'], subMetas: {}, userData: {}
        }, null, 2) + '\n');
        const src = SceneDocument.load(abs);
        applyOperations(src, [{ op: 'add_component', node: '/', type: 'cc.Terrain' }]);
        src.save(abs);
        localIndex = new AssetIndex(projectRoot);
    });

    /** Golden scene with an instance of the terrain-carrying source prefab */
    function sceneWithInstance() {
        const doc = loadScene();
        const ctx = { assetIndex: localIndex, projectRoot };
        applyOperations(doc, [
            { op: 'instantiate_prefab', parent: '/', prefab: SRC_REL, name: 'Src' }
        ], ctx);
        return { doc, ctx };
    }

    /** [propertyPath, ...] of the instance's property overrides */
    function overridePaths(doc) {
        const stub = doc.getObject(doc.resolveNode('Src'));
        const instance = doc.getObject(doc.getObject(stub._prefab.__id__).instance.__id__);
        return instance.propertyOverrides.map(r => doc.getObject(r.__id__).propertyPath);
    }

    for (const property of ['asset', '_asset', '__asset']) {
        test(`property "${property}" records propertyPath ["__asset"]`, () => {
            const { doc, ctx } = sceneWithInstance();
            applyOperations(doc, [{
                op: 'set_instance_property', node: 'Src', component: 'cc.Terrain',
                property, value: { $asset: TERRAIN_PATH }
            }], ctx);

            const assetPaths = overridePaths(doc).filter(p => p.join('.').includes('asset'));
            assert.deepStrictEqual(assetPaths, [['__asset']]);
            doc.renumber();
            assertValid(doc);
        });
    }

    test('the three spellings update ONE record, not three', () => {
        const { doc, ctx } = sceneWithInstance();
        for (const property of ['asset', '_asset', '__asset']) {
            applyOperations(doc, [{
                op: 'set_instance_property', node: 'Src', component: 'cc.Terrain',
                property, value: { $asset: TERRAIN_PATH }
            }], ctx);
        }
        const assetPaths = overridePaths(doc).filter(p => p.join('.').includes('asset'));
        assert.deepStrictEqual(assetPaths, [['__asset']]);
    });

    test('remove_instance_override {property: "asset"} drops the live record', () => {
        const { doc, ctx } = sceneWithInstance();
        applyOperations(doc, [{
            op: 'set_instance_property', node: 'Src', component: 'cc.Terrain',
            property: '__asset', value: { $asset: TERRAIN_PATH }
        }], ctx);
        applyOperations(doc, [{
            op: 'remove_instance_override', node: 'Src', component: 'cc.Terrain',
            property: 'asset'
        }], ctx);
        assert.deepStrictEqual(
            overridePaths(doc).filter(p => p.join('.').includes('asset')), []);
        doc.renumber();
        assertValid(doc);
    });

    test('cc.TerrainCollider: "terrain" → ["_terrain"] (pre-existing underscore retry)', () => {
        const abs = path.join(projectRoot, 'assets', 'Prefabs', 'ColliderSrc.prefab');
        fs.copyFileSync(GOLDEN('TableCash.prefab'), abs);
        fs.writeFileSync(`${abs}.meta`, JSON.stringify({
            ver: '1.1.50', importer: 'prefab', imported: true,
            uuid: '66666666-7777-4888-8999-aaaaaaaaaaaa', files: ['.json'],
            subMetas: {}, userData: {}
        }, null, 2) + '\n');
        const src = SceneDocument.load(abs);
        applyOperations(src, [{ op: 'add_component', node: '/', type: 'cc.TerrainCollider' }]);
        src.save(abs);

        const doc = loadScene();
        const ctx = { assetIndex: new AssetIndex(projectRoot), projectRoot };
        applyOperations(doc, [
            { op: 'instantiate_prefab', parent: '/', prefab: 'Prefabs/ColliderSrc.prefab', name: 'Src' },
            {
                op: 'set_instance_property', node: 'Src', component: 'cc.TerrainCollider',
                property: 'terrain', value: { $asset: TERRAIN_PATH }
            }
        ], ctx);
        assert.deepStrictEqual(
            overridePaths(doc).filter(p => p.join('.').includes('terrain')), [['_terrain']]);
    });
});

describe('ComponentTemplates registration', () => {
    test('both types are in the catalog', () => {
        const types = templateTypes();
        assert.ok(types.includes('cc.Terrain'), 'cc.Terrain missing from the template catalog');
        assert.ok(types.includes('cc.TerrainCollider'), 'cc.TerrainCollider missing');
    });

    test('ALIASES resolves the short spellings (derived, no wiring)', () => {
        for (const alias of ['Terrain', 'terrain', 'cc.Terrain']) {
            assert.strictEqual(resolveTemplateType(alias), 'cc.Terrain', alias);
        }
        for (const alias of ['TerrainCollider', 'terraincollider', 'cc.TerrainCollider']) {
            assert.strictEqual(resolveTemplateType(alias), 'cc.TerrainCollider', alias);
        }
    });
});

describe('read side — inspect_node surfaces the terrain asset', () => {
    // Regression pin: PropertyExtractor hides every `__`-prefixed key, and
    // cc.Terrain's asset reference is literally named __asset. Without the
    // narrow allowlist this tool renders a terrain component with no asset.
    test('the wired __asset shows up in inspect_node output', async () => {
        const edit = await new ApplyEdits().execute({
            filePath: 'assets/Prefabs/TableCash.prefab',
            ops: [
                { op: 'add_node', parent: '/', name: 'Ground' },
                { op: 'add_component', node: 'Ground', type: 'cc.Terrain' },
                {
                    op: 'set_asset_ref', node: 'Ground', component: 'cc.Terrain',
                    property: 'asset', asset: TERRAIN_PATH
                }
            ]
        }, projectRoot);
        assert.ok(!edit.isError, edit.content[0].text);

        const result = await new InspectNode().execute({
            filePath: 'assets/Prefabs/TableCash.prefab',
            nodeName: 'Ground',
            format: 'json'
        }, projectRoot);
        assert.ok(!result.isError, result.content[0].text);

        const json = JSON.parse(result.content[0].text);
        const terrain = json.components.find(c => c.type === 'Terrain');
        assert.ok(terrain, `no Terrain component in ${JSON.stringify(json)}`);
        // The asset resolves to its project label — this is the whole point
        assert.strictEqual(terrain.props.__asset, 'hills.terrain');
        // …and __asset is the ONLY dunder key that got through
        assert.deepStrictEqual(
            Object.keys(terrain.props).filter(k => k.startsWith('__')), ['__asset']);

        const asText = await new InspectNode().execute({
            filePath: 'assets/Prefabs/TableCash.prefab', nodeName: 'Ground'
        }, projectRoot);
        assert.ok(!asText.isError, asText.content[0].text);
        assert.match(asText.content[0].text, /__asset.*hills\.terrain/);
    });
});
