/**
 * SceneDocument - Lossless read/mutate/save model for .scene/.prefab files
 *
 * Unlike the lossy read pipeline (SceneParser → NodeTreeBuilder), this class
 * keeps every object byte-equivalent: unknown fields pass through untouched.
 *
 * Serialization contract (verified on real 3.8.7 files, notes in README):
 * - file = flat JSON array, `{"__id__": N}` = index into that array
 * - object order = depth-first first-visit order over the whole reference
 *   graph starting at index 0, following properties in key order
 *   (cross-references included — a component pointing at a sibling node
 *   pulls that node forward)
 * - output = JSON.stringify(arr, null, 2), no trailing newline
 *
 * SOLID: S - owns document identity, addressing, renumbering and IO;
 * semantic edits live in operations.js
 */

import * as fs from 'fs';
import * as path from 'path';

/** True when a value is an `{__id__: N}` reference and nothing else */
export function isRef(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const keys = Object.keys(value);
    return keys.length === 1 && keys[0] === '__id__';
}

export class SceneDocument {
    #objects;
    #filePath;

    /**
     * @param {object[]} objects - Parsed flat JSON array
     * @param {string|null} filePath - Origin path (for save())
     */
    constructor(objects, filePath = null) {
        if (!Array.isArray(objects) || objects.length === 0) {
            throw new Error('Document must be a non-empty JSON array');
        }
        this.#objects = objects;
        this.#filePath = filePath;
    }

    /**
     * @param {string} filePath - Path to .scene or .prefab file
     * @returns {SceneDocument}
     */
    static load(filePath) {
        const content = fs.readFileSync(filePath, 'utf-8');
        return new SceneDocument(JSON.parse(content), filePath);
    }

    get objects() {
        return this.#objects;
    }

    get filePath() {
        return this.#filePath;
    }

    get isScene() {
        return this.#objects[0].__type__ === 'cc.SceneAsset';
    }

    get isPrefab() {
        return this.#objects[0].__type__ === 'cc.Prefab';
    }

