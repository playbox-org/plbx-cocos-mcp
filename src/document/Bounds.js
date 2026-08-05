/**
 * Bounds - world/local AABB of a node subtree
 *
 * Merges every measurable contributor under a node:
 * - cc.MeshRenderer / cc.SkinnedMeshRenderer → mesh AABB from the import
 *   cache (library/ or .glb accessors, via AssetInspector)
 * - cc.UITransform → contentSize/anchorPoint rect at z=0 (UI pixels)
 * - cc.Terrain → analytic box from the .terrain binary: X/Z from
 *   blockCount*32*tileSize, Y from the height range. Terrain geometry is
 *   anchored at the node ORIGIN (local X∈[0,width], Z∈[0,depth]) and the
 *   shader offsets it by the node's world POSITION only (`cc_matWorld[3]`),
 *   so its box carries `translationOnly` and ignores ancestor rotation/scale
 * - collapsed prefab-instance stubs → the source prefab's own bounds with
 *   the stub's transform overrides applied (recursive, depth-limited)
 *
 * Frames:
 * - `local`: the queried node's own coordinate frame, its own TRS excluded —
 *   exactly what a BoxCollider on that node needs as center/size
 * - `world`: document space (all ancestor transforms applied)
 *
 * SOLID: S - measurement only; no mutations
 */

import { isRef } from './SceneDocument.js';
import {
    loadSourcePrefabByUuid, instanceOverrideValue, mountedChildrenEntries, mountOwners
} from './instances.js';
import {
    mat4Identity, trsToMat4, mat4Multiply, transformAabb, mergeAabb, eulerToQuat
} from '../utils/math3d.js';
import { MESH_RENDERERS } from './componentTypes.js';

const MAX_INSTANCE_DEPTH = 8;
const IDENTITY_TRS = {
    pos: { x: 0, y: 0, z: 0 },
    rot: { x: 0, y: 0, z: 0, w: 1 },
    scale: { x: 1, y: 1, z: 1 }
};

export class BoundsCalculator {
    #ctx;
    #meshCache = new Map();
    #terrainCache = new Map();
    #mountCache = new Map();

    /**
     * @param {{assetIndex: object|null, assetInspector: object|null, projectRoot: string|null}} ctx
     */
    constructor(ctx) {
        this.#ctx = ctx;
    }

    /**
     * @param {import('./SceneDocument.js').SceneDocument} doc
     * @param {number} nodeIdx
     * @param {{skipUI?: boolean}} [options] - `skipUI` drops cc.UITransform contributions: their
     *   rects are UI PIXELS, so merging them into a metre AABB makes a Canvas 1080 m wide. A
     *   caller measuring world ground (a placement/occupancy question) must not see them.
     * @returns {{local: object|null, world: object|null,
     *            contributors: Array<{path: string, type: string, source: string}>,
     *            skipped: Array<{path: string, reason: string}>}}
     */
    computeSubtree(doc, nodeIdx, options = {}) {
        const out = { contributors: [], skipped: [], boxes: [], skipUI: options.skipUI === true };
        this.#enter(doc, nodeIdx, mat4Identity(), doc.nodePath(nodeIdx) ?? '/', out, 0, true, new Map());

        let local = null;
        for (const box of out.boxes) {
            local = mergeAabb(local, transformAabb(box.aabb, effectiveMat(box.matrix, box)));
        }

        let world = null;
        if (local) {
            const worldMat = this.#worldMatrix(doc, nodeIdx);
            for (const box of out.boxes) {
                const m = mat4Multiply(worldMat, box.matrix);
                world = mergeAabb(world, transformAabb(box.aabb, effectiveMat(m, box)));
            }
        }

        return {
            local: withDerived(local),
            world: withDerived(world),
            contributors: out.contributors,
            skipped: out.skipped
        };
    }

