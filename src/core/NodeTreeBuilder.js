/**
 * NodeTreeBuilder - Build minified node tree from scene
 *
 * SOLID: S - Only builds the tree structure
 * SOLID: D - Depends on abstractions (filters, resolver)
 */

import { PropertyExtractor } from './PropertyExtractor.js';

export class NodeTreeBuilder {
    #sceneParser;
    #scriptResolver;
    #typeFilter;
    #nodeFilter;
    #propExtractor;
    #detailed;

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
        this.#propExtractor = new PropertyExtractor(sceneParser, { detailed: this.#detailed });
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

        // Skip empty intermediate nodes (but report them as trimmed to parent)
        if (children.length === 0 && components.length === 0 && depth > 3) {
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
        const minNode = {
            name: node._name || 'unnamed',
            active: node._active !== false
        };

        // Add position for top-level nodes
        if (depth <= 2 && node._lpos) {
            const p = node._lpos;
            if (Math.abs(p.x) > 0.1 || Math.abs(p.y) > 0.1 || Math.abs(p.z) > 0.1) {
                minNode.pos = [
                    Math.round(p.x * 10) / 10,
                    Math.round(p.y * 10) / 10,
                    Math.round(p.z * 10) / 10
                ];
            }
        }

        if (components.length > 0) minNode.components = components;
        if (children.length > 0) minNode.children = children;
        if (node._prefab) minNode.prefab = true;
        if (trimmedCount > 0) minNode.trimmed = { nodes: trimmedCount, depth: trimmedMaxDepth };

        return minNode;
    }
}
