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

        it('should render embedded value-type structs as ordered arrays', () => {
            const parser = new MockSceneParser();
            const extractor = new PropertyExtractor(parser);

            const component = {
                __type__: 'cc.BoxCollider',
                _center: { __type__: 'cc.Vec3', x: 0, y: 4, z: -1.5 },
                _size: { __type__: 'cc.Vec3', x: 25, y: 8, z: 3 },
                _radius: { __type__: 'cc.Vec2', x: 0.5, y: 1 },
                tint: { __type__: 'cc.Color', r: 255, g: 128, b: 0, a: 255 }
            };

            const props = extractor.extract(component);
            assert.deepStrictEqual(props._center, [0, 4, -1.5]);
            assert.deepStrictEqual(props._size, [25, 8, 3]);
            assert.deepStrictEqual(props._radius, [0.5, 1]);
            assert.deepStrictEqual(props.tint, [255, 128, 0, 255]);
        });

        it('should append value-type props after scalars (text-cap additivity)', () => {
            const parser = new MockSceneParser();
            const extractor = new PropertyExtractor(parser);

            // Value-type field appears BEFORE scalar fields in source order —
            // it must still be emitted last so it cannot displace a scalar
            // under the text formatter's prop cap.
            const component = {
                __type__: 'cc.DirectionalLight',
                _color: { __type__: 'cc.Color', r: 255, g: 255, b: 255, a: 255 },
                _useColorTemperature: true,
                _colorTemperature: 5500,
                _illuminanceHDR: 110000
            };

            const keys = Object.keys(extractor.extract(component));
            assert.deepStrictEqual(keys, [
                '_useColorTemperature', '_colorTemperature', '_illuminanceHDR', '_color'
            ]);
        });

        it('should not render plain nested objects (no value-type __type__)', () => {
            const parser = new MockSceneParser();
            const extractor = new PropertyExtractor(parser);

            const component = {
                __type__: 'Test',
                custom: { x: 1, y: 2, z: 3 }
            };

            const props = extractor.extract(component);
            assert.ok(props === undefined || !('custom' in props));
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

        it('should resolve asset references through assetResolver', () => {
            const parser = new MockSceneParser();
            const extractor = new PropertyExtractor(parser, {
                assetResolver: (uuid) => uuid === 'abc-123' ? 'Gold.mtl' : null
            });

            const component = {
                __type__: 'Test',
                material: { __uuid__: 'abc-123' },
                unknown: { __uuid__: 'zzz-999' }
            };

            const props = extractor.extract(component);
            assert.strictEqual(props.material, 'Gold.mtl');
            assert.strictEqual(props.unknown, '<asset>');
        });

        it('should collapse asset-ref arrays as count in default mode', () => {
            const parser = new MockSceneParser();
            const extractor = new PropertyExtractor(parser);

            const component = {
                __type__: 'Test',
                _materials: [{ __uuid__: 'a' }, { __uuid__: 'b' }],
                _clips: [{ __uuid__: 'a' }, null]
            };

            const props = extractor.extract(component);
            assert.strictEqual(props._materials, '[×2]');
            assert.strictEqual(props._clips, '[×1, null×1]');
        });

        it('should expand asset-ref arrays with labels in detailed mode', () => {
            const parser = new MockSceneParser();
            const labels = { 'mat-1': 'Zombie.mtl', 'mat-2': 'Model.fbx@a4098 (embedded)' };
            const extractor = new PropertyExtractor(parser, {
                detailed: true,
                assetResolver: (uuid) => labels[uuid] ?? null
            });

            const component = {
                __type__: 'cc.SkinnedMeshRenderer',
                _materials: [{ __uuid__: 'mat-1' }, { __uuid__: 'mat-2' }, null]
            };

            const props = extractor.extract(component);
            assert.deepStrictEqual(props._materials,
                ['Zombie.mtl', 'Model.fbx@a4098 (embedded)', 'null']);
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

        it('should not lose arrays with a leading null', () => {
            const parser = new MockSceneParser();
            parser.addObject(5, { _name: 'TargetNode' });

            const component = {
                __type__: 'Test',
                items: [null, { __id__: 5 }]
            };

            const props = new PropertyExtractor(parser).extract(component);
            assert.strictEqual(props.items, '[×1, null×1]');

            const detailed = new PropertyExtractor(parser, { detailed: true }).extract(component);
            assert.deepStrictEqual(detailed.items, ['→null', '→TargetNode#5']);
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

    describe('nested data CCClass structs', () => {
        // Mirrors CardsBase.entries: CardEntry[] where each CardEntry is its own
        // object in the flat array (referenced by {__id__}), with a nested
        // CardConfig struct, an asset ref, an enum int and a Vec2[] — none of
        // which resolve to a name.
        function cardParser() {
            const parser = new MockSceneParser();
            parser.addObject(20, {
                __idx__: 20,
                __type__: 'CardEntry',
                type: 1, // CardType enum
                prefab: { __uuid__: 'aaaa', __expectedType__: 'cc.Prefab' },
                config: { __id__: 21 },
                offsets: [
                    { __type__: 'cc.Vec2', x: -20, y: 0 },
                    { __type__: 'cc.Vec2', x: 20, y: 0 }
                ],
                members: []
            });
            parser.addObject(21, {
                __idx__: 21,
                __type__: 'CardConfig',
                icon: { __uuid__: 'bbbb' },
                frame: { __uuid__: 'cccc' }
            });
            return parser;
        }

        it('expands an array of data structs in detailed mode', () => {
            const parser = cardParser();
            const extractor = new PropertyExtractor(parser, {
                detailed: true,
                assetResolver: (u) => ({ aaaa: 'Knight.prefab', bbbb: 'icon.png', cccc: 'frame.png' }[u])
            });
            const props = extractor.extract({ __type__: 'CardsBase', entries: [{ __id__: 20 }] });

            assert.strictEqual(props.entries.length, 1);
            const e = props.entries[0];
            assert.strictEqual(e.__struct__, 'CardEntry');
            assert.strictEqual(e.type, 1);
            assert.strictEqual(e.prefab, 'Knight.prefab');
            assert.deepStrictEqual(e.offsets, [[-20, 0], [20, 0]]);
            // Nested struct expanded recursively with its own asset names
            assert.strictEqual(e.config.__struct__, 'CardConfig');
            assert.strictEqual(e.config.icon, 'icon.png');
            assert.strictEqual(e.config.frame, 'frame.png');
        });

        it('expands a single data-struct ref in detailed mode', () => {
            const parser = cardParser();
            const extractor = new PropertyExtractor(parser, {
                detailed: true,
                assetResolver: (u) => ({ bbbb: 'icon.png', cccc: 'frame.png' }[u])
            });
            const props = extractor.extract({ __type__: 'Holder', config: { __id__: 21 } });
            assert.strictEqual(props.config.__struct__, 'CardConfig');
            assert.strictEqual(props.config.icon, 'icon.png');
        });

        it('does NOT expand structs in compact mode (stays [×N])', () => {
            const parser = cardParser();
            const extractor = new PropertyExtractor(parser); // detailed: false
            const props = extractor.extract({ __type__: 'CardsBase', entries: [{ __id__: 20 }] });
            assert.strictEqual(props.entries, '[×1]');
        });

        it('does not recurse into a component (has node back-ref)', () => {
            const parser = new MockSceneParser();
            parser.addObject(30, {
                __idx__: 30,
                __type__: 'MyScript',
                node: { __id__: 31 }, // component marker
                foo: 1
            });
            parser.addObject(31, { __idx__: 31, __type__: 'cc.Node', _name: 'Owner' });
            const extractor = new PropertyExtractor(parser, { detailed: true });
            const props = extractor.extract({ __type__: 'Holder', ref: { __id__: 30 } });
            // Resolves to the owning node name, NOT an expanded struct
            // (detailed mode appends the #id suffix)
            assert.strictEqual(props.ref, '→Owner#30');
        });

        it('guards against cycles between data structs', () => {
            const parser = new MockSceneParser();
            parser.addObject(40, { __idx__: 40, __type__: 'A', next: { __id__: 41 } });
            parser.addObject(41, { __idx__: 41, __type__: 'B', back: { __id__: 40 } });
            const extractor = new PropertyExtractor(parser, { detailed: true });
            const props = extractor.extract({ __type__: 'Holder', root: { __id__: 40 } });
            assert.strictEqual(props.root.__struct__, 'A');
            assert.strictEqual(props.root.next.__struct__, 'B');
            assert.strictEqual(props.root.next.back, '<cycle A>');
        });
    });
});
