import { describe, it } from 'node:test';
import assert from 'node:assert';
import { TypeFilter } from '../../src/filters/TypeFilter.js';

describe('TypeFilter', () => {
    describe('isNoise', () => {
        it('should filter default noise types', () => {
            const filter = new TypeFilter();

            // Common noise types
            assert.strictEqual(filter.isNoise('cc.Vec3'), true);
            assert.strictEqual(filter.isNoise('cc.Vec2'), true);
            assert.strictEqual(filter.isNoise('cc.Quat'), true);
            assert.strictEqual(filter.isNoise('cc.Color'), true);
            assert.strictEqual(filter.isNoise('cc.Size'), true);
            assert.strictEqual(filter.isNoise('cc.CurveRange'), true);
            assert.strictEqual(filter.isNoise('cc.GradientRange'), true);
        });

        it('should not filter valid component types', () => {
            const filter = new TypeFilter();

            assert.strictEqual(filter.isNoise('cc.RigidBody'), false);
            assert.strictEqual(filter.isNoise('cc.Camera'), false);
            assert.strictEqual(filter.isNoise('cc.MeshRenderer'), false);
            assert.strictEqual(filter.isNoise('PlayerController'), false);
        });

        it('should filter custom noise types after adding', () => {
            const filter = new TypeFilter();
            filter.addNoiseTypes(['cc.CustomNoise', 'cc.AnotherNoise']);

            assert.strictEqual(filter.isNoise('cc.CustomNoise'), true);
            assert.strictEqual(filter.isNoise('cc.AnotherNoise'), true);
            // Original noise still works
            assert.strictEqual(filter.isNoise('cc.Vec3'), true);
        });
    });

    describe('isImportant', () => {
        it('should identify important built-in components', () => {
            const filter = new TypeFilter();

            assert.strictEqual(filter.isImportant('cc.Camera'), true);
            assert.strictEqual(filter.isImportant('cc.RigidBody'), true);
            assert.strictEqual(filter.isImportant('cc.MeshRenderer'), true);
            assert.strictEqual(filter.isImportant('cc.Sprite'), true);
            assert.strictEqual(filter.isImportant('cc.Button'), true);
        });

        it('should not mark custom scripts as important', () => {
            const filter = new TypeFilter();

            assert.strictEqual(filter.isImportant('PlayerController'), false);
            assert.strictEqual(filter.isImportant('63d48abc'), false);
        });
    });

    describe('isCustomScript', () => {
        it('should identify UUID-style custom scripts', () => {
            const filter = new TypeFilter();

            // Valid compressed UUIDs (15+ alphanumeric chars)
            assert.strictEqual(filter.isCustomScript('63d48abcdef123456'), true);
            assert.strictEqual(filter.isCustomScript('a1b2c345678901234'), true);
        });

        it('should not mark cc.* types as custom', () => {
            const filter = new TypeFilter();

            assert.strictEqual(filter.isCustomScript('cc.RigidBody'), false);
            assert.strictEqual(filter.isCustomScript('cc.Camera'), false);
        });

        it('should not mark short types as custom', () => {
            const filter = new TypeFilter();

            assert.strictEqual(filter.isCustomScript('Short'), false);
            assert.strictEqual(filter.isCustomScript('abc123'), false);
        });
    });

    describe('static properties', () => {
        it('should expose noise types list', () => {
            const noiseTypes = TypeFilter.noiseTypes;

            assert.ok(Array.isArray(noiseTypes));
            assert.ok(noiseTypes.includes('cc.Vec3'));
            assert.ok(noiseTypes.includes('cc.Color'));
        });

        it('should expose important types list', () => {
            const importantTypes = TypeFilter.importantTypes;

            assert.ok(Array.isArray(importantTypes));
            assert.ok(importantTypes.includes('cc.Camera'));
            assert.ok(importantTypes.includes('cc.RigidBody'));
        });
    });
});
