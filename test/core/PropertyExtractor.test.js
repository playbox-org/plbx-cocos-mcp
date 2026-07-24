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

    // Flat array form (indexed by id) so component-membership detection
    // (#isComponentIdx → collectComponentIndices) works against the mock.
    get objects() {
        const ids = Object.keys(this.#objects).map(Number);
        const arr = new Array(ids.length ? Math.max(...ids) + 1 : 0).fill(null);
        for (const id of ids) arr[id] = this.#objects[id];
        return arr;
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

        it('does not recurse into a component (real _components member)', () => {
            const parser = new MockSceneParser();
            parser.addObject(30, {
                __idx__: 30,
                __type__: 'MyScript',
                node: { __id__: 31 },
                foo: 1
            });
            // 30 is an ACTUAL component: it is listed in its owning node's
            // _components. Classification is by membership, not the `node`
            // back-ref (review #3/#4) — a non-member with a `node` field would
            // expand as a data struct instead (see the next test).
            parser.addObject(31, {
                __idx__: 31, __type__: 'cc.Node', _name: 'Owner',
                _components: [{ __id__: 30 }]
            });
            const extractor = new PropertyExtractor(parser, { detailed: true });
            const props = extractor.extract({ __type__: 'Holder', ref: { __id__: 30 } });
            // Resolves to the owning node name, NOT an expanded struct
            // (detailed mode appends the #id suffix)
            assert.strictEqual(props.ref, '→Owner#30');
        });

        it('expands array-element data structs carrying a `node` back-ref (review #3/#5)', () => {
            // The motivating CardEntry[] shape: each element is a data struct
            // that references a named node (not a component). It must expand
            // into its fields, NOT collapse to "→<NodeName>" via the back-ref
            // name heuristic (which would fire in the array branch too).
            const objects = [
                { __type__: 'cc.Node', _name: 'Spawner', _components: [] },
                { __type__: 'Waypoint', node: { __id__: 0 }, pause: 2 },
                { __type__: 'Waypoint', node: { __id__: 0 }, pause: 5 }
            ];
            objects.forEach((o, i) => { o.__idx__ = i; });
            const parser = { objects, getObject: (id) => objects[id] ?? null };
            const extractor = new PropertyExtractor(parser, { detailed: true });

            const props = extractor.extract({
                __type__: 'Path', waypoints: [{ __id__: 1 }, { __id__: 2 }]
            });
            assert.strictEqual(props.waypoints.length, 2);
            assert.strictEqual(props.waypoints[0].__struct__, 'Waypoint');
            assert.strictEqual(props.waypoints[0].pause, 2);
            assert.strictEqual(props.waypoints[1].pause, 5);
            // the `node` @property must survive expansion, not be dropped
            assert.strictEqual(props.waypoints[0].node, '→Spawner#0');
            assert.strictEqual(props.waypoints[1].node, '→Spawner#0');
        });

        it('compact mode keeps an unnamed data-struct field as →<owner>', () => {
            // compact has no expansion, but the field must stay visible (→owner)
            const objects = [
                { __type__: 'cc.Node', _name: 'ParentNode', _components: [] },
                { __type__: 'CardConfig', node: { __id__: 0 }, icon: { __uuid__: 'bbbb' } }
            ];
            objects.forEach((o, i) => { o.__idx__ = i; });
            const parser = { objects, getObject: (id) => objects[id] ?? null };

            const compact = new PropertyExtractor(parser); // detailed: false
            const props = compact.extract({ __type__: 'Holder', config: { __id__: 1 } });
            assert.strictEqual(props.config, '→ParentNode');
        });

        it('compact mode falls back to the struct type when there is no node back-ref', () => {
            const objects = [
                { __type__: 'CardConfig', icon: { __uuid__: 'bbbb' } }
            ];
            objects.forEach((o, i) => { o.__idx__ = i; });
            const parser = { objects, getObject: (id) => objects[id] ?? null };

            const compact = new PropertyExtractor(parser); // detailed: false
            const props = compact.extract({ __type__: 'Holder', config: { __id__: 0 } });
            assert.strictEqual(props.config, '→CardConfig');
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

        it('classifies components by _components membership, not the node back-ref (review #4)', () => {
            // Both objects carry a `node` ref to the SAME NAMED node; only [1]
            // is a real component (listed in _components). The user data struct
            // with a `node` @property (very common field name) must still expand
            // — and the node's non-empty name must NOT short-circuit it via the
            // back-ref name heuristic (review #3: an empty _name previously
            // masked this).
            const objects = [
                { __type__: 'cc.Node', _name: 'Root', _components: [{ __id__: 1 }] },
                { __type__: 'CompX', node: { __id__: 0 }, foo: 1 },
                { __type__: 'Waypoint', node: { __id__: 0 }, pause: 2 }
            ];
            objects.forEach((o, i) => { o.__idx__ = i; });
            const parser = { objects, getObject: (id) => objects[id] ?? null };
            const extractor = new PropertyExtractor(parser, { detailed: true });

            const props = extractor.extract({
                __type__: 'Holder', compRef: { __id__: 1 }, wp: { __id__: 2 }
            });
            // component: resolved to its owner's name via the back-ref heuristic
            // (never expanded as a struct)
            assert.strictEqual(props.compRef, '→Root#1');
            // data struct: expanded, even though it has the same `node` back-ref
            // to the same NAMED node — membership, not the name, decides
            assert.strictEqual(props.wp.__struct__, 'Waypoint');
            assert.strictEqual(props.wp.pause, 2);
        });

        // Regression guard: expanding engine plumbing (particle modules, curves,
        // bake settings) blew detailed JSON up +178% on real files and — via the
        // prop cap — displaced main-visible fields. #isDataStruct must reject the
        // same NOISE_TYPES / INTERNAL_STRUCT_TYPES the rest of the read pipeline
        // strips, while still expanding genuine user structs.
        it('does NOT expand engine noise/plumbing types, but still expands user structs', () => {
            const objects = [
                { __type__: 'cc.ModelBakeSettings', castShadow: true }, // NOISE_TYPE
                { __type__: 'cc.CurveRange', mode: 0, constant: 5 },     // NOISE_TYPE
                { __type__: 'cc.PrefabInfo', fileId: 'abc' },            // INTERNAL_STRUCT_TYPE
                { __type__: 'Waypoint', pause: 3 }                       // user data struct
            ];
            objects.forEach((o, i) => { o.__idx__ = i; });
            const parser = { objects, getObject: (id) => objects[id] ?? null };
            const props = new PropertyExtractor(parser, { detailed: true }).extract({
                __type__: 'MeshRenderer',
                _bake: { __id__: 0 }, _width: { __id__: 1 }, _prefab: { __id__: 2 },
                wp: { __id__: 3 }
            });
            // Only the user struct expands; none of the plumbing does
            assert.strictEqual(props.wp.__struct__, 'Waypoint');
            for (const key of ['_bake', '_width', '_prefab']) {
                assert.ok(!(props[key] && props[key].__struct__),
                    `${key} must not expand into a __struct__`);
            }
        });

        it('caps struct recursion at MAX_STRUCT_DEPTH with a <Type> placeholder', () => {
            const chain = [];
            for (let i = 0; i < 8; i++) {
                chain.push({ __type__: `L${i}`, v: i, next: i < 7 ? { __id__: i + 1 } : undefined });
            }
            chain.forEach((o, i) => { o.__idx__ = i; });
            const parser = { objects: chain, getObject: (id) => chain[id] ?? null };
            const root = new PropertyExtractor(parser, { detailed: true })
                .extract({ __type__: 'Root', head: { __id__: 0 } });

            const seen = [];
            let cur = root.head;
            while (cur && typeof cur === 'object') { seen.push(cur.__struct__); cur = cur.next; }
            // Five levels expand (L0..L4), then the cap returns the type as a string
            assert.deepStrictEqual(seen, ['L0', 'L1', 'L2', 'L3', 'L4']);
            assert.strictEqual(cur, '<L5>');
        });
    });

    describe('additive text-cap contract (review #5)', () => {
        it('keeps ref-arrays inline in their original slot, never deferred', () => {
            const parser = new MockSceneParser();
            parser.addObject(50, { __idx__: 50, __type__: 'CardEntry', type: 1 });
            parser.addObject(51, { __idx__: 51, __type__: 'CardEntry', type: 2 });
            const extractor = new PropertyExtractor(parser, { detailed: true });

            const props = extractor.extract({
                __type__: 'CardsBase', node: { __id__: 1 },
                speed: 5,
                entries: [{ __id__: 50 }, { __id__: 51 }],
                alpha: 1, beta: 2, gamma: 3, delta: 4
            });
            // main showed {speed entries alpha beta} in the first 4 text slots —
            // the expanded entries array must not be pushed past the prop cap
            assert.deepStrictEqual(
                Object.keys(props).slice(0, 4),
                ['speed', 'entries', 'alpha', 'beta']
            );
            assert.strictEqual(props.entries[0].__struct__, 'CardEntry');
        });

        it('a newly-surfaced Vec2[] never displaces a value-type scalar visible on main (review #4)', () => {
            // main dropped Vec2[] entirely, so {s1,s2,s3,color} filled the first
            // 4 text slots. The branch now surfaces `offsets`, but it must go
            // AFTER the value-type `color` (which was visible on main) — never
            // interleaved in key order, or `color` would fall past the cap.
            const extractor = new PropertyExtractor(new MockSceneParser());
            const props = extractor.extract({
                __type__: 'MyScript',
                s1: 1, s2: 2, s3: 3,
                offsets: [{ __type__: 'cc.Vec2', x: 1, y: 2 }], // invisible on main
                color: { __type__: 'cc.Color', r: 1, g: 2, b: 3, a: 4 } // visible on main
            });
            const keys = Object.keys(props);
            // color (a value-type scalar) must precede offsets (the new Vec2[])
            assert.ok(keys.indexOf('color') < keys.indexOf('offsets'));
            // and within the first 4 slots the previously-visible fields survive
            assert.deepStrictEqual(keys.slice(0, 4), ['s1', 's2', 's3', 'color']);
        });
    });

    describe('cc.Mat4 (shared value-type registry, review #8)', () => {
        it('renders cc.Mat4 as a 16-number ordered array', () => {
            const extractor = new PropertyExtractor(new MockSceneParser());
            const props = extractor.extract({
                __type__: 'MyScript',
                _mat: {
                    __type__: 'cc.Mat4',
                    m00: 1, m01: 0, m02: 0, m03: 0, m04: 0, m05: 1, m06: 0, m07: 0,
                    m08: 0, m09: 0, m10: 1, m11: 0, m12: 4, m13: 5, m14: 6, m15: 1
                }
            });
            assert.deepStrictEqual(props._mat,
                [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 4, 5, 6, 1]);
        });
    });

    // These guard the additive-only contract against a REGRESSION the snapshot
    // fixtures could not catch: none combined such a field with ≥4 sibling props,
    // so a regenerated snapshot would just record the displaced output as
    // "expected" instead of flagging it (review #1/#4 recommendation).
    describe('prop-cap displacement regressions (review #1/#4)', () => {
        it('#1: compact struct fallback label (→type) is deferred behind visible scalars', () => {
            // cc.Line shape: 4 scalars visible on main + _width→WidthCurve (a user
            // data struct — cc.CurveRange is now noise-filtered like everywhere
            // else), which resolved to null (dropped) on main. The new fallback
            // label must go strictly LAST, never taking a slot a main-visible
            // scalar held under the text prop cap.
            const objects = [
                { __type__: 'WidthCurve', mode: 0, constant: 5 }
            ];
            objects.forEach((o, i) => { o.__idx__ = i; });
            const parser = { objects, getObject: (id) => objects[id] ?? null };
            const compact = new PropertyExtractor(parser); // detailed: false

            const keys = Object.keys(compact.extract({
                __type__: 'cc.Line',
                _tile: 1, _offset: 2, _worldSpace: true, _tileRotation: 3,
                _width: { __id__: 0 } // → cc.CurveRange, invisible on main
            }));
            assert.deepStrictEqual(keys.slice(0, 4),
                ['_tile', '_offset', '_worldSpace', '_tileRotation']);
            assert.strictEqual(keys[keys.length - 1], '_width'); // relocated, still visible
        });

        it('#1: compact struct label WITH a named owner (→owner, visible on main) stays inline', () => {
            const objects = [
                { __type__: 'cc.Node', _name: 'Owner', _components: [] },
                { __type__: 'CardConfig', node: { __id__: 0 } }
            ];
            objects.forEach((o, i) => { o.__idx__ = i; });
            const parser = { objects, getObject: (id) => objects[id] ?? null };
            const compact = new PropertyExtractor(parser); // detailed: false

            const keys = Object.keys(compact.extract({
                __type__: 'Holder',
                cfg: { __id__: 1 }, // → Owner, was visible on main via the back-ref
                a: 1, b: 2, c: 3, d: 4
            }));
            assert.strictEqual(keys[0], 'cfg'); // NOT deferred — keeps its main slot
        });

        it('#4: cc.Mat4 is deferred behind a value-type scalar visible on main', () => {
            const extractor = new PropertyExtractor(new MockSceneParser());
            const keys = Object.keys(extractor.extract({
                __type__: 'MyScript',
                s1: 1, s2: 2,
                mat: { __type__: 'cc.Mat4',
                    m00: 1, m01: 0, m02: 0, m03: 0, m04: 0, m05: 1, m06: 0, m07: 0,
                    m08: 0, m09: 0, m10: 1, m11: 0, m12: 0, m13: 0, m14: 0, m15: 1 }, // new
                color: { __type__: 'cc.Color', r: 1, g: 2, b: 3, a: 4 } // visible on main
            }));
            // color (rendered on main) precedes mat (new); the first 4 slots keep
            // the fields main showed — mat is appended, it never displaces color.
            assert.ok(keys.indexOf('color') < keys.indexOf('mat'));
            assert.deepStrictEqual(keys.slice(0, 4), ['s1', 's2', 'color', 'mat']);
        });
    });

    describe('cycle guard on the SceneDocument backend (review #2)', () => {
        it('detects a struct cycle even without __idx__ tags', () => {
            // SceneDocument (inspect_node) does not tag objects with __idx__;
            // the guard must key on the {__id__} ref, or a self-referential
            // data struct recurses to the depth cap instead of reporting a cycle.
            const objects = [
                null, null,
                { __type__: 'A', next: { __id__: 3 } },
                { __type__: 'B', back: { __id__: 2 } }
            ];
            const doc = { objects, getObject: (id) => objects[id] ?? null };
            const extractor = new PropertyExtractor(doc, { detailed: true });
            const props = extractor.extract({ __type__: 'Holder', root: { __id__: 2 } });
            assert.strictEqual(props.root.__struct__, 'A');
            assert.strictEqual(props.root.next.__struct__, 'B');
            assert.strictEqual(props.root.next.back, '<cycle A>');
        });
    });
});
