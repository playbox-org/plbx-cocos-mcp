/**
 * Typed-value serialization rules shared by every write path
 *
 * Cocos rebuilds a property value from the `__type__` tag the serializer put
 * next to it. Two rules decide what a correct write looks like, and BOTH were
 * broken for values the file could not supply a type for:
 *
 * 1. An object value needs a `__type__`. Without one the engine deserializes a
 *    plain JS object, assigns it to a typed field and the component keeps its
 *    DEFAULT — Size(0, 0), Color(0, 0, 0, 255), an empty array. Nothing in the
 *    file is structurally wrong, so `validate_document` reported it valid: the
 *    corruption is silent on both sides. `mergeTyped` carries the tag over from
 *    the value being merged INTO, so the tag only goes missing where the file
 *    has no value to read it from — a `null` field, or a field a user script
 *    declares and the file does not carry yet (every field of a component
 *    `build_prefab` has just created). There the type is genuinely unknown, so
 *    the write is REFUSED with the spelling that fixes it, rather than written
 *    untyped (`untypedValueError`).
 *
 * 2. A custom `@ccclass` object is a STANDALONE object of the flat array, and
 *    the owning field holds a `{__id__}` reference to it — verified on
 *    editor-saved files: `moveAnim` → `{"__id__": 29}` → `{"__type__":
 *    "AnimationSet", "directions": [{"__id__": 30}, …]}`. Only the engine's
 *    value types (cc.Vec3, cc.Color, …) are serialized inline.
 *    `insert_array_element` already built elements that way; a plain property
 *    write did not, and inlined the object instead. `materializeTypedValue`
 *    is that hoisting, applied to any depth of a written value.
 *
 * The escape hatch for rule 1 is `{"$plain": {...}}`: a field that really is
 * an untyped dictionary (rare — Cocos only reconstructs typed values) is
 * marked by the caller and written verbatim. The mark is a WeakSet brand, so
 * it cannot be forged by file content or survive a round-trip through JSON.
 *
 * SOLID: S - serialization shape of a written value; addressing/ops stay in
 * operations.js, document mechanics in SceneDocument.
 */

import { isRef } from './SceneDocument.js';
import { VALUE_TYPE_FIELDS } from '../core/valueTypes.js';
import { INTERNAL_STRUCT_TYPES } from '../core/componentIndices.js';
import { OperationError } from './operations.js';

/**
 * cc value-types serialized INLINE inside their owner (no {__id__}). Derived
 * from the shared registry so the write side can never accept a type the read
 * side does not render.
 */
export const INLINE_VALUE_TYPES = new Set(Object.keys(VALUE_TYPE_FIELDS));

/**
 * Types a property VALUE must never mint as a standalone object: nodes,
 * components' owners and the engine's own plumbing records. Each of them has
 * a dedicated op (add_node / instantiate_prefab / add_component) or is
 * document bookkeeping the ops maintain — a hand-written one would be an
 * unreachable object at best and a broken instance at worst.
 */
const UNWRITABLE_TYPES = new Set([
    'cc.Node', 'cc.Scene', 'cc.Prefab', 'cc.SceneAsset', ...INTERNAL_STRUCT_TYPES
]);

/** Objects the caller marked `{"$plain": {...}}` — written untyped, verbatim */
const PLAIN_VALUES = new WeakSet();

/** Brand `obj` as an explicitly untyped dictionary value. Returns `obj`. */
export function markPlainValue(obj) {
    if (obj !== null && typeof obj === 'object') PLAIN_VALUES.add(obj);
    return obj;
}

/**
 * Validate a `{"$plain": …}` wrapper and return the payload to brand. The
 * sentinel takes an OBJECT (an array or scalar never needed a type tag) and
 * nothing else beside it — a stray sibling key would be silently dropped,
 * since only the payload is written.
 */
