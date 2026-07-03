/**
 * Prefab-instance operations
 *
 * Instances are serialized COLLAPSED (verified on the golden corpus): a stub
 * node {_parent, _prefab, __editorExtras__} + cc.PrefabInfo {asset, fileId:
 * <source root fileId>, instance} + cc.PrefabInstance {propertyOverrides}.
 * All instance state lives in CCPropertyOverrideInfo objects addressed by
 * cc.TargetInfo {localID: [fileId]} — fileIds come from the SOURCE prefab
 * (node PrefabInfo.fileId / component CompPrefabInfo.fileId), which is the
 * "fileId mapping" this module implements.
 *
 * Scope: single-hop localID only. Targets inside nested instances of
 * the source prefab (multi-hop localID), mountedChildren/mountedComponents
 * and removedComponents are not implemented yet.
 *
 * SOLID: S - instance machinery only; generic ops stay in operations.js
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { SceneDocument, isRef } from './SceneDocument.js';
import {
    OperationError, requireString, resolveEditableNode, mergeTyped, parsePropertyPath,
    findComponent, transformValue, normalizeNodeProperty, describeComponentType
} from './operations.js';
import { generateFileId } from '../utils/fileId.js';
import { eulerToQuat } from '../utils/math3d.js';

const MAX_NESTING_SCAN_DEPTH = 8;

// ------------------------------------------------------- source resolution

/**
 * Resolve a prefab reference into a loadable source document.
 * Accepts .prefab assets, gltf-scene sub-assets ("Coin.fbx@4b8b9") and
 * model files with a single gltf-scene (sugar: "Models/Coin.fbx").
 * Compiled model prefabs are read from library/.
 *
 * @returns {{assetUuid: string, doc: SceneDocument, label: string}}
 */
export function loadSourcePrefab(ctx, ref) {
    if (!ctx.assetIndex) {
        throw new OperationError('Prefab resolution requires a project (assetIndex unavailable)');
    }
    if (!ctx.projectRoot) {
        throw new OperationError('Prefab resolution requires ctx.projectRoot');
    }

    const resolved = ctx.assetIndex.resolve(ref);
    if (!resolved) {
        throw new OperationError(`Prefab asset not found: "${ref}" (checked path, UUID, compressed UUID)`);
    }
    const { entry } = resolved;
    let { subAsset } = resolved;

    let assetUuid;
    if (subAsset) {
        if (subAsset.importer !== 'gltf-scene') {
            throw new OperationError(
                `"${ref}" is a ${subAsset.importer}, not an instantiable prefab (gltf-scene/.prefab)`
            );
        }
        assetUuid = `${entry.uuid}@${subAsset.id}`;
    } else if (entry.importer === 'prefab') {
        assetUuid = entry.uuid;
    } else if (entry.importer === 'fbx' || entry.importer === 'gltf') {
        const scenes = entry.subAssets.filter(s => s.importer === 'gltf-scene');
        if (scenes.length !== 1) {
            throw new OperationError(
                `"${ref}" has ${scenes.length} gltf-scene sub-assets — reference one explicitly ` +
                `(${entry.path}@<subId>)`
            );
        }
        subAsset = scenes[0];
        assetUuid = `${entry.uuid}@${subAsset.id}`;
    } else {
        throw new OperationError(
            `"${ref}" (importer: ${entry.importer}) is not a prefab — expected a .prefab asset or a model's gltf-scene`
        );
    }

    return cachedSourcePrefab(ctx, assetUuid, entry, subAsset, ref);
}

/** Load a source prefab that is already referenced by uuid inside a document */
export function loadSourcePrefabByUuid(ctx, assetUuid) {
    if (!ctx.assetIndex || !ctx.projectRoot) {
        throw new OperationError('Prefab resolution requires a project (assetIndex/projectRoot unavailable)');
    }
    const resolved = ctx.assetIndex.resolve(assetUuid);
    if (!resolved) {
        throw new OperationError(`Source prefab asset ${assetUuid} not found in the project`);
    }
    return cachedSourcePrefab(ctx, assetUuid, resolved.entry, resolved.subAsset, assetUuid);
}

