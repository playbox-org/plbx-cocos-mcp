/**
 * Target overrides — @property references INTO collapsed prefab instances
 *
 * A reference from a document component to an object inside a collapsed
 * instance cannot serialize as {__id__}: the target object does not exist in
 * this file. The editor serializes the property as null and records a
 * cc.TargetOverrideInfo in the document registry (cc.Scene._prefab /
 * prefab-root PrefabInfo → targetOverrides):
 *
 *   { source: <component>, sourceInfo: null, propertyPath: ["detonatorView"],
 *     target: <instance stub node>, targetInfo: cc.TargetInfo{localID: [<fileId>]} }
 *
 * localID is the target's fileId in the SOURCE prefab (node PrefabInfo /
 * component CompPrefabInfo) — the same single-hop addressing instances.js
 * uses for CCPropertyOverrideInfo. On load the engine resolves target →
 * instance root → localID and overwrites the serialized null.
 *
 * Two write forms, both verified against the golden corpus:
 * - source is a plain component of this document → sourceInfo: null (B1);
 * - source itself lives inside a collapsed instance → source = that
 *   instance's stub node, sourceInfo = cc.TargetInfo{localID: [<component
 *   fileId>]} (B2; the engine resolves source through the stub's own
 *   targetMap — see applyTargetOverrides in the 3.8.7 engine sources).
 * Always single-hop localID. Reading tolerates the remaining editor forms
 * (target: null, multi-hop) but never generates them.
 *
 * SOLID: S - target-override machinery only; generic ops stay in
 * operations.js, instance machinery in instances.js
 */

import { isRef } from './SceneDocument.js';
import { OperationError, findComponent, resolveAssetValue } from './operations.js';
import {
    loadSourcePrefabByUuid, registryInfo, nodeFileId, componentFileId,
    findMountedComponent
} from './instances.js';

// -------------------------------------------------------------- resolution

/**
 * Resolve a node reference whose path may continue INSIDE a collapsed
 * instance ("Detonator/DetonatorMesh" where "Detonator" is a stub).
 *
 * @returns {null} when the ref resolves entirely in this document (plain
 *   node or the stub itself) — caller should use the regular {__id__} form;
 * @returns {{stubIdx, sourceDoc, targetIdx, label}} when a path prefix lands
 *   on a stub and the remainder resolves inside its source prefab.
 * @throws the original resolution error when the node exists nowhere.
 */
