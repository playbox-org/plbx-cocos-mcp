import { describe, it } from 'node:test';
import assert from 'node:assert';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { QueryPrefabGraph } from '../../src/tools/QueryPrefabGraph.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, '../fixtures');

describe('QueryPrefabGraph', () => {
    const tool = new QueryPrefabGraph();

    describe('metadata', () => {
        it('should have correct name', () => {
            assert.strictEqual(tool.name, 'query_prefab_graph');
        });

        it('should have description', () => {
            assert.ok(tool.description.length > 0);
        });

        it('should have valid input schema with prefabPath', () => {
            const schema = tool.inputSchema;

            assert.strictEqual(schema.type, 'object');
            assert.ok('prefabPath' in schema.properties);
            assert.ok('detailed' in schema.properties);
            assert.ok(schema.required.includes('prefabPath'));
        });
    });

    describe('execute', () => {
        it('should return minified prefab graph', async () => {
            const result = await tool.execute(
                { prefabPath: 'real-prefabs/Car.prefab' },
                FIXTURES
            );

            assert.ok(result.content, 'should have content');
            assert.ok(!result.isError, 'should not be error');
            const text = result.content[0].text;
            assert.ok(text.includes('Car'), 'should include prefab name');
        });

        it('should return JSON when format is json', async () => {
            const result = await tool.execute(
                { prefabPath: 'real-prefabs/Car.prefab', format: 'json' },
                FIXTURES
            );

            const text = result.content[0].text;
            const parsed = JSON.parse(text);
            assert.ok(parsed.name, 'should be valid JSON with name');
            assert.strictEqual(parsed.name, 'Car');
        });

        it('should execute with detailed: true', async () => {
            const result = await tool.execute(
                { prefabPath: 'real-prefabs/Customer.prefab', detailed: true },
                FIXTURES
            );

            assert.ok(result.content, 'should have content');
            assert.ok(!result.isError, 'should not be error');
            const text = result.content[0].text;
            assert.ok(text.includes('Customer'), 'should include prefab root name');
        });

        it('should return error for invalid prefab path', async () => {
            const result = await tool.execute(
                { prefabPath: 'nonexistent.prefab' },
                FIXTURES
            );

            assert.ok(result.isError, 'should be error result');
        });

        it('should refuse model sources with a get_asset_info hint', async () => {
            const result = await tool.execute(
                { prefabPath: 'assets/Models/Rock.glb' },
                join(FIXTURES, 'mock-project')
            );

            assert.ok(result.isError);
            const text = result.content[0].text;
            assert.ok(text.includes('model source'));
            assert.ok(text.includes('get_asset_info'));
        });

        it('should refuse other non-scene/prefab files', async () => {
            const result = await tool.execute(
                { prefabPath: 'assets/Materials/Dynamite.mtl' },
                join(FIXTURES, 'mock-project')
            );

            assert.ok(result.isError);
            assert.ok(result.content[0].text.includes('.scene/.prefab'));
        });

        it('should work with all test prefabs', async () => {
            const prefabs = [
                'real-prefabs/Car.prefab',
                'real-prefabs/Customer.prefab',
                'real-prefabs/BankScreen.prefab',
                'real-prefabs/PlayerInfo.prefab',
                'real-prefabs/Toilets.prefab'
            ];

            for (const prefabPath of prefabs) {
                const result = await tool.execute({ prefabPath }, FIXTURES);
                assert.ok(!result.isError, `${prefabPath} should not error`);
                assert.ok(result.content[0].text.length > 0, `${prefabPath} should produce output`);
            }
        });
    });
});
