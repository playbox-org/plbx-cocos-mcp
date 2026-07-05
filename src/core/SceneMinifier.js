/**
 * SceneMinifier - Orchestrator for scene minification
 *
 * SOLID: S - Orchestrates components, doesn't implement logic
 * SOLID: D - Depends on abstractions, uses dependency injection
 */

import * as fs from 'fs';
import * as path from 'path';
import { SceneParser } from './SceneParser.js';
import { ScriptResolver } from './ScriptResolver.js';
import { AssetIndex } from './AssetIndex.js';
import { NodeTreeBuilder } from './NodeTreeBuilder.js';
import { TypeFilter } from '../filters/TypeFilter.js';
import { NodeFilter } from '../filters/NodeFilter.js';
import { TextFormatter } from '../formatters/TextFormatter.js';
import { JsonFormatter } from '../formatters/JsonFormatter.js';
import { StatsFormatter } from '../formatters/StatsFormatter.js';

export class SceneMinifier {
    #sceneParser;
    #scriptResolver;
    #typeFilter;
    #nodeFilter;
    #treeBuilder;
    #projectRoot;
    #assetIndex; // lazy: only built when a prefab-instance stub needs its asset name

    /**
     * Create a new SceneMinifier
     * @param {string} scenePath - Path to scene file
     * @param {string} projectRoot - Path to Cocos project root
     * @param {object} [options] - Optional configuration
     */
    constructor(scenePath, projectRoot, options = {}) {
        // Create dependencies
        this.#projectRoot = projectRoot;
        this.#sceneParser = new SceneParser(scenePath);
        this.#scriptResolver = new ScriptResolver(projectRoot);
        this.#typeFilter = options.typeFilter || new TypeFilter();
        this.#nodeFilter = options.nodeFilter || new NodeFilter();

        // Configure filters
        if (options.nodeFilterConfig) {
            this.#nodeFilter.configure(options.nodeFilterConfig);
        }

        // Create tree builder with dependencies
        this.#treeBuilder = new NodeTreeBuilder(
            this.#sceneParser,
            this.#scriptResolver,
            this.#typeFilter,
            this.#nodeFilter,
            { detailed: options.detailed, assetNameResolver: (uuid) => this.#assetName(uuid) }
        );
    }

