/**
 * NodeTreeBuilder - Build minified node tree from scene
 *
 * SOLID: S - Only builds the tree structure
 * SOLID: D - Depends on abstractions (filters, resolver)
 */

import { PropertyExtractor } from './PropertyExtractor.js';
import { quatToEulerYZX } from '../utils/math3d.js';

/** Below these a transform component counts as its default and is not rendered */
const POS_EPS = 0.1;
const SCALE_EPS = 0.001;
const EULER_EPS = 0.05;

export class NodeTreeBuilder {
    #sceneParser;
    #scriptResolver;
    #typeFilter;
    #nodeFilter;
    #propExtractor;
    #detailed;
    #assetNameResolver;
    #transforms;

    /**
     * @param {SceneParser} sceneParser
     * @param {ScriptResolver} scriptResolver
     * @param {TypeFilter} typeFilter
     * @param {NodeFilter} nodeFilter
     * @param {object} [options]
     */
    constructor(sceneParser, scriptResolver, typeFilter, nodeFilter, options = {}) {
        this.#sceneParser = sceneParser;
        this.#scriptResolver = scriptResolver;
        this.#typeFilter = typeFilter;
        this.#nodeFilter = nodeFilter;
        this.#detailed = options.detailed || false;
        this.#assetNameResolver = options.assetNameResolver || null;
        // 'shallow': only near the top of the tree (token budget); 'all': every depth
        this.#transforms = options.transforms === 'all' ? 'all' : 'shallow';
        this.#propExtractor = new PropertyExtractor(sceneParser, {
            detailed: this.#detailed,
            // Richer labels for property values ("file@subId (embedded)");
            // #assetNameResolver stays plain-name for prefabSource display
            assetResolver: options.assetRefResolver || null
        });
    }

    /**
     * Build the minified tree starting from scene root
     * @returns {object|null}
     */
    build() {
        const sceneRoot = this.#sceneParser.findSceneRoot();
        if (!sceneRoot) return null;

        return this.#buildNode(sceneRoot.__idx__, 0, false);
    }

    /**
     * Build subtree starting from a specific node
     * @param {number} nodeId - Node index in scene array
     * @returns {object|null}
     */
    buildFrom(nodeId) {
        return this.#buildNode(nodeId, 0, false);
    }

    #buildNode(nodeId, depth, parentIsBone) {
        const node = this.#sceneParser.getNode(nodeId);
        if (!node) return null;

        // Check filters
        if (this.#nodeFilter.shouldFilter(node, depth, parentIsBone)) {
            return null;
        }

        const isBone = this.#nodeFilter.isBone(node._name);
        const components = this.#extractComponents(node);
        const { children, trimmedCount, trimmedMaxDepth } = this.#buildChildren(node, depth, isBone || parentIsBone);

        // Skip empty intermediate nodes (but report them as trimmed to parent).
        // Instance stubs are always empty in the file — never trim them.
        if (children.length === 0 && components.length === 0 && depth > 3 &&
            !this.#sceneParser.getInstanceInfo(node)) {
            return null;
        }

        return this.#createMinifiedNode(node, components, children, depth, trimmedCount, trimmedMaxDepth);
    }

    #buildChildren(node, depth, parentIsBone) {
        const children = [];
        let trimmedCount = 0;
        let trimmedMaxDepth = 0;

        if (node._children) {
            for (const childRef of node._children) {
                const child = this.#buildNode(childRef.__id__, depth + 1, parentIsBone);
                if (child) {
                    children.push(child);
                } else {
                    // Count filtered subtree size
                    const stats = this.#countDescendants(childRef.__id__);
                    trimmedCount += stats.count;
                    trimmedMaxDepth = Math.max(trimmedMaxDepth, stats.depth);
                }
            }
        }

        return { children, trimmedCount, trimmedMaxDepth };
    }

    #countDescendants(nodeId) {
        const node = this.#sceneParser.getNode(nodeId);
        if (!node) return { count: 0, depth: 0 };

        let count = 1;
        let maxChildDepth = 0;

        if (node._children) {
            for (const childRef of node._children) {
                const stats = this.#countDescendants(childRef.__id__);
                count += stats.count;
                maxChildDepth = Math.max(maxChildDepth, stats.depth);
            }
        }

        return { count, depth: maxChildDepth + 1 };
    }

    #extractComponents(node) {
        const components = [];

        if (!node._components) return components;

        for (const ref of node._components) {
            const comp = this.#sceneParser.getObject(ref.__id__);
            if (!comp || this.#typeFilter.isNoise(comp.__type__)) continue;

            const minComp = this.#createMinifiedComponent(comp);
            if (minComp) components.push(minComp);
        }

        return components;
    }

    #createMinifiedComponent(comp) {
        const typeName = this.#scriptResolver.resolve(comp.__type__);

        const minComp = {
            type: typeName,
            enabled: comp._enabled !== false
        };

        // Extract text for labels
        if (comp.__type__ === 'cc.Label' && comp._string) {
            minComp.text = comp._string.slice(0, 30);
        }

        // Extract properties for custom scripts (always) and built-in cc.* (when detailed)
        if (this.#typeFilter.isCustomScript(comp.__type__) ||
            (this.#detailed && comp.__type__.startsWith('cc.'))) {
            const props = this.#propExtractor.extract(comp);
            if (props) minComp.props = props;
        }

        return minComp;
    }

    #createMinifiedNode(node, components, children, depth, trimmedCount = 0, trimmedMaxDepth = 0) {
        const instance = node._prefab ? this.#sceneParser.getInstanceInfo(node) : null;
        let name = node._name;
        let prefabSource = null;

        if (instance) {
            prefabSource = instance.assetUuid
                ? (this.#assetNameResolver?.(instance.assetUuid)
                    ?? `${instance.assetUuid.slice(0, 8)}…`)
                : null;
            // Editor shows the _name override, falling back to the asset name
            name = name || instance.nameOverride
                || (prefabSource ? prefabSource.replace(/\.[^.]+$/, '') : '');
        }

        const minNode = {
            name: name || 'unnamed',
            active: node._active !== false
        };

        // Position, scale and euler wherever they are non-default. A collapsed instance stub has
        // no transform fields of its own — its placement is a propertyOverride on the source root,
        // and reading the node would print every stub of a scene at its parent's origin.
        if (this.#transforms === 'all' || depth <= 2) {
            const ov = instance?.overrides ?? {};
            const p = ov._lpos ?? node._lpos;
            if (p && (Math.abs(p.x) > POS_EPS || Math.abs(p.y) > POS_EPS || Math.abs(p.z) > POS_EPS)) {
                minNode.pos = round(p, 10);
            }
            const s = ov._lscale ?? node._lscale;
            if (s && (Math.abs(s.x - 1) > SCALE_EPS || Math.abs(s.y - 1) > SCALE_EPS
                || Math.abs(s.z - 1) > SCALE_EPS)) {
                minNode.scale = round(s, 1000);
            }
            // Prefer `_lrot` (what the runtime reads) over a possibly stale `_euler`
            const rot = ov._lrot ?? node._lrot;
            const e = rot ? quatToEulerYZX(rot) : (ov._euler ?? node._euler);
            if (e && (Math.abs(e.x) > EULER_EPS || Math.abs(e.y) > EULER_EPS || Math.abs(e.z) > EULER_EPS)) {
                minNode.euler = round(e, 10);
            }
        }

        if (components.length > 0) minNode.components = components;
        if (children.length > 0) minNode.children = children;
        if (node._prefab) minNode.prefab = true;
        if (prefabSource) minNode.prefabSource = prefabSource;
        if (trimmedCount > 0) minNode.trimmed = { nodes: trimmedCount, depth: trimmedMaxDepth };

        return minNode;
    }
}

/** `{x, y, z}` → a rounded `[x, y, z]` triple (`scale` 10 = one decimal) */
function round(v, scale) {
    return [
        Math.round(v.x * scale) / scale,
        Math.round(v.y * scale) / scale,
        Math.round(v.z * scale) / scale
    ];
}
