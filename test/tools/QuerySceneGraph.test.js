import { describe, it } from 'node:test';
import assert from 'node:assert';
import { fileURLToPath } from 'url';
import { dirname, join, relative } from 'path';
import { QuerySceneGraph } from '../../src/tools/QuerySceneGraph.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, '../fixtures');

describe('QuerySceneGraph', () => {
    const tool = new QuerySceneGraph();

    describe('metadata', () => {
        it('should have correct name', () => {
            assert.strictEqual(tool.name, 'query_scene_graph');
        });

        it('should have description', () => {
            assert.ok(tool.description.length > 0);
        });

        it('should have valid input schema', () => {
            const schema = tool.inputSchema;

            assert.strictEqual(schema.type, 'object');
            assert.ok('scenePath' in schema.properties);
            assert.ok(schema.required.includes('scenePath'));
        });
    });

    describe('execute', () => {
        it('should return minified scene graph', async () => {
            const result = await tool.execute(
                { scenePath: 'sample-scene.json' },
                FIXTURES
            );

            assert.ok(result.content, 'should have content');
            const text = result.content[0].text;
            assert.ok(text.includes('TestScene'), 'should include scene name');
        });

        it('should return JSON when format is json', async () => {
            const result = await tool.execute(
                { scenePath: 'sample-scene.json', format: 'json' },
                FIXTURES
            );

            const text = result.content[0].text;
            const parsed = JSON.parse(text);
            assert.ok(parsed.name, 'should be valid JSON with name');
        });

        it('should return error for invalid scene path', async () => {
            const result = await tool.execute(
                { scenePath: 'nonexistent.scene' },
                FIXTURES
            );

            assert.ok(result.isError, 'should be error result');
        });
    });
});
