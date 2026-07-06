import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { AssetIndex } from '../../src/core/AssetIndex.js';
import { AssetInspector } from '../../src/core/AssetInspector.js';

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
});
