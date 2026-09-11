/**
 * Typed-value serialization tests — the two rules in src/document/typedValues.js
 *
 * 1. An object value needs a `__type__`; where the file cannot supply one
 *    (a null field, a field a user script declares and the file omits), the
 *    write is refused instead of silently deserializing as an untyped object
 *    (the component then keeps Size(0, 0) / Color(0, 0, 0, 255) / []).
 * 2. A custom @ccclass value is a STANDALONE object referenced by {__id__} —
 *    the shape editor-saved files use (verified: cc.ClickEvent in
 *    test/fixtures/real-prefabs/Toilets.prefab, and the reported Knight.prefab
 *    `moveAnim` → AnimationSet → DirectionFrames chain).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { SceneDocument, isRef } from '../../src/document/SceneDocument.js';
import { applyOperations, OperationError } from '../../src/document/operations.js';
import { Validator } from '../../src/document/Validator.js';

/**
 * Fresh prefab: a cc.UITransform (typed fields present) and a user script
 * whose fields are serialized null — the exact shape a build_prefab-created
 * component has, and the one that used to lose every type tag.
 */
function makeDoc() {
    const objects = [
        { __type__: 'cc.Prefab', _name: 'Prince', data: { __id__: 1 } },
        {
            __type__: 'cc.Node', _name: 'Prince', _objFlags: 0, __editorExtras__: {},
            _parent: null, _children: [], _active: true,
            _components: [{ __id__: 2 }, { __id__: 4 }], _prefab: { __id__: 6 },
            _lpos: { __type__: 'cc.Vec3', x: 0, y: 0, z: 0 },
            _lrot: { __type__: 'cc.Quat', x: 0, y: 0, z: 0, w: 1 },
            _lscale: { __type__: 'cc.Vec3', x: 1, y: 1, z: 1 },
            _mobility: 0, _layer: 33554432,
            _euler: { __type__: 'cc.Vec3', x: 0, y: 0, z: 0 }, _id: ''
        },
        {
            __type__: 'cc.UITransform', _name: '', _objFlags: 0, node: { __id__: 1 },
            _enabled: true, __prefab: { __id__: 3 },
            _contentSize: { __type__: 'cc.Size', width: 100, height: 100 },
            _anchorPoint: { __type__: 'cc.Vec2', x: 0.5, y: 0.5 }, _id: ''
        },
        { __type__: 'cc.CompPrefabInfo', fileId: 'compFileId0001' },
        {
            __type__: 'Prince', _name: '', _objFlags: 0, node: { __id__: 1 },
            _enabled: true, __prefab: { __id__: 5 }, _id: '',
            moveAnim: null, tint: null, size: null, settings: null
        },
        { __type__: 'cc.CompPrefabInfo', fileId: 'compFileId0002' },
        {
            __type__: 'cc.PrefabInfo', root: { __id__: 1 }, asset: { __id__: 0 },
            fileId: 'rootFileId0001', instance: null, targetOverrides: null,
            nestedPrefabInstanceRoots: null
        }
    ];
    return new SceneDocument(objects, null);
}

const componentOf = (doc, type) => doc.getObject(
    doc.componentIndices(doc.resolveNode('/')).find(i => doc.getObject(i).__type__ === type));
const script = (doc) => componentOf(doc, 'Prince');

/** load → renumber → serialize must be a stable fixed point and validate */
function assertRoundTrips(doc) {
    doc.renumber();
    const { errors } = new Validator(doc).validate();
    assert.deepStrictEqual(errors, []);
    const once = doc.serialize();
    const again = SceneDocument.fromContent(once);
    again.renumber();
    assert.strictEqual(again.serialize(), once);
}

