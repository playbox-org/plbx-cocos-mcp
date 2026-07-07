/**
 * Semantic edit operations over a SceneDocument
 *
 * Ops never touch raw __id__ values from the caller's side: nodes are
 * addressed by path or stable _id — never by __id__. New objects are
 * appended; canonical order is restored by doc.renumber() before save.
 *
 * Prefab-instance stubs (collapsed instances) are guarded: their content
 * lives in the source prefab. Whole-instance remove/reparent work directly;
 * per-property edits go through set_instance_property (overrides).
 *
 * SOLID: S - semantic mutations only; document mechanics live in SceneDocument,
 * instance machinery in instances.js
 */

import * as fs from 'fs';
import * as path from 'path';
import { isRef } from './SceneDocument.js';
import {
    instantiatePrefab, setInstanceProperty, removeInstanceOverride, sortInstanceRegistry,
    removeInstanceComponent, restoreInstanceComponent
} from './instances.js';
import {
    dropTargetOverrides, upsertTargetOverride, transformValueTracked, pruneDanglingOverrides
} from './targetOverrides.js';
import {
    createComponent, createScriptComponent, resolveTemplateType, templateTypes
} from './ComponentTemplates.js';
import { generateFileId } from '../utils/fileId.js';
import { eulerToQuat } from '../utils/math3d.js';
import { compressUuid, isCompressedUuid } from '../utils/uuid.js';

/** Builtin engine layers (cocos/scene-graph/layers.ts) */
export const LAYERS = {
    ignore_raycast: 1 << 20,
    gizmos: 1 << 21,
    editor: 1 << 22,
    ui_3d: 1 << 23,
    scene_gizmo: 1 << 24,
    ui_2d: 1 << 25,
    profiler: 1 << 28,
    default: 1 << 30
};

/** Asset meta importer → __expectedType__ */
const IMPORTER_TO_TYPE = {
    'sprite-frame': 'cc.SpriteFrame',
    'texture': 'cc.Texture2D',
    'image': 'cc.ImageAsset',
    'gltf-mesh': 'cc.Mesh',
    'gltf-material': 'cc.Material',
    'material': 'cc.Material',
    'gltf-animation': 'cc.AnimationClip',
    'animation-clip': 'cc.AnimationClip',
    'gltf-skeleton': 'cc.Skeleton',
    'gltf-scene': 'cc.Prefab',
    'prefab': 'cc.Prefab',
    'scene': 'cc.SceneAsset',
    'audio-clip': 'cc.AudioClip',
    'ttf-font': 'cc.TTFFont',
    'bitmap-font': 'cc.BitmapFont',
    'sprite-atlas': 'cc.SpriteAtlas',
    'auto-atlas': 'cc.SpriteAtlas',
    'effect': 'cc.EffectAsset',
    'physics-material': 'cc.PhysicsMaterial',
    'animation-graph': 'cc.animation.AnimationGraph'
};

export class OperationError extends Error {
    name = 'OperationError';
}

/** Insertion index into `_children`: undefined = append; negatives rejected (JS splice semantics) */
export function childInsertIndex(index, length) {
    if (index === undefined) return length;
    if (!Number.isInteger(index) || index < 0) {
        throw new OperationError(
            `index must be a non-negative integer, got ${JSON.stringify(index)}`
        );
    }
    return Math.min(index, length);
}

/**
 * Apply a batch of operations in order. Throws OperationError on the first
 * failing op (the document must then be discarded, not saved).
 *
 * @param {import('./SceneDocument.js').SceneDocument} doc
 * @param {object[]} ops
 * @param {{assetIndex?: object}} [ctx] - assetIndex enables asset/script resolution
 * @returns {Array<{op: string, target: string, summary: string, nodeIdx: number}>}
 */
export function applyOperations(doc, ops, ctx = {}) {
    if (!Array.isArray(ops) || ops.length === 0) {
        throw new OperationError('ops must be a non-empty array');
    }
    return ops.map((op, i) => {
        try {
            return applyOperation(doc, op, ctx);
        } catch (err) {
            // Uniform error surface: node-resolution errors etc. become OperationError too
            throw new OperationError(`op[${i}] ${op?.op ?? '<no op field>'}: ${err.message}`);
        }
    });
}

const HANDLERS = {
    set_node_property: setNodeProperty,
    add_node: addNode,
    remove_node: removeNode,
    reparent: reparent,
    add_component: addComponent,
    remove_component: removeComponent,
    set_component_property: setComponentProperty,
    set_asset_ref: setAssetRef,
    instantiate_prefab: instantiatePrefab,
    set_instance_property: setInstanceProperty,
    remove_instance_override: removeInstanceOverride,
    restore_instance_component: restoreInstanceComponent,
    prune_dangling_overrides: pruneDanglingOverridesOp
};