export function resolveIntoInstance(doc, ref, ctx) {
    let resolveError;
    try {
        doc.resolveNode(ref);
        return null;
    } catch (err) {
        resolveError = err;
    }

    if (typeof ref !== 'string' || !ref.includes('/')) throw resolveError;
    const segments = ref.replace(/^\//, '').split('/');
    // Longest resolvable prefix wins; a non-stub prefix means the node is
    // genuinely missing — surface the original error.
    for (let cut = segments.length - 1; cut >= 1; cut--) {
        const prefix = segments.slice(0, cut).join('/');
        let prefixIdx;
        try {
            prefixIdx = doc.resolveNode(prefix);
        } catch {
            continue;
        }
        if (!doc.isInstanceStub(prefixIdx)) throw resolveError;
        return openStub(doc, prefixIdx, segments.slice(cut).join('/'), ctx);
    }
    throw resolveError;
}

/** Load a stub's source prefab and resolve an internal path (default root) */
function openStub(doc, stubIdx, innerPath, ctx) {
    const info = doc.getObject(doc.getObject(stubIdx)._prefab.__id__);
    if (typeof info.asset?.__uuid__ !== 'string') {
        throw new OperationError('Instance PrefabInfo has no asset UUID — file is malformed');
    }
    const { doc: sourceDoc, label } = loadSourcePrefabByUuid(ctx, info.asset.__uuid__);

    const targetRef = innerPath === undefined || innerPath === '' ? '/' : innerPath;
    let targetIdx;
    try {
        targetIdx = sourceDoc.resolveNode(targetRef);
    } catch (err) {
        if (/collapsed prefab instance/.test(err.message)) {
            throw new OperationError(
                `"${targetRef}" continues inside a nested prefab instance of ${label} — ` +
                `references into nested instances are not supported. Edit that prefab's source asset instead.`
            );
        }
        throw new OperationError(`In source prefab ${label}: ${err.message}`);
    }
    if (sourceDoc.isInstanceStub(targetIdx)) {
        throw new OperationError(
            `"${targetRef}" is itself a nested prefab instance inside ${label} — ` +
            `references into nested instances are not supported. Edit that prefab's source asset instead.`
        );
    }
    return { stubIdx, sourceDoc, targetIdx, label };
}

/**
 * {"$node": ref} pointing THROUGH a stub → {stubIdx, localID}, else null
 * (a ref landing exactly on the stub stays a regular {__id__} — the stub is
 * a legal node of this document).
 */
export function detectNodeInstanceRef(doc, ref, ctx) {
    const hit = resolveIntoInstance(doc, ref, ctx);
    if (!hit) return null;
    return { stubIdx: hit.stubIdx, localID: [nodeFileId(hit.sourceDoc, hit.targetIdx, hit.label)] };
}

/**
 * {"$component": spec} whose node is (or continues into) a stub →
 * {stubIdx, localID}, else null. spec.target optionally addresses the node
 * inside the source prefab (default: its root), like set_instance_property.
 * A component MOUNTED on the stub is a plain object of this file — it wins
 * over source-prefab lookup and returns {direct: compIdx} for a regular
 * {__id__} reference (the golden scene references mounted components that
 * way).
 */
export function detectComponentInstanceRef(doc, spec, ctx) {
    let hit = null;
    let exactIdx = null;
    try {
        exactIdx = doc.resolveNode(spec.node);
    } catch (err) {
        hit = resolveIntoInstance(doc, spec.node, ctx); // rethrows err when no stub is on the way
    }
    if (exactIdx !== null) {
        if (!doc.isInstanceStub(exactIdx)) return null;
        if (spec.target === undefined) {
            const mounted = findMountedComponent(doc, exactIdx,
                { component: spec.type, componentIndex: spec.componentIndex }, ctx,
                { optional: true });
            if (mounted) return { direct: mounted.compIdx };
        }
        hit = openStub(doc, exactIdx, spec.target ?? '/', ctx);
    } else if (spec.target !== undefined) {
        throw new OperationError(
            `$component: "target" only applies when "node" is the instance stub itself ` +
            `(got a path through the instance: "${spec.node}")`
        );
    }

    let compIdx;
    try {
        compIdx = findComponent(hit.sourceDoc, hit.targetIdx, spec.type, spec.componentIndex, ctx);
    } catch (err) {
        throw new OperationError(`In source prefab ${hit.label}: ${err.message}`);
    }
    return { stubIdx: hit.stubIdx, localID: [componentFileId(hit.sourceDoc, compIdx, hit.label)] };
}

// ---------------------------------------------------------- value transform

/**
 * transformValue twin that additionally recognizes $node/$component values
 * pointing inside collapsed instances: those serialize as null and are
 * collected into `refs` as {path: string[], stubIdx, localID} for the caller
 * to turn into TargetOverrideInfo entries. All other forms behave exactly
 * like operations.js transformValue.
 */
export function transformValueTracked(doc, value, ctx, refs, path = []) {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) {
        return value.map((v, i) => transformValueTracked(doc, v, ctx, refs, [...path, String(i)]));
    }
    if ('$node' in value) {
        const hit = detectNodeInstanceRef(doc, value.$node, ctx);
        if (hit) {
            refs.push({ path, ...hit });
            return null;
        }
        return { __id__: doc.resolveNode(value.$node) };
    }
    if ('$component' in value) {
        const spec = value.$component;
        const hit = detectComponentInstanceRef(doc, spec, ctx);
        if (hit?.direct !== undefined) return { __id__: hit.direct };
        if (hit) {
            refs.push({ path, stubIdx: hit.stubIdx, localID: hit.localID });
            return null;
        }
        const nodeIdx = doc.resolveNode(spec.node);
        return { __id__: findComponent(doc, nodeIdx, spec.type, spec.componentIndex, ctx) };
    }
    if ('$asset' in value) {
        return resolveAssetValue(ctx, value.$asset, value.$type);
    }
    // Plain object (e.g. a cc.ClickEvent literal): $-forms may hide inside
    const out = {};
    for (const [key, v] of Object.entries(value)) {
        out[key] = transformValueTracked(doc, v, ctx, refs, [...path, key]);
    }
    return out;
}

