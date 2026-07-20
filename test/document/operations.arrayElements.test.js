/**
 * array-element operations tests — insert_array_element / remove_array_element
 * plus the footgun guard against writing a bare value into an array of
 * {__id__} references to typed objects (docs/array-element-ops-analysis.md).
 *
 * A synthetic prefab holds a `CardsBase.entries: CardEntry[]` (references to
 * standalone typed objects, each owning a nested `config: CardConfig` ref and
 * an inline `offsets: cc.Vec2[]`) — the exact shape the analysis targets.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { SceneDocument, isRef } from '../../src/document/SceneDocument.js';
import { applyOperations, OperationError, mergeTyped } from '../../src/document/operations.js';
import { Validator } from '../../src/document/Validator.js';

/** Fresh document each call (ops mutate in place) */
function makeCardsDoc() {
    const objects = [
        { __type__: 'cc.Prefab', _name: 'Cards', data: { __id__: 1 } },
        {
            __type__: 'cc.Node', _name: 'Root', _objFlags: 0, __editorExtras__: {},
            _parent: null, _children: [], _active: true,
            _components: [{ __id__: 2 }], _prefab: { __id__: 4 },
            _lpos: { __type__: 'cc.Vec3', x: 0, y: 0, z: 0 },
            _lrot: { __type__: 'cc.Quat', x: 0, y: 0, z: 0, w: 1 },
            _lscale: { __type__: 'cc.Vec3', x: 1, y: 1, z: 1 },
            _mobility: 0, _layer: 1073741824, _euler: { __type__: 'cc.Vec3', x: 0, y: 0, z: 0 }, _id: ''
        },
        {
            __type__: 'CardsBase', _name: '', _objFlags: 0, node: { __id__: 1 },
            _enabled: true, __prefab: { __id__: 3 }, _id: '',
            entries: [{ __id__: 5 }, { __id__: 7 }],
            links: [{ __id__: 1 }],  // references to EXISTING nodes (not owned)
            clips: []                // empty CCClass[] — the legendale gap slot

        },
        { __type__: 'cc.CompPrefabInfo', fileId: 'compFileId0001' },
        {
            __type__: 'cc.PrefabInfo', root: { __id__: 1 }, asset: { __id__: 0 },
            fileId: 'rootFileId0001', instance: null, targetOverrides: null,
            nestedPrefabInstanceRoots: null
        },
        {
            __type__: 'CardEntry', type: 1,
            prefab: { __uuid__: 'aaaaaaaa-1111-1111-1111-111111111111', __expectedType__: 'cc.Prefab' },
            config: { __id__: 6 },
            offsets: [{ __type__: 'cc.Vec2', x: -20, y: 0 }, { __type__: 'cc.Vec2', x: 20, y: 0 }],
            members: []
        },
        { __type__: 'CardConfig', price: 5, label: 'first' },
        {
            __type__: 'CardEntry', type: 2,
            prefab: { __uuid__: 'bbbbbbbb-2222-2222-2222-222222222222', __expectedType__: 'cc.Prefab' },
            config: { __id__: 8 },
            offsets: [],
            members: []
        },
        { __type__: 'CardConfig', price: 9, label: 'second' }
    ];
    return new SceneDocument(objects, null);
}

const comp = (doc) => doc.getObject(doc.componentIndices(doc.resolveNode('/'))[0]);
const entryOf = (doc, i) => doc.getObject(comp(doc).entries[i].__id__);

function assertValid(doc) {
    const { errors } = new Validator(doc).validate();
    assert.deepStrictEqual(errors, []);
}

/** load → renumber → serialize must be a stable fixed point and validate */
function assertRoundTrips(doc) {
    doc.renumber();
    assertValid(doc);
    const once = doc.serialize();
    const again = SceneDocument.fromContent(once);
    again.renumber();
    assert.strictEqual(again.serialize(), once);
}