export function applyOperation(doc, op, ctx = {}) {
    const handler = HANDLERS[op?.op];
    if (!handler) {
        throw new OperationError(
            `Unknown op "${op?.op}". Supported: ${Object.keys(HANDLERS).join(', ')}`
        );
    }
    return handler(doc, op, ctx);
}

// ---------------------------------------------------------------- helpers

export function requireString(op, field) {
    if (typeof op[field] !== 'string') {
        throw new OperationError(`"${field}" (string) is required`);
    }
    return op[field];
}

export function resolveEditableNode(doc, ref, { allowStub = false } = {}) {
    const idx = doc.resolveNode(ref);
    if (!allowStub && doc.isInstanceStub(idx)) {
        throw new OperationError(
            `"${doc.nodePath(idx)}" is a prefab instance (collapsed stub). ` +
            `Use set_instance_property to override its properties, or edit the source ` +
            `.prefab asset. remove_node/reparent of the whole instance are also allowed.`
        );
    }
    return idx;
}

export function resolveLayer(value) {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
    if (typeof value === 'string') {
        const bit = LAYERS[value.toLowerCase()];
        if (bit !== undefined) return bit;
    }
    throw new OperationError(
        `Invalid layer "${value}". Use a bitmask number or one of: ${Object.keys(LAYERS).join(', ')}`
    );
}

/** Merge a plain {x,y,..} object into a serialized value-type, keeping __type__ */
export function mergeTyped(existing, given, what) {
    if (given === null || typeof given !== 'object' || Array.isArray(given)) return given;
    if (given.__type__) return given; // caller provided a full serialized value
    if (existing === null || typeof existing !== 'object' || !existing.__type__) return given;
    const allowed = new Set(Object.keys(existing));
    for (const key of Object.keys(given)) {
        if (!allowed.has(key)) {
            throw new OperationError(
                `Unknown field "${key}" for ${what} (${existing.__type__}); ` +
                `expected: ${[...allowed].filter(k => k !== '__type__').join(', ')}`
            );
        }
    }
    return { ...existing, ...given };
}

/** Parse "a.b[0].c" / "materials.0" into path segments */
export function parsePropertyPath(path) {
    const segments = [];
    for (const part of String(path).split('.')) {
        const m = part.match(/^([^[\]]*)((?:\[\d+\])*)$/);
        if (!m) throw new OperationError(`Bad property path "${path}"`);
        // "materials.0" ≡ "materials[0]": bare numeric segments index arrays.
        // A negative one would become a string key JSON.stringify drops on save.
        if (/^-\d+$/.test(m[1])) {
            throw new OperationError(
                `Bad property path "${path}": negative array index "${m[1]}" is not allowed`
            );
        }
        if (m[1] !== '') segments.push(/^\d+$/.test(m[1]) ? Number(m[1]) : m[1]);
        for (const idxMatch of m[2].matchAll(/\[(\d+)\]/g)) {
            segments.push(Number(idxMatch[1]));
        }
    }
    if (segments.length === 0) throw new OperationError('Empty property path');
    return segments;
}

/**
 * Navigate to the property container. Every string segment tolerates the
 * serialized underscore prefix ("spriteFrame" matches "_spriteFrame",
 * "shapeModule.enable" matches "_shapeModule._enable") and must exist —
 * a typo'd key is rejected with the container's field list instead of
 * silently creating a stray key (scripts may create top-level fields via
 * allowCreate). Intermediate `{__id__}` references are followed into their
 * standalone objects (cc.Line._width → cc.CurveRange, particle modules,
 * MeshRenderer.bakeSettings, …), so "width.constant" edits the referenced
 * object instead of corrupting the reference.
 */
const HIDDEN_FIELDS = ['__type__', '_objFlags', '__editorExtras__', 'node', '__prefab'];

function locateProperty(doc, component, path, { allowCreate = false } = {}) {
    const segments = parsePropertyPath(path);
    let container = component;
    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const last = i === segments.length - 1;
        if (typeof seg === 'string' && !Array.isArray(container) && !(seg in container)) {
            const underscored = `_${seg}`;
            if (underscored in container) {
                segments[i] = underscored;
            } else if (!(allowCreate && last)) {
                const owner = i === 0
                    ? `Component ${component.__type__}`
                    : `"${segments.slice(0, i).join('.')}" (${container.__type__ ?? 'object'})`;
                const fields = Object.keys(container).filter(k => !HIDDEN_FIELDS.includes(k));
                throw new OperationError(
                    `${owner} has no property "${seg}". Available: ${fields.join(', ')}`
                );
            }
        }
        if (last) break;
        let next = container[segments[i]];
        if (isRef(next)) next = doc.getObject(next.__id__);
        if (next === null || typeof next !== 'object') {
            throw new OperationError(
                `Cannot navigate "${path}": "${segments.slice(0, i + 1).join('.')}" is not an object/array`
            );
        }
        container = next;
    }
    const key = segments[segments.length - 1];
    if (Array.isArray(container) && typeof key === 'number' && key > container.length) {
        throw new OperationError(
            `Index ${key} out of bounds for "${path}" (length ${container.length})`
        );
    }
    return { container, key, segments };
}

