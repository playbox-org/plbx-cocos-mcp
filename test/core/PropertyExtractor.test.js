import { describe, it } from 'node:test';
import assert from 'node:assert';
import { PropertyExtractor } from '../../src/core/PropertyExtractor.js';

// Mock SceneParser
class MockSceneParser {
    #objects = {};

    addObject(id, obj) {
        this.#objects[id] = obj;
    }

    getObject(id) {
        return this.#objects[id] || null;
    }
}

describe('PropertyExtractor', () => {
    describe('extract', () => {
        it('should extract primitive properties', () => {
            const parser = new MockSceneParser();
            const extractor = new PropertyExtractor(parser);

            const component = {
                __type__: 'PlayerController',
                _enabled: true,
                node: { __id__: 1 },
                moveSpeed: 5,
                health: 100,
                isActive: true
            };

            const props = extractor.extract(component);

            assert.strictEqual(props.moveSpeed, 5);
            assert.strictEqual(props.health, 100);
            assert.strictEqual(props.isActive, true);
            assert.ok(!('_enabled' in props));
            assert.ok(!('node' in props));
            assert.ok(!('__type__' in props));
        });

        it('should format node references', () => {
            const parser = new MockSceneParser();
            parser.addObject(5, { _name: 'TargetNode' });

            const extractor = new PropertyExtractor(parser);

            const component = {
                __type__: 'Test',
                target: { __id__: 5 }
            };

            const props = extractor.extract(component);
            assert.strictEqual(props.target, '→TargetNode');
        });

        it('should mark asset references', () => {
            const parser = new MockSceneParser();
            const extractor = new PropertyExtractor(parser);

            const component = {
                __type__: 'Test',
                prefab: { __uuid__: 'abc-123' }
            };

            const props = extractor.extract(component);
            assert.strictEqual(props.prefab, '<asset>');
        });

        it('should truncate long strings', () => {
            const parser = new MockSceneParser();
            const extractor = new PropertyExtractor(parser);

            const component = {
                __type__: 'Test',
                description: 'A'.repeat(100)
            };

            const props = extractor.extract(component);
            assert.ok(props.description.length <= 35);
            assert.ok(props.description.endsWith('...'));
        });

        it('should format array references as count', () => {
            const parser = new MockSceneParser();
            const extractor = new PropertyExtractor(parser);

            const component = {
                __type__: 'Test',
                items: [{ __id__: 1 }, { __id__: 2 }, { __id__: 3 }]
            };

            const props = extractor.extract(component);
            assert.strictEqual(props.items, '[×3]');
        });

        it('should keep small primitive arrays', () => {
            const parser = new MockSceneParser();
            const extractor = new PropertyExtractor(parser);

            const component = {
                __type__: 'Test',
                values: [1, 2, 3]
            };

            const props = extractor.extract(component);
            assert.deepStrictEqual(props.values, [1, 2, 3]);
        });

        it('should return undefined for components with no user properties', () => {
            const parser = new MockSceneParser();
            const extractor = new PropertyExtractor(parser);

            const component = {
                __type__: 'Something',
                _enabled: true,
                node: { __id__: 1 }
            };

            const props = extractor.extract(component);
            assert.strictEqual(props, undefined);
        });

        it('should round numbers to 2 decimals', () => {
            const parser = new MockSceneParser();
            const extractor = new PropertyExtractor(parser);

            const component = {
                __type__: 'Test',
                speed: 5.12345
            };

            const props = extractor.extract(component);
            assert.strictEqual(props.speed, 5.12);
        });
    });
});