describe('insert_array_element', () => {
    test('clones a neighbor as the skeleton and merges value', () => {
        const doc = makeCardsDoc();
        applyOperations(doc, [{
            op: 'insert_array_element', node: '/', component: 'CardsBase',
            property: 'entries', value: { type: 42 }
        }]);

        const entries = comp(doc).entries;
        assert.strictEqual(entries.length, 3);
        const added = doc.getObject(entries[2].__id__);
        assert.strictEqual(added.__type__, 'CardEntry');
        assert.strictEqual(added.type, 42);           // merged override
        assert.strictEqual(added.offsets.length, 2);  // structure copied from neighbor 0
        assertRoundTrips(doc);
    });

    test('allocates FRESH owned sub-objects (no aliasing with the source)', () => {
        const doc = makeCardsDoc();
        const srcConfigIdx = entryOf(doc, 0).config.__id__;
        applyOperations(doc, [{
            op: 'insert_array_element', node: '/', component: 'CardsBase', property: 'entries'
        }]);

        const added = doc.getObject(comp(doc).entries[2].__id__);
        assert.notStrictEqual(added.config.__id__, srcConfigIdx);
        // Mutating the clone's config must not touch the original
        doc.getObject(added.config.__id__).price = 999;
        assert.strictEqual(doc.getObject(srcConfigIdx).price, 5);
    });

    test('index places the element; append is the default', () => {
        const doc = makeCardsDoc();
        applyOperations(doc, [{
            op: 'insert_array_element', node: '/', component: 'CardsBase',
            property: 'entries', index: 0, value: { type: 7 }
        }]);
        assert.strictEqual(entryOf(doc, 0).type, 7);
        assert.strictEqual(entryOf(doc, 1).type, 1);
    });

    test('from selects which neighbor to clone', () => {
        const doc = makeCardsDoc();
        applyOperations(doc, [{
            op: 'insert_array_element', node: '/', component: 'CardsBase',
            property: 'entries', from: 1
        }]);
        const added = doc.getObject(comp(doc).entries[2].__id__);
        assert.strictEqual(added.type, 2);            // copied from entries[1]
        assert.strictEqual(added.label, undefined);
    });

    test('type mismatch against the neighbor is rejected', () => {
        const doc = makeCardsDoc();
        assert.throws(() => applyOperations(doc, [{
            op: 'insert_array_element', node: '/', component: 'CardsBase',
            property: 'entries', type: 'OtherClass'
        }]), /does not match/);
    });

    test('unknown merged field is rejected', () => {
        const doc = makeCardsDoc();
        assert.throws(() => applyOperations(doc, [{
            op: 'insert_array_element', node: '/', component: 'CardsBase',
            property: 'entries', value: { nope: 1 }
        }]), /Unknown field "nope"/);
    });

    test('inline value-type array (cc.Vec2[]) inserts an inline element', () => {
        const doc = makeCardsDoc();
        applyOperations(doc, [{
            op: 'insert_array_element', node: '/', component: 'CardsBase',
            property: 'entries.0.offsets', value: { x: 5, y: 6 }
        }]);
        const offsets = entryOf(doc, 0).offsets;
        assert.strictEqual(offsets.length, 3);
        assert.deepStrictEqual(offsets[2], { __type__: 'cc.Vec2', x: 5, y: 6 });
    });

    test('empty array requires an explicit type', () => {
        const doc = makeCardsDoc();
        assert.throws(() => applyOperations(doc, [{
            op: 'insert_array_element', node: '/', component: 'CardsBase',
            property: 'entries.1.members'
        }]), /pass "type"/);
    });

    test('empty ref-to-existing array accepts a reference value without a type', () => {
        const doc = makeCardsDoc();
        comp(doc).links = []; // empty the node-ref array
        const rootIdx = doc.resolveNode('/');
        applyOperations(doc, [{
            op: 'insert_array_element', node: '/', component: 'CardsBase',
            property: 'links', value: { $node: '/' }
        }]);
        const links = comp(doc).links;
        assert.strictEqual(links.length, 1);
        // linked directly, NOT wrapped in a fresh unlinked standalone object
        assert.deepStrictEqual(links[0], { __id__: rootIdx });
        assertRoundTrips(doc);
    });

    test('empty array with type builds a standalone reference element', () => {
        const doc = makeCardsDoc();
        applyOperations(doc, [{
            op: 'insert_array_element', node: '/', component: 'CardsBase',
            property: 'entries.1.members', type: 'CardMember', value: { hp: 3 }
        }]);
        const members = entryOf(doc, 1).members;
        assert.strictEqual(members.length, 1);
        const m = doc.getObject(members[0].__id__);
        assert.strictEqual(m.__type__, 'CardMember');
        assert.strictEqual(m.hp, 3);
    });

    test('reference-to-existing array inserts a reference value (no cloning)', () => {
        const doc = makeCardsDoc();
        const rootIdx = doc.resolveNode('/');
        applyOperations(doc, [{
            op: 'insert_array_element', node: '/', component: 'CardsBase',
            property: 'links', value: { $node: '/' }
        }]);
        const links = comp(doc).links;
        assert.strictEqual(links.length, 2);
        assert.deepStrictEqual(links[1], { __id__: rootIdx });   // plain ref, not a clone
    });

    test('reference-to-existing array without a reference value is rejected', () => {
        const doc = makeCardsDoc();
        assert.throws(() => applyOperations(doc, [{
            op: 'insert_array_element', node: '/', component: 'CardsBase',
            property: 'links', value: { foo: 1 }
        }]), /references to existing objects/);
    });

    test('rejects a non-array property', () => {
        const doc = makeCardsDoc();
        assert.throws(() => applyOperations(doc, [{
            op: 'insert_array_element', node: '/', component: 'CardsBase',
            property: 'entries.0.type'
        }]), /not an array/);
    });

    test('`from` pointing at a null hole of a typed-ref array is rejected (review #2)', () => {
        const doc = makeCardsDoc();
        comp(doc).entries.push(null); // legal serialization: [ref, ref, null]
        assert.throws(() => applyOperations(doc, [{
            op: 'insert_array_element', node: '/', component: 'CardsBase',
            property: 'entries', from: 2, value: { id: 'x' }
        }]), /null hole/);
        assert.strictEqual(comp(doc).entries.length, 3); // nothing was spliced
    });

    test('a null-hole `from` still accepts an explicit reference value', () => {
        const doc = makeCardsDoc();
        comp(doc).entries.push(null);
        applyOperations(doc, [{
            op: 'insert_array_element', node: '/', component: 'CardsBase',
            property: 'entries', from: 2, value: { $node: '/' }
        }]);
        assert.deepStrictEqual(comp(doc).entries[3], { __id__: 1 });
    });

    test('a data struct with a `node` @property is cloned as owned, not treated as a component (review #4)', () => {
        const doc = makeCardsDoc();
        // `node` is a very common user field name — it must not trip the
        // component classification (components are found by _components
        // membership, not by the back-ref heuristic).
        const wpIdx = doc.addObject({ __type__: 'Waypoint', node: { __id__: 1 }, pause: 2 });
        comp(doc).waypoints = [{ __id__: wpIdx }];

        applyOperations(doc, [{
            op: 'insert_array_element', node: '/', component: 'CardsBase',
            property: 'waypoints', value: { pause: 5 }
        }]);
        const wps = comp(doc).waypoints;
        assert.strictEqual(wps.length, 2);
        assert.notStrictEqual(wps[1].__id__, wpIdx);   // fresh object, not an alias
        const added = doc.getObject(wps[1].__id__);
        assert.strictEqual(added.__type__, 'Waypoint');
        assert.strictEqual(added.pause, 5);
        assert.deepStrictEqual(added.node, { __id__: 1 }); // node LINK kept by value
        assert.strictEqual(doc.getObject(wpIdx).pause, 2); // source untouched
    });

    test('cc.Mat4 inserts inline into an empty array (shared value-type registry, review #8)', () => {
        const doc = makeCardsDoc();
        applyOperations(doc, [{
            op: 'insert_array_element', node: '/', component: 'CardsBase',
            property: 'entries.1.members', type: 'cc.Mat4', value: { m00: 2 }
        }]);
        const members = entryOf(doc, 1).members;
        assert.strictEqual(members.length, 1);
        assert.strictEqual(members[0].__type__, 'cc.Mat4'); // inline, no {__id__}
        assert.strictEqual(members[0].m00, 2);
    });

    test('cc.Mat3 inserts inline (was missing from the value-type registry, review #7)', () => {
        const doc = makeCardsDoc();
        applyOperations(doc, [{
            op: 'insert_array_element', node: '/', component: 'CardsBase',
            property: 'entries.1.members', type: 'cc.Mat3', value: { m00: 3 }
        }]);
        const m = entryOf(doc, 1).members[0];
        assert.strictEqual(m.__type__, 'cc.Mat3'); // inline, NOT a standalone {__id__}
        assert.strictEqual(m.__id__, undefined);
        assert.strictEqual(m.m00, 3);
    });

    // review #1: an array with no clonable neighbor (all-null, or a null-hole
    // `from`) must NOT fall through to a raw scalar splice that would write a
    // bare object where the engine expects a reference / a {__type__} value.
    test('all-null typed-ref array + type allocates a standalone reference (review #1)', () => {
        const doc = makeCardsDoc();
        comp(doc).entries = [null]; // serialized entirely as null — no live ref to read the type from
        applyOperations(doc, [{
            op: 'insert_array_element', node: '/', component: 'CardsBase',
            property: 'entries', type: 'CardEntry', value: { type: 7 }
        }]);
        const entries = comp(doc).entries;
        assert.strictEqual(entries.length, 2);
        assert.ok(entries[1].__id__ !== undefined);          // {__id__} reference, not inline
        const added = doc.getObject(entries[1].__id__);
        assert.strictEqual(added.__type__, 'CardEntry');
        assert.strictEqual(added.type, 7);
        assertRoundTrips(doc);
    });

    test('all-null typed array with no type and a bare object is rejected, not corrupted (review #1)', () => {
        const doc = makeCardsDoc();
        comp(doc).entries = [null];
        assert.throws(() => applyOperations(doc, [{
            op: 'insert_array_element', node: '/', component: 'CardsBase',
            property: 'entries', value: { type: 7 }
        }]), /Cannot determine the element type/);
        assert.deepStrictEqual(comp(doc).entries, [null]); // untouched
    });

    test('null-hole `from` in a value-type array builds an inline element (review #1)', () => {
        const doc = makeCardsDoc();
        // offsets is cc.Vec2[]; push a legal null hole and clone-target it
        entryOf(doc, 0).offsets.push(null); // [{Vec2}, {Vec2}, null]
        applyOperations(doc, [{
            op: 'insert_array_element', node: '/', component: 'CardsBase',
            property: 'entries.0.offsets', from: 2, value: { x: 9, y: 8 }
        }]);
        const offsets = entryOf(doc, 0).offsets;
        // inserted inline (has __type__), not a bare object
        assert.strictEqual(offsets[offsets.length - 1].__type__, 'cc.Vec2');
        assert.strictEqual(offsets[offsets.length - 1].x, 9);
        assertRoundTrips(doc);
    });
});