    /**
     * World AABB (or world position, when nothing under it is measurable) per DIRECT child — the
     * "which child stands at (4, 6)" question a merged group box cannot answer.
     *
     * A collapsed instance stub has no `_children` of its own: its children live in the source
     * prefab, and enumerating the document would report zero children right next to a Contributors
     * list naming all of them. Those are marked `inPrefab` — their paths are relative to the prefab
     * root, not scene addresses. Mounted children are the other half: real nodes of THIS document
     * added on top of the instance, marked `mounted` (and named so, since the row prints its name).
     * @param {import('./SceneDocument.js').SceneDocument} doc
     * @param {number} nodeIdx
     * @param {{skipUI?: boolean}} [options]
     * @returns {Array<{name: string, path: string|null, inPrefab: boolean, mounted: boolean,
     *   active: boolean, world: object|null, position: object|null}>}
     */
    computeChildren(doc, nodeIdx, options = {}) {
        if (!doc.isInstanceStub(nodeIdx)) {
            return doc.childIndices(nodeIdx).map(childIdx => this.#childRow(doc, childIdx, options));
        }

        const info = doc.getObject(doc.getObject(nodeIdx)._prefab.__id__);
        let source = null;
        try {
            source = loadSourcePrefabByUuid(this.#ctx, info.asset?.__uuid__);
        } catch {
            // Source unreadable — the mounted children below are still knowable
        }
        const rows = [];
        if (source) {
            const stubWorld = this.#worldMatrix(doc, nodeIdx);
            for (const childIdx of source.doc.childIndices(source.doc.root.idx)) {
                const name = source.doc.nodeName(childIdx) ?? '<unnamed>';
                const out = { contributors: [], skipped: [], boxes: [], skipUI: options.skipUI === true };
                this.#enter(source.doc, childIdx, mat4Identity(), name, out, 1, false, new Map());
                let world = null;
                for (const box of out.boxes) {
                    const m = mat4Multiply(stubWorld, box.matrix);
                    world = mergeAabb(world, transformAabb(box.aabb, effectiveMat(m, box)));
                }
                const own = mat4Multiply(stubWorld, nodeTrsMat(source.doc.getObject(childIdx)));
                rows.push({
                    name,
                    path: name,
                    inPrefab: true,
                    mounted: false,
                    active: source.doc.getObject(childIdx)._active !== false,
                    world: withDerived(world),
                    position: world ? null : { x: own[12], y: own[13], z: own[14] }
                });
            }
        }
        for (const entry of this.#mountedEntries(doc, nodeIdx, null)) {
            for (const childIdx of entry.nodeIndices) {
                rows.push(this.#childRow(doc, childIdx, options, true));
            }
        }
        return rows;
    }

    /** One computeChildren row for a node of THIS document (`#worldMatrix` does the mount hop) */
    #childRow(doc, childIdx, options, mounted = false) {
        const own = this.computeSubtree(doc, childIdx, options);
        const name = doc.nodeName(childIdx) ?? '<unnamed>';
        return {
            name: mounted ? `${name} (mounted)` : name,
            path: doc.nodePath(childIdx),
            inPrefab: false,
            mounted,
            active: doc.getObject(childIdx)._active !== false,
            world: own.world,
            position: own.world ? null : this.worldPosition(doc, childIdx)
        };
    }

    /**
     * World position of a node — the only measurement a node with no measurable contributor has.
     * @param {import('./SceneDocument.js').SceneDocument} doc
     * @param {number} nodeIdx
     * @returns {{x: number, y: number, z: number}}
     */
    worldPosition(doc, nodeIdx) {
        const m = this.#worldMatrix(doc, nodeIdx);
        return { x: m[12], y: m[13], z: m[14] };
    }

    /**
     * Walk a node: collect component boxes at `matrix` (maps the node's own
     * frame — TRS applied — to the queried node's frame), then descend.
     * When `excludeOwnTrs`, `matrix` is used as-is (query root / instance root).
     */
    #enter(doc, nodeIdx, matrix, label, out, depth, excludeOwnTrs, visiting) {
        // Cycle guard over the current recursion path only: source-prefab docs
        // are cached, so sibling stubs legitimately revisit the same (doc, idx)
        let onPath = visiting.get(doc);
        if (!onPath) visiting.set(doc, onPath = new Set());
        if (onPath.has(nodeIdx)) {
            out.skipped.push({ path: label, reason: 'cycle in node tree' });
            return;
        }
        onPath.add(nodeIdx);
        try {
            const node = doc.getObject(nodeIdx);

            if (doc.isInstanceStub(nodeIdx)) {
                this.#enterStub(doc, nodeIdx, matrix, label, out, depth, excludeOwnTrs, visiting);
                return;
            }

            const m = excludeOwnTrs ? matrix : mat4Multiply(matrix, nodeTrsMat(node));
            this.#collectComponents(doc, nodeIdx, m, label, out);
            for (const childIdx of doc.childIndices(nodeIdx)) {
                const childLabel = `${label === '/' ? '' : label}/${doc.nodeName(childIdx) ?? '<unnamed>'}`;
                this.#enter(doc, childIdx, m, childLabel, out, depth, false, visiting);
            }
        } finally {
            onPath.delete(nodeIdx);
        }
    }

    /**
     * Collapsed instance: recurse into the source prefab with overrides applied, then into the
     * nodes MOUNTED on the instance. An unreadable source only costs the prefab half — the mounted
     * children are real nodes of this document and stay measurable at the instance origin.
     */
    #enterStub(doc, stubIdx, matrix, label, out, depth, excludeOwnTrs, visiting) {
        if (depth >= MAX_INSTANCE_DEPTH) {
            out.skipped.push({ path: label, reason: 'prefab nesting too deep' });
            return;
        }
        const info = doc.getObject(doc.getObject(stubIdx)._prefab.__id__);
        const assetUuid = info.asset?.__uuid__;
        let source = null;
        if (typeof assetUuid !== 'string') {
            out.skipped.push({ path: label, reason: 'instance has no asset uuid' });
        } else {
            try {
                source = loadSourcePrefabByUuid(this.#ctx, assetUuid);
            } catch (err) {
                out.skipped.push({ path: label, reason: `source prefab unavailable: ${err.message}` });
            }
        }
        const rootNode = source ? source.doc.getObject(source.doc.root.idx) : null;

        // The stub's transform = source root TRS overridden per propertyOverrides
        const instance = doc.instanceOf(stubIdx);
        const rot = instanceOverrideValue(doc, instance, info.fileId, '_lrot') ??
            rootNode?._lrot ??
            (rootNode?._euler ? { __type__: 'cc.Quat', ...eulerToQuat(rootNode._euler) } : IDENTITY_TRS.rot);
        const trs = {
            pos: instanceOverrideValue(doc, instance, info.fileId, '_lpos') ?? rootNode?._lpos ?? IDENTITY_TRS.pos,
            rot,
            scale: instanceOverrideValue(doc, instance, info.fileId, '_lscale') ?? rootNode?._lscale ?? IDENTITY_TRS.scale
        };
        const m = excludeOwnTrs ? matrix : mat4Multiply(matrix, trsToMat4(trs.pos, trs.rot, trs.scale));

        if (source) {
            const rootIdx = source.doc.root.idx;
            this.#collectComponents(source.doc, rootIdx, m, label, out);
            for (const childIdx of source.doc.childIndices(rootIdx)) {
                const childLabel = `${label}→${source.doc.nodeName(childIdx) ?? '<unnamed>'}`;
                this.#enter(source.doc, childIdx, m, childLabel, out, depth + 1, false, visiting);
            }
        }
        for (const entry of this.#mountedEntries(doc, stubIdx, source)) {
            const base = entry.inner ? mat4Multiply(m, entry.inner) : m;
            for (const childIdx of entry.nodeIndices) {
                const childLabel = `${label}/${doc.nodeName(childIdx) ?? '<unnamed>'}`;
                this.#enter(doc, childIdx, base, childLabel, out, depth + 1, false, visiting);
            }
        }
    }

    /**
     * Mounted children of a stub, each entry carrying the source-prefab TRS chain from the root
     * down to its mount node (null when the source is unreadable — then the instance origin is it).
     * A mounted node with a real `_parent` is walked as that parent's child, never here: exactly one
     * contribution per node.
     */
    #mountedEntries(doc, stubIdx, source) {
        const instance = doc.instanceOf(stubIdx);
        if (!instance) return [];
        return mountedChildrenEntries(doc, instance).map(e => ({
            inner: source && e.localID?.length === 1 ? mountNodeMatrix(source.doc, e.localID[0]) : null,
            nodeIndices: e.nodeIndices.filter(i => !isRef(doc.getObject(i)?._parent))
        }));
    }

