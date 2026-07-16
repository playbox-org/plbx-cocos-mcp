/**
 * PropertyExtractor - Extract meaningful properties from components
 *
 * SOLID: S - Only extracts properties
 * SOLID: O - Can be extended with custom extractors
 */

// Embedded value-type structs (Vec3/Color/…) → compact ordered arrays.
// Shared registry with the write side (operations.js) — see valueTypes.js.
import { VALUE_TYPE_FIELDS } from './valueTypes.js';
import { collectComponentIndices } from './componentIndices.js';

// Internal serialization types that look like data structs (no `node` back-ref)
// but must never be recursed into — they belong to the instance/prefab plumbing,
// not to user @property data.
const INTERNAL_STRUCT_TYPES = new Set([
    'cc.PrefabInfo', 'cc.PrefabInstance', 'cc.CompPrefabInfo',
    'cc.TargetInfo', 'cc.TargetOverrideInfo',
    'CCPropertyOverrideInfo', 'cc.MountedComponentsInfo', 'cc.MountedChildrenInfo'
]);

// Guard against deep/cyclic data-struct graphs when expanding nested CCClasses.
const MAX_STRUCT_DEPTH = 5;

export class PropertyExtractor {
    #sceneParser;
    #detailed;
    #assetResolver;
    #refResolver;
    #targetOverridesBySource; // lazy: component idx → [{key, targetId}]
    #componentIdxSet; // lazy: indices referenced from _components / mounted records
    #skipKeys = new Set([
        '__type__', '__idx__', 'node', '_enabled', '_name',
        '_objFlags', '__editorExtras__', '__prefab', '_string'
    ]);

    constructor(sceneParser, options = {}) {
        this.#sceneParser = sceneParser;
        this.#detailed = options.detailed || false;
        this.#assetResolver = options.assetResolver || null;
        // Optional (id) => string label for {__id__} refs — lets callers
        // render full node/component addresses instead of bare names
        this.#refResolver = options.refResolver || null;
    }

    /**
     * Extract meaningful properties from a component
     * @param {object} component
     * @returns {object|undefined}
     */
    extract(component) {
        const props = {};
        // Two deferral tiers, both appended AFTER scalar/ref props so they never
        // displace a previously-visible field under the text formatter's prop
        // cap (keeping text output additive for main-branch clients; JSON is
        // uncapped and shows everything):
        //   1. value-type structs (Vec3/Color/…) — these were ALSO deferred on
        //      main, so they must keep their exact relative position;
        //   2. newly-surfaced complex forms (expanded structs, Vec2[] arrays) —
        //      invisible on main, so they go strictly LAST. Interleaving them
        //      with tier 1 in key order would push a value-type scalar that was
        //      visible on main past the cap (review #4).
        const deferredValueTypes = [];
        const deferredNew = [];

        for (const [key, value] of Object.entries(component)) {
            if (this.#shouldSkip(key, value)) continue;

            const extracted = this.#extractValue(value);
            if (extracted === undefined) continue;

            // Ref-arrays are exempt from deferral: they rendered inline on
            // main ('→Foo'/'→?' strings, or the '[×N]' summary), so pushing
            // them behind the text prop cap would HIDE a previously-visible
            // field — breaking the additive-only contract (review #5).
            if (this.#isValueType(value)) {
                deferredValueTypes.push([key, extracted]);
            } else if (this.#isComplex(extracted) && !this.#isRefArray(value)) {
                deferredNew.push([key, extracted]);
            } else {
                props[key] = extracted;
            }
        }
        for (const [key, extracted] of deferredValueTypes) props[key] = extracted;
        for (const [key, extracted] of deferredNew) props[key] = extracted;

        // Properties overridden by cc.TargetOverrideInfo serialize as null
        // (or are omitted) — surface the real target as a sibling
        // "<prop>__targetOverride" entry so the reference is visible.
        for (const o of this.#overridesFor(component.__idx__)) {
            const name = o.targetId !== undefined ? this.#resolveRefName(o.targetId) : null;
            const suffix = this.#detailed && o.targetId !== undefined ? `#${o.targetId}` : '';
            props[`${o.key}__targetOverride`] = `→${name ?? '(instance)'}${suffix}`;
        }

        return Object.keys(props).length > 0 ? props : undefined;
    }

    /**
     * targetOverrides whose source is a plain component of this file
     * (sourceInfo null), grouped by component index. Built lazily on the
     * first extract() call.
     */
    #overridesFor(componentIdx) {
        if (this.#targetOverridesBySource === undefined) {
            const map = new Map();
            const objects = Array.isArray(this.#sceneParser.objects) ? this.#sceneParser.objects : [];
            for (const obj of objects) {
                if (obj?.__type__ !== 'cc.TargetOverrideInfo') continue;
                if (obj.sourceInfo !== null) continue; // source lives inside an instance
                const src = obj.source?.__id__;
                if (src === undefined || !Array.isArray(obj.propertyPath)) continue;
                const list = map.get(src) ?? [];
                list.push({ key: obj.propertyPath.join('.'), targetId: obj.target?.__id__ });
                map.set(src, list);
            }
            this.#targetOverridesBySource = map;
        }
        return componentIdx !== undefined
            ? (this.#targetOverridesBySource.get(componentIdx) ?? [])
            : [];
    }

    #shouldSkip(key, value) {
        if (this.#skipKeys.has(key)) return true;
        if (key.startsWith('__')) return true;
        if (value === null || value === undefined) return true;
        return false;
    }

    #resolveRef(id) {
        const custom = this.#refResolver?.(id);
        if (custom) return `→${custom}`;

        const refObj = this.#sceneParser.getObject(id);
        if (!refObj) return null;

        const suffix = this.#detailed ? `#${id}` : '';

        // Direct name on the object (nodes)
        if (refObj._name) return `→${refObj._name}${suffix}`;

        // Prefab node without _name — resolve from property overrides
        if (refObj.__type__ === 'cc.Node' && refObj._prefab) {
            const name = this.#resolvePrefabName(refObj);
            if (name) return `→${name}${suffix}`;
        }

        // cc.ClickEvent — show target.handler
        if (refObj.__type__ === 'cc.ClickEvent' && refObj.handler) {
            const targetName = refObj.target?.__id__ !== undefined
                ? this.#resolveRefName(refObj.target.__id__)
                : null;
            const label = targetName
                ? `${targetName}.${refObj.handler}`
                : refObj.handler;
            return `→${label}${suffix}`;
        }

        // Component without _name — name it after its owning node. This
        // back-ref heuristic must fire ONLY for an actual component (membership
        // in some node's _components), never for a user data struct that merely
        // declares a `node: cc.Node` @property — otherwise the struct resolves
        // to "→<NodeName>" and its field expansion (#isDataStruct/#extractStruct)
        // never runs, the very case the PR set out to fix (review #3). `node`
        // is a very common field name, so the check is by membership, not shape.
        if (refObj.node?.__id__ !== undefined && this.#isComponentIdx(id)) {
            const parentNode = this.#sceneParser.getObject(refObj.node.__id__);
            if (parentNode?._name) return `→${parentNode._name}${suffix}`;
        }

        // Fallback: object with target (like ClickEvent variants)
        if (refObj.target?.__id__ !== undefined) {
            const targetNode = this.#sceneParser.getObject(refObj.target.__id__);
            if (targetNode?._name) return `→${targetNode._name}${suffix}`;
        }

        return null;
    }

    /** Resolve just the name part (no arrow/suffix), used for composing labels */
    #resolveRefName(id) {
        const obj = this.#sceneParser.getObject(id);
        if (!obj) return null;
        if (obj._name) return obj._name;
        if (obj.__type__ === 'cc.Node' && obj._prefab) {
            return this.#resolvePrefabName(obj);
        }
        return null;
    }

    /** Asset name/label by uuid via the injected resolver, '<asset>' when unresolvable */
    #assetLabel(uuid) {
        return (typeof uuid === 'string' ? this.#assetResolver?.(uuid) : null) ?? '<asset>';
    }

    /** Traverse prefab override chain to find _name */
    #resolvePrefabName(node) {
        const prefabInfo = this.#sceneParser.getObject(node._prefab?.__id__);
        if (!prefabInfo?.instance?.__id__) return null;

        const instance = this.#sceneParser.getObject(prefabInfo.instance.__id__);
        if (!instance?.propertyOverrides) return null;

        for (const ovRef of instance.propertyOverrides) {
            const ov = this.#sceneParser.getObject(ovRef.__id__);
            if (ov?.propertyPath?.[0] === '_name' && typeof ov.value === 'string') {
                return ov.value;
            }
        }
        return null;
    }

    /**
     * True when an EXTRACTED value is "complex": an expanded data struct (object)
     * or an array containing objects/arrays (array of structs, or value-type
     * arrays like Vec2[]). Such values are deferred to the tail of the prop list
     * so they never push a previously-visible scalar past the text prop cap.
     * Arrays of ref-name strings (["→Foo",…]) are NOT complex — they stay inline
     * exactly as before.
     */
    #isComplex(extracted) {
        if (extracted === null || typeof extracted !== 'object') return false;
        if (Array.isArray(extracted)) {
            return extracted.some(v => v !== null && typeof v === 'object');
        }
        return true; // expanded struct object
    }

    /** True for a RAW array of {__id__} references (visible inline on main) */
    #isRefArray(value) {
        if (!Array.isArray(value)) return false;
        const first = value.find(v => v != null);
        return typeof first === 'object' && first !== null && '__id__' in first;
    }

    /**
     * True when the object at `idx` is a component: membership in some node's
     * _components (or a MountedComponentsInfo.components) — NOT the `node`
     * back-ref heuristic, which false-positives on a user data struct that
     * declares `@property node: cc.Node` (review #4). Built lazily over the
     * flat objects array, so it works for both SceneParser and SceneDocument.
     */
    #isComponentIdx(idx) {
        if (this.#componentIdxSet === undefined) {
            this.#componentIdxSet = collectComponentIndices(
                this.#sceneParser.objects,
                (o) => o.__type__ === 'cc.Node' || o.__type__ === 'cc.Scene'
            );
        }
        return this.#componentIdxSet.has(idx);
    }

    /** True for an embedded value-type struct (cc.Vec3, cc.Color, …) */
    #isValueType(value) {
        return typeof value === 'object' && value !== null &&
            VALUE_TYPE_FIELDS[value.__type__] !== undefined;
    }

    /**
     * True for a plain data CCClass object worth expanding: not a node/scene,
     * not a value-type, not internal plumbing, and NOT a component. Component
     * detection is by MEMBERSHIP (referenced from a node's _components /
     * mounted records), not by the `node` back-ref — a user data struct with
     * a `node: cc.Node` @property must still expand (review #4). These are
     * @property structs (CardEntry, CardConfig, cc.CurveRange, …) stored as
     * their own objects in the flat array and referenced by {__id__}.
     */
    #isDataStruct(obj, idx) {
        if (!obj || typeof obj !== 'object') return false;
        const type = obj.__type__;
        if (!type) return false;
        if (type === 'cc.Node' || type === 'cc.Scene') return false;
        if (VALUE_TYPE_FIELDS[type]) return false;
        if (INTERNAL_STRUCT_TYPES.has(type)) return false;
        if (this.#isComponentIdx(idx)) return false;
        return true;
    }

    /**
     * Recursively extract a nested data-CCClass object into a plain object,
     * tagged with __struct__ so the reader knows the concrete class. Detailed
     * mode only (callers gate on this.#detailed). Depth-capped and cycle-guarded.
     */
    #extractStruct(obj, depth, seen) {
        if (depth >= MAX_STRUCT_DEPTH) return `<${obj.__type__}>`;
        const idx = obj.__idx__;
        const visited = seen ?? new Set();
        if (idx !== undefined && visited.has(idx)) return `<cycle ${obj.__type__}>`;
        const nextSeen = new Set(visited);
        if (idx !== undefined) nextSeen.add(idx);

        const out = { __struct__: obj.__type__ };
        const deferred = [];
        for (const [key, value] of Object.entries(obj)) {
            if (this.#shouldSkip(key, value)) continue;
            const extracted = this.#extractValue(value, depth + 1, nextSeen);
            if (extracted === undefined) continue;
            if (this.#isValueType(value)) {
                deferred.push([key, extracted]);
            } else {
                out[key] = extracted;
            }
        }
        for (const [key, extracted] of deferred) out[key] = extracted;
        return out;
    }

    #extractValue(value, depth = 0, seen = null) {
        // Embedded value-type struct (cc.Vec3, cc.Size, cc.Color, …) →
        // compact rounded array in canonical field order
        if (this.#isValueType(value)) {
            return VALUE_TYPE_FIELDS[value.__type__].map(k =>
                typeof value[k] === 'number' ? Math.round(value[k] * 100) / 100 : 0);
        }

        // Asset reference
        if (typeof value === 'object' && '__uuid__' in value) {
            return this.#assetLabel(value.__uuid__);
        }

        // Node/component reference
        if (typeof value === 'object' && '__id__' in value) {
            const named = this.#resolveRef(value.__id__);
            if (named) return named;
            // Unnamed ref: expand nested data CCClass structs (detailed only)
            if (this.#detailed) {
                const target = this.#sceneParser.getObject(value.__id__);
                if (this.#isDataStruct(target, value.__id__)) {
                    return this.#extractStruct(target, depth, seen);
                }
            }
            return undefined;
        }

        // Array of embedded value-type structs (offsets: Vec2[], colors, …).
        // Additive: previously dropped entirely. Kept in both modes (compact).
        if (Array.isArray(value) && value.length > 0 && this.#isValueType(value.find(v => v != null))) {
            return value.map(v => v == null ? null : this.#extractValue(v, depth + 1, seen));
        }

        // Array of references (may contain nulls anywhere, including the head)
        if (Array.isArray(value) && value.length > 0) {
            const firstRef = value.find(v => v != null);
            if (firstRef?.__id__ !== undefined) {
                if (this.#detailed) {
                    return value.map(ref => {
                        if (ref == null) return '→null';
                        const named = this.#resolveRef(ref.__id__);
                        if (named) return named;
                        // Unnamed ref → nested data-struct expansion
                        const target = this.#sceneParser.getObject(ref.__id__);
                        if (this.#isDataStruct(target, ref.__id__)) {
                            return this.#extractStruct(target, depth, seen);
                        }
                        return '→?';
                    });
                }
                const nullCount = value.filter(r => r == null).length;
                if (nullCount > 0) {
                    return `[×${value.length - nullCount}, null×${nullCount}]`;
                }
                return `[×${value.length}]`;
            }
            if (firstRef?.__uuid__ !== undefined) {
                if (this.#detailed) {
                    return value.map(ref =>
                        ref == null ? 'null' : this.#assetLabel(ref.__uuid__));
                }
                const nullCount = value.filter(r => r == null).length;
                if (nullCount > 0) {
                    return `[×${value.length - nullCount}, null×${nullCount}]`;
                }
                return `[×${value.length}]`;
            }
            if (typeof value[0] !== 'object' && value.length <= 5) {
                return value;
            }
            return undefined;
        }

        // Primitives
        if (typeof value === 'number') {
            return Math.round(value * 100) / 100;
        }

        if (typeof value === 'string' && value.length > 0) {
            return value.length > 30 ? value.slice(0, 30) + '...' : value;
        }

        if (typeof value === 'boolean') {
            return value;
        }

        return undefined;
    }
}