/** Find a component on a node by type/script name or positional index */
export function findComponent(doc, nodeIdx, compRef, componentIndex, ctx) {
    const compIndices = doc.componentIndices(nodeIdx);
    if (compRef === undefined && componentIndex === undefined) {
        throw new OperationError('"component" (type/script name) or "componentIndex" is required');
    }
    if (compRef === undefined) {
        if (componentIndex < 0 || componentIndex >= compIndices.length) {
            throw new OperationError(
                `componentIndex ${componentIndex} out of range (node has ${compIndices.length} components)`
            );
        }
        return compIndices[componentIndex];
    }

    const wanted = new Set([compRef]);
    const template = resolveTemplateType(compRef);
    if (template) wanted.add(template);
    if (!compRef.startsWith('cc.') && !isCompressedUuid(compRef)) {
        const uuid = resolveScriptUuid(ctx, compRef);
        if (uuid) wanted.add(compressUuid(uuid));
    }

    const matches = compIndices.filter(i => wanted.has(doc.getObject(i).__type__));
    if (matches.length === 0) {
        const present = compIndices.map(i => describeComponentType(doc.getObject(i).__type__, ctx)).join(', ');
        throw new OperationError(
            `Node "${doc.nodePath(nodeIdx)}" has no "${compRef}" component. Present: ${present || 'none'}`
        );
    }
    if (matches.length > 1 && componentIndex === undefined) {
        throw new OperationError(
            `Node has ${matches.length} "${compRef}" components — disambiguate with componentIndex`
        );
    }
    if (componentIndex !== undefined && (componentIndex < 0 || componentIndex >= matches.length)) {
        throw new OperationError(
            `componentIndex ${componentIndex} out of range — node "${doc.nodePath(nodeIdx)}" has ` +
            `${matches.length} "${compRef}" component(s)`
        );
    }
    return matches[componentIndex ?? 0];
}

export function describeComponentType(type, ctx) {
    if (type.startsWith('cc.')) return type;
    const name = ctx.scriptNameByCompressed?.get?.(type);
    return name ? `${name} (script)` : type;
}

/**
 * Error-path only: when a script fails to resolve through .meta files, walk
 * assets/ on disk to tell "typo" apart from "not imported by the editor yet".
 * @returns {string|null} Project-relative path of the found source file
 */
function findUnimportedScript(projectRoot, name) {
    if (!projectRoot) return null;
    const wanted = new Set([`${name.toLowerCase()}.ts`, `${name.toLowerCase()}.js`]);
    const stack = [path.join(projectRoot, 'assets')];

    while (stack.length > 0) {
        const dir = stack.pop();
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            if (entry.isDirectory()) {
                stack.push(path.join(dir, entry.name));
            } else if (wanted.has(entry.name.toLowerCase())) {
                return path.relative(projectRoot, path.join(dir, entry.name)).replaceAll('\\', '/');
            }
        }
    }
    return null;
}

/** Reverse script lookup: class/file name → full asset UUID */
function resolveScriptUuid(ctx, name) {
    if (!ctx.assetIndex) return null;
    const scripts = ctx.assetIndex.list({ type: 'script' });
    const match = scripts.find(e => e.name.replace(/\.[jt]s$/, '') === name) ??
                  scripts.find(e => e.name.replace(/\.[jt]s$/, '').toLowerCase() === name.toLowerCase());
    return match?.uuid ?? null;
}

/** Resolve an asset ref via AssetIndex into {__uuid__, __expectedType__} */
export function resolveAssetValue(ctx, ref, expectedType) {
    if (!ctx.assetIndex) {
        throw new OperationError('Asset resolution requires a project (assetIndex unavailable)');
    }
    const resolved = ctx.assetIndex.resolve(ref);
    if (!resolved) {
        throw new OperationError(`Asset not found: "${ref}" (checked path, UUID, compressed UUID)`);
    }
    const { entry, subAsset } = resolved;
    const uuid = subAsset ? `${entry.uuid}@${subAsset.id}` : entry.uuid;
    const importer = subAsset ? subAsset.importer : entry.importer;
    const type = expectedType ?? IMPORTER_TO_TYPE[importer];
    if (!type) {
        throw new OperationError(
            `Cannot infer __expectedType__ for importer "${importer}" (asset "${ref}") — pass expectedType explicitly`
        );
    }
    return { __uuid__: uuid, __expectedType__: type };
}

/**
 * Transform special value forms:
 * {"$node": ref} → node reference, {"$component": {node, type}} → component
 * reference, {"$asset": ref, "$type"?} → asset uuid object.
 */