    #collectComponents(doc, nodeIdx, matrix, label, out) {
        for (const compIdx of doc.componentIndices(nodeIdx)) {
            const comp = doc.getObject(compIdx);

            if (MESH_RENDERERS.includes(comp.__type__)) {
                const meshUuid = comp._mesh?.__uuid__;
                if (!meshUuid) {
                    out.skipped.push({ path: label, reason: `${comp.__type__} has no mesh` });
                    continue;
                }
                const aabb = this.#meshAabb(meshUuid);
                if (!aabb) {
                    out.skipped.push({
                        path: label,
                        reason: `mesh AABB unavailable for ${meshUuid} (no library/ cache or .glb)`
                    });
                    continue;
                }
                out.boxes.push({ aabb, matrix });
                out.contributors.push({ path: label, type: comp.__type__, source: `mesh ${meshUuid}` });
                continue;
            }

            if (comp.__type__ === 'cc.Terrain') {
                // The asset key is `__asset` (double underscore) — the @serializable
                // member of cc.Terrain; `_asset` is only a getter/setter facade.
                const assetUuid = comp.__asset?.__uuid__;
                if (typeof assetUuid !== 'string') {
                    out.skipped.push({ path: label, reason: 'cc.Terrain has no __asset' });
                    continue;
                }
                const box = this.#terrainBox(assetUuid);
                if (box.error) {
                    out.skipped.push({ path: label, reason: box.error });
                    continue;
                }
                out.boxes.push({ aabb: box.aabb, matrix, translationOnly: true });
                out.contributors.push({ path: label, type: 'cc.Terrain', source: box.source });
                continue;
            }

            if (comp.__type__ === 'cc.UITransform') {
                if (out.skipUI) {
                    out.skipped.push({
                        path: label,
                        reason: 'cc.UITransform rect is in UI pixels, not world metres'
                    });
                    continue;
                }
                const w = comp._contentSize?.width ?? 0;
                const h = comp._contentSize?.height ?? 0;
                const ax = comp._anchorPoint?.x ?? 0.5;
                const ay = comp._anchorPoint?.y ?? 0.5;
                if (w > 0 || h > 0) {
                    out.boxes.push({
                        aabb: {
                            min: { x: -ax * w, y: -ay * h, z: 0 },
                            max: { x: (1 - ax) * w, y: (1 - ay) * h, z: 0 }
                        },
                        matrix
                    });
                    out.contributors.push({ path: label, type: 'cc.UITransform', source: `${w}x${h}` });
                }
            }
        }
    }

    /** Mesh AABB by "<uuid>@<subId>" via AssetInspector, cached */
    #meshAabb(meshUuid) {
        if (this.#meshCache.has(meshUuid)) return this.#meshCache.get(meshUuid);
        let aabb = null;
        const inspector = this.#ctx.assetInspector;
        if (inspector) {
            const baseUuid = meshUuid.split('@')[0];
            const info = inspector.inspect(baseUuid);
            const mesh = info?.meshes?.find(m => m.uuid === meshUuid) ??
                         (info?.meshes?.length === 1 ? info.meshes[0] : null);
            aabb = mesh?.aabb ? { min: mesh.aabb.min, max: mesh.aabb.max } : null;
        }
        this.#meshCache.set(meshUuid, aabb);
        return aabb;
    }

    /**
     * Analytic terrain AABB by asset uuid, cached (negatives included).
     * X/Z span `[0, blockCount*32*tileSize]` from the node origin, Y is the
     * height range of the grid — a never-sculpted sentinel is still measurable
     * with a flat Y span of [0, 0].
     * @returns {{aabb: object, source: string}|{error: string}}
     */
    #terrainBox(assetUuid) {
        if (this.#terrainCache.has(assetUuid)) return this.#terrainCache.get(assetUuid);
        const result = this.#computeTerrainBox(assetUuid);
        this.#terrainCache.set(assetUuid, result);
        return result;
    }

    #computeTerrainBox(assetUuid) {
        const inspector = this.#ctx.assetInspector;
        if (!inspector) {
            return { error: `terrain asset ${assetUuid} unreadable: no asset inspector available` };
        }
        const info = inspector.inspect(assetUuid);
        if (!info) return { error: `terrain asset ${assetUuid} not found under assets/` };
        const t = info.terrain;
        if (!t) return { error: `asset ${assetUuid} is a ${info.importer} asset, not a terrain` };
        if (t.error) return { error: `terrain asset ${assetUuid} unreadable: ${t.error}` };

        const [w, d] = t.size;
        const minY = t.heightMin ?? 0;
        const maxY = t.heightMax ?? 0;
        const fmt = v => Number(v.toFixed(4));
        const note = t.isDefaultSentinel ? ' (empty default terrain)' : '';
        return {
            aabb: { min: { x: 0, y: minY, z: 0 }, max: { x: w, y: maxY, z: d } },
            source: `terrain ${fmt(w)}x${fmt(d)}m, height ${fmt(minY)}..${fmt(maxY)}${note}`
        };
    }

    /** World matrix of a node (ancestors' TRS, instance stubs included) */
    #worldMatrix(doc, nodeIdx, mounts = new Set()) {
        const chain = [];
        let idx = nodeIdx;
        let above = null;
        const guard = new Set();
        while (idx !== undefined && !guard.has(idx)) {
            guard.add(idx);
            chain.unshift(idx);
            const parent = doc.getObject(idx)._parent;
            if (isRef(parent)) {
                idx = parent.__id__;
                continue;
            }
            // A mounted child is serialized with `_parent: null` — the engine resolves it through
            // the MountedChildrenInfo of the instance it was added to. Without that hop the chain
            // ends here and the node measures at the document origin.
            const owner = this.#mountOwners(doc).get(idx);
            if (owner && !mounts.has(owner.stubIdx)) {
                above = this.#mountMatrix(doc, owner, new Set(mounts).add(owner.stubIdx));
            }
            break;
        }
        let m = above ?? mat4Identity();
        for (const i of chain) {
            const node = doc.getObject(i);
            if (doc.isInstanceStub(i)) {
                const info = doc.getObject(node._prefab.__id__);
                const instance = doc.instanceOf(i);
                let pos = instanceOverrideValue(doc, instance, info.fileId, '_lpos');
                let rot = instanceOverrideValue(doc, instance, info.fileId, '_lrot');
                let scale = instanceOverrideValue(doc, instance, info.fileId, '_lscale');
                if (pos === undefined || rot === undefined || scale === undefined) {
                    // Same fallback as #enterStub: the source prefab root's own TRS
                    const rootNode = this.#sourceRootNode(info);
                    pos ??= rootNode?._lpos ?? IDENTITY_TRS.pos;
                    rot ??= rootNode?._lrot ??
                        (rootNode?._euler ? { __type__: 'cc.Quat', ...eulerToQuat(rootNode._euler) } : IDENTITY_TRS.rot);
                    scale ??= rootNode?._lscale ?? IDENTITY_TRS.scale;
                }
                m = mat4Multiply(m, trsToMat4(pos, rot, scale));
            } else {
                m = mat4Multiply(m, nodeTrsMat(node));
            }
        }
        return m;
    }

    /** instances.js' mount-owner map, built once per document */
    #mountOwners(doc) {
        let map = this.#mountCache.get(doc);
        if (!map) this.#mountCache.set(doc, map = mountOwners(doc));
        return map;
    }

    /**
     * World matrix of the node a mounted child is mounted ON: the stub's own world matrix times the
     * TRS chain from the source prefab's root down to the mount node (the root's own TRS is what
     * the stub's transform already is). Falls back to the stub itself when the source prefab or the
     * mount fileId is unresolvable — the instance origin, which beats the document origin.
     * Nested-node propertyOverrides inside the source are not applied, matching #enterStub.
     */
    #mountMatrix(doc, owner, mounts) {
        const stubWorld = this.#worldMatrix(doc, owner.stubIdx, mounts);
        if (owner.localID?.length !== 1) return stubWorld;
        const info = doc.getObject(doc.getObject(owner.stubIdx)._prefab.__id__);
        if (typeof info?.asset?.__uuid__ !== 'string') return stubWorld;
        let source;
        try {
            source = loadSourcePrefabByUuid(this.#ctx, info.asset.__uuid__);
        } catch {
            return stubWorld;
        }
        const inner = mountNodeMatrix(source.doc, owner.localID[0]);
        return inner ? mat4Multiply(stubWorld, inner) : stubWorld;
    }

    /** Root node of a stub's source prefab, or null when unavailable */
    #sourceRootNode(info) {
        if (typeof info.asset?.__uuid__ !== 'string') return null;
        try {
            return loadSourcePrefabByUuid(this.#ctx, info.asset.__uuid__).doc.root.node;
        } catch {
            return null;
        }
    }
}