/** Shared cache + load: sub-assets read from library/, .prefab from the asset path */
function cachedSourcePrefab(ctx, assetUuid, entry, subAsset, ref) {
    const cache = (ctx._prefabCache ??= new Map());
    if (cache.has(assetUuid)) return cache.get(assetUuid);

    const filePath = subAsset
        ? libraryPath(ctx.projectRoot, assetUuid)
        : path.join(ctx.projectRoot, entry.path);
    const doc = loadPrefabDocument(filePath, ref);
    const result = { assetUuid, doc, label: subAsset ? `${entry.path}@${subAsset.id}` : entry.path };
    cache.set(assetUuid, result);
    return result;
}

function libraryPath(projectRoot, assetUuid) {
    return path.join(projectRoot, 'library', assetUuid.slice(0, 2), `${assetUuid}.json`);
}

function loadPrefabDocument(filePath, ref) {
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (err) {
        throw new OperationError(
            `Cannot read source prefab for "${ref}" at ${filePath}: ${err.message}` +
            (filePath.includes(`${path.sep}library${path.sep}`)
                ? ' (model prefab lives in the library/ import cache — open the project in the editor once to build it)'
                : '')
        );
    }
    if (!Array.isArray(parsed) || parsed[0]?.__type__ !== 'cc.Prefab') {
        throw new OperationError(`"${ref}" is not a serialized prefab (head: ${parsed?.[0]?.__type__})`);
    }
    return new SceneDocument(parsed, filePath);
}

/** fileId of a node inside its own prefab file (PrefabInfo.fileId) */
function nodeFileId(sourceDoc, nodeIdx, label) {
    const node = sourceDoc.getObject(nodeIdx);
    if (!isRef(node._prefab)) {
        throw new OperationError(
            `Node "${sourceDoc.nodePath(nodeIdx)}" in ${label} has no PrefabInfo — cannot build a fileId target`
        );
    }
    const info = sourceDoc.getObject(node._prefab.__id__);
    if (typeof info?.fileId !== 'string' || info.fileId === '') {
        throw new OperationError(`Node "${sourceDoc.nodePath(nodeIdx)}" in ${label} has no fileId`);
    }
    return info.fileId;
}

// --------------------------------------------------------- cycle detection

/** Throw when instantiating `assetUuid` into `doc` would create a prefab cycle */
function guardCycle(doc, assetUuid, ctx) {
    if (!doc.isPrefab || !doc.filePath) return;
    const ownUuid = ownAssetUuid(doc.filePath);
    if (!ownUuid) return;

    const visited = new Set();
    const stack = [[assetUuid, 0]];
    while (stack.length) {
        const [uuid, depth] = stack.pop();
        const base = uuid.split('@')[0];
        if (base === ownUuid) {
            throw new OperationError(
                `Instantiating this prefab would create a cycle (it directly or indirectly contains ${doc.filePath})`
            );
        }
        if (visited.has(uuid) || depth >= MAX_NESTING_SCAN_DEPTH) continue;
        visited.add(uuid);

        let source;
        try {
            source = loadSourcePrefabByUuid(ctx, uuid);
        } catch {
            continue; // unreadable nested source — cannot recurse, accept
        }
        for (const obj of source.doc.objects) {
            if (obj.__type__ === 'cc.PrefabInfo' && obj.instance &&
                typeof obj.asset?.__uuid__ === 'string') {
                stack.push([obj.asset.__uuid__, depth + 1]);
            }
        }
    }
}

function ownAssetUuid(filePath) {
    try {
        return JSON.parse(fs.readFileSync(`${filePath}.meta`, 'utf-8')).uuid ?? null;
    } catch {
        return null;
    }
}

// ------------------------------------------------------ instantiate_prefab

/**
 * op: {parent, prefab, name?, position?, rotation?, scale?, index?}
 * Creates a collapsed instance stub, registers it in the document's
 * instance registry (cc.Scene._prefab / prefab-root PrefabInfo).
 */
