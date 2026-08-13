/**
 * LintAssets tool tests (mock project fixtures)
 *
 * Planted findings: Models/mesh_001.fbx (cryptic name),
 * Prefabs/Sprite(2).prefab (cryptic name + MeshRenderer on root + root
 * scale 0.01), and a huge Coin-vs-Rock model size spread. The terrain check
 * has nothing to find in the pristine fixture (Maps/Terrain.terrain's two
 * layers resolve and both are painted) — its findings are planted per test on
 * a temp copy.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { LintAssets } from '../../src/tools/LintAssets.js';
import { ApplyEdits } from '../../src/tools/ApplyEdits.js';
import {
    readTerrain, writeTerrain, readTerrainInfo, terrainWarningText
} from '../../src/utils/terrainBin.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT = join(__dirname, '../fixtures/mock-project');
const TERRAIN_REL = 'assets/Maps/Terrain.terrain';

/**
 * Run the terrain check over a throwaway copy of the mock project whose
 * Maps/Terrain.terrain has been mutated in memory by `mutate(data)`.
 * @returns {Promise<{text: string, warnings: string[]}>} lint output + what
 *   readTerrainInfo says about the same file (drift guard: the lint check
 *   re-derives the zero-coverage rule from layerUsage/blockLayers)
 */
