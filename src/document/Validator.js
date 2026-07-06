/**
 * Validator - structural invariants for scene/prefab documents
 *
 * Runs after every apply_edits batch and standalone via validate_document.
 * Errors block saving; warnings inform (they all occur in editor-authored
 * files too, e.g. stale euler/quat pairs).
 *
 * fileId scoping (verified on the golden corpus): instances of the same
 * prefab legitimately share fileIds, so uniqueness only applies to a prefab's
 * own definition objects (PrefabInfo with asset {__id__: 0} + CompPrefabInfo
 * on definition components). Node _id must be unique file-wide.
 */

import { isRef } from './SceneDocument.js';
import { loadSourcePrefabByUuid } from './instances.js';
import { fileIdTargets } from './targetOverrides.js';
import { eulerToQuat, quatApproxEquals } from '../utils/math3d.js';
import { VISUAL_ROOT_TYPES } from './componentTypes.js';

export class Validator {
    #doc;
    #assetIndex;
    #projectRoot;

    /**
     * @param {import('./SceneDocument.js').SceneDocument} doc
     * @param {object|null} [assetIndex] - Enables asset-existence checks
     * @param {{projectRoot?: string}} [options] - projectRoot additionally
     *   enables targetOverride resolution checks against source prefabs
     */
    constructor(doc, assetIndex = null, options = {}) {
        this.#doc = doc;
        this.#assetIndex = assetIndex;
        this.#projectRoot = options.projectRoot ?? null;
    }

    /**
     * @returns {{errors: string[], warnings: string[]}}
     */
    validate() {
        const errors = [];
        const warnings = [];

        this.#checkHead(errors);
        this.#checkReferences(errors);
        if (errors.length === 0) {
            // Graph checks assume resolvable refs
            this.#checkHierarchy(errors);
            this.#checkComponents(errors);
            this.#checkIds(errors);
            this.#checkTargetOverrides(errors, warnings);
            this.#checkRemovedComponents(errors, warnings);
            this.#checkReachability(warnings);
            this.#checkRotations(warnings);
            this.#checkWrapperRule(warnings);
            this.#checkInstanceRegistry(warnings);
            if (this.#assetIndex) this.#checkAssetRefs(warnings);
        }
        return { errors, warnings };
    }

    #checkHead(errors) {
        const head = this.#doc.objects[0];
        if (this.#doc.isScene) {
            if (!isRef(head.scene)) errors.push('cc.SceneAsset at index 0 has no scene reference');
        } else if (this.#doc.isPrefab) {
            if (!isRef(head.data)) errors.push('cc.Prefab at index 0 has no data reference');
        } else {
            errors.push(`Unexpected head object "${head.__type__}" (want cc.SceneAsset or cc.Prefab)`);
        }
    }

