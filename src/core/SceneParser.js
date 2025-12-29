/**
 * SceneParser - Single Responsibility: Parse scene JSON into indexed objects
 *
 * SOLID: S - Only responsible for parsing and indexing scene data
 */

import * as fs from 'fs';

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
        return ['cc.Vec3', 'cc.Vec2', 'cc.Vec4', 'cc.Quat',
                'cc.Color', 'cc.Size', 'cc.Rect'].includes(type);
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
        return this.#objects.find(obj => obj.__type__ === 'cc.Scene');
    }
}