/**
 * Effective matrix of a collected box: normally the composed one, but a
 * `translationOnly` box (cc.Terrain) keeps just the translation column.
 * Stripping happens on the COMPOSED matrix so ancestor translation coming
 * through a rotated parent survives — that is exactly the world position the
 * terrain shader reads out of `cc_matWorld[3]`.
 */
function effectiveMat(m, box) {
    if (!box.translationOnly) return m;
    return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, m[12], m[13], m[14], 1];
}

/**
 * TRS chain from a source prefab's root (its own transform EXCLUDED) down to the node whose
 * PrefabInfo.fileId is `fileId`, or null when no node carries it. The root itself matches as the
 * identity — mounting onto the instance root is the common case.
 */
function mountNodeMatrix(sourceDoc, fileId) {
    const rootIdx = sourceDoc.root.idx;
    const walk = (idx, m) => {
        const node = sourceDoc.getObject(idx);
        const here = idx === rootIdx ? m : mat4Multiply(m, nodeTrsMat(node));
        if (isRef(node._prefab)) {
            const info = sourceDoc.getObject(node._prefab.__id__);
            if (info?.fileId === fileId) return here;
        }
        for (const childIdx of sourceDoc.childIndices(idx)) {
            const found = walk(childIdx, here);
            if (found) return found;
        }
        return null;
    };
    return walk(rootIdx, mat4Identity());
}

function nodeTrsMat(node) {
    // cc.Scene has no transform fields — identity
    return trsToMat4(
        node._lpos ?? IDENTITY_TRS.pos,
        node._lrot ?? IDENTITY_TRS.rot,
        node._lscale ?? IDENTITY_TRS.scale
    );
}

function withDerived(aabb) {
    if (!aabb) return null;
    return {
        min: aabb.min,
        max: aabb.max,
        size: {
            x: aabb.max.x - aabb.min.x,
            y: aabb.max.y - aabb.min.y,
            z: aabb.max.z - aabb.min.z
        },
        center: {
            x: (aabb.min.x + aabb.max.x) / 2,
            y: (aabb.min.y + aabb.max.y) / 2,
            z: (aabb.min.z + aabb.max.z) / 2
        }
    };
}
