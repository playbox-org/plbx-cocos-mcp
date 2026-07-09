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

        it('should require scenePath; pattern/component are optional filters', () => {
            const schema = tool.inputSchema;

            assert.ok(schema.required.includes('scenePath'));
            assert.ok(!schema.required.includes('pattern'));
            assert.ok(schema.properties.component);
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

        it('should show the root-anchored path and #N id for each match', async () => {
            const result = await tool.execute(
                { scenePath: 'sample-scene.json', pattern: '^Player$' },
                FIXTURES
            );

            const text = result.content[0].text;
            assert.match(text, /● Level\/Player #\d+ \[/,
                'match line is "path #id [components]"');
            assert.ok(text.includes('root-anchored `node` addresses'),
                'output explains how to reuse the printed values');
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

        it('should reject a call with neither pattern nor component', async () => {
            const result = await tool.execute(
                { scenePath: 'sample-scene.json' },
                FIXTURES
            );

            assert.ok(result.isError);
            assert.match(result.content[0].text, /pattern.*component/s);
        });
    });

    describe('component filter (golden scene + mock project)', () => {
        const GOLDEN_SCENE = join(FIXTURES, 'golden', 'Main.scene_V2.scene');
        const MOCK_PROJECT = join(FIXTURES, 'mock-project');

        it('finds nodes by cc.* component type', async () => {
            const result = await tool.execute(
                { scenePath: GOLDEN_SCENE, component: 'cc.Camera' },
                MOCK_PROJECT
            );

            const text = result.content[0].text;
            assert.match(text, /component = cc\.Camera/);
            assert.match(text, /Found: [1-9]/);
            assert.ok(text.includes('cc.Camera'));
        });

        it('matches components MOUNTED on prefab instances by script name', async () => {
            const result = await tool.execute(
                { scenePath: GOLDEN_SCENE, component: 'PlayerController' },
                MOCK_PROJECT
            );

            const text = result.content[0].text;
            // ButtonPurchaseZone carries PlayerController only as a mounted component
            assert.match(text, /\[WORLD\]\/Zones\/ButtonPurchaseZone #\d+ \[.*PlayerController \(mounted\)/);
        });

        it('combines with pattern (both filters must hold)', async () => {
            const result = await tool.execute(
                { scenePath: GOLDEN_SCENE, pattern: 'NoSuchName123', component: 'cc.Camera' },
                MOCK_PROJECT
            );

            assert.ok(result.content[0].text.includes('Found: 0'));
        });

        it('tolerates the omitted cc. prefix', async () => {
            const withPrefix = await tool.execute(
                { scenePath: GOLDEN_SCENE, component: 'cc.Camera' }, MOCK_PROJECT);
            const withoutPrefix = await tool.execute(
                { scenePath: GOLDEN_SCENE, component: 'Camera' }, MOCK_PROJECT);

            const count = (r) => r.content[0].text.match(/Found: (\d+)/)[1];
            assert.strictEqual(count(withoutPrefix), count(withPrefix));
        });
    });
});