export function transformValue(doc, value, ctx) {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(v => transformValue(doc, v, ctx));
    if ('$node' in value) {
        return { __id__: doc.resolveNode(value.$node) };
    }
    if ('$component' in value) {
        const spec = value.$component;
        const nodeIdx = doc.resolveNode(spec.node);
        return { __id__: findComponent(doc, nodeIdx, spec.type, spec.componentIndex, ctx) };
    }
    if ('$asset' in value) {
        return resolveAssetValue(ctx, value.$asset, value.$type);
    }
    // Plain object (e.g. a cc.ClickEvent literal): $-forms may hide inside
    const out = {};
    for (const [key, v] of Object.entries(value)) out[key] = transformValue(doc, v, ctx);
    return out;
}

/**
 * Shared validation/normalization for node-property writes, used by both
 * set_node_property and instance overrides: maps a semantic property to its
 * serialized field write(s). `base` is the current serialized value merged
 * into for position/rotation/scale (the node's field, or an existing
 * override); rotation expands into paired _euler/_lrot writes.
 *
 * @param {string} property - name|active|layer|mobility|position|rotation|scale
 * @param {*} value - raw op value
 * @param {object} [base] - current _lpos/_euler/_lscale for value-type merges
 * @returns {Array<{field: string, value: *}>}
 */
export function normalizeNodeProperty(property, value, base) {
    switch (property) {
        case 'name':
            if (typeof value !== 'string' || value === '') {
                throw new OperationError('name must be a non-empty string');
            }
            return [{ field: '_name', value }];
        case 'active':
            if (typeof value !== 'boolean') throw new OperationError('active must be a boolean');
            return [{ field: '_active', value }];
        case 'layer':
            return [{ field: '_layer', value: resolveLayer(value) }];
        case 'mobility':
            if (![0, 1, 2].includes(value)) throw new OperationError('mobility must be 0, 1 or 2');
            return [{ field: '_mobility', value }];
        case 'position':
            return [{ field: '_lpos', value: mergeTyped(base, value, 'position') }];
        case 'scale':
            return [{ field: '_lscale', value: mergeTyped(base, value, 'scale') }];
        case 'rotation': {
            const euler = mergeTyped(base, value, 'rotation (euler degrees)');
            // _lrot is what the runtime reads — always derive it from euler
            return [
                { field: '_euler', value: euler },
                { field: '_lrot', value: { __type__: 'cc.Quat', ...eulerToQuat(euler) } }
            ];
        }
        default:
            throw new OperationError(
                `Unknown node property "${property}". ` +
                `Supported: name, active, layer, mobility, position, rotation, scale`
            );
    }
}

// ------------------------------------------------------------- operations

function setNodeProperty(doc, op, ctx) {
    const idx = resolveEditableNode(doc, requireString(op, 'node'));
    const node = doc.getObject(idx);
    const property = requireString(op, 'property');
    const value = op.value;

    if (node.__type__ === 'cc.Scene' && ['position', 'rotation', 'scale'].includes(property)) {
        throw new OperationError(
            `The scene root is a cc.Scene and has no transform — cannot set "${property}". ` +
            `Target a child node instead.`
        );
    }

    const base = { position: node._lpos, rotation: node._euler, scale: node._lscale }[property];
    for (const write of normalizeNodeProperty(property, value, base)) {
        node[write.field] = write.value;
    }
    // Keep prefab asset name in sync when renaming the prefab root
    if (property === 'name' && doc.isPrefab && idx === doc.root.idx) {
        doc.getObject(0)._name = value;
    }

    const path = doc.nodePath(idx);
    return {
        op: 'set_node_property',
        target: path,
        summary: `${path}: ${property} = ${JSON.stringify(value)}`,
        nodeIdx: idx
    };
}

function addNode(doc, op) {
    const parentIdx = resolveEditableNode(doc, requireString(op, 'parent'));
    const name = requireString(op, 'name');
    const parent = doc.getObject(parentIdx);

    const taken = doc.takenIds();
    const euler = mergeTyped({ __type__: 'cc.Vec3', x: 0, y: 0, z: 0 }, op.rotation ?? {}, 'rotation');
    const node = {
        __type__: 'cc.Node',
        _name: name,
        _objFlags: 0,
        __editorExtras__: {},
        _parent: { __id__: parentIdx },
        _children: [],
        _active: op.active ?? true,
        _components: [],
        _prefab: null,
        _lpos: mergeTyped({ __type__: 'cc.Vec3', x: 0, y: 0, z: 0 }, op.position ?? {}, 'position'),
        _lrot: { __type__: 'cc.Quat', ...eulerToQuat(euler) },
        _lscale: mergeTyped({ __type__: 'cc.Vec3', x: 1, y: 1, z: 1 }, op.scale ?? {}, 'scale'),
        _mobility: 0,
        _layer: op.layer !== undefined ? resolveLayer(op.layer) : (parent._layer ?? LAYERS.default),
        _euler: euler,
        _id: doc.isScene ? generateFileId(taken) : ''
    };
    const nodeIdx = doc.addObject(node);

    if (doc.isPrefab) {
        const infoIdx = doc.addObject({
            __type__: 'cc.PrefabInfo',
            root: { __id__: doc.root.idx },
            asset: { __id__: 0 },
            fileId: generateFileId(taken),
            instance: null,
            targetOverrides: null,
            nestedPrefabInstanceRoots: null
        });
        node._prefab = { __id__: infoIdx };
    }

    const at = childInsertIndex(op.index, parent._children.length);
    parent._children.splice(at, 0, { __id__: nodeIdx });

    const path = doc.nodePath(nodeIdx);
    return {
        op: 'add_node',
        target: path,
        summary: `created node "${path}"`,
        nodeIdx
    };
}