async function lintMutatedTerrain(mutate) {
    const root = fs.mkdtempSync(join(os.tmpdir(), 'cocos-lint-terrain-'));
    try {
        fs.cpSync(PROJECT, root, { recursive: true });
        const file = join(root, TERRAIN_REL);
        const data = readTerrain(fs.readFileSync(file));
        mutate(data);
        fs.writeFileSync(file, writeTerrain(data));
        const result = await new LintAssets().execute({ checks: ['terrain'] }, root);
        return { text: result.content[0].text, warnings: readTerrainInfo(file).warnings };
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

/** Zero out one weight channel across the whole global weight map */
function clearChannel(data, channel) {
    for (let i = channel; i < data.weights.length; i += 4) data.weights[i] = 0;
}

describe('LintAssets tool', () => {
    const tool = new LintAssets();

    it('should have correct metadata', () => {
        assert.strictEqual(tool.name, 'lint_assets');
        assert.deepStrictEqual(tool.inputSchema.properties.checks.items.enum,
            ['names', 'scales', 'wrappers', 'materials', 'terrain']);
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
        assert.ok(text.includes('Material consistency'));
        assert.ok(text.includes('Terrain layers'), 'terrain runs by default like its siblings');
        assert.ok(!text.includes('mesh_001'), 'outside the folder');
        assert.ok(text.startsWith('# Asset lint — 0 finding(s)'), text);
    });

    it('passes materials check on the untouched mock project', async () => {
        const result = await tool.execute({ checks: ['materials'] }, PROJECT);
        const text = result.content[0].text;
        assert.ok(text.includes('OK — no mesh mixes embedded and project materials'), text);
    });

    describe('materials consistency finding', () => {
        // Same mesh (Coin.fbx) twice: one instance re-materialed to a project
        // .mtl, the other left on the embedded fbx material → one finding
        let projectRoot;

        before(async () => {
            projectRoot = fs.mkdtempSync(join(os.tmpdir(), 'cocos-lint-materials-'));
            fs.cpSync(PROJECT, projectRoot, { recursive: true });
            const result = await new ApplyEdits().execute({
                filePath: 'assets/Prefabs/TableCash.prefab',
                ops: [
                    { op: 'instantiate_prefab', parent: 'Table', prefab: 'Models/Coin.fbx', name: 'GoodCoin' },
                    { op: 'instantiate_prefab', parent: 'Table', prefab: 'Models/Coin.fbx', name: 'BadCoin' },
                    {
                        op: 'set_instance_property', node: 'Table/GoodCoin', target: 'CoinLP',
                        component: 'cc.MeshRenderer', property: 'materials[0]',
                        value: { $asset: 'Materials/Dynamite.mtl' }
                    }
                ]
            }, projectRoot);
            assert.ok(!result.isError, result.content[0].text);
        });

        after(() => {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        });

        it('flags the mesh that mixes embedded and project materials', async () => {
            const result = await tool.execute({ checks: ['materials'] }, projectRoot);
            const text = result.content[0].text;
            assert.ok(text.includes('Material consistency (1)'), text);
            assert.ok(text.includes('BadCoin'), text);
            assert.ok(text.includes('Dynamite.mtl'), text);
            assert.ok(text.includes('forgotten material assignment'), text);
        });
    });

    describe('terrain check', () => {
        it('passes on the untouched mock project', async () => {
            const result = await tool.execute({ checks: ['terrain'] }, PROJECT);
            const text = result.content[0].text;
            assert.ok(text.includes('Terrain layers (0)'), text);
            assert.ok(text.includes('OK — every terrain layer resolves and contributes weight'), text);
        });

        it('flags a detail map whose uuid no longer resolves', async () => {
            const id = 'deadbeef-1111-4222-8333-444455556666@6c48a';
            const { text } = await lintMutatedTerrain((data) => {
                data.layers[0].detailMapId = id;
            });
            assert.ok(text.includes('Terrain layers (1)'), text);
            // Whole line: our per-file prefix + terrainBin's registered wording, character for
            // character what query_terrain and get_asset_info print for the same defect
            assert.ok(text.split('\n').includes(`- ${TERRAIN_REL} — ` +
                terrainWarningText('unresolvedTexture', { slot: 0, field: 'detailMap', id })), text);
            assert.ok(text.includes('edit_terrain set_layer'), text);
        });

        it('flags a normal map whose uuid no longer resolves', async () => {
            const id = 'deadbeef-2222-4222-8333-444455556666@6c48a';
            const { text } = await lintMutatedTerrain((data) => {
                data.layers[1].normalMapId = id;
            });
            assert.ok(text.includes('Terrain layers (1)'), text);
            assert.ok(text.split('\n').includes(`- ${TERRAIN_REL} — ` +
                terrainWarningText('unresolvedTexture', { slot: 1, field: 'normalMap', id })), text);
        });

        it('keeps a detail map that resolves to a real mock-project image quiet', async () => {
            // panel.png's texture sub-asset — the id the fixture already uses on slot 1
            const { text } = await lintMutatedTerrain((data) => {
                data.layers[0].detailMapId = '11112222-3333-4444-8555-666677778888@6c48a';
            });
            assert.ok(text.includes('Terrain layers (0)'), text);
        });

        it('flags a layer a block blends but whose weight channel is 0 everywhere', async () => {
            // The fixture block is [0, 1, -1, -1]: channel 1 zeroed makes slot 1 invisible
            const { text, warnings } = await lintMutatedTerrain((data) => clearChannel(data, 1));
            assert.ok(text.includes('Terrain layers (1)'), text);
            assert.ok(text.includes('layer slot 1 (panel.png@6c48a) is assigned to 1 block(s) ' +
                'but its weight channel is 0 in all 1024 texel(s)'), text);
            assert.ok(text.includes('edit_terrain paint_layer'), text);
            // Same rule, independently derived: readTerrainInfo warns about the same slot
            assert.ok(warnings.some(w => /^layer slot 1 .*zero weight coverage/.test(w)),
                warnings.join('\n'));
        });

        it('stays quiet when every block using the layer ignores the weight map', async () => {
            // A block with a single assigned channel draws detailMap0 flat and never
            // samples the weight texture, so channel 0 being 0 is harmless there.
            const { text, warnings } = await lintMutatedTerrain((data) => {
                data.layerBuffer.set([0, -1, -1, -1]);
                clearChannel(data, 0);
            });
            assert.ok(text.includes('Terrain layers (0)'), text);
            assert.ok(!warnings.some(w => /zero weight coverage/.test(w)), warnings.join('\n'));
        });

        it('reports an unreadable terrain instead of aborting the lint', async () => {
            const root = fs.mkdtempSync(join(os.tmpdir(), 'cocos-lint-terrain-bad-'));
            try {
                fs.cpSync(PROJECT, root, { recursive: true });
                // Valid V8 magic, then a height count that overruns the file (the count
                // sits at byte 24: version i32 + tileSize f64 + blockCount i32x2 + two i16)
                const buf = Buffer.alloc(64);
                buf.writeInt32LE(0x01010008, 0);
                buf.writeInt32LE(0x7ffffff0, 24);
                fs.writeFileSync(join(root, TERRAIN_REL), buf);
                const result = await new LintAssets().execute({ checks: ['terrain'] }, root);
                const text = result.content[0].text;
                assert.ok(!result.isError, text);
                assert.ok(text.includes(`${TERRAIN_REL} — cannot read:`), text);
            } finally {
                fs.rmSync(root, { recursive: true, force: true });
            }
        });
    });
});
