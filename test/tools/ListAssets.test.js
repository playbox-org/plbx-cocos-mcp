import { describe, it } from 'node:test';
import assert from 'node:assert';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { ListAssets } from '../../src/tools/ListAssets.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT = join(__dirname, '../fixtures/mock-project');

describe('ListAssets tool', () => {
    const tool = new ListAssets();

    it('should have correct metadata', () => {
        assert.strictEqual(tool.name, 'list_assets');
        assert.ok(tool.description.includes('sprite'));
    });

    it('should list all assets without filters', async () => {
        const result = await tool.execute({}, PROJECT);
        assert.ok(!result.isError);
        const text = result.content[0].text;
        assert.ok(text.includes('Gold.prefab'));
        assert.ok(text.includes('Coin.fbx'));
        assert.ok(text.includes('836478c3-ffde-4110-8347-cfda26288652'));
    });

    it('should filter by type and folder', async () => {
        const result = await tool.execute({ type: 'model', folder: 'Models' }, PROJECT);
        const text = result.content[0].text;
        assert.ok(text.includes('# Assets (3)'));
        assert.ok(text.includes('Rock.glb'));
        assert.ok(!text.includes('Gold.prefab'));
    });

    it('should report empty result gracefully', async () => {
        const result = await tool.execute({ pattern: 'zzz*' }, PROJECT);
        assert.ok(!result.isError);
        assert.ok(result.content[0].text.includes('No assets match'));
    });

    it('should explain which filter emptied the result', async () => {
        const result = await tool.execute({ type: 'prefab', pattern: 'zzz*' }, PROJECT);
        assert.ok(!result.isError);
        const text = result.content[0].text;
        assert.ok(text.includes('no filters:'));
        assert.match(text, /\+ type="prefab": [1-9]/);
        assert.ok(text.includes('+ pattern="zzz*": 0'));
        assert.ok(text.includes('file name'));
    });

    it('should find assets by bare substring pattern', async () => {
        const result = await tool.execute({ pattern: 'old' }, PROJECT);
        assert.ok(!result.isError);
        assert.ok(result.content[0].text.includes('Gold.prefab'));
    });

    it('should reject unknown asset types listing the valid ones', async () => {
        const result = await tool.execute({ type: 'bogusType' }, PROJECT);
        assert.strictEqual(result.isError, true);
        const text = result.content[0].text;
        assert.ok(text.includes('Known types:'));
        assert.ok(text.includes('sprite'));
        assert.ok(text.includes('Importers in this project:'));
    });

    it('should accept spriteFrame as a type alias', async () => {
        const result = await tool.execute({ type: 'spriteFrame' }, PROJECT);
        assert.ok(!result.isError);
        assert.ok(result.content[0].text.includes('panel.png'));
    });

    it('should render json format', async () => {
        const result = await tool.execute({ type: 'sprite', format: 'json' }, PROJECT);
        const parsed = JSON.parse(result.content[0].text);
        assert.ok(parsed.total >= 1);
        assert.ok(parsed.items.every(i => i.uuid && i.path));
    });

    it('should accept query as an alias for pattern via run()', async () => {
        const aliased = await tool.run({ query: 'Coin*' }, PROJECT);
        const canonical = await tool.execute({ pattern: 'Coin*' }, PROJECT);
        assert.ok(!aliased.isError);
        assert.strictEqual(aliased.content[0].text, canonical.content[0].text);
    });
});
