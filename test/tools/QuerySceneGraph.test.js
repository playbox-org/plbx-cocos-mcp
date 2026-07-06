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

        it('should accept filePath as an alias for scenePath via run()', async () => {
            const result = await tool.run(
                { filePath: 'sample-scene.json' },
                FIXTURES
            );

            assert.ok(!result.isError, 'should not be error');
            assert.ok(result.content[0].text.includes('TestScene'));
        });

        it('should execute with detailed: true without error', async () => {
            const result = await tool.execute(
                { scenePath: 'sample-scene.json', detailed: true },
                FIXTURES
            );

            assert.ok(result.content, 'should have content');
            assert.ok(!result.isError, 'should not be error');
            const text = result.content[0].text;
            assert.ok(text.includes('TestScene'), 'should include scene name');
        });

        it('should include built-in component props when detailed', async () => {
            const result = await tool.execute(
                { scenePath: 'sample-scene.json', format: 'json', detailed: true },
                FIXTURES
            );

            const text = result.content[0].text;
            const parsed = JSON.parse(text);

            // Find Player node which has cc.BoxCollider (enabled: false)
            // ScriptResolver strips 'cc.' prefix, so type appears as 'BoxCollider'
            const player = parsed.children?.[0]?.children?.find(c => c.name === 'Player');
            assert.ok(player, 'should find Player node');

            const boxCollider = player.components?.find(c => c.type === 'BoxCollider');
            assert.ok(boxCollider, 'should have BoxCollider component');
            assert.strictEqual(boxCollider.enabled, false);
        });

        it('should have detailed in inputSchema', () => {
            const schema = tool.inputSchema;
            assert.ok('detailed' in schema.properties, 'should have detailed property');
            assert.strictEqual(schema.properties.detailed.type, 'boolean');
        });

        it('should include trimmed indicators for filtered nodes', async () => {
            const result = await tool.execute(
                { scenePath: 'real-scenes/roadside-c4-main.scene', format: 'json' },
                FIXTURES
            );

            const parsed = JSON.parse(result.content[0].text);

            // Find any node with trimmed field recursively
            function findTrimmed(node) {
                if (node.trimmed) return node;
                if (node.children) {
                    for (const child of node.children) {
                        const found = findTrimmed(child);
                        if (found) return found;
                    }
                }
                return null;
            }

            const trimmed = findTrimmed(parsed);
            assert.ok(trimmed, 'should have at least one node with trimmed field');
            assert.ok(trimmed.trimmed.nodes > 0, 'trimmed.nodes should be > 0');
            assert.ok(trimmed.trimmed.depth > 0, 'trimmed.depth should be > 0');
        });

        it('should show trimmed indicators in text format', async () => {
            const result = await tool.execute(
                { scenePath: 'real-scenes/roadside-c4-main.scene' },
                FIXTURES
            );

            const text = result.content[0].text;
            assert.ok(text.includes('hidden nodes, depth'), 'should include trimmed text indicator');
        });
    });
});