export function plainPayload(wrapper, transformed) {
    const extra = Object.keys(wrapper).filter(k => k !== '$plain');
    if (extra.length > 0) {
        throw new OperationError(
            `"$plain" must be the only key of the value it marks (also got: ${extra.join(', ')}). ` +
            `Write {"$plain": {…}} with every field INSIDE it.`
        );
    }
    if (transformed === null || typeof transformed !== 'object' || Array.isArray(transformed)) {
        throw new OperationError(
            `"$plain" marks an untyped dictionary and expects an object, got ` +
            `${Array.isArray(transformed) ? 'an array' : JSON.stringify(transformed)}. ` +
            `Arrays and scalars need no type tag — pass them directly.`
        );
    }
    return transformed;
}

/**
 * `{"$plain": …}` written over a value the file DOES type: the mark exists for
 * a field whose type cannot be known, so on a typed one it would only strip the
 * tag — the very corruption this module refuses everywhere else.
 */
export function plainOverTypedError(what, type) {
    return new OperationError(
        `"${what}" holds a ${type} — {"$plain": …} marks an UNTYPED dictionary and would strip ` +
        `its type, so the engine could no longer rebuild it. Pass the fields to merge, or a ` +
        `full value ({"__type__": "${type}", …}).`
    );
}

/** True for a value the caller wrapped in `{"$plain": …}` */
export function isPlainValue(obj) {
    return obj !== null && typeof obj === 'object' && PLAIN_VALUES.has(obj);
}

/** A plain (non-ref, non-asset, non-array) object — the shape both rules judge */
function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) &&
        !isRef(value) && !Object.hasOwn(value, '__uuid__');
}

/**
 * Hoist every custom `@ccclass` object inside `value` into its own standalone
 * document object, replacing it with the `{__id__}` reference the engine
 * expects (rule 2 above). Depth-first, so a nested object becomes its own
 * entry before its owner does. Engine value types stay inline, references and
 * assets pass through untouched, and a `$plain` dictionary keeps its shape
 * (its CONTENTS are still hoisted — a typed object inside a dictionary is
 * serialized the same way).
 *
 * Allocation only: objects unreachable after a failed batch are dropped by
 * `renumber()` exactly like any other orphan.
 */
export function materializeTypedValue(doc, value, what) {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) {
        return value.map((v, i) => materializeTypedValue(doc, v, `${what}[${i}]`));
    }
    if (!isPlainObject(value)) return value; // {__id__} / {__uuid__}
    const plain = isPlainValue(value);
    const out = {};
    for (const [key, v] of Object.entries(value)) {
        out[key] = materializeTypedValue(doc, v, `${what}.${key}`);
    }
    if (plain) return markPlainValue(out);
    const type = out.__type__;
    if (typeof type !== 'string' || INLINE_VALUE_TYPES.has(type)) return out;
    if (UNWRITABLE_TYPES.has(type)) {
        throw new OperationError(
            `"${what}" has "__type__": "${type}" — that is a node/scene/plumbing object, not a ` +
            `property value. Reference an existing object instead ({"$node": "path"} / ` +
            `{"$component": {node, type}}), or use the op that creates one (add_node, ` +
            `instantiate_prefab, add_component).`
        );
    }
    return { __id__: doc.addObject(out) };
}

/**
 * `materializeTypedValue` over the FIELDS of `value`, leaving the root object
 * in place. Used where the root is not a value but a bag of fields merged into
 * an element the op constructs itself (insert_array_element).
 */
export function materializeTypedFields(doc, value, what) {
    if (!isPlainObject(value)) return materializeTypedValue(doc, value, what);
    const plain = isPlainValue(value);
    const out = {};
    for (const [key, v] of Object.entries(value)) {
        out[key] = materializeTypedValue(doc, v, `${what}.${key}`);
    }
    return plain ? markPlainValue(out) : out;
}

/**
 * Value types whose field set could hold exactly these keys — `{width, height}`
 * → cc.Size and cc.Rect. Used to name the likely spelling in the refusal; an
 * empty result just means the shape matches no engine value type (a custom
 * `@ccclass`, whose name only the caller knows).
 */
