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

        it('should skip _string key', () => {
            const parser = new MockSceneParser();
            const extractor = new PropertyExtractor(parser);

            const component = {
                __type__: 'cc.Label',
                _string: 'Hello World'
            };

            const props = extractor.extract(component);
            assert.strictEqual(props, undefined);
        });
    });

    describe('detailed mode', () => {
        it('should expand array references with #id suffix', () => {
            const parser = new MockSceneParser();
            parser.addObject(1, { _name: 'Node1' });
            parser.addObject(2, { _name: 'Node2' });

            const extractor = new PropertyExtractor(parser, { detailed: true });

            const component = {
                __type__: 'Test',
                items: [{ __id__: 1 }, { __id__: 2 }]
            };

            const props = extractor.extract(component);
            assert.deepStrictEqual(props.items, ['→Node1#1', '→Node2#2']);
        });

        it('should use →? for unresolvable references', () => {
            const parser = new MockSceneParser();
            parser.addObject(1, { _name: 'Node1' });
            // id 99 does not exist

            const extractor = new PropertyExtractor(parser, { detailed: true });

            const component = {
                __type__: 'Test',
                items: [{ __id__: 1 }, { __id__: 99 }]
            };

            const props = extractor.extract(component);
            assert.deepStrictEqual(props.items, ['→Node1#1', '→?']);
        });

        it('should include #id on single refs in detailed mode', () => {
            const parser = new MockSceneParser();
            parser.addObject(5, { _name: 'TargetNode' });

            const extractor = new PropertyExtractor(parser, { detailed: true });

            const component = {
                __type__: 'Test',
                target: { __id__: 5 }
            };

            const props = extractor.extract(component);
            assert.strictEqual(props.target, '→TargetNode#5');
        });

        it('should show →null for null entries in detailed arrays', () => {
            const parser = new MockSceneParser();
            parser.addObject(1, { _name: 'Node1' });

            const extractor = new PropertyExtractor(parser, { detailed: true });

            const component = {
                __type__: 'Test',
                items: [{ __id__: 1 }, null, { __id__: 1 }]
            };

            const props = extractor.extract(component);
            assert.deepStrictEqual(props.items, ['→Node1#1', '→null', '→Node1#1']);
        });

        it('should show null count in default mode arrays', () => {
            const parser = new MockSceneParser();

            const extractor = new PropertyExtractor(parser);

            const component = {
                __type__: 'Test',
                items: [{ __id__: 1 }, null, { __id__: 2 }]
            };

            const props = extractor.extract(component);
            assert.strictEqual(props.items, '[×2, null×1]');
        });

        it('should still collapse arrays in default mode', () => {
            const parser = new MockSceneParser();
            parser.addObject(1, { _name: 'Node1' });
            parser.addObject(2, { _name: 'Node2' });

            const extractor = new PropertyExtractor(parser);

            const component = {
                __type__: 'Test',
                items: [{ __id__: 1 }, { __id__: 2 }]
            };

            const props = extractor.extract(component);
            assert.strictEqual(props.items, '[×2]');
        });

        it('should handle refs to objects without _name', () => {
            const parser = new MockSceneParser();
            parser.addObject(1, { __type__: 'cc.Vec3' }); // no _name

            const extractor = new PropertyExtractor(parser, { detailed: true });

            const component = {
                __type__: 'Test',
                items: [{ __id__: 1 }]
            };

            const props = extractor.extract(component);
            assert.deepStrictEqual(props.items, ['→?']);
        });
    });

    describe('ClickEvent resolution', () => {
        it('should resolve cc.ClickEvent as target.handler', () => {
            const parser = new MockSceneParser();
            parser.addObject(10, { _name: 'PlayButton' });
            parser.addObject(20, {
                __type__: 'cc.ClickEvent',
                target: { __id__: 10 },
                handler: 'onPlay',
                customEventData: ''
            });

            const extractor = new PropertyExtractor(parser, { detailed: true });

            const component = {
                __type__: 'cc.Button',
                clickEvents: [{ __id__: 20 }]
            };

            const props = extractor.extract(component);
            assert.deepStrictEqual(props.clickEvents, ['→PlayButton.onPlay#20']);
        });

        it('should show handler only when target is unresolvable', () => {
            const parser = new MockSceneParser();
            parser.addObject(20, {
                __type__: 'cc.ClickEvent',
                target: { __id__: 999 },
                handler: 'onClick'
            });

            const extractor = new PropertyExtractor(parser, { detailed: true });

            const component = {
                __type__: 'cc.Button',
                clickEvents: [{ __id__: 20 }]
            };

            const props = extractor.extract(component);
            assert.deepStrictEqual(props.clickEvents, ['→onClick#20']);
        });

        it('should resolve ClickEvent as single ref too', () => {
            const parser = new MockSceneParser();
            parser.addObject(10, { _name: 'Btn' });
            parser.addObject(20, {
                __type__: 'cc.ClickEvent',
                target: { __id__: 10 },
                handler: 'doStuff'
            });

            const extractor = new PropertyExtractor(parser);

            const component = {
                __type__: 'Test',
                event: { __id__: 20 }
            };

            const props = extractor.extract(component);
            assert.strictEqual(props.event, '→Btn.doStuff');
        });
    });

    describe('prefab node name resolution', () => {
        it('should resolve prefab node name from propertyOverrides', () => {
            const parser = new MockSceneParser();
            // Prefab node without _name
            parser.addObject(10, {
                __type__: 'cc.Node',
                _prefab: { __id__: 11 }
            });
            // PrefabInfo → instance
            parser.addObject(11, {
                __type__: 'cc.PrefabInfo',
                instance: { __id__: 12 }
            });
            // PrefabInstance with propertyOverrides
            parser.addObject(12, {
                __type__: 'cc.PrefabInstance',
                propertyOverrides: [{ __id__: 13 }, { __id__: 14 }]
            });
            // Override for position (not _name)
            parser.addObject(13, {
                __type__: 'CCPropertyOverrideInfo',
                propertyPath: ['_lpos'],
                value: { x: 0, y: 0, z: 0 }
            });
            // Override for _name
            parser.addObject(14, {
                __type__: 'CCPropertyOverrideInfo',
                propertyPath: ['_name'],
                value: 'PlayerInfo'
            });

            const extractor = new PropertyExtractor(parser, { detailed: true });

            const component = {
                __type__: 'Test',
                target: { __id__: 10 }
            };

            const props = extractor.extract(component);
            assert.strictEqual(props.target, '→PlayerInfo#10');
        });

        it('should return →? when prefab has no _name override', () => {
            const parser = new MockSceneParser();
            parser.addObject(10, {
                __type__: 'cc.Node',
                _prefab: { __id__: 11 }
            });
            parser.addObject(11, {
                __type__: 'cc.PrefabInfo',
                instance: { __id__: 12 }
            });
            parser.addObject(12, {
                __type__: 'cc.PrefabInstance',
                propertyOverrides: [{ __id__: 13 }]
            });
            parser.addObject(13, {
                __type__: 'CCPropertyOverrideInfo',
                propertyPath: ['_lpos'],
                value: { x: 0, y: 0, z: 0 }
            });

            const extractor = new PropertyExtractor(parser, { detailed: true });

            const component = {
                __type__: 'Test',
                items: [{ __id__: 10 }]
            };

            const props = extractor.extract(component);
            assert.deepStrictEqual(props.items, ['→?']);
        });
    });
});
