import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { AssetIndex } from '../../src/core/AssetIndex.js';
import { AssetInspector } from '../../src/core/AssetInspector.js';
import { materialize, writeTerrain, defaultSentinel } from '../../src/utils/terrainBin.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT = join(__dirname, '../fixtures/mock-project');

describe('AssetInspector', () => {
    let inspector;

    before(() => {
        const index = new AssetIndex(PROJECT);
        inspector = new AssetInspector(PROJECT, index);
    });

    it('should return null for unknown assets', () => {
        assert.strictEqual(inspector.inspect('assets/Nope.png'), null);
    });

    describe('sprites', () => {
        it('should extract rect/trim/rawSize from a trimmed sprite', () => {
            const info = inspector.inspect('assets/Sprites/coin_bar.png');
            assert.strictEqual(info.importer, 'image');
            const sf = info.spriteFrame;
            assert.deepStrictEqual(sf.rect, { x: 0, y: 2, width: 317, height: 94 });
            assert.deepStrictEqual(sf.rawSize, { width: 326, height: 96 });
            assert.deepStrictEqual(sf.offset, { x: -4.5, y: -1 });
            assert.strictEqual(sf.isSliced, false);
        });

        it('should extract 9-slice borders', () => {
            const info = inspector.inspect('assets/Sprites/panel.png');
            const sf = info.spriteFrame;
            assert.strictEqual(sf.isSliced, true);
            assert.deepStrictEqual(sf.borders, { top: 20, bottom: 20, left: 24, right: 24 });
        });

        it('should inspect a sprite by sub-asset UUID', () => {
            const info = inspector.inspect('11112222-3333-4444-8555-666677778888@f9941');
            assert.strictEqual(info.importer, 'sprite-frame');
            assert.strictEqual(info.uuid, '11112222-3333-4444-8555-666677778888@f9941');
            assert.ok(info.spriteFrame);
        });
    });

    describe('models', () => {
        it('should read mesh AABB from compiled library JSON', () => {
            const info = inspector.inspect('assets/Models/Coin.fbx');
            assert.strictEqual(info.meshes.length, 1);
            const mesh = info.meshes[0];
            assert.strictEqual(mesh.name, 'Circle.019.mesh');
            assert.strictEqual(mesh.aabbSource, 'library');
            assert.ok(Math.abs(mesh.aabb.min.x - -0.004092) < 1e-4);
            assert.ok(mesh.aabb.size.x > 0);
            assert.strictEqual(info.materials.length, 1);
            assert.ok(info.modelPrefab.endsWith('@4b8b9'));
        });

        it('should fall back to glb accessors when library is missing', () => {
            const info = inspector.inspect('assets/Models/Rock.glb');
            assert.strictEqual(info.meshes.length, 1);
            const mesh = info.meshes[0];
            assert.strictEqual(mesh.aabbSource, 'glb');
            assert.deepStrictEqual(mesh.aabb.min, { x: -0.5, y: 0, z: -0.5 });
            assert.deepStrictEqual(mesh.aabb.size, { x: 1, y: 2, z: 1 });
        });
    });

    describe('prefabs', () => {
        it('should summarize prefab structure', () => {
            const info = inspector.inspect('assets/Prefabs/Gold.prefab');
            assert.strictEqual(info.rootName, 'Gold');
            assert.strictEqual(info.nodeCount, 2);
            assert.strictEqual(info.prefabInstances, 1);
            assert.ok(Array.isArray(info.rootComponents));
        });
    });

    describe('materials', () => {
        it('should extract effect reference and defines', () => {
            const info = inspector.inspect('assets/Materials/Dynamite.mtl');
            assert.strictEqual(info.effect.uuid, 'c8f66d17-351a-48da-a12c-0212d28575c4');
            assert.strictEqual(info.technique, 0);
            assert.strictEqual(info.defines.USE_INSTANCING, true);
            assert.strictEqual(info.defines.USE_ALBEDO_MAP, true);
        });
    });

    describe('scripts', () => {
        it('should expose the compressed UUID used in scene files', () => {
            const info = inspector.inspect('assets/Scripts/PlayerController.ts');
            assert.strictEqual(info.compressedUuid, '34eedIT7YpDJIIjpHypi4aF');
        });
    });

    describe('terrain', () => {
        it('should read geometry, height range and the layer palette', () => {
            const info = inspector.inspect('assets/Maps/Terrain.terrain');
            assert.strictEqual(info.importer, 'terrain');
            const t = info.terrain;
            assert.ok(t, 'terrain block must be a uniquely named container key');
            assert.deepStrictEqual(t.blockCount, [1, 1]);
            assert.deepStrictEqual(t.size, [32, 32]);
            assert.deepStrictEqual(t.vertexCount, [33, 33]);
            assert.strictEqual(t.weightMapSize, 32);
            assert.strictEqual(t.heightMin, 0);
            assert.strictEqual(t.heightMax, 3);
            assert.strictEqual(t.isDefaultSentinel, false);
            assert.strictEqual(t.layers.length, 2);
            assert.deepStrictEqual(t.warnings, []);
        });

        it('should resolve layer texture ids to names, keeping the raw id', () => {
            const [first, second] = inspector.inspect('assets/Maps/Terrain.terrain').terrain.layers;
            assert.strictEqual(first.detailMapId, '35b97cf8-601e-4835-8a3e-0d29568af652@6c48a');
            assert.strictEqual(first.detailMapName, 'coin_bar.png@6c48a');
            // An absent map is null, the same spelling query_terrain uses — the binary's
            // own "" must not leak into the json card (two spellings of one absent value).
            assert.strictEqual(first.normalMapId, null);
            assert.strictEqual(first.normalMapName, null);
            assert.strictEqual(second.detailMapName, 'panel.png@6c48a');
        });

        // get_asset_info and query_terrain used to answer with two incompatible json
        // shapes for the same asset (heightMin vs height.min, "" vs null). The nested
        // block is query_terrain's, and it is now emitted here too.
        it('should mirror query_terrain\'s nested height block', () => {
            const t = inspector.inspect('assets/Maps/Terrain.terrain').terrain;
            assert.deepStrictEqual(t.height, {
                min: t.heightMin,
                max: t.heightMax,
                mean: t.heightMean,
                minRaw: t.heightMinRaw,
                maxRaw: t.heightMaxRaw,
                flat: t.isFlat,
                quantum: 1 / 128
            });
            assert.strictEqual(t.height.min, 0);
            assert.strictEqual(t.height.max, 3);
            assert.strictEqual(t.height.flat, false);
        });

        it('should be resolvable by UUID too', () => {
            const info = inspector.inspect('a3c1b7d2-4e58-4f0a-9b6c-1d2e3f405060');
            assert.strictEqual(info.terrain.weightMapSize, 32);
        });
    });
});

