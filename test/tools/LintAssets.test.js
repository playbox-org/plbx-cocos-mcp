/**
 * LintAssets tool tests (mock project fixtures)
 *
 * Planted findings: Models/mesh_001.fbx (cryptic name),
 * Prefabs/Sprite(2).prefab (cryptic name + MeshRenderer on root + root
 * scale 0.01), and a huge Coin-vs-Rock model size spread.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { LintAssets } from '../../src/tools/LintAssets.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT = join(__dirname, '../fixtures/mock-project');

describe('LintAssets tool', () => {
    const tool = new LintAssets();

    it('should have correct metadata', () => {
        assert.strictEqual(tool.name, 'lint_assets');
        assert.deepStrictEqual(tool.inputSchema.properties.checks.items.enum,
            ['names', 'scales', 'wrappers']);
    });

    it('flags cryptic names', async () => {
        const result = await tool.execute({ checks: ['names'] }, PROJECT);
        const text = result.content[0].text;
        assert.ok(text.includes('mesh_001.fbx — generic auto-name'), text);
        assert.ok(text.includes('Sprite(2).prefab — editor duplicate suffix'), text);
        assert.ok(!text.includes('TableCash.prefab —'), 'good names must pass');
    });

    it('flags scattered model scales', async () => {
        // Coin ≈ 0.008 units vs Rock = 2 units → far beyond 10× of the median
        const result = await tool.execute({ checks: ['scales'] }, PROJECT);
        const text = result.content[0].text;
        assert.ok(text.includes('Model scale spread (1)'), text);
        assert.ok(text.includes('Coin.fbx'), text);
        assert.ok(!text.includes('mesh_001'), 'models without AABB are not compared');
    });

    it('flags wrapper-rule violations on prefab roots', async () => {
        const result = await tool.execute({ checks: ['wrappers'] }, PROJECT);
        const text = result.content[0].text;
        assert.ok(text.includes('Sprite(2).prefab — root carries cc.MeshRenderer'), text);
        assert.ok(text.includes('root scale is (0.01, 0.01, 0.01)'), text);
        assert.ok(!text.includes('Crate.prefab —'), 'wrapper-conform prefab must pass');
    });

    it('respects the folder filter and runs all checks by default', async () => {
        const result = await tool.execute({ folder: 'assets/Sprites' }, PROJECT);
        const text = result.content[0].text;
        assert.ok(text.includes('Cryptic names'));
        assert.ok(text.includes('Prefab wrapper rule'));
        assert.ok(!text.includes('mesh_001'), 'outside the folder');
        assert.ok(text.startsWith('# Asset lint — 0 finding(s)'), text);
    });
});