describe('typed values — rule 1: an object value needs __type__', () => {
    test('merging into an existing typed value keeps the tag (unchanged)', () => {
        const doc = makeDoc();
        applyOperations(doc, [{
            op: 'set_component_property', node: '/', component: 'cc.UITransform',
            property: '_contentSize', value: { width: 184, height: 184 }
        }]);
        assert.deepStrictEqual(componentOf(doc, 'cc.UITransform')._contentSize,
            { __type__: 'cc.Size', width: 184, height: 184 });
    });

    test('an untyped object into a null field is refused, naming the type that fits', () => {
        const doc = makeDoc();
        assert.throws(() => applyOperations(doc, [{
            op: 'set_component_property', node: '/', component: 'Prince',
            property: 'size', value: { width: 184, height: 184 }
        }]), (err) => {
            assert.ok(err instanceof OperationError);
            assert.match(err.message, /no "__type__"/);
            assert.match(err.message, /"__type__": "cc\.Size"/);
            assert.match(err.message, /\$plain/);
            return true;
        });
        assert.strictEqual(script(doc).size, null); // nothing written
    });

    test('an untyped object into a field the file does not carry is refused too', () => {
        const doc = makeDoc();
        assert.throws(() => applyOperations(doc, [{
            op: 'set_component_property', node: '/', component: 'Prince',
            property: 'newColor', value: { r: 255, g: 0, b: 0, a: 255 }
        }]), /"__type__": "cc\.Color"/);
        assert.ok(!Object.hasOwn(script(doc), 'newColor'));
    });

    test('the same write with an explicit __type__ succeeds', () => {
        const doc = makeDoc();
        applyOperations(doc, [{
            op: 'set_component_property', node: '/', component: 'Prince',
            property: 'size', value: { __type__: 'cc.Size', width: 184, height: 184 }
        }]);
        assert.deepStrictEqual(script(doc).size,
            { __type__: 'cc.Size', width: 184, height: 184 });
        assertRoundTrips(doc);
    });

    test('an untyped object nested in a typed value is refused at its own path', () => {
        const doc = makeDoc();
        // A struct whose own field is serialized null cannot type what goes in.
        script(doc).settings = { __type__: 'PrinceSettings', hitBox: null };
        assert.throws(() => applyOperations(doc, [{
            op: 'set_component_property', node: '/', component: 'Prince',
            property: 'settings', value: { hitBox: { width: 4, height: 4 } }
        }]), /"settings\.hitBox" got an object/);
        assert.strictEqual(script(doc).settings.hitBox, null);
    });

    test('an array over a typed value is refused (the flat-array spelling)', () => {
        const doc = makeDoc();
        assert.throws(() => applyOperations(doc, [{
            op: 'set_component_property', node: '/', component: 'cc.UITransform',
            property: '_contentSize', value: [184, 184]
        }]), /holds a cc\.Size.*replaces the typed value with an array/s);
        assert.deepStrictEqual(componentOf(doc, 'cc.UITransform')._contentSize,
            { __type__: 'cc.Size', width: 100, height: 100 });
    });

    test('null still clears a typed field', () => {
        const doc = makeDoc();
        applyOperations(doc, [{
            op: 'set_component_property', node: '/', component: 'cc.UITransform',
            property: '_contentSize', value: null
        }]);
        assert.strictEqual(componentOf(doc, 'cc.UITransform')._contentSize, null);
    });

    test('$plain writes a genuinely untyped dictionary verbatim', () => {
        const doc = makeDoc();
        applyOperations(doc, [{
            op: 'set_component_property', node: '/', component: 'Prince',
            property: 'settings', value: { $plain: { difficulty: 'hard', flags: { a: 1 } } }
        }]);
        assert.deepStrictEqual(script(doc).settings, { difficulty: 'hard', flags: { a: 1 } });
        assertRoundTrips(doc);
    });

    test('$plain rejects a sibling key and a non-object payload', () => {
        const doc = makeDoc();
        assert.throws(() => applyOperations(doc, [{
            op: 'set_component_property', node: '/', component: 'Prince',
            property: 'settings', value: { $plain: { a: 1 }, b: 2 }
        }]), /must be the only key/);
        assert.throws(() => applyOperations(doc, [{
            op: 'set_component_property', node: '/', component: 'Prince',
            property: 'settings', value: { $plain: [1, 2] }
        }]), /expects an object/);
    });

    test('$plain is refused over a value the file DOES type', () => {
        const doc = makeDoc();
        assert.throws(() => applyOperations(doc, [{
            op: 'set_component_property', node: '/', component: 'cc.UITransform',
            property: '_contentSize', value: { $plain: { width: 1, height: 2 } }
        }]), /holds a cc\.Size.*would strip/s);
        assert.deepStrictEqual(componentOf(doc, 'cc.UITransform')._contentSize,
            { __type__: 'cc.Size', width: 100, height: 100 });
    });

    test('a node rotation with no _euler in the file merges onto a TYPED zero', () => {
        const doc = makeDoc();
        delete doc.getObject(doc.resolveNode('/'))._euler;
        applyOperations(doc, [{
            op: 'set_node_property', node: '/', property: 'rotation', value: { y: 90 }
        }]);
        assert.deepStrictEqual(doc.getObject(doc.resolveNode('/'))._euler,
            { __type__: 'cc.Vec3', x: 0, y: 90, z: 0 });
    });
});