function removeNode(doc, op) {
    const idx = resolveEditableNode(doc, requireString(op, 'node'), { allowStub: true });
    if (idx === doc.root.idx) throw new OperationError('Cannot remove the root node');
    const path = doc.nodePath(idx);
    const node = doc.getObject(idx);

    const removed = doc.subtreeObjectIds(idx);

    // Prefab bookkeeping outside the subtree: prune nestedPrefabInstanceRoots
    // entries and targetOverrides whose endpoints die with the subtree.
    for (let i = 0; i < doc.objects.length; i++) {
        if (removed.has(i)) continue;
        const obj = doc.getObject(i);
        if (obj.__type__ !== 'cc.PrefabInfo') continue;
        if (Array.isArray(obj.nestedPrefabInstanceRoots)) {
            obj.nestedPrefabInstanceRoots =
                obj.nestedPrefabInstanceRoots.filter(r => !(isRef(r) && removed.has(r.__id__)));
        }
        if (Array.isArray(obj.targetOverrides)) {
            obj.targetOverrides = obj.targetOverrides.filter(r => {
                if (!isRef(r)) return true;
                const override = doc.getObject(r.__id__);
                return ![override?.source, override?.target].some(
                    end => isRef(end) && removed.has(end.__id__)
                );
            });
        }
    }

    // Detach first, then judge remaining references by reachability: pruned
    // override objects are unreachable now and must not count as referrers.
    const parent = doc.getObject(node._parent.__id__);
    parent._children = parent._children.filter(r => !(isRef(r) && r.__id__ === idx));

    const nulled = resolveExternalRefs(
        doc, removed, op.force, `"${path}" is referenced from outside the subtree`
    );

    return {
        op: 'remove_node',
        target: path,
        summary: `removed "${path}" (${removed.size} objects${nulled ? `, nulled ${nulled} external refs` : ''})`,
        nodeIdx: node._parent.__id__
    };
}

/**
 * Post-detach check shared by remove_node / remove_component: throw on
 * reachable references into `removed` unless `force`, else null them out.
 * Returns the number of nulled references.
 */
function resolveExternalRefs(doc, removed, force, subject) {
    const reachable = doc.reachableIds();
    const external = doc.externalRefsInto(removed)
        .filter(r => reachable.has(r.fromIdx));
    if (external.length > 0 && !force) {
        const list = external.slice(0, 10).map(r => {
            const from = doc.getObject(r.fromIdx);
            const owner = isRef(from.node) ? ` on node "${doc.nodePath(from.node.__id__)}"` : '';
            return `${from.__type__}${owner} → .${r.path}`;
        }).join('; ');
        throw new OperationError(
            `${subject} (${external.length} refs): ${list}. ` +
            `Retarget those references first, or pass force: true to null them. ` +
            `(The document is now inconsistent — discard it, do not save.)`
        );
    }
    for (const r of external) {
        nullifyRef(doc.getObject(r.fromIdx), r.path);
    }
    return external.length;
}

/** Null out the reference at a recorded path like "_target" or "clickEvents[0].target" */
function nullifyRef(obj, refPath) {
    const segments = refPath.split(/[.[\]]+/).filter(Boolean)
        .map(s => (/^\d+$/.test(s) ? Number(s) : s));
    let container = obj;
    for (let i = 0; i < segments.length - 1; i++) container = container[segments[i]];
    container[segments[segments.length - 1]] = null;
}