// ------------------------------------------------------------ registry CRUD

/** The registry PrefabInfo when it already exists (never creates one) */
function existingRegistry(doc) {
    const root = doc.root.node;
    return isRef(root._prefab) ? doc.getObject(root._prefab.__id__) : null;
}

/** True when the override's sourceInfo matches (null ↔ null, else localID) */
function sameSourceInfo(doc, obj, sourceLocalID) {
    if (sourceLocalID === null) return obj.sourceInfo === null;
    const info = isRef(obj.sourceInfo) ? doc.getObject(obj.sourceInfo.__id__) : null;
    return info?.__type__ === 'cc.TargetInfo' && samePath(info.localID, sourceLocalID);
}

/**
 * Create or update the TargetOverrideInfo for (source, sourceInfo,
 * propertyPath). sourceLocalID = null → plain-component source (B1 form);
 * an array → source is a component INSIDE the instance whose stub is
 * `sourceIdx` (B2 form, golden scene shape). TargetInfo objects are appended
 * right after their override — sourceInfo before targetInfo, matching key
 * order — so renumber() is an identity on canonical docs.
 */
export function upsertTargetOverride(doc, ctx, { sourceIdx, sourceLocalID = null, propertyPath, stubIdx, localID }) {
    const registry = registryInfo(doc, ctx);
    if (!Array.isArray(registry.targetOverrides)) registry.targetOverrides = [];

    const existing = overrideEntries(doc, registry).find(({ obj }) =>
        isRef(obj.source) && obj.source.__id__ === sourceIdx &&
        sameSourceInfo(doc, obj, sourceLocalID) && samePath(obj.propertyPath, propertyPath));
    if (existing) {
        existing.obj.target = { __id__: stubIdx };
        const info = isRef(existing.obj.targetInfo) ? doc.getObject(existing.obj.targetInfo.__id__) : null;
        if (info) {
            info.localID = [...localID];
        } else {
            existing.obj.targetInfo = {
                __id__: doc.addObject({ __type__: 'cc.TargetInfo', localID: [...localID] })
            };
        }
        return;
    }

    const override = {
        __type__: 'cc.TargetOverrideInfo',
        source: { __id__: sourceIdx },
        sourceInfo: null, // wired below for in-instance sources
        propertyPath: [...propertyPath],
        target: { __id__: stubIdx },
        targetInfo: null // wired below
    };
    const overrideIdx = doc.addObject(override);
    if (sourceLocalID !== null) {
        override.sourceInfo = {
            __id__: doc.addObject({ __type__: 'cc.TargetInfo', localID: [...sourceLocalID] })
        };
    }
    override.targetInfo = {
        __id__: doc.addObject({ __type__: 'cc.TargetInfo', localID: [...localID] })
    };
    registry.targetOverrides.push({ __id__: overrideIdx });
}

/**
 * Remove every override of source (`sourceIdx`, `sourceLocalID`) whose
 * propertyPath equals or extends `pathPrefix` (a whole-array write covers
 * its element overrides). With the default sourceLocalID = null only
 * plain-component-source entries match — in-instance-source forms are
 * addressed by their own (stub, localID) pair and never touched by accident.
 * @returns {number} removed count
 */
