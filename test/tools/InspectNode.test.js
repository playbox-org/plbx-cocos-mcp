import { describe, it } from 'node:test';
import assert from 'node:assert';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { InspectNode } from '../../src/tools/InspectNode.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, '../fixtures');

describe('InspectNode', () => {
    const tool = new InspectNode();

    describe('metadata', () => {
        it('should have correct name', () => {
            assert.strictEqual(tool.name, 'inspect_node');
        });

        it('should have valid input schema', () => {
            const schema = tool.inputSchema;

            assert.ok('filePath' in schema.properties);
            assert.ok('nodeId' in schema.properties);
            assert.ok('nodeName' in schema.properties);
            assert.ok(schema.required.includes('filePath'));
        });
    });

    describe('execute with nodeId', () => {
        it('should return subtree for valid nodeId (scene)', async () => {
            // Node id 4 = Player in sample-scene.json
            const result = await tool.execute(
                { filePath: 'sample-scene.json', nodeId: 4 },
                FIXTURES
            );

            assert.ok(!result.isError, 'should not be error');
            const text = result.content[0].text;
            assert.ok(text.includes('Player'), 'should include node name');
        });

        it('should return subtree for valid nodeId (prefab)', async () => {
            // Node id 1 = root node in Car.prefab
            const result = await tool.execute(
                { filePath: 'real-prefabs/Car.prefab', nodeId: 1 },
                FIXTURES
            );

            assert.ok(!result.isError, 'should not be error');
            const text = result.content[0].text;
            assert.ok(text.includes('Car'), 'should include prefab root name');
        });

        it('should return JSON format', async () => {
            const result = await tool.execute(
                { filePath: 'sample-scene.json', nodeId: 4, format: 'json' },
                FIXTURES
            );

            const text = result.content[0].text;
            const parsed = JSON.parse(text);
            assert.strictEqual(parsed.name, 'Player');
        });

        it('should return error for invalid nodeId', async () => {
            const result = await tool.execute(
                { filePath: 'sample-scene.json', nodeId: 9999 },
                FIXTURES
            );

            assert.ok(result.isError, 'should be error');
        });
    });

    describe('execute with nodeName', () => {
        it('should return subtree for unique name', async () => {
            const result = await tool.execute(
                { filePath: 'sample-scene.json', nodeName: 'Player' },
                FIXTURES
            );

            assert.ok(!result.isError, 'should not be error');
            const text = result.content[0].text;
            assert.ok(text.includes('Player'), 'should include node name');
        });

        it('should return disambiguation list for duplicate names', async () => {
            // roadside-c4 has 9 nodes named "root"
            const result = await tool.execute(
                { filePath: 'real-scenes/roadside-c4-main.scene', nodeName: 'root' },
                FIXTURES
            );

            assert.ok(!result.isError, 'should not be error');
            const text = result.content[0].text;
            assert.ok(text.includes('Multiple nodes'), 'should indicate multiple matches');
            assert.ok(text.includes('nodeId'), 'should suggest using nodeId');
        });

        it('should return error for non-existent name', async () => {
            const result = await tool.execute(
                { filePath: 'sample-scene.json', nodeName: 'NonExistentNode' },
                FIXTURES
            );

            assert.ok(result.isError, 'should be error');
        });
    });

    describe('validation', () => {
        it('should error when neither nodeId nor nodeName provided', async () => {
            const result = await tool.execute(
                { filePath: 'sample-scene.json' },
                FIXTURES
            );

            assert.ok(result.isError, 'should be error');
        });

        it('should error for invalid file path', async () => {
            const result = await tool.execute(
                { filePath: 'nonexistent.scene', nodeId: 1 },
                FIXTURES
            );

            assert.ok(result.isError, 'should be error');
        });
    });
});