function reparent(doc, op) {
    const idx = resolveEditableNode(doc, requireString(op, 'node'), { allowStub: true });
    if (idx === doc.root.idx) throw new OperationError('Cannot reparent the root node');
    const newParentIdx = resolveEditableNode(doc, requireString(op, 'newParent'));
    const oldPath = doc.nodePath(idx);

    // Guard: cannot move a node under itself
    let cursor = newParentIdx;
    while (cursor !== undefined) {
        if (cursor === idx) {
            throw new OperationError(`Cannot reparent "${oldPath}" into its own subtree`);
        }
        const parentRef = doc.getObject(cursor)._parent;
        cursor = isRef(parentRef) ? parentRef.__id__ : undefined;
    }

    const node = doc.getObject(idx);
    const oldParent = doc.getObject(node._parent.__id__);
    if (node._parent.__id__ === newParentIdx && op.index === undefined) {
        throw new OperationError(`"${oldPath}" is already a child of the target parent`);
    }

    oldParent._children = oldParent._children.filter(r => !(isRef(r) && r.__id__ === idx));
    const newParent = doc.getObject(newParentIdx);
    const at = childInsertIndex(op.index, newParent._children.length);
    newParent._children.splice(at, 0, { __id__: idx });
    node._parent = { __id__: newParentIdx };

    // The instance registry (nestedPrefabInstanceRoots) mirrors hierarchy DFS
    // order — restore it when the moved subtree carries instance stubs.
    if (subtreeHasInstanceStub(doc, idx)) sortInstanceRegistry(doc);

    const newPath = doc.nodePath(idx);
    return {
        op: 'reparent',
        target: newPath,
        summary: `moved "${oldPath}" → "${newPath}"`,
        nodeIdx: idx
    };
}

/** True when the node or any of its descendants is a collapsed instance stub */
function subtreeHasInstanceStub(doc, nodeIdx) {
    const stack = [nodeIdx];
    while (stack.length) {
        const idx = stack.pop();
        if (doc.isInstanceStub(idx)) return true;
        stack.push(...doc.childIndices(idx));
    }
    return false;
}

function addComponent(doc, op, ctx) {
    const idx = resolveEditableNode(doc, requireString(op, 'node'));
    const type = requireString(op, 'type');
    const node = doc.getObject(idx);
    const path = doc.nodePath(idx);

    let created;
    let label;
    const templateType = resolveTemplateType(type);
    if (templateType) {
        created = createComponent(templateType);
        label = templateType;
    } else if (type.startsWith('cc.')) {
        throw new OperationError(
            `No template for "${type}". Available cc.* templates: ${templateTypes().join(', ')}`
        );
    } else {
        const compressed = isCompressedUuid(type) ? type : (() => {
            const uuid = resolveScriptUuid(ctx, type);
            if (!uuid) {
                const onDisk = findUnimportedScript(ctx.projectRoot, type);
                if (onDisk) {
                    throw new OperationError(
                        `Script "${type}" exists on disk (${onDisk}) but has no .meta — ` +
                        'the editor has not imported it yet. Ask the user to open the project ' +
                        'in Cocos Creator once, then retry.'
                    );
                }
                throw new OperationError(
                    `Script "${type}" not found in assets (looked for ${type}.ts). ` +
                    `Available cc.* templates: ${templateTypes().join(', ')}`
                );
            }
            return compressUuid(uuid);
        })();
        created = createScriptComponent(compressed);
        label = `${type} (script)`;
    }

    const { component, extras } = created;
    const taken = doc.takenIds();

    // Duplicate guard: the editor forbids two identical builtin components
    if (templateType && doc.componentIndices(idx).some(c => doc.getObject(c).__type__ === templateType)) {
        throw new OperationError(`Node "${path}" already has a ${templateType}`);
    }

    const compIdx = doc.addObject(component);
    component.node = { __id__: idx };
    component._id = doc.isScene ? generateFileId(taken) : '';
    if (doc.isPrefab) {
        const infoIdx = doc.addObject({
            __type__: 'cc.CompPrefabInfo',
            fileId: generateFileId(taken)
        });
        component.__prefab = { __id__: infoIdx };
    }

    // Wire template placeholders — deep walk: extras may reference other
    // extras (particle modules point at their own CurveRanges), and two keys
    // may share one __ref__ (startSize/startSizeX alias the same object)
    const extraIndices = extras.map(e => doc.addObject(e));
    const wire = (obj) => {
        for (const [key, value] of Object.entries(obj)) {
            if (!value || typeof value !== 'object') continue;
            if ('__ref__' in value) obj[key] = { __id__: extraIndices[value.__ref__] };
            else if (value.__self_node__) obj[key] = { __id__: idx };
            else if (value.__self_component__) obj[key] = { __id__: compIdx };
            else wire(value);
        }
    };
    wire(component);
    for (const extra of extras) wire(extra);

    node._components.push({ __id__: compIdx });

    // Apply initial properties through the same code path as set_component_property
    const applied = [];
    for (const [prop, raw] of Object.entries(op.properties ?? {})) {
        setPropertyOnComponent(doc, compIdx, prop, raw, ctx, { isScript: !templateType });
        applied.push(prop);
    }

    return {
        op: 'add_component',
        target: path,
        summary: `added ${label} to "${path}"${applied.length ? ` (set: ${applied.join(', ')})` : ''}`,
        nodeIdx: idx
    };
}

/**
 * Components the editor refuses to remove while a dependent component is
 * still on the node (the dependent's requireComponent). force does NOT
 * bypass this — the editor forbids it too.
 */