describe('typed values — rule 2: a custom @ccclass is a standalone object', () => {
    test('a nested @ccclass value is hoisted into its own object at every depth', () => {
        const doc = makeDoc();
        applyOperations(doc, [{
            op: 'set_component_property', node: '/', component: 'Prince', property: 'moveAnim',
            value: {
                __type__: 'AnimationSet',
                directions: [
                    { __type__: 'DirectionFrames', frames: [], speed: 1 },
                    { __type__: 'DirectionFrames', frames: [], speed: 2 }
                ]
            }
        }]);
        const moveAnim = script(doc).moveAnim;
        assert.ok(isRef(moveAnim), 'moveAnim holds an {__id__} reference');
        const set = doc.getObject(moveAnim.__id__);
        assert.strictEqual(set.__type__, 'AnimationSet');
        assert.ok(set.directions.every(isRef), 'each direction is a reference too');
        assert.deepStrictEqual(
            set.directions.map(r => doc.getObject(r.__id__).__type__),
            ['DirectionFrames', 'DirectionFrames']);
        assert.strictEqual(doc.getObject(set.directions[1].__id__).speed, 2);
        assertRoundTrips(doc);
    });

    test('engine value types stay inline, assets and references pass through', () => {
        const doc = makeDoc();
        applyOperations(doc, [{
            op: 'set_component_property', node: '/', component: 'Prince', property: 'moveAnim',
            value: {
                __type__: 'AnimationSet',
                offset: { __type__: 'cc.Vec3', x: 1, y: 2, z: 3 },
                owner: { $node: '/' }
            }
        }]);
        const set = doc.getObject(script(doc).moveAnim.__id__);
        assert.deepStrictEqual(set.offset, { __type__: 'cc.Vec3', x: 1, y: 2, z: 3 });
        assert.deepStrictEqual(set.owner, { __id__: doc.resolveNode('/') });
        assertRoundTrips(doc);
    });

    test('a whole-array write of @ccclass elements becomes an array of references', () => {
        const doc = makeDoc();
        applyOperations(doc, [{
            op: 'set_component_property', node: '/', component: 'Prince', property: 'clips',
            value: [{ __type__: 'CharacterClip', name: 'Idle' },
                { __type__: 'CharacterClip', name: 'Run' }]
        }]);
        const clips = script(doc).clips;
        assert.ok(clips.every(isRef));
        assert.deepStrictEqual(clips.map(r => doc.getObject(r.__id__).name), ['Idle', 'Run']);
        assertRoundTrips(doc);
    });

    test('a node/plumbing __type__ is refused rather than minted as a value', () => {
        const doc = makeDoc();
        for (const type of ['cc.Node', 'cc.PrefabInfo']) {
            assert.throws(() => applyOperations(doc, [{
                op: 'set_component_property', node: '/', component: 'Prince',
                property: 'moveAnim', value: { __type__: type, _name: 'x' }
            }]), /not a property value/);
        }
        assert.strictEqual(script(doc).moveAnim, null);
    });

    test('insert_array_element hoists a @ccclass nested in the element value', () => {
        const doc = makeDoc();
        applyOperations(doc, [
            { op: 'set_component_property', node: '/', component: 'Prince',
                property: 'clips', value: [] },
            { op: 'insert_array_element', node: '/', component: 'Prince', property: 'clips',
                type: 'CharacterClip',
                value: { name: 'Idle', curve: { __type__: 'ClipCurve', points: [] } } }
        ]);
        const clip = doc.getObject(script(doc).clips[0].__id__);
        assert.strictEqual(clip.__type__, 'CharacterClip');
        assert.ok(isRef(clip.curve), 'the nested @ccclass got its own object');
        assert.strictEqual(doc.getObject(clip.curve.__id__).__type__, 'ClipCurve');
        assertRoundTrips(doc);
    });
});

describe('typed values — validate_document finds files written before the fix', () => {
    test('an untyped object / an array in a typed cc.* field is warned about', () => {
        const doc = makeDoc();
        const ui = componentOf(doc, 'cc.UITransform');
        ui._contentSize = { width: 184, height: 184 }; // what the old merge form wrote
        ui._anchorPoint = [0.5, 0.5];
        const { errors, warnings } = new Validator(doc).validate();
        assert.deepStrictEqual(errors, []); // structurally fine — that was the trap
        assert.ok(warnings.some(w => /_contentSize.*untyped object.*cc\.Size/.test(w)),
            `expected a _contentSize warning, got: ${warnings.join(' | ')}`);
        assert.ok(warnings.some(w => /_anchorPoint.*an array.*cc\.Vec2/.test(w)));
    });

    test('a correctly typed document warns about neither', () => {
        const { warnings } = new Validator(makeDoc()).validate();
        assert.ok(!warnings.some(w => /untyped object|an array where/.test(w)));
    });
});