export function instantiatePrefab(doc, op, ctx) {
    const parentIdx = resolveEditableNode(doc, requireString(op, 'parent'));
    const source = loadSourcePrefab(ctx, requireString(op, 'prefab'));
    guardCycle(doc, source.assetUuid, ctx);

    const srcRoot = source.doc.root;
    const rootFileId = nodeFileId(source.doc, srcRoot.idx, source.label);
    const name = op.name ?? srcRoot.node._name;
    if (typeof name !== 'string' || name === '') {
        throw new OperationError('Instance needs a name (op.name or source prefab root _name)');
    }

    const taken = doc.takenIds();
    const parent = doc.getObject(parentIdx);

    // Stub node: no _name/_children/_components — state lives in overrides
    const stub = {
        __type__: 'cc.Node',
        _objFlags: 0,
        _parent: { __id__: parentIdx },
        _prefab: null, // wired below
        __editorExtras__: {}
    };
    const stubIdx = doc.addObject(stub);

    const info = {
        __type__: 'cc.PrefabInfo',
        root: { __id__: stubIdx },
        asset: { __uuid__: source.assetUuid, __expectedType__: 'cc.Prefab' },
        fileId: rootFileId,
        instance: null, // wired below
        targetOverrides: null
    };
    // Scene stubs carry `nestedPrefabInstanceRoots: null` — UNLESS the source
    // prefab itself contains nested instances, then the editor omits the key
    // (verified via editor re-save on the real scene). Prefab-nested stubs
    // omit it always (golden shapes).
    if (doc.isScene &&
        !source.doc.objects.some(o => o.__type__ === 'cc.PrefabInstance')) {
        info.nestedPrefabInstanceRoots = null;
    }
    const infoIdx = doc.addObject(info);
    stub._prefab = { __id__: infoIdx };

    const instance = {
        __type__: 'cc.PrefabInstance',
        fileId: generateFileId(taken),
        prefabRootNode: doc.isPrefab ? { __id__: doc.root.idx } : null,
        mountedChildren: [],
        mountedComponents: [],
        propertyOverrides: [],
        removedComponents: []
    };
    const instanceIdx = doc.addObject(instance);
    info.instance = { __id__: instanceIdx };

    // Default override set matches a freshly dropped editor instance:
    // _name, _lpos, _lrot, _euler (+_lscale only when requested)
    const euler = mergeTyped({ __type__: 'cc.Vec3', x: 0, y: 0, z: 0 }, op.rotation ?? {}, 'rotation');
    pushOverride(doc, instance, [rootFileId], ['_name'], name);
    pushOverride(doc, instance, [rootFileId], ['_lpos'],
        mergeTyped({ __type__: 'cc.Vec3', x: 0, y: 0, z: 0 }, op.position ?? {}, 'position'));
    pushOverride(doc, instance, [rootFileId], ['_lrot'], { __type__: 'cc.Quat', ...eulerToQuat(euler) });
    pushOverride(doc, instance, [rootFileId], ['_euler'], euler);
    if (op.scale !== undefined) {
        pushOverride(doc, instance, [rootFileId], ['_lscale'],
            mergeTyped({ __type__: 'cc.Vec3', x: 1, y: 1, z: 1 }, op.scale, 'scale'));
    }

    const at = Math.min(op.index ?? parent._children.length, parent._children.length);
    parent._children.splice(at, 0, { __id__: stubIdx });

    registerInstance(doc, stubIdx, ctx);

    const nodePath = doc.nodePath(stubIdx);
    return {
        op: 'instantiate_prefab',
        target: nodePath,
        summary: `instantiated ${source.label} as "${nodePath}"`,
        nodeIdx: stubIdx
    };
}

/**
 * Add the stub to the document's instance registry. The editor keeps the
 * registry in hierarchy (DFS) order of the stub nodes, not insertion order
 * (verified via editor re-save) — re-sort after inserting.
 */
function registerInstance(doc, stubIdx, ctx) {
    const registry = registryInfo(doc, ctx);
    if (!Array.isArray(registry.nestedPrefabInstanceRoots)) {
        registry.nestedPrefabInstanceRoots = [];
    }
    registry.nestedPrefabInstanceRoots.push({ __id__: stubIdx });
    sortInstanceRegistry(doc);
}

/**
 * Restore the registry's hierarchy (DFS) order over the stub nodes. Call
 * after any mutation that moves instance stubs around (register, reparent).
 * No-op when the document has no registry PrefabInfo.
 */