export function valueTypeCandidates(keys) {
    const wanted = keys.filter(k => k !== '__type__');
    if (wanted.length === 0) return [];
    return Object.entries(VALUE_TYPE_FIELDS)
        .filter(([, fields]) => wanted.every(k => fields.includes(k)))
        .map(([type]) => type);
}

/**
 * True when a plain object written over `existing` carries no type and none
 * can be read from the file — the silent-default case of rule 1.
 */
export function isUntypedObjectWrite(existing, given) {
    if (!isPlainObject(given) || Object.hasOwn(given, '__type__') || isPlainValue(given)) return false;
    // A typed value to merge into, or a plain dictionary already in the file,
    // both ANSWER the question "what is this field?" — only nothing does.
    return existing === null || existing === undefined || isRef(existing);
}

/**
 * True when a NON-object (array or scalar) is written over an inline typed
 * value — `_contentSize: [184, 184]` over a cc.Size. The engine assigns it
 * verbatim to a typed field, so the component keeps its default exactly as an
 * untyped object would: the same silent corruption, a different spelling.
 * `null` is excluded — clearing a field is legal.
 */
export function isTypeClobberWrite(existing, given) {
    if (given === null || given === undefined) return false;
    if (existing === null || typeof existing !== 'object' || Array.isArray(existing)) return false;
    if (typeof existing.__type__ !== 'string' || !INLINE_VALUE_TYPES.has(existing.__type__)) return false;
    return Array.isArray(given) || typeof given !== 'object';
}

/** The refusal for `isTypeClobberWrite` */
export function typeClobberError(what, given, existing) {
    const fields = VALUE_TYPE_FIELDS[existing.__type__];
    return new OperationError(
        `"${what}" holds a ${existing.__type__} — writing ${JSON.stringify(given)} there replaces ` +
        `the typed value with ${Array.isArray(given) ? 'an array' : 'a scalar'} the engine cannot ` +
        `rebuild, and the component silently keeps its default. Pass the fields to merge ` +
        `({${fields.map(f => `"${f}": …`).join(', ')}}, any subset) or a full typed value ` +
        `({"__type__": "${existing.__type__}", …}); null clears the field.`
    );
}

/**
 * The refusal for rule 1: what the caller wrote, why the engine drops it, and
 * the two spellings that work.
 */
export function untypedValueError(what, given, existing, opts = {}) {
    const keys = Object.keys(given);
    const shown = keys.slice(0, 6).join(', ') + (keys.length > 6 ? ', …' : '');
    const candidates = valueTypeCandidates(keys);
    const suggestion = candidates.length > 0
        ? `e.g. {"__type__": "${candidates[0]}", …}` +
          (candidates.length > 1 ? ` (keys {${shown}} also fit ${candidates.slice(1).join(', ')})` : '')
        : `e.g. {"__type__": "cc.Vec3", …} for an engine value type, or the @ccclass name for a ` +
          `custom one ({"__type__": "AnimationSet", …}) — a custom class is hoisted into its own ` +
          `object with an {__id__} reference, exactly as the editor serializes it`;
    const where = isRef(existing)
        ? `"${what}" currently holds a reference to another object`
        : `"${what}" is ${existing === null ? 'null' : 'absent'} in the file`;
    return new OperationError(
        `"${what}" got an object {${shown}} with no "__type__", and the field's type cannot be ` +
        `read from the file (${where}). Cocos rebuilds a value from that tag — without one it ` +
        `deserializes as an untyped object and the component keeps its DEFAULT (Size(0, 0), ` +
        `Color(0, 0, 0, 255), an empty array) while the file still validates. Pass the type ` +
        `explicitly: ${suggestion}. ` +
        (isRef(existing)
            ? `To retarget the reference instead, pass {"$node": …} / {"$component": {…}}; to edit ` +
              `the referenced object's fields, use a dotted path ("${what}.<field>"). `
            : '') +
        `If the field really is an untyped dictionary, mark it: {"$plain": {…}}.` +
        (opts.instance
            ? ` (This value becomes a prefab-instance override — the source prefab ` +
              `${opts.sourcePrefab ?? ''} is where its declared type lives.)`
            : '')
    );
}
