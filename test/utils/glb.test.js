import { describe, it } from 'node:test';
import assert from 'node:assert';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readGlbJson, extractMeshBounds } from '../../src/utils/glb.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GLB = join(__dirname, '../fixtures/mock-project/assets/Models/Rock.glb');

describe('glb utils', () => {
    it('should read the JSON chunk of a GLB file', () => {
        const gltf = readGlbJson(GLB);
        assert.ok(gltf);
        assert.strictEqual(gltf.asset.version, '2.0');
        assert.strictEqual(gltf.meshes.length, 1);
    });

    it('should extract per-mesh AABB from POSITION accessors', () => {
        const bounds = extractMeshBounds(GLB);
        assert.strictEqual(bounds.length, 1);
        assert.strictEqual(bounds[0].name, 'Rock');
        assert.deepStrictEqual(bounds[0].min, [-0.5, 0, -0.5]);
        assert.deepStrictEqual(bounds[0].max, [0.5, 2, 0.5]);
    });

    it('should return null for a non-GLB file', () => {
        const notGlb = join(__dirname, '../fixtures/mock-project/package.json');
        assert.strictEqual(readGlbJson(notGlb), null);
    });
});