    /**
     * Root node: the cc.Scene node, or the prefab's data node
     * @returns {{idx: number, node: object}}
     */
    get root() {
        const head = this.#objects[0];
        const ref = this.isScene ? head.scene : head.data;
        if (!isRef(ref)) throw new Error('Cannot locate root node (not a scene/prefab file?)');
        return { idx: ref.__id__, node: this.#objects[ref.__id__] };
    }

    getObject(idx) {
        return this.#objects[idx];
    }

    /** Append a new object, returns its index */
    addObject(obj) {
        this.#objects.push(obj);
        return this.#objects.length - 1;
    }

    isNode(obj) {
        return obj && (obj.__type__ === 'cc.Node' || obj.__type__ === 'cc.Scene');
    }

    /**
     * True when the node is a collapsed prefab-instance stub
     * (its content lives in the source prefab + propertyOverrides)
     */
    isInstanceStub(nodeIdx) {
        const node = this.#objects[nodeIdx];
        if (!node || !isRef(node._prefab)) return false;
        const info = this.#objects[node._prefab.__id__];
        return !!(info && info.instance);
    }

    /** PrefabInstance object for a stub node, or null */
    instanceOf(nodeIdx) {
        const node = this.#objects[nodeIdx];
        if (!node || !isRef(node._prefab)) return null;
        const info = this.#objects[node._prefab.__id__];
        if (!info || !isRef(info.instance)) return null;
        return this.#objects[info.instance.__id__];
    }

    /**
     * Display name of a node. Instance stubs have no _name of their own —
     * fall back to their `_name` propertyOverride when present.
     */
    nodeName(nodeIdx) {
        const node = this.#objects[nodeIdx];
        if (!node) return null;
        if (typeof node._name === 'string' && node._name !== '') return node._name;

        const instance = this.instanceOf(nodeIdx);
        if (instance && Array.isArray(instance.propertyOverrides)) {
            for (const ref of instance.propertyOverrides) {
                if (!isRef(ref)) continue;
                const override = this.#objects[ref.__id__];
                if (override &&
                    Array.isArray(override.propertyPath) &&
                    override.propertyPath.length === 1 &&
                    override.propertyPath[0] === '_name' &&
                    typeof override.value === 'string') {
                    return override.value;
                }
            }
        }
        return node._name ?? null;
    }

    /** Child node indices of a node */
    childIndices(nodeIdx) {
        const node = this.#objects[nodeIdx];
        if (!node || !Array.isArray(node._children)) return [];
        return node._children.filter(isRef).map(r => r.__id__);
    }

    /** Component indices attached to a node */
    componentIndices(nodeIdx) {
        const node = this.#objects[nodeIdx];
        if (!node || !Array.isArray(node._components)) return [];
        return node._components.filter(isRef).map(r => r.__id__);
    }

    /**
     * Path of a node from the root, e.g. "Canvas/Panel/BuyBtn".
     * Root itself is "/".
     */
    nodePath(nodeIdx) {
        const rootIdx = this.root.idx;
        const segments = [];
        let idx = nodeIdx;
        const guard = new Set();
        while (idx !== rootIdx) {
            if (guard.has(idx)) return null; // broken parent chain
            guard.add(idx);
            const node = this.#objects[idx];
            if (!node) return null;
            segments.unshift(this.nodeName(idx) ?? '<unnamed>');
            if (!isRef(node._parent)) return null;
            idx = node._parent.__id__;
        }
        return segments.length ? segments.join('/') : '/';
    }

    /**
     * Resolve a node reference to an index.
     *
     * Accepted forms:
     * - "/" or ""            → root node
     * - "Canvas/Panel/BuyBtn" → path from root (segment "Name[i]" picks the
     *   i-th (0-based) same-named sibling; bare "[i]" picks by child position)
     * - a node `_id` string (scenes) — checked before path resolution
     *
     * @param {string} ref
     * @returns {number} node index
     * @throws {Error} with a helpful message on miss/ambiguity
     */
    resolveNode(ref) {
        if (typeof ref !== 'string') throw new Error('Node reference must be a string');
        const rootIdx = this.root.idx;
        if (ref === '' || ref === '/') return rootIdx;

        // _id lookup (node ids never contain '/')
        if (!ref.includes('/')) {
            for (let i = 0; i < this.#objects.length; i++) {
                const o = this.#objects[i];
                if (this.isNode(o) && o._id && o._id === ref) return i;
            }
        }

        let current = rootIdx;
        const walked = [];
        for (const rawSegment of ref.replace(/^\//, '').split('/')) {
            const m = rawSegment.match(/^(.*?)(?:\[(\d+)\])?$/);
            const name = m[1];
            const pick = m[2] === undefined ? null : Number(m[2]);
            const children = this.childIndices(current);

            let matches;
            if (name === '' && pick !== null) {
                matches = pick < children.length ? [children[pick]] : [];
            } else {
                matches = children.filter(c => this.nodeName(c) === name);
                if (pick !== null) matches = pick < matches.length ? [matches[pick]] : [];
            }

            if (matches.length === 0) {
                if (this.isInstanceStub(current)) {
                    throw new Error(
                        `Node not found: "${ref}" — "${walked.join('/') || '/'}" is a collapsed prefab ` +
                        `instance; its internals are not addressable in this file. Run inspect_node on ` +
                        `the instance to see internal target paths, then override with ` +
                        `set_instance_property {node: "${walked.join('/') || '/'}", target: "...", ...}.`
                    );
                }
                const available = children
                    .map((c, i) => `${this.nodeName(c) ?? '<unnamed>'}${this.isInstanceStub(c) ? ' (prefab instance)' : ''} [${i}]`)
                    .join(', ');
                const hints = [];
                if (/^\d+$/.test(ref)) {
                    hints.push(
                        `"${ref}" looks like a #N node index from inspect_node output — ` +
                        `\`node\` takes a root-anchored path ("Canvas/Panel/BuyBtn") or a node _id string, not #N.`
                    );
                }
                const suggestions = this.#pathsOfNodesNamed(
                    ref.replace(/^\//, '').split('/').pop().replace(/\[\d+\]$/, ''), 5
                ).filter(p => p !== ref);
                if (suggestions.length > 0) {
                    hints.push(`Did you mean: ${suggestions.map(p => `"${p}"`).join(', ')}?`);
                }
                throw new Error(
                    `Node not found: "${ref}" (no child "${rawSegment}" under "${walked.join('/') || '/'}"; ` +
                    `children: ${available || 'none'})` +
                    (hints.length ? `\n${hints.join('\n')}` : '')
                );
            }
            if (matches.length > 1) {
                throw new Error(
                    `Ambiguous node reference "${ref}": ${matches.length} children named "${name}" ` +
                    `under "${walked.join('/') || '/'}". Disambiguate with "${name}[0]".."${name}[${matches.length - 1}]".`
                );
            }
            current = matches[0];
            walked.push(rawSegment);
        }
        return current;
    }

    /**
     * Root-anchored paths of nodes with the given name — "did you mean"
     * suggestions for a failed resolveNode() lookup.
     * @param {string} name - Exact node name
     * @param {number} limit - Max suggestions
     * @returns {string[]}
     */
    #pathsOfNodesNamed(name, limit) {
        if (!name) return [];
        const paths = [];
        const rootIdx = this.root.idx;
        for (let i = 0; i < this.#objects.length && paths.length < limit; i++) {
            if (i === rootIdx || !this.isNode(this.#objects[i])) continue;
            if (this.nodeName(i) !== name) continue;
            const p = this.nodePath(i);
            if (p) paths.push(p);
        }
        return paths;
    }

    /**
     * Object indices owned by a node's subtree: the nodes themselves plus
     * their components, prefab machinery and value objects. Cross-references
     * to outside nodes/components are NOT included.
     * @param {number} nodeIdx
     * @returns {Set<number>}
     */
    subtreeObjectIds(nodeIdx) {
        // 1. Collect node set via _children recursion
        const nodeSet = new Set();
        const stack = [nodeIdx];
        while (stack.length) {
            const idx = stack.pop();
            if (nodeSet.has(idx)) continue;
            nodeSet.add(idx);
            stack.push(...this.childIndices(idx));
        }

        // 2. From each node, follow ownership edges. Stop at references to
        //    nodes outside the set and at components owned by outside nodes.
        const owned = new Set(nodeSet);
        const walk = (value) => {
            if (value === null || typeof value !== 'object') return;
            if (isRef(value)) {
                const idx = value.__id__;
                if (idx === 0) return; // file head (cc.Prefab/cc.SceneAsset) is never owned
                if (owned.has(idx)) return;
                const target = this.#objects[idx];
                if (!target) return;
                if (this.isNode(target)) {
                    if (!nodeSet.has(idx)) return; // cross-ref to outside node
                } else if (isRef(target.node) && !nodeSet.has(target.node.__id__)) {
                    return; // component owned by an outside node
                }
                owned.add(idx);
                walk(target);
                return;
            }
            if (Array.isArray(value)) { value.forEach(walk); return; }
            for (const key of Object.keys(value)) {
                if (key === '_parent') continue; // never walk upward
                walk(value[key]);
            }
        };
        for (const idx of nodeSet) walk(this.#objects[idx]);
        return owned;
    }

    /**
     * Find all references into `targetIds` from objects outside of it.
     * @param {Set<number>} targetIds
     * @returns {Array<{fromIdx: number, path: string, toIdx: number}>}
     */
    externalRefsInto(targetIds) {
        const refs = [];
        const walk = (fromIdx, value, trail) => {
            if (value === null || typeof value !== 'object') return;
            if (isRef(value)) {
                if (targetIds.has(value.__id__)) {
                    refs.push({ fromIdx, path: trail, toIdx: value.__id__ });
                }
                return;
            }
            if (Array.isArray(value)) {
                value.forEach((v, i) => walk(fromIdx, v, `${trail}[${i}]`));
                return;
            }
            for (const key of Object.keys(value)) {
                if (key === '__id__') continue;
                walk(fromIdx, value[key], trail ? `${trail}.${key}` : key);
            }
        };
        for (let i = 0; i < this.#objects.length; i++) {
            if (targetIds.has(i)) continue;
            walk(i, this.#objects[i], '');
        }
        return refs;
    }

    /** Indices reachable from object 0 (everything else is dropped on renumber) */
    reachableIds() {
        const reachable = new Set([0]);
        const walk = (value) => {
            if (value === null || typeof value !== 'object') return;
            if (isRef(value)) {
                if (reachable.has(value.__id__)) return;
                reachable.add(value.__id__);
                walk(this.#objects[value.__id__]);
                return;
            }
            if (Array.isArray(value)) { value.forEach(walk); return; }
            for (const key of Object.keys(value)) {
                if (key !== '__id__') walk(value[key]);
            }
        };
        walk(this.#objects[0]);
        return reachable;
    }

    /** All fileId/_id strings present in the document (for unique generation) */
    takenIds() {
        const taken = new Set();
        for (const o of this.#objects) {
            if (typeof o.fileId === 'string' && o.fileId) taken.add(o.fileId);
            if (typeof o._id === 'string' && o._id) taken.add(o._id);
        }
        return taken;
    }

    /**
     * Canonical renumbering: rebuild the array in depth-first first-visit
     * order from object 0 and rewrite every `{__id__}`. Objects that became
     * unreachable (e.g. detached subtrees) are dropped.
     *
     * This matches the editor's own numbering — verified byte-identical on
     * all golden corpus files.
     *
     * @returns {{dropped: number}}
     */
    renumber() {
        const oldObjects = this.#objects;
        const order = [];
        const newIndexByOld = new Map();

        const visit = (oldIdx) => {
            if (newIndexByOld.has(oldIdx)) return;
            const obj = oldObjects[oldIdx];
            if (obj === undefined) {
                throw new Error(`Dangling __id__ reference: ${oldIdx} (document has ${oldObjects.length} objects)`);
            }
            newIndexByOld.set(oldIdx, order.length);
            order.push(oldIdx);
            walk(obj);
        };
        const walk = (value) => {
            if (value === null || typeof value !== 'object') return;
            if (isRef(value)) { visit(value.__id__); return; }
            if (Array.isArray(value)) { value.forEach(walk); return; }
            for (const key of Object.keys(value)) {
                if (key !== '__id__') walk(value[key]);
            }
        };
        visit(0);

        const rewrite = (value) => {
            if (value === null || typeof value !== 'object') return;
            if (isRef(value)) { value.__id__ = newIndexByOld.get(value.__id__); return; }
            if (Array.isArray(value)) { value.forEach(rewrite); return; }
            for (const key of Object.keys(value)) {
                if (key !== '__id__') rewrite(value[key]);
            }
        };
        const newObjects = order.map(oldIdx => oldObjects[oldIdx]);
        newObjects.forEach(rewrite);

        const dropped = oldObjects.length - newObjects.length;
        this.#objects = newObjects;
        return { dropped };
    }

    /** Serialize exactly like the editor (2-space indent, no trailing newline) */
    serialize() {
        return JSON.stringify(this.#objects, null, 2);
    }

    /**
     * Atomic save: write to a temp file in the same directory, then rename.
     * @param {string} [filePath] - Defaults to the origin path
     */
    save(filePath = this.#filePath) {
        if (!filePath) throw new Error('No file path to save to');
        const dir = path.dirname(filePath);
        const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}`);
        fs.writeFileSync(tmp, this.serialize(), 'utf-8');
        fs.renameSync(tmp, filePath);
        this.#filePath = filePath;
    }
}