export function sortInstanceRegistry(doc) {
    const root = doc.root.node;
    if (!isRef(root._prefab)) return;
    const registry = doc.getObject(root._prefab.__id__);
    if (!Array.isArray(registry?.nestedPrefabInstanceRoots)) return;

    const order = new Map();
    const walk = (idx) => {
        order.set(idx, order.size);
        for (const child of doc.childIndices(idx)) walk(child);
    };
    walk(doc.root.idx);
    registry.nestedPrefabInstanceRoots.sort((a, b) =>
        (order.get(a.__id__) ?? Infinity) - (order.get(b.__id__) ?? Infinity));
}

function registryInfo(doc, ctx) {
    const root = doc.root.node;
    if (isRef(root._prefab)) return doc.getObject(root._prefab.__id__);

    if (doc.isPrefab) {
        throw new OperationError('Prefab root node has no PrefabInfo — file is malformed');
    }
    // Scene that never held an instance: create the registry PrefabInfo.
    // Its fileId is the scene asset's full dashed UUID (golden scene shape).
    const info = {
        __type__: 'cc.PrefabInfo',
        root: null,
        asset: null,
        fileId: sceneAssetUuid(doc, ctx) ?? randomUUID(),
        instance: null,
        targetOverrides: null,
        nestedPrefabInstanceRoots: []
    };
    root._prefab = { __id__: doc.addObject(info) };
    return info;
}

function sceneAssetUuid(doc, ctx) {
    if (!doc.filePath || !ctx.projectRoot || !ctx.assetIndex) return null;
    const rel = path.relative(ctx.projectRoot, doc.filePath).replaceAll(path.sep, '/');
    return ctx.assetIndex.resolve(rel)?.entry.uuid ?? null;
}

// -------------------------------------------------- set_instance_property

/** Node-property sugar shared with set_node_property, adapted to overrides */
const NODE_PROPERTY_FORMS = {
    name: '_name', _name: '_name',
    active: '_active', _active: '_active',
    layer: '_layer', _layer: '_layer',
    mobility: '_mobility', _mobility: '_mobility',
    position: '_lpos', _lpos: '_lpos',
    scale: '_lscale', _lscale: '_lscale',
    rotation: 'rotation', _euler: 'rotation'
};

/** form → canonical property name understood by normalizeNodeProperty */
const CANONICAL_BY_FORM = {
    _name: 'name', _active: 'active', _layer: 'layer', _mobility: 'mobility',
    _lpos: 'position', _lscale: 'scale', rotation: 'rotation'
};

/**
 * op: {node, target?, component?, componentIndex?, property, value}
 * `node` is the instance stub in THIS document; `target` addresses a node
 * inside the SOURCE prefab by path ("" or "/" = instance root).
 * Existing overrides with the same target+path are updated, not duplicated.
 */
export function setInstanceProperty(doc, op, ctx) {
    const resolved = resolveInstanceTarget(doc, op, ctx);

    if (op.component !== undefined || op.componentIndex !== undefined) {
        return setComponentOverride(doc, op, ctx, resolved);
    }
    return setNodeOverride(doc, op, ctx, resolved);
}

/**
 * op: {node, target?, component?, componentIndex?, property}
 * Removes matching override(s); "rotation" removes both _euler and _lrot.
 */
export function removeInstanceOverride(doc, op, ctx) {
    const { instance, sourceDoc, targetIdx, label, stubIdx } = resolveInstanceTarget(doc, op, ctx);
    const property = requireString(op, 'property');

    let localId;
    let paths;
    if (op.component !== undefined || op.componentIndex !== undefined) {
        const compIdx = findComponent(sourceDoc, targetIdx, op.component, op.componentIndex, ctx);
        localId = componentFileId(sourceDoc, compIdx, label);
        paths = [overridePathForComponent(sourceDoc.getObject(compIdx), property)];
    } else {
        localId = nodeFileId(sourceDoc, targetIdx, label);
        const form = NODE_PROPERTY_FORMS[property] ?? property;
        paths = form === 'rotation' ? [['_euler'], ['_lrot']] : [[form]];
    }

    let removed = 0;
    for (const p of paths) {
        removed += dropOverride(doc, instance, [localId], p);
    }
    if (removed === 0) {
        throw new OperationError(
            `No override for "${property}" on "${op.target ?? '/'}" — nothing to remove ` +
            `(existing: ${listOverrides(doc, instance).join(', ') || 'none'})`
        );
    }

    const nodePath = doc.nodePath(stubIdx);
    return {
        op: 'remove_instance_override',
        target: nodePath,
        summary: `${nodePath}: removed ${removed} override(s) for "${property}"`,
        nodeIdx: stubIdx
    };
}