describe('remove_array_element', () => {
    test('removes an element and GCs its owned subtree on renumber', () => {
        const doc = makeCardsDoc();
        const before = doc.objects.length;
        applyOperations(doc, [{
            op: 'remove_array_element', node: '/', component: 'CardsBase',
            property: 'entries', index: 0
        }]);
        assert.strictEqual(comp(doc).entries.length, 1);
        assert.strictEqual(entryOf(doc, 0).type, 2);   // the survivor is old entries[1]

        const { dropped } = doc.renumber();
        assert.strictEqual(dropped, 2);                // CardEntry #0 + its CardConfig
        assert.strictEqual(doc.objects.length, before - 2);
        assertValid(doc);
    });

    test('out-of-range index is rejected', () => {
        const doc = makeCardsDoc();
        assert.throws(() => applyOperations(doc, [{
            op: 'remove_array_element', node: '/', component: 'CardsBase',
            property: 'entries', index: 5
        }]), /out of range/);
        assert.throws(() => applyOperations(doc, [{
            op: 'remove_array_element', node: '/', component: 'CardsBase',
            property: 'entries'
        }]), /out of range/);
    });

    test('a reachable reference into the removed element blocks removal (force nulls it)', () => {
        const doc = makeCardsDoc();
        // A second component elsewhere points at entries[0]'s config
        const targetConfigIdx = entryOf(doc, 0).config.__id__;
        const otherIdx = doc.addObject({
            __type__: 'OtherComp', node: { __id__: 1 }, _id: '', __prefab: null,
            ref: { __id__: targetConfigIdx }
        });
        doc.getObject(1)._components.push({ __id__: otherIdx });

        assert.throws(() => applyOperations(doc, [{
            op: 'remove_array_element', node: '/', component: 'CardsBase',
            property: 'entries', index: 0
        }]), /referenced from outside/);

        const doc2 = rebuildWithOtherComp();
        applyOperations(doc2, [{
            op: 'remove_array_element', node: '/', component: 'CardsBase',
            property: 'entries', index: 0, force: true
        }]);
        const other = doc2.getObject(doc2.componentIndices(doc2.resolveNode('/'))[1]);
        assert.strictEqual(other.ref, null);           // external ref nulled
    });

    test('removing an inline value-type element just splices', () => {
        const doc = makeCardsDoc();
        applyOperations(doc, [{
            op: 'remove_array_element', node: '/', component: 'CardsBase',
            property: 'entries.0.offsets', index: 0
        }]);
        const offsets = entryOf(doc, 0).offsets;
        assert.strictEqual(offsets.length, 1);
        assert.strictEqual(offsets[0].x, 20);
    });

    test('removing a node reference from a link array just splices (review #1)', () => {
        const doc = makeCardsDoc();
        // links[0] → the root node: dropping the LINK must neither throw
        // ("referenced from outside") nor GC the live node.
        applyOperations(doc, [{
            op: 'remove_array_element', node: '/', component: 'CardsBase',
            property: 'links', index: 0
        }]);
        assert.deepStrictEqual(comp(doc).links, []);
        assert.strictEqual(doc.getObject(1).__type__, 'cc.Node'); // target kept
        assertRoundTrips(doc);
    });

    test('removing a reference to a live component keeps the component (review #1)', () => {
        const doc = makeCardsDoc();
        const fooIdx = doc.addObject({
            __type__: 'FooComp', node: { __id__: 1 }, _id: '', __prefab: null
        });
        doc.getObject(1)._components.push({ __id__: fooIdx });
        comp(doc).controllers = [{ __id__: fooIdx }];

        // No force needed — the element is a link, not an owned subtree
        applyOperations(doc, [{
            op: 'remove_array_element', node: '/', component: 'CardsBase',
            property: 'controllers', index: 0
        }]);
        assert.deepStrictEqual(comp(doc).controllers, []);

        doc.renumber();
        assert.ok(doc.objects.some(o => o?.__type__ === 'FooComp')); // not GC'd
    });

    test('array splices remap targetOverride propertyPaths through the array (review #3)', () => {
        const doc = makeCardsDoc();
        const registry = doc.getObject(4); // prefab-root PrefabInfo = the registry
        const ovIdx = doc.addObject({
            __type__: 'cc.TargetOverrideInfo',
            source: { __id__: 2 }, sourceInfo: null,
            propertyPath: ['entries', '1', 'target'],
            target: { __id__: 1 }, targetInfo: null
        });
        const tiIdx = doc.addObject({ __type__: 'cc.TargetInfo', localID: ['someFileId01'] });
        const ov = doc.getObject(ovIdx);
        ov.targetInfo = { __id__: tiIdx };
        registry.targetOverrides = [{ __id__: ovIdx }];

        // insert before it → the index segment shifts up
        applyOperations(doc, [{
            op: 'insert_array_element', node: '/', component: 'CardsBase',
            property: 'entries', index: 0, value: { type: 9 }
        }]);
        assert.deepStrictEqual(ov.propertyPath, ['entries', '2', 'target']);

        // remove before it → shifts back down
        applyOperations(doc, [{
            op: 'remove_array_element', node: '/', component: 'CardsBase',
            property: 'entries', index: 0
        }]);
        assert.deepStrictEqual(ov.propertyPath, ['entries', '1', 'target']);

        // removing the overridden element itself drops the record
        applyOperations(doc, [{
            op: 'remove_array_element', node: '/', component: 'CardsBase',
            property: 'entries', index: 1
        }]);
        assert.deepStrictEqual(registry.targetOverrides, []);
        assertValid(doc);
    });
});

