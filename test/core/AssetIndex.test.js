import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { AssetIndex } from '../../src/core/AssetIndex.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT = join(__dirname, '../fixtures/mock-project');

describe('AssetIndex', () => {
    let index;

    before(() => {
        index = new AssetIndex(PROJECT);
    });

    it('should index all .meta files including directories', () => {
        assert.ok(index.entries.length >= 7);
        assert.ok(index.entries.some(e => e.importer === 'directory'));
    });

    it('should resolve by project-relative path', () => {
        const result = index.resolve('assets/Prefabs/Gold.prefab');
        assert.ok(result);
        assert.strictEqual(result.entry.uuid, '836478c3-ffde-4110-8347-cfda26288652');
        assert.strictEqual(result.subAsset, null);
    });

    it('should resolve paths given relative to assets/', () => {
        const result = index.resolve('Prefabs/Gold.prefab');
        assert.ok(result);
        assert.strictEqual(result.entry.name, 'Gold.prefab');
    });

    it('should resolve by full UUID', () => {
        const result = index.resolve('34eed213-ed8a-4324-8223-a47ca98b8685');
        assert.ok(result);
        assert.strictEqual(result.entry.path, 'assets/Scripts/PlayerController.ts');
    });

    it('should resolve by compressed UUID', () => {
        const result = index.resolve('34eedIT7YpDJIIjpHypi4aF');
        assert.ok(result);
        assert.strictEqual(result.entry.name, 'PlayerController.ts');
    });

    it('should resolve sub-asset references', () => {
        const result = index.resolve('11112222-3333-4444-8555-666677778888@f9941');
        assert.ok(result);
        assert.strictEqual(result.entry.name, 'panel.png');
        assert.strictEqual(result.subAsset.importer, 'sprite-frame');
    });

    it('should return null for unknown references', () => {
        assert.strictEqual(index.resolve('assets/Nope.png'), null);
        assert.strictEqual(index.resolve('99999999-9999-4999-8999-999999999999'), null);
        assert.strictEqual(index.resolve(''), null);
    });

    it('should list assets excluding directories by default', () => {
        const all = index.list();
        assert.ok(all.length > 0);
        assert.ok(all.every(e => e.importer !== 'directory'));
    });

    it('should filter by friendly type alias', () => {
        const models = index.list({ type: 'model' });
        assert.strictEqual(models.length, 3); // Coin.fbx, Rock.glb, mesh_001.fbx (lint fixture)
        assert.ok(models.every(e => ['fbx', 'gltf'].includes(e.importer)));

        const sprites = index.list({ type: 'sprite' });
        assert.ok(sprites.every(e => e.subAssets.some(s => s.importer === 'sprite-frame')));
        assert.ok(sprites.some(e => e.name === 'panel.png'));
    });

    it('should filter by raw importer name', () => {
        const scripts = index.list({ type: 'typescript' });
        assert.strictEqual(scripts.length, 1);
        assert.strictEqual(scripts[0].name, 'PlayerController.ts');
    });

    it('should filter by folder with or without assets/ prefix', () => {
        assert.strictEqual(index.list({ folder: 'assets/Models' }).length, 3);
        assert.strictEqual(index.list({ folder: 'Models' }).length, 3);
        assert.strictEqual(index.list({ folder: 'Models/' }).length, 3);
    });

    it('should filter by wildcard pattern', () => {
        const pngs = index.list({ pattern: '*.png' });
        assert.ok(pngs.length >= 2);
        assert.ok(pngs.every(e => e.name.endsWith('.png')));

        const gold = index.list({ pattern: 'Gold.*' });
        assert.strictEqual(gold.length, 1);
    });

    it('should combine filters', () => {
        const result = index.list({ type: 'image', folder: 'Sprites', pattern: 'panel*' });
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].name, 'panel.png');
    });

    it('should handle a project without assets directory', () => {
        const empty = new AssetIndex('/nonexistent/path');
        assert.strictEqual(empty.entries.length, 0);
        assert.strictEqual(empty.resolve('anything'), null);
    });
});
