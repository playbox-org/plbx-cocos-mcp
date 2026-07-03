/**
 * Bounds - world/local AABB of a node subtree
 *
 * Merges every measurable contributor under a node:
 * - cc.MeshRenderer / cc.SkinnedMeshRenderer → mesh AABB from the import
 *   cache (library/ or .glb accessors, via AssetInspector)
 * - cc.UITransform → contentSize/anchorPoint rect at z=0 (UI pixels)
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
import { loadSourcePrefabByUuid } from './instances.js';
import {
    mat4Identity, trsToMat4, mat4Multiply, transformAabb, mergeAabb
} from '../utils/math3d.js';

const MESH_RENDERERS = ['cc.MeshRenderer', 'cc.SkinnedMeshRenderer'];
const MAX_INSTANCE_DEPTH = 8;
const IDENTITY_TRS = {
    pos: { x: 0, y: 0, z: 0 },
    rot: { x: 0, y: 0, z: 0, w: 1 },
    scale: { x: 1, y: 1, z: 1 }
};

export class BoundsCalculator {
    #ctx;
    #meshCache = new Map();

    /**
     * @param {{assetIndex: object|null, assetInspector: object|null, projectRoot: string|null}} ctx
     */
    constructor(ctx) {
        this.#ctx = ctx;
    }

    /**
     * @param {import('./SceneDocument.js').SceneDocument} doc
     * @param {number} nodeIdx
     * @returns {{local: object|null, world: object|null,
     *            contributors: Array<{path: string, type: string, source: string}>,
     *            skipped: Array<{path: string, reason: string}>}}
     */
    computeSubtree(doc, nodeIdx) {
        const out = { contributors: [], skipped: [], boxes: [] };
        this.#enter(doc, nodeIdx, mat4Identity(), doc.nodePath(nodeIdx) ?? '/', out, 0, true);

        let local = null;
        for (const box of out.boxes) {
            local = mergeAabb(local, transformAabb(box.aabb, box.matrix));
        }

        let world = null;
        if (local) {
            const worldMat = this.#worldMatrix(doc, nodeIdx);
            for (const box of out.boxes) {
                world = mergeAabb(world, transformAabb(box.aabb, mat4Multiply(worldMat, box.matrix)));
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
     * Walk a node: collect component boxes at `matrix` (maps the node's own
     * frame — TRS applied — to the queried node's frame), then descend.
     * When `excludeOwnTrs`, `matrix` is used as-is (query root / instance root).
     */
    #enter(doc, nodeIdx, matrix, label, out, depth, excludeOwnTrs) {
        const node = doc.getObject(nodeIdx);

        if (doc.isInstanceStub(nodeIdx)) {
            this.#enterStub(doc, nodeIdx, matrix, label, out, depth, excludeOwnTrs);
            return;
        }

        const m = excludeOwnTrs ? matrix : mat4Multiply(matrix, nodeTrsMat(node));
        this.#collectComponents(doc, nodeIdx, m, label, out);
        for (const childIdx of doc.childIndices(nodeIdx)) {
            const childLabel = `${label === '/' ? '' : label}/${doc.nodeName(childIdx) ?? '<unnamed>'}`;
            this.#enter(doc, childIdx, m, childLabel, out, depth, false);
        }
    }

    /** Collapsed instance: recurse into the source prefab with overrides applied */
    #enterStub(doc, stubIdx, matrix, label, out, depth, excludeOwnTrs) {
        if (depth >= MAX_INSTANCE_DEPTH) {
            out.skipped.push({ path: label, reason: 'prefab nesting too deep' });
            return;
        }
        const info = doc.getObject(doc.getObject(stubIdx)._prefab.__id__);
        const assetUuid = info.asset?.__uuid__;
        if (typeof assetUuid !== 'string') {
            out.skipped.push({ path: label, reason: 'instance has no asset uuid' });
            return;
        }
        let source;
        try {
            source = loadSourcePrefabByUuid(this.#ctx, assetUuid);
        } catch (err) {
            out.skipped.push({ path: label, reason: `source prefab unavailable: ${err.message}` });
            return;
        }
        const rootIdx = source.doc.root.idx;
        const rootNode = source.doc.getObject(rootIdx);

        // The stub's transform = source root TRS overridden per propertyOverrides
        const instance = doc.instanceOf(stubIdx);
        const trs = {
            pos: this.#overrideValue(doc, instance, info.fileId, '_lpos') ?? rootNode._lpos ?? IDENTITY_TRS.pos,
            rot: this.#overrideValue(doc, instance, info.fileId, '_lrot') ?? rootNode._lrot ?? IDENTITY_TRS.rot,
            scale: this.#overrideValue(doc, instance, info.fileId, '_lscale') ?? rootNode._lscale ?? IDENTITY_TRS.scale
        };
        const m = excludeOwnTrs ? matrix : mat4Multiply(matrix, trsToMat4(trs.pos, trs.rot, trs.scale));

        this.#collectComponents(source.doc, rootIdx, m, label, out);
        for (const childIdx of source.doc.childIndices(rootIdx)) {
            const childLabel = `${label}→${source.doc.nodeName(childIdx) ?? '<unnamed>'}`;
            this.#enter(source.doc, childIdx, m, childLabel, out, depth + 1, false);
        }
    }

    #overrideValue(doc, instance, rootFileId, prop) {
        if (!instance) return undefined;
        for (const ref of instance.propertyOverrides ?? []) {
            if (!isRef(ref)) continue;
            const o = doc.getObject(ref.__id__);
            if (o?.__type__ !== 'CCPropertyOverrideInfo') continue;
            const target = isRef(o.targetInfo) ? doc.getObject(o.targetInfo.__id__) : null;
            if (target?.localID?.length === 1 && target.localID[0] === rootFileId &&
                o.propertyPath.length === 1 && o.propertyPath[0] === prop) {
                return o.value;
            }
        }
        return undefined;
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

            if (comp.__type__ === 'cc.UITransform') {
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

    /** World matrix of a node (ancestors' TRS, instance stubs included) */
    #worldMatrix(doc, nodeIdx) {
        const chain = [];
        let idx = nodeIdx;
        const guard = new Set();
        while (idx !== undefined && !guard.has(idx)) {
            guard.add(idx);
            chain.unshift(idx);
            const parent = doc.getObject(idx)._parent;
            idx = isRef(parent) ? parent.__id__ : undefined;
        }
        let m = mat4Identity();
        for (const i of chain) {
            const node = doc.getObject(i);
            if (doc.isInstanceStub(i)) {
                const info = doc.getObject(node._prefab.__id__);
                const instance = doc.instanceOf(i);
                let pos = this.#overrideValue(doc, instance, info.fileId, '_lpos');
                let rot = this.#overrideValue(doc, instance, info.fileId, '_lrot');
                let scale = this.#overrideValue(doc, instance, info.fileId, '_lscale');
                if (pos === undefined || rot === undefined || scale === undefined) {
                    // Same fallback as #enterStub: the source prefab root's own TRS
                    const rootNode = this.#sourceRootNode(info);
                    pos ??= rootNode?._lpos ?? IDENTITY_TRS.pos;
                    rot ??= rootNode?._lrot ?? IDENTITY_TRS.rot;
                    scale ??= rootNode?._lscale ?? IDENTITY_TRS.scale;
                }
                m = mat4Multiply(m, trsToMat4(pos, rot, scale));
            } else {
                m = mat4Multiply(m, nodeTrsMat(node));
            }
        }
        return m;
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
