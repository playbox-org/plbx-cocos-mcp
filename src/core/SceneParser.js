/**
 * SceneParser - Single Responsibility: Parse scene JSON into indexed objects
 *
 * SOLID: S - Only responsible for parsing and indexing scene data
 */

import * as fs from 'fs';
import { VALUE_TYPES } from '../filters/TypeFilter.js';

export class SceneParser {
    #objects = [];
    #nodesById = new Map();
    #componentsById = new Map();

    /**
     * @param {string} scenePath - Path to .scene file
     */
    constructor(scenePath) {
        const content = fs.readFileSync(scenePath, 'utf-8');
        this.#objects = JSON.parse(content);
        if (!Array.isArray(this.#objects)) {
            throw new Error('Not a Cocos scene/prefab: expected a JSON array');
        }
        this.#indexObjects();
    }

    #indexObjects() {
        this.#objects.forEach((obj, idx) => {
            obj.__idx__ = idx;

            const type = obj.__type__;
            if (type === 'cc.Node' || type === 'cc.Scene') {
                this.#nodesById.set(idx, obj);
            } else if (!this.#isValueType(type)) {
                this.#componentsById.set(idx, obj);
            }
        });
    }

    #isValueType(type) {
        // Value types are inlined and don't need separate tracking
        return VALUE_TYPES.has(type);
    }

    get objects() {
        return this.#objects;
    }

    get nodes() {
        return this.#nodesById;
    }

    get components() {
        return this.#componentsById;
    }

    getObject(id) {
        return this.#objects[id];
    }

    getNode(id) {
        return this.#nodesById.get(id);
    }

    findSceneRoot() {
        const scene = this.#objects.find(obj => obj.__type__ === 'cc.Scene');
        if (scene) return scene;

        // Prefab files: cc.Prefab.data points to root cc.Node
        const prefab = this.#objects.find(obj => obj.__type__ === 'cc.Prefab');
        if (prefab?.data?.__id__ !== undefined) {
            return this.getObject(prefab.data.__id__);
        }
        return null;
    }
}
