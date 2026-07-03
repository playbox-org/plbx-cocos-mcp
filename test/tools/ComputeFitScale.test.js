/**
 * ComputeFitScale + GetNodeBounds tool tests (mock project data)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { ComputeFitScale } from '../../src/tools/ComputeFitScale.js';
import { GetNodeBounds } from '../../src/tools/GetNodeBounds.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT = join(__dirname, '../fixtures/mock-project');

const COIN_MESH_HEIGHT = 0.004092095419764519 + 0.004092094954103231; // y extent

describe('ComputeFitScale tool', () => {
    const tool = new ComputeFitScale();

    it('should have correct metadata', () => {
        assert.strictEqual(tool.name, 'compute_fit_scale');
        assert.ok(tool.inputSchema.properties.targetHeight);
    });

    it('measures a model mesh and computes the factor', async () => {
        const result = await tool.execute({ asset: 'Models/Coin.fbx', targetHeight: 1.8 }, PROJECT);
        assert.ok(!result.isError, result.content[0].text);
        const text = result.content[0].text;
        const expected = 1.8 / COIN_MESH_HEIGHT;
        assert.ok(text.includes('Uniform scale factor'));
        assert.ok(text.includes(String(Math.round(expected * 10000) / 10000).slice(0, 6)));
    });

    it('fits inside multiple targets with the min factor', async () => {
        const result = await tool.execute(
            { asset: 'Models/Rock.glb', targetHeight: 2, targetWidth: 0.5 }, PROJECT
        );
        const text = result.content[0].text;
        // Rock AABB is 1 x 2 x 1 → height factor 1, width factor 0.5 → min 0.5
        assert.ok(text.includes('Uniform scale factor: 0.5'), text);
        assert.ok(text.includes('fits inside all targets'));
    });

    it('measures sprites in pixels', async () => {
        const result = await tool.execute({ asset: 'Sprites/coin_bar.png', targetWidth: 163 }, PROJECT);
        const text = result.content[0].text;
        assert.ok(text.includes('pixels'), text);
        assert.ok(text.includes('Uniform scale factor: 0.5'), text);
    });

    it('measures a prefab and reports without target', async () => {
        const result = await tool.execute({ asset: 'Prefabs/Crate.prefab' }, PROJECT);
        const text = result.content[0].text;
        assert.ok(!result.isError, text);
        assert.ok(text.includes('Measured size'));
        assert.ok(text.includes('No target given'));
    });

    it('suggests a ready-to-apply op for nodes', async () => {
        const result = await tool.execute({
            filePath: 'assets/Prefabs/Crate.prefab', node: 'Visual', targetHeight: 1.0
        }, PROJECT);
        const text = result.content[0].text;
        assert.ok(text.includes('set_node_property'), text);
        // Visual's own frame excludes its scale 2 → base = mesh size; suggested = 2 * factor
        const op = JSON.parse(text.match(/```json\n(.*)\n```/s)[1]);
        assert.strictEqual(op.property, 'scale');
        const factor = 1.0 / COIN_MESH_HEIGHT;
        assert.ok(Math.abs(op.value.y - 2 * factor) < 1);
    });

    it('errors cleanly on unmeasurable input', async () => {
        const result = await tool.execute({ asset: 'Materials/Dynamite.mtl', targetHeight: 1 }, PROJECT);
        assert.ok(result.isError);
        assert.match(result.content[0].text, /Cannot measure/);
    });
});

describe('GetNodeBounds tool', () => {
    const tool = new GetNodeBounds();

    it('should have correct metadata', () => {
        assert.strictEqual(tool.name, 'get_node_bounds');
        assert.deepStrictEqual(tool.inputSchema.required, ['filePath', 'node']);
    });

    it('reports local and world bounds with contributors', async () => {
        const result = await tool.execute(
            { filePath: 'assets/Prefabs/Crate.prefab', node: '/' }, PROJECT
        );
        assert.ok(!result.isError);
        const text = result.content[0].text;
        assert.ok(text.includes('Local'));
        assert.ok(text.includes('World'));
        assert.ok(text.includes('/Visual: cc.MeshRenderer'));
        assert.ok(text.includes('center: (0, 0.5, 0)'), text);
    });

    it('errors on missing files and unknown nodes', async () => {
        const missing = await tool.execute({ filePath: 'assets/Nope.scene', node: '/' }, PROJECT);
        assert.ok(missing.isError);
        const badNode = await tool.execute(
            { filePath: 'assets/Prefabs/Crate.prefab', node: 'Nope' }, PROJECT
        );
        assert.ok(badNode.isError);
        assert.match(badNode.content[0].text, /Node not found/);
    });
});