export function dropTargetOverrides(doc, sourceIdx, pathPrefix, { sourceLocalID = null } = {}) {
    const registry = existingRegistry(doc);
    if (!registry || !Array.isArray(registry.targetOverrides)) return 0;
    const before = registry.targetOverrides.length;
    registry.targetOverrides = registry.targetOverrides.filter(r => {
        if (!isRef(r)) return true;
        const obj = doc.getObject(r.__id__);
        if (obj?.__type__ !== 'cc.TargetOverrideInfo') return true;
        if (!isRef(obj.source) || obj.source.__id__ !== sourceIdx) return true;
        if (!sameSourceInfo(doc, obj, sourceLocalID)) return true;
        return !pathStartsWith(obj.propertyPath, pathPrefix);
    });
    return before - registry.targetOverrides.length;
}

/**
 * An array splice on a component property shifts the numeric segment of
 * every TargetOverrideInfo.propertyPath running THROUGH that array (review
 * #3): after remove_array_element {index: 0}, ['entries','2','target'] must
 * become ['entries','1','target'] — and an override addressing the removed
 * element itself must be dropped — or the engine applies the override to the
 * WRONG element on load. Only plain-component-source records (B1 form,
 * sourceInfo: null) can address this document's arrays; that includes
 * overrides sourced from mounted components.
 *
 * @param {number} sourceIdx - component whose array property was spliced
 * @param {string[]} arrayPath - path segments of the array property
 * @param {{removed?: number, inserted?: number}} splice - the index removed
 *   (drop exact match, shift later ones -1) or inserted (shift >= it +1)
 * @returns {{dropped: number, shifted: number}}
 */
export function remapTargetOverridesForSplice(doc, sourceIdx, arrayPath, { removed, inserted }) {
    // Only the root PrefabInfo registry is scanned — unlike findDanglingOverrides,
    // which walks every PrefabInfo.targetOverrides. This rests on a design
    // invariant, not a scan: a LIVE, array-index-addressing override is always
    // hosted on the root registry. Non-root (per-stub) targetOverrides either
    // address instance internals (which insert/remove_array_element never splice
    // — instance content is edited only through property overrides) or are dead
    // by overrideDeadReasons (the engine skips them on load, so a stale index is
    // moot). The golden corpus holds no live non-root array-index override.
    const registry = existingRegistry(doc);
    if (!registry || !Array.isArray(registry.targetOverrides)) return { dropped: 0, shifted: 0 };
    let shifted = 0;
    const dead = new Set();
    for (const r of registry.targetOverrides) {
        if (!isRef(r)) continue;
        const obj = doc.getObject(r.__id__);
        if (obj?.__type__ !== 'cc.TargetOverrideInfo') continue;
        if (!isRef(obj.source) || obj.source.__id__ !== sourceIdx) continue;
        if (obj.sourceInfo !== null) continue;
        const p = obj.propertyPath;
        if (!pathStartsWith(p, arrayPath) || p.length <= arrayPath.length) continue;
        const seg = p[arrayPath.length];
        if (!/^\d+$/.test(String(seg))) continue;
        const idx = Number(seg);
        if (removed !== undefined) {
            if (idx === removed) {
                dead.add(r.__id__); // its element is gone — the record with it
            } else if (idx > removed) {
                p[arrayPath.length] = String(idx - 1);
                shifted++;
            }
        } else if (inserted !== undefined && idx >= inserted) {
            p[arrayPath.length] = String(idx + 1);
            shifted++;
        }
    }
    if (dead.size > 0) {
        // Dropped records (and their TargetInfo objects) become unreachable
        // and are GC'd on renumber, like dropTargetOverrides.
        registry.targetOverrides = registry.targetOverrides.filter(
            r => !(isRef(r) && dead.has(r.__id__)));
    }
    return { dropped: dead.size, shifted };
}

/**
 * Remove every override whose TARGET is the object addressed by
 * (stubIdx, localID) — used when that in-instance object ceases to exist
 * (component recorded in removedComponents).
 * @returns {number} removed count
 */
export function dropTargetOverridesInto(doc, stubIdx, localID) {
    const registry = existingRegistry(doc);
    if (!registry || !Array.isArray(registry.targetOverrides)) return 0;
    const before = registry.targetOverrides.length;
    registry.targetOverrides = registry.targetOverrides.filter(r => {
        if (!isRef(r)) return true;
        const obj = doc.getObject(r.__id__);
        if (obj?.__type__ !== 'cc.TargetOverrideInfo') return true;
        if (!isRef(obj.target) || obj.target.__id__ !== stubIdx) return true;
        const info = isRef(obj.targetInfo) ? doc.getObject(obj.targetInfo.__id__) : null;
        return !(info?.__type__ === 'cc.TargetInfo' && samePath(info.localID, localID));
    });
    return before - registry.targetOverrides.length;
}