describe('footgun guard (docs §3a)', () => {
    test('set_component_property into the append slot of a typed-ref array is rejected', () => {
        const doc = makeCardsDoc();
        assert.throws(() => applyOperations(doc, [{
            op: 'set_component_property', node: '/', component: 'CardsBase',
            property: 'entries.2', value: { type: 99 }
        }]), /insert_array_element/);
    });

    test('editing a field of an EXISTING element still works (not blocked)', () => {
        const doc = makeCardsDoc();
        applyOperations(doc, [{
            op: 'set_component_property', node: '/', component: 'CardsBase',
            property: 'entries.0.type', value: 8
        }]);
        assert.strictEqual(entryOf(doc, 0).type, 8);
    });

    test('merging into an EXISTING element through its ref still works', () => {
        const doc = makeCardsDoc();
        applyOperations(doc, [{
            op: 'set_component_property', node: '/', component: 'CardsBase',
            property: 'entries.0', value: { type: 3 }
        }]);
        assert.strictEqual(entryOf(doc, 0).type, 3);
        assert.strictEqual(entryOf(doc, 0).offsets.length, 2); // preserved through the merge
    });

    test('replacing a whole typed-ref array with inline objects is rejected (review #2a)', () => {
        const doc = makeCardsDoc();
        assert.throws(() => applyOperations(doc, [{
            op: 'set_component_property', node: '/', component: 'CardsBase',
            property: 'entries', value: [{ type: 1 }]
        }]), /references to standalone objects|insert_array_element/);
        assert.strictEqual(comp(doc).entries.length, 2); // untouched
    });

    test('writing bare objects into an EMPTY typed array is rejected (legendale gap)', () => {
        const doc = makeCardsDoc();
        // clips starts []: isRefArrayClobber has no live {__id__} to key off, so
        // without the untagged-array guard the bare objects serialize inline and
        // untyped and the engine drops them (array shows empty).
        assert.throws(() => applyOperations(doc, [{
            op: 'set_component_property', node: '/', component: 'CardsBase',
            property: 'clips', value: [{ name: 'Idle' }, { name: 'Run' }]
        }]), /insert_array_element/);
        assert.deepStrictEqual(comp(doc).clips, []); // untouched
    });

    test('one bare object among refs into an empty array is still rejected', () => {
        const doc = makeCardsDoc();
        assert.throws(() => applyOperations(doc, [{
            op: 'set_component_property', node: '/', component: 'CardsBase',
            property: 'clips', value: [{ $node: '/' }, { name: 'Idle' }]
        }]), /insert_array_element/);
        assert.deepStrictEqual(comp(doc).clips, []);
    });

    test('a whole-array write whose elements carry __type__ is allowed (inline value type)', () => {
        const doc = makeCardsDoc();
        // cc.ClickEvent[]-style: the elements are explicit inline value objects —
        // the guard keys on the MISSING type tag, so a tagged write is legitimate.
        applyOperations(doc, [{
            op: 'set_component_property', node: '/', component: 'CardsBase',
            property: 'clips',
            value: [{ __type__: 'cc.Vec2', x: 1, y: 2 }, { __type__: 'cc.Vec2', x: 3, y: 4 }]
        }]);
        assert.strictEqual(comp(doc).clips.length, 2);
        assert.strictEqual(comp(doc).clips[0].__type__, 'cc.Vec2');
    });

    test('empty [] clear then insert_array_element with explicit type is the correct path (A)', () => {
        const doc = makeCardsDoc();
        applyOperations(doc, [
            { op: 'set_component_property', node: '/', component: 'CardsBase',
              property: 'clips', value: [] },
            { op: 'insert_array_element', node: '/', component: 'CardsBase',
              property: 'clips', type: 'CharacterClip', value: { name: 'Idle' } },
            { op: 'insert_array_element', node: '/', component: 'CardsBase',
              property: 'clips', type: 'CharacterClip', value: { name: 'Run' } }
        ]);
        const clips = comp(doc).clips;
        assert.strictEqual(clips.length, 2);
        assert.ok(isRef(clips[0]) && isRef(clips[1]));           // {__id__} references
        assert.strictEqual(doc.getObject(clips[0].__id__).__type__, 'CharacterClip');
        assert.strictEqual(doc.getObject(clips[1].__id__).name, 'Run');
        assertRoundTrips(doc);
    });

    test('merging inline objects into a nested reference sub-array is rejected (review #2b)', () => {
        const doc = makeCardsDoc();
        // entries[0].members is a {__id__}[]; seed a live reference so the array
        // is recognizably a ref-array, then try to clobber it with inline objects
        const memberIdx = doc.addObject({ __type__: 'CardMember', hp: 1 });
        entryOf(doc, 0).members = [{ __id__: memberIdx }];
        assert.throws(() => applyOperations(doc, [{
            op: 'set_component_property', node: '/', component: 'CardsBase',
            property: 'entries.0', value: { members: [{ hp: 3 }] }
        }]), /references to standalone objects|insert_array_element/);
        // the ref sub-array is intact
        assert.deepStrictEqual(entryOf(doc, 0).members, [{ __id__: memberIdx }]);
    });

    test('ref-array clobber on an instance stub points at the source .prefab, not the element ops (review #3)', () => {
        const existing = [{ __id__: 5 }, { __id__: 6 }]; // source-prefab CardEntry[]
        const given = [{ type: 1 }]; // inline objects
        // Off an instance: element-op remediation (the array is directly addressable).
        assert.throws(() => mergeTyped(existing, given, 'entries'),
            /insert_array_element|remove_array_element/);
        // On an instance stub: element ops only reach mounted components, so the
        // remediation must send the caller to the source prefab asset instead.
        assert.throws(
            () => mergeTyped(existing, given, 'entries',
                { instance: true, sourcePrefab: 'assets/Cards.prefab' }),
            (err) => err instanceof OperationError &&
                /assets\/Cards\.prefab/.test(err.message) &&
                !/insert_array_element/.test(err.message)
        );
    });

    test('replacing a typed-ref array with references (not inline objects) still works', () => {
        const doc = makeCardsDoc();
        // links is a reference-to-existing array — re-linking with a reference
        // value is legitimate and must not be blocked by the clobber guard
        applyOperations(doc, [{
            op: 'set_component_property', node: '/', component: 'CardsBase',
            property: 'links', value: [{ $node: '/' }]
        }]);
        assert.deepStrictEqual(comp(doc).links, [{ __id__: 1 }]);
    });

    test('set_component_property into the append slot of a NODE-ref array is rejected', () => {
        const doc = makeCardsDoc();
        // links is cc.Node[] — the guard must cover node refs, not just non-nodes
        assert.throws(() => applyOperations(doc, [{
            op: 'set_component_property', node: '/', component: 'CardsBase',
            property: 'links.1', value: 5
        }]), /insert_array_element/);
        assert.deepStrictEqual(comp(doc).links, [{ __id__: 1 }]); // untouched
    });

    test('overwriting a live NODE-ref element with a bare value is rejected (review #2)', () => {
        const doc = makeCardsDoc();
        // links[0] is a live {__id__} node reference — a scalar there would
        // replace the reference with an inline value (silent corruption).
        assert.throws(() => applyOperations(doc, [{
            op: 'set_component_property', node: '/', component: 'CardsBase',
            property: 'links.0', value: 5
        }]), /corrupts the file/);
        assert.deepStrictEqual(comp(doc).links, [{ __id__: 1 }]); // untouched
    });

    test('overwriting a live NODE-ref element with an inline object is rejected (review #2)', () => {
        const doc = makeCardsDoc();
        assert.throws(() => applyOperations(doc, [{
            op: 'set_component_property', node: '/', component: 'CardsBase',
            property: 'links.0', value: { foo: 1 }
        }]), /corrupts the file/);
        assert.deepStrictEqual(comp(doc).links, [{ __id__: 1 }]);
    });

    test('overwriting a live COMPONENT-ref element with a scalar is rejected (review #2)', () => {
        const doc = makeCardsDoc();
        const fooIdx = doc.addObject({
            __type__: 'FooComp', node: { __id__: 1 }, _id: '', __prefab: null
        });
        doc.getObject(1)._components.push({ __id__: fooIdx });
        comp(doc).controllers = [{ __id__: fooIdx }];
        assert.throws(() => applyOperations(doc, [{
            op: 'set_component_property', node: '/', component: 'CardsBase',
            property: 'controllers.0', value: 5
        }]), /corrupts the file/);
        assert.deepStrictEqual(comp(doc).controllers, [{ __id__: fooIdx }]);
    });

    test('overwriting a live value-object element with a scalar still gives the "set its fields" hint', () => {
        const doc = makeCardsDoc();
        // entries[0] → CardEntry (value object): a scalar is caught downstream
        // by the merge-through path, not blocked as append/hole corruption.
        assert.throws(() => applyOperations(doc, [{
            op: 'set_component_property', node: '/', component: 'CardsBase',
            property: 'entries.0', value: 5
        }]), /set its fields/);
    });

    test('set_asset_ref over a live typed-ref element is rejected (review #3)', () => {
        const doc = makeCardsDoc();
        const ctx = {
            assetIndex: {
                resolve: () => ({ entry: { uuid: 'aaaa-uuid', importer: 'sprite-frame' } }),
                scriptUuidByName: () => ({ exact: new Map(), lower: new Map() })
            }
        };
        // entries[0] is a live {__id__} → CardEntry; an asset ({__uuid__}) there
        // would overwrite the reference (silent corruption, review #3).
        assert.throws(() => applyOperations(doc, [{
            op: 'set_asset_ref', node: '/', componentIndex: 0,
            property: 'entries.0', asset: 'whatever', expectedType: 'cc.SpriteFrame'
        }], ctx), /corrupts the file/);
        assert.deepStrictEqual(comp(doc).entries[0], { __id__: 5 }); // untouched
    });

    test('writing null into the append slot / a hole is allowed (review #6)', () => {
        const doc = makeCardsDoc();
        // Null holes are a legal serialization (the golden files contain them)
        applyOperations(doc, [{
            op: 'set_component_property', node: '/', component: 'CardsBase',
            property: 'entries.2', value: null
        }]);
        assert.strictEqual(comp(doc).entries.length, 3);
        assert.strictEqual(comp(doc).entries[2], null);

        applyOperations(doc, [{
            op: 'set_component_property', node: '/', component: 'CardsBase',
            property: 'entries.2', value: null // overwrite the hole with null again
        }]);
        assert.strictEqual(comp(doc).entries[2], null);
        assertRoundTrips(doc);
    });
});

// --- helpers that need their own fresh document instances ---

function rebuildWithOtherComp() {
    const doc = makeCardsDoc();
    const targetConfigIdx = entryOf(doc, 0).config.__id__;
    const otherIdx = doc.addObject({
        __type__: 'OtherComp', node: { __id__: 1 }, _id: '', __prefab: null,
        ref: { __id__: targetConfigIdx }
    });
    doc.getObject(1)._components.push({ __id__: otherIdx });
    return doc;
}
