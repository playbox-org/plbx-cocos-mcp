/**
 * PropertyExtractor - Extract meaningful properties from components
 *
 * SOLID: S - Only extracts properties
 * SOLID: O - Can be extended with custom extractors
 */

export class PropertyExtractor {
    #sceneParser;
    #skipKeys = new Set([
        '__type__', '__idx__', 'node', '_enabled', '_name',
        '_objFlags', '__editorExtras__', '__prefab'
    ]);

    constructor(sceneParser) {
        this.#sceneParser = sceneParser;
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

    #extractValue(key, value) {
        // Asset reference
        if (typeof value === 'object' && '__uuid__' in value) {
            return '<asset>';
        }

        // Node/component reference
        if (typeof value === 'object' && '__id__' in value) {
            const refObj = this.#sceneParser.getObject(value.__id__);
            if (refObj?._name) {
                return `→${refObj._name}`;
            }
            return undefined;
        }

        // Array of references
        if (Array.isArray(value) && value.length > 0) {
            if (value[0]?.__id__ !== undefined) {
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