// ------------------------------------------------------------ dangling prune

/**
 * Structurally dead TargetOverrideInfo records: broken forms the engine
 * skips on load (applyTargetOverrides bails on an unresolvable endpoint)
 * but that block apply_edits because they fail validation. Editor-authored
 * benign forms are NOT flagged — target: null occurs in the golden corpus
 * and stays. Scans every PrefabInfo.targetOverrides array (the editor
 * leaves stale records on instance-stub PrefabInfos too, not just the
 * document root registry).
 *
 * @returns {Array<{ownerIdx: number, idx: number, obj: object,
 *   propertyPath: string, reasons: string[]}>}
 */
export function findDanglingOverrides(doc) {
    const dead = [];
    const mountedNodes = mountedChildNodeIdxs(doc);
    doc.objects.forEach((owner, ownerIdx) => {
        if (owner.__type__ !== 'cc.PrefabInfo' || !Array.isArray(owner.targetOverrides)) return;
        for (const ref of owner.targetOverrides) {
            if (!isRef(ref)) continue;
            const obj = doc.getObject(ref.__id__);
            if (obj?.__type__ !== 'cc.TargetOverrideInfo') continue;
            const reasons = overrideDeadReasons(doc, obj, mountedNodes);
            if (reasons.length > 0) {
                dead.push({
                    ownerIdx,
                    idx: ref.__id__,
                    obj,
                    propertyPath: Array.isArray(obj.propertyPath)
                        ? obj.propertyPath.join('.') : String(obj.propertyPath),
                    reasons
                });
            }
        }
    });
    return dead;
}

/**
 * Node indices that are mounted children of an instance (roots + their whole
 * subtrees). These are serialized with `_parent: null`, so `nodePath()`
 * returns null for them even though the engine resolves them at load — they
 * must NOT be treated as "detached" by the dangling-override check.
 */
export function mountedChildNodeIdxs(doc) {
    const set = new Set();
    const addSubtree = (idx) => {
        if (set.has(idx)) return;
        set.add(idx);
        for (const child of doc.childIndices(idx)) addSubtree(child);
    };
    doc.objects.forEach((obj) => {
        if (obj?.__type__ !== 'cc.MountedChildrenInfo' || !Array.isArray(obj.nodes)) return;
        for (const r of obj.nodes) if (isRef(r)) addSubtree(r.__id__);
    });
    return set;
}

/** A node still resolvable at load: attached to the scene, or a mounted child */
function nodeAttached(doc, nodeIdx, mountedNodes) {
    return doc.nodePath(nodeIdx) !== null || mountedNodes.has(nodeIdx);
}

/** Why the engine would skip this record on load ([] = record is live) */
export function overrideDeadReasons(doc, obj, mountedNodes = new Set()) {
    const reasons = [];

    if (!isRef(obj.source)) {
        reasons.push('source is null — the referencing component no longer exists');
    } else {
        const src = doc.getObject(obj.source.__id__);
        const ownerNodeIdx = doc.isNode(src) ? obj.source.__id__
            : isRef(src?.node) ? src.node.__id__ : null;
        if (ownerNodeIdx === null || !nodeAttached(doc, ownerNodeIdx, mountedNodes)) {
            reasons.push('source is detached from the node hierarchy');
        }
    }

    if (!Array.isArray(obj.propertyPath) || obj.propertyPath.length === 0 ||
        obj.propertyPath.some(s => typeof s !== 'string')) {
        reasons.push('propertyPath is empty or invalid');
    }

    const info = isRef(obj.targetInfo) ? doc.getObject(obj.targetInfo.__id__) : null;
    if (info?.__type__ !== 'cc.TargetInfo' ||
        !Array.isArray(info.localID) || info.localID.length === 0 ||
        info.localID.some(s => typeof s !== 'string')) {
        reasons.push('targetInfo is missing or invalid');
    }

    // target: null is a legal editor form (kept); a reference must land on
    // a node that is still attached to the hierarchy.
    if (obj.target !== null && obj.target !== undefined) {
        if (!isRef(obj.target)) {
            reasons.push('target is not a reference');
        } else if (!doc.isNode(doc.getObject(obj.target.__id__))) {
            reasons.push('target is not a node');
        } else if (!nodeAttached(doc, obj.target.__id__, mountedNodes)) {
            reasons.push('target node is detached from the node hierarchy');
        }
    }
    return reasons;
}