    #getAssetIndex() {
        if (this.#assetIndex === undefined) {
            try {
                this.#assetIndex = new AssetIndex(this.#projectRoot);
            } catch {
                this.#assetIndex = null;
            }
        }
        return this.#assetIndex;
    }

    /** Asset file name ("Gold.prefab") by UUID, or null */
    #assetName(uuid) {
        return this.#getAssetIndex()?.resolve(uuid)?.entry.name ?? null;
    }

    /**
     * Name as the editor shows it: _name, or for collapsed prefab instances
     * the _name override / source asset name.
     */
    #displayName(node) {
        if (node._name) return node._name;
        const info = this.#sceneParser.getInstanceInfo(node);
        if (!info) return node._name;
        return info.nameOverride
            ?? (info.assetUuid
                ? this.#assetName(info.assetUuid)?.replace(/\.[^.]+$/, '') ?? null
                : null);
    }

    /**
     * Build minified scene graph
     * @returns {object|null}
     */
    minify() {
        return this.#treeBuilder.build();
    }

    /**
     * Format as text
     * @param {object} [graph] - Optional pre-built graph
     * @returns {string}
     */
    toText(graph = null) {
        const g = graph || this.minify();
        if (!g) return 'Error: Could not parse scene';

        const formatter = new TextFormatter();
        return formatter.format(g);
    }

    /**
     * Format as JSON
     * @param {object} [graph] - Optional pre-built graph
     * @param {boolean} [pretty=true] - Pretty print
     * @returns {string}
     */
    toJson(graph = null, pretty = true) {
        const g = graph || this.minify();
        if (!g) return '{"error": "Could not parse scene"}';

        const formatter = new JsonFormatter().configure({ pretty });
        return formatter.format(g);
    }

    /**
     * Get scene statistics
     * @returns {object}
     */
    getStats() {
        const stats = {
            nodeCount: this.#sceneParser.nodes.size,
            scripts: new Set(),
            builtins: new Map()
        };

        for (const obj of this.#sceneParser.objects) {
            const type = obj.__type__;

            // Only real components carry a back-reference to their node;
            // skip helper objects (cc.PrefabInfo, cc.SceneGlobals, ...)
            if (obj.node?.__id__ === undefined) continue;
            if (this.#typeFilter.isNoise(type)) continue;

            if (this.#typeFilter.isCustomScript(type)) {
                stats.scripts.add(this.#scriptResolver.resolve(type));
            } else if (type.startsWith('cc.')) {
                stats.builtins.set(type, (stats.builtins.get(type) || 0) + 1);
            }
        }

        return stats;
    }

    /**
     * Format statistics as text
     * @returns {string}
     */
    formatStats() {
        const formatter = new StatsFormatter();
        return formatter.format(this.getStats());
    }

    /**
     * Get list of scripts used in scene
     * @returns {string[]}
     */
    getScripts() {
        return Array.from(this.getStats().scripts).sort();
    }

    /**
     * Find nodes by name pattern
     * @param {string} pattern - Regex pattern
     * @returns {object[]}
     */
    findNodes(pattern) {
        const regex = new RegExp(pattern, 'i');
        const matches = [];

        for (const [_, node] of this.#sceneParser.nodes) {
            const name = this.#displayName(node);
            if (name && regex.test(name)) {
                matches.push({
                    name,
                    active: node._active !== false,
                    components: this.#getComponentTypes(node)
                });
            }
        }

        return matches;
    }

    /**
     * Build full subtree for a specific node (no depth filtering)
     * @param {number} nodeId - Node index in scene array
     * @returns {object|null}
     */
    inspectNode(nodeId) {
        const noLimitFilter = new NodeFilter().configure({
            maxDepth: 999, boneMaxDepth: 999, filterNestedBones: false
        });
        const builder = new NodeTreeBuilder(
            this.#sceneParser,
            this.#scriptResolver,
            this.#typeFilter,
            noLimitFilter,
            { detailed: true, assetNameResolver: (uuid) => this.#assetName(uuid) }
        );
        return builder.buildFrom(nodeId);
    }

    /**
     * Find nodes by name, returning id and parent path for disambiguation
     * @param {string} name - Exact node name
     * @returns {{id: number, name: string, path: string}[]}
     */
    resolveNodeId(name) {
        const matches = [];

        for (const [id, node] of this.#sceneParser.nodes) {
            if (this.#displayName(node) === name) {
                matches.push({
                    id,
                    name,
                    path: this.#getNodePath(node)
                });
            }
        }

        return matches;
    }

    /**
     * Best-effort check whether `name` is a node inside a collapsed
     * prefab-instance source — those nodes are not addressable, and a failed
     * lookup should say so instead of a bare "not found".
     * @param {string} name - Exact node name
     * @returns {{instance: string, source: string}[]} Instances whose source contains it
     */
    findInInstanceSources(name) {
        const hits = [];
        const sourceHasNode = new Map(); // assetUuid → boolean

        for (const [, node] of this.#sceneParser.nodes) {
            const info = this.#sceneParser.getInstanceInfo(node);
            if (!info?.assetUuid) continue;

            if (!sourceHasNode.has(info.assetUuid)) {
                sourceHasNode.set(info.assetUuid, this.#sourceContainsNode(info.assetUuid, name));
            }
            if (sourceHasNode.get(info.assetUuid)) {
                hits.push({
                    instance: this.#displayName(node) ?? '(instance)',
                    source: this.#assetName(info.assetUuid) ?? info.assetUuid
                });
            }
        }

        return hits;
    }

    /** Read an instance's source prefab (.prefab asset or library/ model cache) and scan node names */
    #sourceContainsNode(assetUuid, name) {
        try {
            const resolved = this.#getAssetIndex()?.resolve(assetUuid);
            if (!resolved) return false;
            const file = resolved.subAsset
                ? path.join(this.#projectRoot, 'library', assetUuid.slice(0, 2), `${assetUuid}.json`)
                : path.join(this.#projectRoot, resolved.entry.path);
            const objects = JSON.parse(fs.readFileSync(file, 'utf-8'));
            return Array.isArray(objects) &&
                   objects.some(o => o?.__type__ === 'cc.Node' && o._name === name);
        } catch {
            return false;
        }
    }

    #getNodePath(node) {
        const parts = [];
        let current = node;
        while (current?._parent?.__id__ !== undefined) {
            current = this.#sceneParser.getObject(current._parent.__id__);
            if (current?._name) parts.unshift(current._name);
        }
        return parts.join('/');
    }

    #getComponentTypes(node) {
        if (!node._components) return [];

        return node._components
            .map(ref => {
                const comp = this.#sceneParser.getObject(ref.__id__);
                return comp ? this.#scriptResolver.resolve(comp.__type__) : null;
            })
            .filter(Boolean);
    }
}
