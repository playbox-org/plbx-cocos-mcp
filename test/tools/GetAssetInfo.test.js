import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { GetAssetInfo } from '../../src/tools/GetAssetInfo.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT = join(__dirname, '../fixtures/mock-project');

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
