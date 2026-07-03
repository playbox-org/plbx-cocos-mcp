import { describe, it } from 'node:test';
import assert from 'node:assert';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { GetProjectInfo } from '../../src/tools/GetProjectInfo.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT = join(__dirname, '../fixtures/mock-project');

describe('GetProjectInfo tool', () => {
    const tool = new GetProjectInfo();

    it('should have correct metadata', () => {
        assert.strictEqual(tool.name, 'get_project_info');
        assert.ok(tool.description.length > 0);
        assert.strictEqual(tool.inputSchema.type, 'object');
    });

    it('should render text output with all sections', async () => {
        const result = await tool.execute({}, PROJECT);
        assert.ok(!result.isError);
        const text = result.content[0].text;
        assert.ok(text.includes('Cocos Creator 3.8.7'));
        assert.ok(text.includes('720x1280'));
        assert.ok(text.includes('GROUND'));
        assert.ok(text.includes('physics-ammo'));
        assert.ok(text.includes('1:PLAYER'));
    });

    it('should render valid JSON when requested', async () => {
        const result = await tool.execute({ format: 'json' }, PROJECT);
        const parsed = JSON.parse(result.content[0].text);
        assert.strictEqual(parsed.engineVersion, '3.8.7');
        assert.strictEqual(parsed.layers.custom.length, 2);
    });

    it('should error for a non-project directory', async () => {
        const result = await tool.execute({}, '/nonexistent/path');
        assert.strictEqual(result.isError, true);
    });
});
