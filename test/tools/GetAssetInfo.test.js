import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { GetAssetInfo } from '../../src/tools/GetAssetInfo.js';
import { defaultSentinel } from '../../src/utils/terrainBin.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT = join(__dirname, '../fixtures/mock-project');

/**
 * Disposable project holding a single `assets/Maps/Terrain.terrain` with the
 * mock project's meta (so path/uuid resolution works) and the given payload.
 * Deliberately NOT a copy of the shared mock project: other suites create and
 * delete files under it, which makes a recursive copy racy.
 */
function terrainOnlyProject(prefix, payload) {
    const root = fs.mkdtempSync(join(os.tmpdir(), prefix));
    fs.mkdirSync(join(root, 'assets', 'Maps'), { recursive: true });
    fs.copyFileSync(
        join(PROJECT, 'assets/Maps/Terrain.terrain.meta'),
        join(root, 'assets/Maps/Terrain.terrain.meta')
    );
    fs.writeFileSync(join(root, 'assets/Maps/Terrain.terrain'), payload);
    return root;
}

describe('GetAssetInfo tool', () => {
    const tool = new GetAssetInfo();

    it('should have correct metadata', () => {
        assert.strictEqual(tool.name, 'get_asset_info');
        assert.deepStrictEqual(tool.inputSchema.required, ['asset']);
    });

    it('should render sprite info as text', async () => {
        const result = await tool.execute({ asset: 'assets/Sprites/panel.png' }, PROJECT);
        assert.ok(!result.isError);
        const text = result.content[0].text;
        assert.ok(text.includes('SpriteFrame'));
        assert.ok(text.includes('128x128'));
        assert.ok(text.includes('SLICED'));
    });

    it('should render model info with mesh AABB', async () => {
        const result = await tool.execute({ asset: 'assets/Models/Rock.glb' }, PROJECT);
        const text = result.content[0].text;
        assert.ok(text.includes('Meshes (1)'));
        assert.ok(text.includes('1 x 2 x 1'));
        assert.ok(text.includes('[glb]'));
    });

    it('should render prefab summary', async () => {
        const result = await tool.execute({ asset: 'assets/Prefabs/Gold.prefab' }, PROJECT);
        const text = result.content[0].text;
        assert.ok(text.includes('Root: Gold'));
        assert.ok(text.includes('Nodes: 2'));
    });

    it('should accept UUID input and json format', async () => {
        const result = await tool.execute(
            { asset: '836478c3-ffde-4110-8347-cfda26288652', format: 'json' },
            PROJECT
        );
        const parsed = JSON.parse(result.content[0].text);
        assert.strictEqual(parsed.rootName, 'Gold');
    });

    it('should error for unknown assets', async () => {
        const result = await tool.execute({ asset: 'assets/Nope.png' }, PROJECT);
        assert.strictEqual(result.isError, true);
        assert.ok(result.content[0].text.includes('list_assets'));
    });

    it('should render the terrain card with resolved layer textures', async () => {
        const result = await tool.execute({ asset: 'assets/Maps/Terrain.terrain' }, PROJECT);
        assert.ok(!result.isError);
        const text = result.content[0].text;
        assert.ok(text.includes('## Terrain'));
        assert.ok(text.includes('Size: 32 x 32 m'));
        // a block is 32x32 tiles, not 32; weightMapSize is a per-SIDE texel count and is
        // spelled the same way query_terrain spells it; the mean carries its unit
        assert.ok(text.includes('Blocks: 1 x 1 of 32x32 tiles, tileSize 1 m'), text);
        assert.ok(text.includes('Vertex grid: 33 x 33'));
        assert.ok(text.includes('Weight map: 32 x 32 per block (32 x 32 texels total)'), text);
        assert.ok(text.includes('Height range: 0 .. 3 m (mean 0.9394 m)'), text);
        assert.ok(text.includes('## Terrain layers (2)'));
        assert.ok(text.includes('slot 0: coin_bar.png@6c48a'), text);
        assert.ok(/coverage 80\.8%/.test(text), text);
    });

    it('should render the terrain error line the generic formatter never prints', async () => {
        const tmp = terrainOnlyProject('cocos-asset-info-terrain-', 'garbage, not a terrain');
        try {
            const result = await tool.execute({ asset: 'assets/Maps/Terrain.terrain' }, tmp);
            assert.ok(!result.isError, 'an unreadable payload is still a valid asset card');
            const text = result.content[0].text;
            assert.ok(text.includes('## Terrain'));
            assert.match(text, /Error: Not a Cocos \.terrain binary/);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    it('should note an empty default (sentinel) terrain', async () => {
        const tmp = terrainOnlyProject('cocos-asset-info-sentinel-', defaultSentinel());
        try {
            const text = (await tool.execute({ asset: 'assets/Maps/Terrain.terrain' }, tmp))
                .content[0].text;
            assert.ok(text.includes('Note: empty default terrain'), text);
            assert.ok(text.includes('Height range: no height data'), text);
            assert.ok(text.includes('## Terrain layers (0)'), text);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    it('should keep the terrain block machine-readable in json format', async () => {
        const result = await tool.execute(
            { asset: 'assets/Maps/Terrain.terrain', format: 'json' }, PROJECT);
        const parsed = JSON.parse(result.content[0].text);
        assert.strictEqual(parsed.importer, 'terrain');
        assert.deepStrictEqual(parsed.terrain.blockCount, [1, 1]);
        assert.strictEqual(parsed.terrain.layers[1].detailMapName, 'panel.png@6c48a');
    });

    it('should flag files on disk the editor has not imported', async () => {
        const tmp = fs.mkdtempSync(join(os.tmpdir(), 'cocos-asset-info-'));
        try {
            fs.cpSync(PROJECT, tmp, { recursive: true });
            fs.writeFileSync(join(tmp, 'assets/Scripts/NotImported.ts'), 'export {}\n');

            const result = await tool.execute({ asset: 'assets/Scripts/NotImported.ts' }, tmp);
            assert.strictEqual(result.isError, true);
            const text = result.content[0].text;
            assert.ok(text.includes('no .meta'));
            assert.ok(text.includes('create_asset_meta'));
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });
});
