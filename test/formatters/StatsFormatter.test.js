import { describe, it } from 'node:test';
import assert from 'node:assert';
import { StatsFormatter } from '../../src/formatters/StatsFormatter.js';

describe('StatsFormatter', () => {
    const formatter = new StatsFormatter();

    describe('format', () => {
        it('should format statistics correctly', () => {
            const stats = {
                nodeCount: 50,
                scripts: new Set(['PlayerController', 'EnemyAI']),
                builtins: new Map([
                    ['cc.RigidBody', 10],
                    ['cc.MeshRenderer', 25]
                ])
            };

            const result = formatter.format(stats);

            assert.ok(result.includes('Nodes: 50'));
            assert.ok(result.includes('Scripts: 2'));
            assert.ok(result.includes('PlayerController'));
            assert.ok(result.includes('EnemyAI'));
        });

        it('should show builtin components sorted by count', () => {
            const stats = {
                nodeCount: 10,
                scripts: new Set(),
                builtins: new Map([
                    ['cc.Camera', 1],
                    ['cc.MeshRenderer', 50],
                    ['cc.RigidBody', 25]
                ])
            };

            const result = formatter.format(stats);

            // MeshRenderer should appear before RigidBody (50 > 25)
            const meshIdx = result.indexOf('MeshRenderer');
            const rigidIdx = result.indexOf('RigidBody');
            const camIdx = result.indexOf('Camera');

            assert.ok(meshIdx < rigidIdx, 'MeshRenderer should come before RigidBody');
            assert.ok(rigidIdx < camIdx, 'RigidBody should come before Camera');
        });

        it('should include header', () => {
            const stats = {
                nodeCount: 10,
                scripts: new Set(),
                builtins: new Map()
            };

            const result = formatter.format(stats);
            assert.ok(result.includes('Stats'));
        });
    });
});