describe('AssetInspector terrain edge cases', () => {
    let root;
    let inspector;

    const TERRAIN = 'assets/Maps/Terrain.terrain';

    /** Overwrite the disposable project's terrain binary */
    const rewrite = (buf) => fs.writeFileSync(join(root, TERRAIN), buf);

    before(() => {
        // A minimal project (one .terrain + its .meta), NOT a copy of the shared
        // mock project: other suites create and delete files under it, which
        // makes a recursive copy racy.
        root = fs.mkdtempSync(join(os.tmpdir(), 'cocos-inspect-terrain-'));
        fs.mkdirSync(join(root, 'assets', 'Maps'), { recursive: true });
        fs.copyFileSync(join(PROJECT, `${TERRAIN}.meta`), join(root, `${TERRAIN}.meta`));
        fs.copyFileSync(join(PROJECT, TERRAIN), join(root, TERRAIN));
        inspector = new AssetInspector(root, new AssetIndex(root));
    });

    after(() => fs.rmSync(root, { recursive: true, force: true }));

    it('should report an unresolvable layer texture as a warning', () => {
        const data = materialize({
            blockCount: [1, 1], tileSize: 1, weightMapSize: 4, lightMapSize: 4,
            layers: [{
                slot: 0, tileSize: 1,
                detailMapId: 'deadbeef-0000-4000-8000-000000000000@6c48a',
                normalMapId: '', roughness: 1, metallic: 0
            }]
        });
        rewrite(writeTerrain(data));

        const t = inspector.inspect(TERRAIN).terrain;
        assert.strictEqual(t.layers[0].detailMapName, null);
        assert.ok(t.warnings.some(w => /does not resolve to a project asset/.test(w)),
            `expected an unresolvable-texture warning, got ${JSON.stringify(t.warnings)}`);
    });

    it('should surface the sentinel flag of a never-sculpted terrain', () => {
        rewrite(defaultSentinel());
        const t = inspector.inspect(TERRAIN).terrain;
        assert.strictEqual(t.isDefaultSentinel, true);
        assert.strictEqual(t.heightMin, null);
        assert.deepStrictEqual(t.size, [32, 32]); // class defaults: 1x1 blocks, tileSize 1
        assert.deepStrictEqual(t.layers, []);
    });

    it('should return {error} for a file that is not a terrain binary', () => {
        rewrite(Buffer.from('not a terrain at all, really'));
        const t = inspector.inspect(TERRAIN).terrain;
        assert.match(t.error, /Not a Cocos \.terrain binary/);
    });

    it('should return {error} when the payload is truncated', () => {
        // Valid V8 magic, then a header that claims more than the file holds
        const head = writeTerrain(materialize({
            blockCount: [1, 1], tileSize: 1, weightMapSize: 4, lightMapSize: 4, layers: []
        }));
        rewrite(head.subarray(0, 64));
        const t = inspector.inspect(TERRAIN).terrain;
        assert.match(t.error, /truncated|count/);
    });

    it('should return {error} when the file is gone', () => {
        fs.rmSync(join(root, TERRAIN));
        const t = inspector.inspect(TERRAIN).terrain;
        assert.match(t.error, /Cannot read terrain file/);
    });

    it('should re-read after an in-process rewrite (cache keyed on mtime+size)', () => {
        const small = materialize({
            blockCount: [1, 1], tileSize: 1, weightMapSize: 4, lightMapSize: 4, layers: []
        });
        rewrite(writeTerrain(small));
        assert.strictEqual(inspector.inspect(TERRAIN).terrain.weightMapSize, 4);

        const bigger = materialize({
            blockCount: [2, 1], tileSize: 2, weightMapSize: 8, lightMapSize: 8, layers: []
        });
        rewrite(writeTerrain(bigger));
        const t = inspector.inspect(TERRAIN).terrain;
        assert.strictEqual(t.weightMapSize, 8);
        assert.deepStrictEqual(t.size, [128, 64]);
    });
});