function resolveInstanceTarget(doc, op, ctx) {
    const stubIdx = doc.resolveNode(requireString(op, 'node'));
    if (!doc.isInstanceStub(stubIdx)) {
        throw new OperationError(
            `"${doc.nodePath(stubIdx)}" is not a prefab instance — ` +
            `use set_node_property/set_component_property for regular nodes`
        );
    }
    const info = doc.getObject(doc.getObject(stubIdx)._prefab.__id__);
    if (typeof info.asset?.__uuid__ !== 'string') {
        throw new OperationError('Instance PrefabInfo has no asset UUID — file is malformed');
    }
    const { doc: sourceDoc, label } = loadSourcePrefabByUuid(ctx, info.asset.__uuid__);

    const targetRef = op.target === undefined || op.target === '' ? '/' : op.target;
    let targetIdx;
    try {
        targetIdx = sourceDoc.resolveNode(targetRef);
    } catch (err) {
        throw new OperationError(`In source prefab ${label}: ${err.message}`);
    }
    if (sourceDoc.isInstanceStub(targetIdx)) {
        throw new OperationError(
            `"${targetRef}" is itself a nested prefab instance inside ${label} — ` +
            `multi-hop overrides are not supported yet. Edit that prefab's source asset instead.`
        );
    }
    return { instance: doc.instanceOf(stubIdx), sourceDoc, targetIdx, label, stubIdx };
}

function setNodeOverride(doc, op, ctx, { instance, sourceDoc, targetIdx, label, stubIdx }) {
    const property = requireString(op, 'property');
    const form = NODE_PROPERTY_FORMS[property];
    if (!form) {
        throw new OperationError(
            `Unknown node property "${property}". Supported: ` +
            `${Object.keys(NODE_PROPERTY_FORMS).filter(k => !k.startsWith('_')).join(', ')}. ` +
            `For component fields pass "component".`
        );
    }
    const localId = nodeFileId(sourceDoc, targetIdx, label);
    const sourceNode = sourceDoc.getObject(targetIdx);
    const value = op.value;

    // Base for value-type merges: existing override, else the source value
    const baseField = form === 'rotation' ? '_euler' : form;
    const base = findOverride(doc, instance, [localId], [baseField])?.value ?? sourceNode[baseField];
    for (const write of normalizeNodeProperty(CANONICAL_BY_FORM[form], value, base)) {
        pushOverride(doc, instance, [localId], [write.field], write.value);
    }

    const stubPath = doc.nodePath(stubIdx);
    const where = op.target ? `${stubPath}→${op.target}` : stubPath;
    return {
        op: 'set_instance_property',
        target: stubPath,
        summary: `${where}: ${property} = ${JSON.stringify(value)} (override in ${label})`,
        nodeIdx: stubIdx
    };
}

function setComponentOverride(doc, op, ctx, { instance, sourceDoc, targetIdx, label, stubIdx }) {
    const property = requireString(op, 'property');
    const compIdx = findComponent(sourceDoc, targetIdx, op.component, op.componentIndex, ctx);
    const component = sourceDoc.getObject(compIdx);
    const localId = componentFileId(sourceDoc, compIdx, label);
    const propertyPath = overridePathForComponent(component, property);

    // Base for value-type merges: existing override, else the source value
    const existing = findOverride(doc, instance, [localId], propertyPath)?.value ??
        readPath(component, propertyPath);
    const value = transformValue(doc, op.value, ctx);
    const isReference = value && typeof value === 'object' && ('__id__' in value || '__uuid__' in value);
    const finalValue = isReference ? value : mergeTyped(existing, value, property);

    pushOverride(doc, instance, [localId], propertyPath, finalValue);

    const stubPath = doc.nodePath(stubIdx);
    const where = op.target ? `${stubPath}→${op.target}` : stubPath;
    return {
        op: 'set_instance_property',
        target: stubPath,
        summary: `${where}.${describeComponentType(component.__type__, ctx)}.${property} = ` +
            `${JSON.stringify(op.value)} (override in ${label})`,
        nodeIdx: stubIdx
    };
}

