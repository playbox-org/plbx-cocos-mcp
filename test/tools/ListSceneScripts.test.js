import { describe, it } from 'node:test';
import assert from 'node:assert';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { ListSceneScripts } from '../../src/tools/ListSceneScripts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, '../fixtures');

describe('ListSceneScripts', () => {
    const tool = new ListSceneScripts();

    describe('metadata', () => {
        it('should have correct name', () => {
            assert.strictEqual(tool.name, 'list_scene_scripts');
        });

        it('should have valid input schema', () => {
            const schema = tool.inputSchema;
            assert.strictEqual(schema.type, 'object');
            assert.ok(schema.required.includes('scenePath'));
        });
    });

    describe('execute', () => {
        it('should list scripts from scene', async () => {
            const result = await tool.execute(
                { scenePath: 'sample-scene.json' },
                FIXTURES
            );

            assert.ok(result.content, 'should have content');
            const text = result.content[0].text;

            // The scene has script UUIDs that should be detected
            assert.ok(text.includes('Scripts'), 'should include Scripts header');
        });

        it('should return error for invalid scene', async () => {
            const result = await tool.execute(
                { scenePath: 'nonexistent.scene' },
                FIXTURES
            );

            assert.ok(result.isError, 'should be error result');
        });
    });
});
