import { describe, it } from 'node:test';
import assert from 'node:assert';
import { JsonFormatter } from '../../src/formatters/JsonFormatter.js';

describe('JsonFormatter', () => {
    const formatter = new JsonFormatter();

    describe('format', () => {
        it('should return valid JSON string', () => {
            const graph = {
                name: 'Scene',
                active: true,
                children: [
                    { name: 'Node1', active: true, children: [] }
                ]
            };

            const result = formatter.format(graph);
            const parsed = JSON.parse(result);

            assert.strictEqual(parsed.name, 'Scene');
            assert.strictEqual(parsed.children.length, 1);
        });

        it('should use 2-space indentation', () => {
            const graph = { name: 'Test', children: [] };
            const result = formatter.format(graph);

            assert.ok(result.includes('\n  '), 'should have 2-space indent');
        });

        it('should preserve all properties', () => {
            const graph = {
                name: 'Node',
                active: false,
                pos: [1, 2, 3],
                prefab: true,
                components: [
                    { type: 'Script', enabled: true, props: { a: 1 } }
                ],
                children: []
            };

            const result = formatter.format(graph);
            const parsed = JSON.parse(result);

            assert.strictEqual(parsed.active, false);
            assert.deepStrictEqual(parsed.pos, [1, 2, 3]);
            assert.strictEqual(parsed.prefab, true);
            assert.strictEqual(parsed.components[0].type, 'Script');
        });
    });
});
