import { describe, it } from 'node:test';
import assert from 'node:assert';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { FindSceneNodes } from '../../src/tools/FindSceneNodes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, '../fixtures');

describe('FindSceneNodes', () => {
    const tool = new FindSceneNodes();

    describe('metadata', () => {
        it('should have correct name', () => {
            assert.strictEqual(tool.name, 'find_scene_nodes');
        });

        it('should require scenePath and pattern', () => {
            const schema = tool.inputSchema;

            assert.ok(schema.required.includes('scenePath'));
            assert.ok(schema.required.includes('pattern'));
        });
    });

    describe('execute', () => {
        it('should find nodes matching pattern', async () => {
            const result = await tool.execute(
                { scenePath: 'sample-scene.json', pattern: 'Player' },
                FIXTURES
            );

            assert.ok(result.content, 'should have content');
            const text = result.content[0].text;
            assert.ok(text.includes('Player'));
        });

        it('should find nodes with regex pattern', async () => {
            const result = await tool.execute(
                { scenePath: 'sample-scene.json', pattern: 'Enemy.*' },
                FIXTURES
            );

            const text = result.content[0].text;
            assert.ok(text.includes('Enemy'));
        });

        it('should show found count', async () => {
            const result = await tool.execute(
                { scenePath: 'sample-scene.json', pattern: 'NonExistent12345' },
                FIXTURES
            );

            const text = result.content[0].text;
            assert.ok(text.includes('Found: 0'));
        });

        it('should return error for invalid scene', async () => {
            const result = await tool.execute(
                { scenePath: 'nonexistent.scene', pattern: 'test' },
                FIXTURES
            );

            assert.ok(result.isError, 'should be error result');
        });
    });
});
