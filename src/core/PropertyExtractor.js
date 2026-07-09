/**
 * PropertyExtractor - Extract meaningful properties from components
 *
 * SOLID: S - Only extracts properties
 * SOLID: O - Can be extended with custom extractors
 */

// Embedded value-type structs (Vec3/Color/…) → compact ordered arrays.
// The field order per type matches the editor/API constructors.
const VALUE_TYPE_FIELDS = {
    'cc.Vec2': ['x', 'y'],
    'cc.Vec3': ['x', 'y', 'z'],
    'cc.Vec4': ['x', 'y', 'z', 'w'],
    'cc.Quat': ['x', 'y', 'z', 'w'],
    'cc.Color': ['r', 'g', 'b', 'a'],
    'cc.Size': ['width', 'height'],
    'cc.Rect': ['x', 'y', 'width', 'height']
};

export class PropertyExtractor {
    #sceneParser;
    #detailed;
    #assetResolver;
    #refResolver;
    #targetOverridesBySource; // lazy: component idx → [{key, targetId}]
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
        // Value-type structs (Vec3/Color/…) are appended AFTER scalar/ref
        // props so they never displace a previously-visible field under the
        // text formatter's prop cap — keeping text output additive for
        // main-branch clients (JSON is uncapped and shows everything).
        const deferred = [];

        for (const [key, value] of Object.entries(component)) {
            if (this.#shouldSkip(key, value)) continue;

            const extracted = this.#extractValue(value);
            if (extracted === undefined) continue;

            if (this.#isValueType(value)) {
                deferred.push([key, extracted]);
            } else {
                props[key] = extracted;
            }
        }
        for (const [key, extracted] of deferred) {
            props[key] = extracted;
        }

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

        // Component without _name — try parent node
        if (refObj.node?.__id__ !== undefined) {
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

    /** True for an embedded value-type struct (cc.Vec3, cc.Color, …) */
    #isValueType(value) {
        return typeof value === 'object' && value !== null &&
            VALUE_TYPE_FIELDS[value.__type__] !== undefined;
    }

    #extractValue(value) {
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
            return this.#resolveRef(value.__id__) || undefined;
        }

        // Array of references (may contain nulls anywhere, including the head)
        if (Array.isArray(value) && value.length > 0) {
            const firstRef = value.find(v => v != null);
            if (firstRef?.__id__ !== undefined) {
                if (this.#detailed) {
                    return value.map(ref => {
                        if (ref == null) return '→null';
                        return this.#resolveRef(ref.__id__) || '→?';
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
