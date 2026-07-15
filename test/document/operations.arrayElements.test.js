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
import { SceneDocument } from '../../src/document/SceneDocument.js';
import { applyOperations, OperationError } from '../../src/document/operations.js';
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
            links: [{ __id__: 1 }]   // references to EXISTING nodes (not owned)
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