/**
 * Remove every dangling record found by findDanglingOverrides from its
 * owning PrefabInfo. An emptied targetOverrides array becomes null (the
 * editor's no-overrides form). Orphaned TargetInfo objects and detached
 * target nodes become unreachable and are dropped by renumber().
 *
 * @returns {Array<{propertyPath: string, reasons: string[]}>} removed records
 */
export function pruneDanglingOverrides(doc) {
    const dead = findDanglingOverrides(doc);
    const deadIds = new Set(dead.map(d => d.idx));
    for (const ownerIdx of new Set(dead.map(d => d.ownerIdx))) {
        const owner = doc.getObject(ownerIdx);
        owner.targetOverrides = owner.targetOverrides.filter(
            r => !(isRef(r) && deadIds.has(r.__id__)));
        if (owner.targetOverrides.length === 0) owner.targetOverrides = null;
    }
    return dead.map(({ propertyPath, reasons }) => ({ propertyPath, reasons }));
}

// ------------------------------------------------------------ read helpers

/**
 * All TargetOverrideInfo entries of a document's registry.
 * @returns {Array<{ref: object, obj: object, idx: number}>}
 */
export function listTargetOverrides(doc) {
    const registry = existingRegistry(doc);
    return registry ? overrideEntries(doc, registry) : [];
}

/**
 * fileId → {target, component} over a source prefab document: node
 * PrefabInfo.fileId and component CompPrefabInfo.fileId, keyed the way
 * cc.TargetInfo.localID references them (single-hop). `target` is the
 * node path relative to the prefab root ("/" = root).
 */
export function fileIdTargets(sourceDoc) {
    const map = new Map();
    const rootIdx = sourceDoc.root.idx;
    const walk = (idx) => {
        const node = sourceDoc.getObject(idx);
        const target = idx === rootIdx ? '/' : sourceDoc.nodePath(idx);
        if (isRef(node._prefab)) {
            const info = sourceDoc.getObject(node._prefab.__id__);
            if (typeof info?.fileId === 'string' && info.fileId !== '') {
                map.set(info.fileId, { target, component: null });
            }
        }
        for (const compIdx of sourceDoc.componentIndices(idx)) {
            const comp = sourceDoc.getObject(compIdx);
            if (!isRef(comp?.__prefab)) continue;
            const info = sourceDoc.getObject(comp.__prefab.__id__);
            if (typeof info?.fileId === 'string' && info.fileId !== '') {
                map.set(info.fileId, { target, component: comp.__type__ });
            }
        }
        for (const childIdx of sourceDoc.childIndices(idx)) walk(childIdx);
    };
    walk(rootIdx);
    return map;
}

function overrideEntries(doc, registry) {
    return (registry.targetOverrides ?? [])
        .filter(isRef)
        .map(r => ({ ref: r, obj: doc.getObject(r.__id__), idx: r.__id__ }))
        .filter(e => e.obj?.__type__ === 'cc.TargetOverrideInfo');
}

function samePath(a, b) {
    return Array.isArray(a) && Array.isArray(b) &&
        a.length === b.length && a.every((v, i) => v === b[i]);
}

function pathStartsWith(fullPath, prefix) {
    return Array.isArray(fullPath) && Array.isArray(prefix) &&
        fullPath.length >= prefix.length && prefix.every((seg, i) => fullPath[i] === seg);
}
