/**
 * PropertyExtractor - Extract meaningful properties from components
 *
 * SOLID: S - Only extracts properties
 * SOLID: O - Can be extended with custom extractors
 */

export class PropertyExtractor {
    #sceneParser;
    #detailed;
    #skipKeys = new Set([
        '__type__', '__idx__', 'node', '_enabled', '_name',
        '_objFlags', '__editorExtras__', '__prefab', '_string'
    ]);

    constructor(sceneParser, options = {}) {
        this.#sceneParser = sceneParser;
        this.#detailed = options.detailed || false;
    }

    /**
     * Extract meaningful properties from a component
     * @param {object} component
     * @returns {object|undefined}
     */
    extract(component) {
        const props = {};

        for (const [key, value] of Object.entries(component)) {
            if (this.#shouldSkip(key, value)) continue;

            const extracted = this.#extractValue(key, value);
            if (extracted !== undefined) {
                props[key] = extracted;
            }
        }

        return Object.keys(props).length > 0 ? props : undefined;
    }

    #shouldSkip(key, value) {
        if (this.#skipKeys.has(key)) return true;
        if (key.startsWith('__')) return true;
        if (value === null || value === undefined) return true;
        return false;
    }

    #resolveRef(id) {
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

    #extractValue(key, value) {
        // Asset reference
        if (typeof value === 'object' && '__uuid__' in value) {
            return '<asset>';
        }

        // Node/component reference
        if (typeof value === 'object' && '__id__' in value) {
            return this.#resolveRef(value.__id__) || undefined;
        }

        // Array of references
        if (Array.isArray(value) && value.length > 0) {
            if (value[0]?.__id__ !== undefined) {
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