export const REQUIRED_COMPANIONS = {
    'cc.UITransform': [
        'cc.Sprite', 'cc.Label', 'cc.RichText', 'cc.Button', 'cc.Layout',
        'cc.Widget', 'cc.Mask', 'cc.Graphics', 'cc.ProgressBar', 'cc.Slider',
        'cc.ScrollView', 'cc.PageView', 'cc.EditBox', 'cc.Toggle', 'cc.Canvas'
    ],
    'cc.Widget': ['cc.SafeArea'],
    'cc.Label': ['cc.LabelOutline']
};

function removeComponent(doc, op, ctx) {
    const idx = resolveEditableNode(doc, requireString(op, 'node'), { allowStub: true });
    if (doc.isInstanceStub(idx)) {
        // The component lives in the source prefab — removal is recorded as
        // a removedComponents entry on the instance (instances.js).
        return removeInstanceComponent(doc, op, ctx);
    }
    const compIdx = findComponent(doc, idx, op.component, op.componentIndex, ctx);
    const component = doc.getObject(compIdx);
    const node = doc.getObject(idx);
    const nodePath = doc.nodePath(idx);
    const label = describeComponentType(component.__type__, ctx);

    const dependents = (REQUIRED_COMPANIONS[component.__type__] ?? []).filter(dep =>
        doc.componentIndices(idx).some(c => c !== compIdx && doc.getObject(c).__type__ === dep));
    if (dependents.length > 0) {
        throw new OperationError(
            `Cannot remove ${component.__type__} from "${nodePath}" — required by ` +
            `${dependents.join(', ')} on the same node. Remove those components first.`
        );
    }

    // The component and its prefab bookkeeping die together; loose helper
    // objects (ClickEvents etc.) become unreachable and are GC'd on renumber.
    const removed = new Set([compIdx]);
    if (isRef(component.__prefab)) removed.add(component.__prefab.__id__);

    // Prune targetOverrides sourced from the dying component (mirror of the
    // endpoint cleanup in remove_node)
    for (let i = 0; i < doc.objects.length; i++) {
        if (removed.has(i)) continue;
        const obj = doc.getObject(i);
        if (obj.__type__ !== 'cc.PrefabInfo' || !Array.isArray(obj.targetOverrides)) continue;
        obj.targetOverrides = obj.targetOverrides.filter(r => {
            if (!isRef(r)) return true;
            const override = doc.getObject(r.__id__);
            return !(isRef(override?.source) && removed.has(override.source.__id__));
        });
    }

    // Detach first, then judge remaining references by reachability: pruned
    // override objects are unreachable now and must not count as referrers.
    node._components = node._components.filter(r => !(isRef(r) && r.__id__ === compIdx));

    const nulled = resolveExternalRefs(
        doc, removed, op.force, `${label} on "${nodePath}" is referenced from outside`
    );

    return {
        op: 'remove_component',
        target: nodePath,
        summary: `removed ${label} from "${nodePath}"` +
            `${nulled ? ` (nulled ${nulled} external refs)` : ''}`,
        nodeIdx: idx
    };
}

/**
 * Fields the engine serializes twice as a getter/setter pair — a write to one
 * must mirror into the other (verified on the golden scene's
 * cc.animation.AnimationController: _graph and graph always match).
 * Keyed by the __type__ of the object holding the field, so pairs inside
 * standalone value objects (particle-system modules reached through refs)
 * sync too.
 */
const PAIRED_FIELDS = {
    'cc.animation.AnimationController': { _graph: 'graph', graph: '_graph' },
    // Particle-system pairs (editor serializes both halves, values equal):
    // enableCulling is the deprecated serialized alias of dataCulling
    'cc.ParticleSystem': { _dataCulling: 'enableCulling', enableCulling: '_dataCulling' },
    'cc.ShapeModule': { _shapeType: 'shapeType', shapeType: '_shapeType' },
    'cc.TextureAnimationModule': {
        _numTilesX: 'numTilesX', numTilesX: '_numTilesX',
        _numTilesY: 'numTilesY', numTilesY: '_numTilesY'
    },
    'cc.ParticleSystem2D': { _preview: 'preview', preview: '_preview' },
    // Light components: the HDR field and its formerlySerializedAs twin
    'cc.DirectionalLight': { _illuminanceHDR: '_illuminance', _illuminance: '_illuminanceHDR' },
    'cc.SphereLight': { _luminanceHDR: '_luminance', _luminance: '_luminanceHDR' },
    'cc.SpotLight': { _luminanceHDR: '_luminance', _luminance: '_luminanceHDR' }
};

function syncPairedField(component, container, key, value) {
    const twin = PAIRED_FIELDS[container?.__type__]?.[key];
    if (!twin) return;
    // Deep-copy: the twins must not alias one object (renumber rewrites
    // every {__id__} it visits, and would hit a shared one twice)
    container[twin] = value !== null && typeof value === 'object'
        ? JSON.parse(JSON.stringify(value))
        : value;
}

