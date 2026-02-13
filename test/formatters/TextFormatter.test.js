import { describe, it } from 'node:test';
import assert from 'node:assert';
import { TextFormatter } from '../../src/formatters/TextFormatter.js';

describe('TextFormatter', () => {
    const formatter = new TextFormatter();

    describe('format', () => {
        it('should format simple graph with correct symbols', () => {
            const graph = {
                name: 'TestScene',
                active: true,
                children: [
                    {
                        name: 'Player',
                        active: true,
                        pos: [10, 0, -5],
                        components: [
                            { type: 'RigidBody', enabled: true }
                        ],
                        children: []
                    }
                ]
            };

            const result = formatter.format(graph);

            assert.ok(result.includes('● TestScene'), 'should show active node');
            assert.ok(result.includes('● Player'), 'should show child node');
            assert.ok(result.includes('@(10,0,-5)'), 'should show position');
            assert.ok(result.includes('◆ RigidBody'), 'should show enabled component');
        });

        it('should use hollow symbols for inactive/disabled', () => {
            const graph = {
                name: 'Scene',
                active: true,
                children: [
                    {
                        name: 'InactiveNode',
                        active: false,
                        components: [
                            { type: 'Collider', enabled: false }
                        ],
                        children: []
                    }
                ]
            };

            const result = formatter.format(graph);

            assert.ok(result.includes('○ InactiveNode'), 'should show inactive node');
            assert.ok(result.includes('◇ Collider'), 'should show disabled component');
        });

        it('should show component properties', () => {
            const graph = {
                name: 'Scene',
                active: true,
                children: [
                    {
                        name: 'Player',
                        active: true,
                        components: [
                            { type: 'Controller', enabled: true, props: { speed: 5, health: 100 } }
                        ],
                        children: []
                    }
                ]
            };

            const result = formatter.format(graph);
            assert.ok(result.includes('speed=5'));
            assert.ok(result.includes('health=100'));
        });

        it('should handle nested children with indentation', () => {
            const graph = {
                name: 'Root',
                active: true,
                children: [
                    {
                        name: 'Level1',
                        active: true,
                        children: [
                            {
                                name: 'Level2',
                                active: true,
                                children: [
                                    { name: 'Level3', active: true, children: [] }
                                ]
                            }
                        ]
                    }
                ]
            };

            const result = formatter.format(graph);
            const lines = result.split('\n');

            // Check indentation increases
            const level1Line = lines.find(l => l.includes('Level1'));
            const level2Line = lines.find(l => l.includes('Level2'));
            const level3Line = lines.find(l => l.includes('Level3'));

            assert.ok(level2Line.indexOf('●') > level1Line.indexOf('●'));
            assert.ok(level3Line.indexOf('●') > level2Line.indexOf('●'));
        });

        it('should show trimmed node indicator', () => {
            const graph = {
                name: 'Scene',
                active: true,
                children: [
                    {
                        name: 'Armature',
                        active: true,
                        trimmed: { nodes: 33, depth: 12 },
                        children: []
                    }
                ]
            };

            const result = formatter.format(graph);
            assert.ok(result.includes('[+33 hidden nodes, depth 12]'), 'should show trimmed indicator');
        });

        it('should not show trimmed indicator when no nodes are trimmed', () => {
            const graph = {
                name: 'Scene',
                active: true,
                children: [
                    { name: 'Child', active: true, children: [] }
                ]
            };

            const result = formatter.format(graph);
            assert.ok(!result.includes('hidden'), 'should not have trimmed indicator');
        });

        it('should mark prefab root nodes', () => {
            const graph = {
                name: 'Scene',
                active: true,
                children: [
                    {
                        name: 'PrefabInstance',
                        active: true,
                        prefab: true,
                        children: []
                    }
                ]
            };

            const result = formatter.format(graph);
            assert.ok(result.includes('[P]'), 'should mark prefab with [P]');
        });
    });

    describe('configure', () => {
        it('should allow custom indent', () => {
            const customFormatter = new TextFormatter();
            customFormatter.configure({ indent: '    ' });

            const graph = {
                name: 'Root',
                active: true,
                children: [
                    { name: 'Child', active: true, children: [] }
                ]
            };

            const result = customFormatter.format(graph);
            assert.ok(result.includes('    ● Child'));
        });
    });
});