    #checkReferences(errors) {
        const max = this.#doc.objects.length;
        const walk = (idx, value, trail) => {
            if (value === null || typeof value !== 'object') return;
            if (isRef(value)) {
                const target = value.__id__;
                if (!Number.isInteger(target) || target < 0 || target >= max) {
                    errors.push(`#${idx}.${trail}: dangling __id__ ${target} (document has ${max} objects)`);
                }
                return;
            }
            if (Array.isArray(value)) {
                value.forEach((v, i) => walk(idx, v, `${trail}[${i}]`));
                return;
            }
            for (const key of Object.keys(value)) {
                if (key !== '__id__') walk(idx, value[key], trail ? `${trail}.${key}` : key);
            }
        };
        this.#doc.objects.forEach((obj, idx) => walk(idx, obj, ''));
    }

    #checkHierarchy(errors) {
        const doc = this.#doc;
        doc.objects.forEach((obj, idx) => {
            if (!doc.isNode(obj)) return;

            // parent ↔ children must be bidirectional
            if (isRef(obj._parent)) {
                const parent = doc.getObject(obj._parent.__id__);
                if (!doc.isNode(parent)) {
                    errors.push(`node #${idx} "${obj._name}": _parent #${obj._parent.__id__} is not a node`);
                } else if (!(parent._children ?? []).some(r => isRef(r) && r.__id__ === idx)) {
                    errors.push(`node #${idx} "${obj._name}": missing from parent's _children`);
                }
            }
            for (const ref of obj._children ?? []) {
                if (!isRef(ref)) {
                    errors.push(`node #${idx} "${obj._name}": _children holds a non-reference entry`);
                    continue;
                }
                const child = doc.getObject(ref.__id__);
                if (!doc.isNode(child)) {
                    errors.push(`node #${idx} "${obj._name}": child #${ref.__id__} is not a node`);
                } else if (!isRef(child._parent) || child._parent.__id__ !== idx) {
                    errors.push(`node #${idx} "${obj._name}": child #${ref.__id__} does not point back via _parent`);
                }
            }
        });
    }

    #checkComponents(errors) {
        const doc = this.#doc;
        doc.objects.forEach((obj, idx) => {
            if (!doc.isNode(obj)) return;
            for (const ref of obj._components ?? []) {
                if (!isRef(ref)) {
                    errors.push(`node #${idx} "${obj._name}": _components holds a non-reference entry`);
                    continue;
                }
                const comp = doc.getObject(ref.__id__);
                if (!comp || doc.isNode(comp)) {
                    errors.push(`node #${idx} "${obj._name}": component #${ref.__id__} is not a component`);
                } else if (!isRef(comp.node) || comp.node.__id__ !== idx) {
                    errors.push(
                        `node #${idx} "${obj._name}": component ${comp.__type__} #${ref.__id__} ` +
                        `does not point back via .node`
                    );
                }
            }
        });
    }

    #checkIds(errors) {
        const doc = this.#doc;

        // Node/component _id: unique when present
        const seenIds = new Map();
        doc.objects.forEach((obj, idx) => {
            if (typeof obj._id === 'string' && obj._id !== '') {
                if (seenIds.has(obj._id)) {
                    errors.push(`duplicate _id "${obj._id}" (#${seenIds.get(obj._id)} and #${idx})`);
                }
                seenIds.set(obj._id, idx);
            }
        });

        // Definition-scope fileIds: PrefabInfo owned by this file's prefab +
        // CompPrefabInfo (prefab files only — instances in scenes may repeat)
        const seenFileIds = new Map();
        const checkFileId = (fileId, idx) => {
            if (typeof fileId !== 'string' || fileId === '') return;
            if (seenFileIds.has(fileId)) {
                errors.push(`duplicate definition fileId "${fileId}" (#${seenFileIds.get(fileId)} and #${idx})`);
            }
            seenFileIds.set(fileId, idx);
        };
        doc.objects.forEach((obj, idx) => {
            if (obj.__type__ === 'cc.PrefabInfo' &&
                isRef(obj.asset) && obj.asset.__id__ === 0 && !obj.instance) {
                checkFileId(obj.fileId, idx);
            }
            if (doc.isPrefab && obj.__type__ === 'cc.CompPrefabInfo') {
                checkFileId(obj.fileId, idx);
            }
        });

        if (doc.isScene) {
            doc.objects.forEach((obj, idx) => {
                if (obj.__type__ === 'cc.Node' && (!obj._id || obj._id === '') &&
                    !doc.isInstanceStub(idx)) {
                    errors.push(`scene node #${idx} "${obj._name}" has no _id`);
                }
            });
        }
    }

    /**
     * cc.TargetOverrideInfo invariants (references into collapsed instances).
     * Structural violations are errors; anything that also occurs in
     * editor-authored files stays a warning — the golden corpus must
     * validate with 0 errors.
     */
    #checkTargetOverrides(errors, warnings) {
        const doc = this.#doc;
        const resolvable = this.#assetIndex && this.#projectRoot
            ? { assetIndex: this.#assetIndex, projectRoot: this.#projectRoot }
            : null;
        const targetMaps = new Map(); // asset uuid → fileIdTargets map | null

        doc.objects.forEach((obj, idx) => {
            if (obj.__type__ !== 'cc.TargetOverrideInfo') return;
            const at = `TargetOverrideInfo #${idx}`;

            if (!Array.isArray(obj.propertyPath) || obj.propertyPath.length === 0 ||
                obj.propertyPath.some(s => typeof s !== 'string')) {
                errors.push(`${at}: propertyPath must be a non-empty array of strings`);
            }

            const info = isRef(obj.targetInfo) ? doc.getObject(obj.targetInfo.__id__) : null;
            if (info?.__type__ !== 'cc.TargetInfo' ||
                !Array.isArray(info.localID) || info.localID.length === 0 ||
                info.localID.some(s => typeof s !== 'string')) {
                errors.push(`${at}: targetInfo must reference a cc.TargetInfo with a non-empty string localID`);
            }

            if (!isRef(obj.source)) {
                errors.push(`${at}: source must reference an object in this file`);
            } else if (obj.sourceInfo === null) {
                const src = doc.getObject(obj.source.__id__);
                if (!src || doc.isNode(src)) {
                    errors.push(`${at}: sourceInfo is null but source #${obj.source.__id__} is not a component`);
                }
            } else {
                const srcInfo = isRef(obj.sourceInfo) ? doc.getObject(obj.sourceInfo.__id__) : null;
                if (srcInfo?.__type__ !== 'cc.TargetInfo') {
                    errors.push(`${at}: sourceInfo must be null or reference a cc.TargetInfo`);
                }
                if (!doc.isNode(doc.getObject(obj.source.__id__))) {
                    errors.push(`${at}: sourceInfo is set but source #${obj.source.__id__} is not a node`);
                } else if (!doc.isInstanceStub(obj.source.__id__)) {
                    warnings.push(
                        `${at}: sourceInfo is set but source "${doc.nodePath(obj.source.__id__)}" ` +
                        `is not a prefab instance — the engine cannot resolve the source`
                    );
                } else if (resolvable && Array.isArray(srcInfo?.localID) && srcInfo.localID.length === 1) {
                    const targets = this.#sourcePrefabTargets(obj.source.__id__, targetMaps);
                    if (targets && !targets.has(srcInfo.localID[0])) {
                        warnings.push(
                            `${at}: sourceInfo localID "${srcInfo.localID[0]}" does not resolve ` +
                            `in the source prefab of "${doc.nodePath(obj.source.__id__)}"`
                        );
                    }
                }
            }

            if (obj.target !== null) {
                if (!isRef(obj.target) || !doc.isNode(doc.getObject(obj.target.__id__))) {
                    errors.push(`${at}: target must be null or reference a node`);
                    return;
                }
            }

            // A live override shadows the serialized value on load — a
            // non-null serialized value is a silent surprise.
            if (obj.sourceInfo === null && isRef(obj.source) &&
                Array.isArray(obj.propertyPath) && obj.propertyPath.length > 0) {
                let value = doc.getObject(obj.source.__id__);
                for (const seg of obj.propertyPath) {
                    if (value === null || typeof value !== 'object') { value = undefined; break; }
                    value = value[seg];
                }
                if (value !== null && value !== undefined) {
                    warnings.push(
                        `${at}: source property "${obj.propertyPath.join('.')}" has a non-null ` +
                        `serialized value that the target override will overwrite on load`
                    );
                }
            }

            // Resolution checks (warnings): single-hop localID against the
            // target stub's source prefab; unresolvable prefabs are skipped
            // (the missing-asset warning already covers them).
            if (!resolvable || !isRef(obj.target)) return;
            const stubIdx = obj.target.__id__;
            if (!doc.isInstanceStub(stubIdx)) return;
            const localID = info?.localID;
            if (!Array.isArray(localID) || localID.length !== 1) return;

            const targets = this.#sourcePrefabTargets(stubIdx, targetMaps);
            if (targets && !targets.has(localID[0])) {
                warnings.push(
                    `${at}: localID "${localID[0]}" does not resolve in the source prefab ` +
                    `of "${doc.nodePath(stubIdx)}" — the reference will be lost on load`
                );
            }
        });
    }

    /**
     * fileIdTargets map of a stub's source prefab, cached per asset uuid.
     * Requires assetIndex + projectRoot; null when the prefab is unreadable
     * (the missing-asset warning already covers that).
     */
    #sourcePrefabTargets(stubIdx, cache) {
        const doc = this.#doc;
        const assetUuid = doc.getObject(doc.getObject(stubIdx)._prefab.__id__).asset?.__uuid__;
        if (typeof assetUuid !== 'string') return null;
        if (!cache.has(assetUuid)) {
            try {
                const { doc: sourceDoc } = loadSourcePrefabByUuid(
                    { assetIndex: this.#assetIndex, projectRoot: this.#projectRoot }, assetUuid);
                cache.set(assetUuid, fileIdTargets(sourceDoc));
            } catch {
                cache.set(assetUuid, null);
            }
        }
        return cache.get(assetUuid);
    }

    /**
     * cc.PrefabInstance.removedComponents invariants: entries are
     * cc.TargetInfo references with string localIDs (errors); with a
     * project available, single-hop localIDs must resolve to a component
     * of the source prefab (warnings).
     */
    #checkRemovedComponents(errors, warnings) {
        const doc = this.#doc;
        const resolvable = this.#assetIndex && this.#projectRoot;
        const targetMaps = new Map();

        doc.objects.forEach((obj, idx) => {
            if (obj.__type__ !== 'cc.PrefabInstance') return;
            const rc = obj.removedComponents;
            if (rc === null || rc === undefined) return;
            if (!Array.isArray(rc)) {
                errors.push(`PrefabInstance #${idx}: removedComponents must be an array or null`);
                return;
            }
            const stubIdx = this.#stubOfInstance(idx);
            rc.forEach((r, i) => {
                const at = `PrefabInstance #${idx}.removedComponents[${i}]`;
                const info = isRef(r) ? doc.getObject(r.__id__) : null;
                if (info?.__type__ !== 'cc.TargetInfo' ||
                    !Array.isArray(info.localID) || info.localID.length === 0 ||
                    info.localID.some(s => typeof s !== 'string')) {
                    errors.push(`${at}: must reference a cc.TargetInfo with a non-empty string localID`);
                    return;
                }
                if (!resolvable || stubIdx === null || info.localID.length !== 1) return;
                const targets = this.#sourcePrefabTargets(stubIdx, targetMaps);
                const hit = targets?.get(info.localID[0]);
                if (targets && !hit) {
                    warnings.push(
                        `${at}: localID "${info.localID[0]}" does not resolve in the ` +
                        `source prefab of "${doc.nodePath(stubIdx)}" — the removal is a no-op`
                    );
                } else if (hit && !hit.component) {
                    warnings.push(
                        `${at}: localID "${info.localID[0]}" resolves to node "${hit.target}", ` +
                        `not a component — the removal is a no-op`
                    );
                }
            });
        });
    }

    /** The instance stub node owning a cc.PrefabInstance (PrefabInfo.root) */
    #stubOfInstance(instanceIdx) {
        const doc = this.#doc;
        for (const obj of doc.objects) {
            if (obj.__type__ === 'cc.PrefabInfo' &&
                isRef(obj.instance) && obj.instance.__id__ === instanceIdx && isRef(obj.root)) {
                return obj.root.__id__;
            }
        }
        return null;
    }

    #checkReachability(warnings) {
        const orphans = this.#doc.objects.length - this.#doc.reachableIds().size;
        if (orphans > 0) {
            warnings.push(`${orphans} unreachable objects (renumber/save will drop them)`);
        }
    }

    #checkRotations(warnings) {
        const doc = this.#doc;
        let stale = 0;
        doc.objects.forEach((obj) => {
            if (!doc.isNode(obj) || !obj._euler || !obj._lrot) return;
            if (!quatApproxEquals(eulerToQuat(obj._euler), obj._lrot)) stale++;
        });
        if (stale > 0) {
            warnings.push(
                `${stale} node(s) have _euler out of sync with _lrot ` +
                `(the runtime reads _lrot; also present in editor-saved files)`
            );
        }
    }

    #checkWrapperRule(warnings) {
        if (!this.#doc.isPrefab) return;
        const { idx } = this.#doc.root;
        for (const compIdx of this.#doc.componentIndices(idx)) {
            const type = this.#doc.getObject(compIdx).__type__;
            if (VISUAL_ROOT_TYPES.includes(type)) {
                warnings.push(
                    `wrapper rule: prefab root carries ${type} — prefer Root (logic, scale 1) → ` +
                    `Visual child (renderer with import scale), so tweens/colliders stay independent`
                );
            }
        }
    }

    /**
     * Every collapsed instance stub must be listed in the document's
     * registry: cc.Scene._prefab / prefab-root PrefabInfo →
     * nestedPrefabInstanceRoots (the editor keeps these in sync).
     */
    #checkInstanceRegistry(warnings) {
        const doc = this.#doc;
        const rootNode = doc.root.node;
        const registry = isRef(rootNode._prefab) ? doc.getObject(rootNode._prefab.__id__) : null;
        const listed = new Set(
            (Array.isArray(registry?.nestedPrefabInstanceRoots) ? registry.nestedPrefabInstanceRoots : [])
                .filter(isRef)
                .map(r => r.__id__)
        );
        const missing = [];
        doc.objects.forEach((obj, idx) => {
            if (!doc.isNode(obj) || idx === doc.root.idx) return;
            if (doc.isInstanceStub(idx) && !listed.has(idx)) missing.push(idx);
        });
        if (missing.length > 0) {
            warnings.push(
                `${missing.length} prefab instance(s) missing from the ` +
                `${doc.isScene ? 'scene' : 'prefab root'} registry (nestedPrefabInstanceRoots), ` +
                `e.g. "${doc.nodePath(missing[0])}"`
            );
        }
    }

    #checkAssetRefs(warnings) {
        const missing = new Map();
        const walk = (value) => {
            if (value === null || typeof value !== 'object') return;
            if (typeof value.__uuid__ === 'string') {
                if (!this.#assetIndex.resolve(value.__uuid__)) {
                    missing.set(value.__uuid__, (missing.get(value.__uuid__) ?? 0) + 1);
                }
                return;
            }
            if (Array.isArray(value)) { value.forEach(walk); return; }
            for (const key of Object.keys(value)) walk(value[key]);
        };
        this.#doc.objects.forEach(walk);
        if (missing.size > 0) {
            const sample = [...missing.keys()].slice(0, 5).join(', ');
            warnings.push(
                `${missing.size} referenced asset UUID(s) not found under assets/ ` +
                `(may be engine built-ins): ${sample}${missing.size > 5 ? ', …' : ''}`
            );
        }
    }
}