function setPropertyOnComponent(doc, compIdx, property, rawValue, ctx, { isScript }) {
    const component = doc.getObject(compIdx);
    const { container, key, segments } = locateProperty(doc, component, property, { allowCreate: isScript });
    const pathStrings = segments.map(String);

    // A write supersedes any target override it covers — otherwise the stale
    // override would silently overwrite the new value on load.
    dropTargetOverrides(doc, compIdx, pathStrings);

    // $node/$component values pointing INSIDE collapsed prefab instances
    // cannot serialize as {__id__} — they become null + a TargetOverrideInfo
    // in the document registry (golden-scene shape, sourceInfo: null).
    const refs = [];
    const value = transformValueTracked(doc, rawValue, ctx, refs);
    const existing = container[key];
    const isReference = value && typeof value === 'object' &&
        ('__id__' in value || '__uuid__' in value);

    // Write THROUGH a reference to a standalone value object (cc.Line._width
    // → cc.CurveRange etc.): merge into the referenced object, keep the ref.
    // Nodes/components stay plain replacements — they are retargeted, not
    // edited, through a property write.
    const standalone = !isReference && isRef(existing) ? doc.getObject(existing.__id__) : null;
    const isValueObject = standalone?.__type__ &&
        !doc.isNode(standalone) && !isRef(standalone.node);
    if (isValueObject && value !== null) {
        if (typeof value !== 'object' || Array.isArray(value)) {
            throw new OperationError(
                `"${property}" is a standalone ${standalone.__type__} object — ` +
                `set its fields instead (e.g. "${property}.constant") or pass an object to merge`
            );
        }
        doc.objects[existing.__id__] = mergeTyped(standalone, value, property);
    } else {
        container[key] = isReference ? value : mergeTyped(existing, value, property);
    }
    syncPairedField(component, container, key, container[key]);

    for (const ref of refs) {
        upsertTargetOverride(doc, ctx, {
            sourceIdx: compIdx,
            propertyPath: [...pathStrings, ...ref.path],
            stubIdx: ref.stubIdx,
            localID: ref.localID
        });
    }
}

function setComponentProperty(doc, op, ctx) {
    const idx = resolveEditableNode(doc, requireString(op, 'node'));
    const property = requireString(op, 'property');
    const compIdx = findComponent(doc, idx, op.component, op.componentIndex, ctx);
    const component = doc.getObject(compIdx);
    const isScript = !component.__type__.startsWith('cc.');

    setPropertyOnComponent(doc, compIdx, property, op.value, ctx, { isScript });

    const path = doc.nodePath(idx);
    return {
        op: 'set_component_property',
        target: path,
        summary: `${path}.${describeComponentType(component.__type__, ctx)}.${property} = ${JSON.stringify(op.value)}`,
        nodeIdx: idx
    };
}

/**
 * Editor crashes/reworks leave broken cc.TargetOverrideInfo records behind
 * (null source, targets pointing at detached leftover nodes). The engine
 * skips them on load, but they fail validation and block every apply_edits
 * batch on the file. This op removes exactly the records the engine would
 * skip; the detached nodes/TargetInfos they referenced are GC'd on save.
 * Idempotent — running it on a clean document is a no-op.
 */
function pruneDanglingOverridesOp(doc) {
    const removed = pruneDanglingOverrides(doc);
    return {
        op: 'prune_dangling_overrides',
        target: '/',
        summary: removed.length === 0
            ? 'no dangling target-override records found'
            : `removed ${removed.length} dangling target-override record(s): ` +
              removed.map(r => `"${r.propertyPath}" (${r.reasons.join('; ')})`).join(', '),
        nodeIdx: doc.root.idx
    };
}

function setAssetRef(doc, op, ctx) {
    const idx = resolveEditableNode(doc, requireString(op, 'node'));
    const property = requireString(op, 'property');
    const compIdx = findComponent(doc, idx, op.component, op.componentIndex, ctx);
    const component = doc.getObject(compIdx);

    const value = op.asset === null
        ? null
        : resolveAssetValue(ctx, requireString(op, 'asset'), op.expectedType);
    const { container, key, segments } = locateProperty(doc, component, property, {
        allowCreate: !component.__type__.startsWith('cc.')
    });
    // Same supersede rule as setPropertyOnComponent (asset values are never
    // instance refs, so only the drop side applies here)
    dropTargetOverrides(doc, compIdx, segments.map(String));
    container[key] = value;
    syncPairedField(component, container, key, value);

    const path = doc.nodePath(idx);
    return {
        op: 'set_asset_ref',
        target: path,
        summary: `${path}.${describeComponentType(component.__type__, ctx)}.${property} = ${value ? value.__uuid__ : 'null'}`,
        nodeIdx: idx
    };
}