function componentFileId(sourceDoc, compIdx, label) {
    const component = sourceDoc.getObject(compIdx);
    if (!isRef(component.__prefab)) {
        throw new OperationError(
            `Component ${component.__type__} in ${label} has no CompPrefabInfo — cannot target it with an override`
        );
    }
    const info = sourceDoc.getObject(component.__prefab.__id__);
    if (typeof info?.fileId !== 'string' || info.fileId === '') {
        throw new OperationError(`Component ${component.__type__} in ${label} has no fileId`);
    }
    return info.fileId;
}

/**
 * Property path for a component override, tolerating the serialized
 * underscore prefix ("sizeX" → "_sizeX" when only the latter exists).
 * Editor stores every segment as a string (verified: ["_materials", "0"]).
 */
function overridePathForComponent(component, property) {
    const segments = parsePropertyPath(property);
    if (typeof segments[0] === 'string' && !(segments[0] in component)) {
        const underscored = `_${segments[0]}`;
        if (underscored in component) segments[0] = underscored;
    }
    return segments.map(String);
}

/** Read a value along a string-segment path, undefined when absent */
function readPath(obj, segments) {
    let current = obj;
    for (const seg of segments) {
        if (current === null || typeof current !== 'object') return undefined;
        current = current[seg];
    }
    return current;
}

// ---------------------------------------------------------- override store

function overrideEntries(doc, instance) {
    return (instance.propertyOverrides ?? [])
        .filter(isRef)
        .map(r => ({ ref: r, obj: doc.getObject(r.__id__) }))
        .filter(e => e.obj?.__type__ === 'CCPropertyOverrideInfo');
}

function sameArray(a, b) {
    return Array.isArray(a) && Array.isArray(b) &&
        a.length === b.length && a.every((v, i) => v === b[i]);
}

function findOverride(doc, instance, localID, propertyPath) {
    for (const { obj } of overrideEntries(doc, instance)) {
        const target = isRef(obj.targetInfo) ? doc.getObject(obj.targetInfo.__id__) : null;
        if (target && sameArray(target.localID, localID) && sameArray(obj.propertyPath, propertyPath)) {
            return obj;
        }
    }
    return null;
}

/** Create or update the override for (localID, propertyPath) */
function pushOverride(doc, instance, localID, propertyPath, value) {
    const existing = findOverride(doc, instance, localID, propertyPath);
    if (existing) {
        existing.value = value;
        return;
    }
    const targetInfoIdx = doc.addObject({ __type__: 'cc.TargetInfo', localID: [...localID] });
    const overrideIdx = doc.addObject({
        __type__: 'CCPropertyOverrideInfo',
        targetInfo: { __id__: targetInfoIdx },
        propertyPath: [...propertyPath],
        value
    });
    instance.propertyOverrides.push({ __id__: overrideIdx });
}

/** Remove the override for (localID, propertyPath); returns removed count */
function dropOverride(doc, instance, localID, propertyPath) {
    const before = instance.propertyOverrides.length;
    instance.propertyOverrides = instance.propertyOverrides.filter(r => {
        if (!isRef(r)) return true;
        const obj = doc.getObject(r.__id__);
        if (obj?.__type__ !== 'CCPropertyOverrideInfo') return true;
        const target = isRef(obj.targetInfo) ? doc.getObject(obj.targetInfo.__id__) : null;
        return !(target && sameArray(target.localID, localID) && sameArray(obj.propertyPath, propertyPath));
    });
    return before - instance.propertyOverrides.length;
}

function listOverrides(doc, instance) {
    return overrideEntries(doc, instance).map(({ obj }) => obj.propertyPath.join('.'));
}
