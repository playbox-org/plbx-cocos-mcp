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
    removeInstanceComponent, restoreInstanceComponent, findMountedComponent
} from './instances.js';
import {
    dropTargetOverrides, upsertTargetOverride, transformValueTracked, pruneDanglingOverrides
} from './targetOverrides.js';
import {
    createComponent, createScriptComponent, resolveTemplateType, templateTypes
} from './ComponentTemplates.js';
import { generateFileId } from '../utils/fileId.js';
import { eulerToQuat } from '../utils/math3d.js';
import { resolveBuiltin } from '../core/builtins.js';
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
    insert_array_element: insertArrayElement,
    remove_array_element: removeArrayElement,
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

/**
 * Merge a plain {x,y,..} object into a serialized value-type, keeping __type__.
 * The merge is DEEP: a partial nested value (e.g. {boxThickness:{x:2}} into a
 * cc.ShapeModule) recurses so the nested cc.Vec3 keeps its __type__ and its
 * untouched components instead of being flattened to a bare {x:2}. Given keys
 * tolerate the serialized underscore prefix ("enable" → "_enable"), matching
 * locateProperty. A field that references a standalone object cannot be
 * overwritten with a scalar (it would orphan the referenced object) — the
 * dotted-path form must be used instead.
 */
export function mergeTyped(existing, given, what) {
    if (given === null || typeof given !== 'object' || Array.isArray(given)) return given;
    if (given.__type__) return given; // caller provided a full serialized value
    if (existing === null || typeof existing !== 'object' || !existing.__type__) return given;
    const allowed = new Set(Object.keys(existing));
    const merged = { ...existing };
    for (const [rawKey, val] of Object.entries(given)) {
        let key = rawKey;
        if (!allowed.has(key)) {
            if (allowed.has(`_${key}`)) key = `_${key}`;
            else throw new OperationError(
                `Unknown field "${rawKey}" for ${what} (${existing.__type__}); ` +
                `expected: ${[...allowed].filter(k => k !== '__type__').join(', ')}`
            );
        }
        const cur = existing[key];
        // A field that references a standalone object cannot be rewritten in
        // place: mergeTyped has no `doc`, so it cannot follow `{__id__}` into
        // the referenced value object. A scalar/array/null would orphan the ref
        // outright; a plain object (without its own `__id__`) would silently
        // REPLACE the ref with a non-ref, dropping __id__/__type__ and orphaning
        // the referenced object just the same. Reject both — the dotted-path
        // form (which does follow the ref) is the way to edit through it.
        if (isRef(cur) && !isRef(val)) {
            throw new OperationError(
                `"${rawKey}" in ${what} (${existing.__type__}) references a standalone object — ` +
                `cannot overwrite it with ${JSON.stringify(val)}. Edit it via a dotted path ` +
                `(e.g. "${what}.${rawKey}.<field>").`
            );
        }
        const recurse = cur && typeof cur === 'object' && cur.__type__ &&
            val && typeof val === 'object' && !Array.isArray(val) && !val.__type__;
        merged[key] = recurse ? mergeTyped(cur, val, `${what}.${rawKey}`) : val;
    }
    return merged;
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
        if (isRef(next)) {
            const ref = doc.getObject(next.__id__);
            // Follow a ref ONLY into a standalone value object (cc.CurveRange
            // behind cc.Line._width, particle modules, MeshRenderer.bakeSettings,
            // …). A ref to a node or a component is a structural link, not a
            // sub-property: navigating through it would mutate a DIFFERENT
            // node/component and bypass layer/instance-override validation.
            const isValueObj = ref?.__type__ && !doc.isNode(ref) && !isRef(ref.node);
            if (!isValueObj) {
                const kind = ref && doc.isNode(ref) ? 'a node'
                    : ref && isRef(ref.node) ? 'another component'
                    : 'a non-value reference';
                throw new OperationError(
                    `Cannot navigate "${path}": "${segments.slice(0, i + 1).join('.')}" is ` +
                    `${kind}, not an editable sub-object — target it directly ` +
                    `(set_node_property, or a separate set_component_property).`
                );
            }
            next = ref;
        }
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

    const matcher = componentTypeMatcher(compRef, ctx);
    const matches = compIndices.filter(i => matcher(doc.getObject(i).__type__));
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

/**
 * (type) => bool matcher for a component reference: exact __type__,
 * template alias, or script class name resolved to its compressed uuid.
 */
export function componentTypeMatcher(compRef, ctx) {
    const wanted = new Set([compRef]);
    const template = resolveTemplateType(compRef);
    if (template) wanted.add(template);
    if (!compRef.startsWith('cc.') && !isCompressedUuid(compRef)) {
        const uuid = resolveScriptUuid(ctx, compRef);
        if (uuid) wanted.add(compressUuid(uuid));
    }
    return (type) => wanted.has(type);
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

/** Reverse script lookup: class/file name → full asset UUID (memoized index) */
function resolveScriptUuid(ctx, name) {
    if (!ctx.assetIndex) return null;
    const { exact, lower } = ctx.assetIndex.scriptUuidByName();
    return exact.get(name) ?? lower.get(name.toLowerCase()) ?? null;
}

/** Resolve an asset ref via AssetIndex into {__uuid__, __expectedType__} */
export function resolveAssetValue(ctx, ref, expectedType) {
    if (!ctx.assetIndex) {
        throw new OperationError('Asset resolution requires a project (assetIndex unavailable)');
    }
    // Project assets first, then engine builtins (default material, primitive
    // meshes, …). resolveBuiltin returns the same {entry, subAsset} shape, so
    // the uuid/importer plumbing below applies unchanged — mirroring the read
    // path (AssetIndex.label / GetAssetInfo / FindAssetReferences).
    const resolved = ctx.assetIndex.resolve(ref) ?? resolveBuiltin(ref);
    if (!resolved) {
        throw new OperationError(
            `Asset not found: "${ref}" (checked project path, UUID, compressed UUID, engine builtins)`
        );
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

    const taken = doc.takenIds();

    // Duplicate guard: the editor forbids two identical builtin components
    if (templateType && doc.componentIndices(idx).some(c => doc.getObject(c).__type__ === templateType)) {
        throw new OperationError(`Node "${path}" already has a ${templateType}`);
    }

    // Auto-add missing companions BEFORE the component itself, exactly as the
    // editor does (adding cc.Sprite inserts cc.UITransform first). Idempotent:
    // a companion already present on the node is left as-is, never doubled —
    // so this never adds a second cc.UITransform to a node that has one.
    const autoAdded = [];
    ensureCompanions(doc, idx, templateType ?? type, taken, autoAdded);

    const compIdx = attachCreatedComponent(doc, idx, created, taken);
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
        summary: `added ${label} to "${path}"` +
            `${autoAdded.length ? ` (auto-added ${autoAdded.join(', ')})` : ''}` +
            `${applied.length ? ` (set: ${applied.join(', ')})` : ''}`,
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

/**
 * Reverse of REQUIRED_COMPANIONS: for a component type, the companions it
 * needs present on the same node. Adding a UI component auto-creates these,
 * exactly like the editor — cc.Sprite pulls in cc.UITransform, cc.SafeArea
 * pulls in cc.Widget (→ cc.UITransform), cc.LabelOutline pulls in cc.Label.
 * Without this, a UI node with no UITransform serializes "valid" but crashes
 * the editor on scene activation (Widget.onEnable reads a null UITransform).
 */
const COMPANIONS_FOR = (() => {
    const map = {};
    for (const [companion, dependents] of Object.entries(REQUIRED_COMPANIONS)) {
        for (const dep of dependents) (map[dep] ??= []).push(companion);
    }
    return map;
})();

/**
 * Instantiate a created component ({component, extras}) onto a node: register
 * it, stamp node / _id / (prefab CompPrefabInfo), and wire template
 * placeholders. Returns the new component's object index. Does NOT push onto
 * the node's _components (the caller controls ordering). Generated ids are
 * added to `taken` so repeated calls within one op never collide.
 */
function attachCreatedComponent(doc, nodeIdx, created, taken) {
    const { component, extras } = created;
    const compIdx = doc.addObject(component);
    component.node = { __id__: nodeIdx };
    if (doc.isScene) {
        component._id = generateFileId(taken);
        taken.add(component._id);
    } else {
        component._id = '';
    }
    if (doc.isPrefab) {
        const fileId = generateFileId(taken);
        taken.add(fileId);
        const infoIdx = doc.addObject({ __type__: 'cc.CompPrefabInfo', fileId });
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
            else if (value.__self_node__) obj[key] = { __id__: nodeIdx };
            else if (value.__self_component__) obj[key] = { __id__: compIdx };
            else wire(value);
        }
    };
    wire(component);
    for (const extra of extras) wire(extra);
    return compIdx;
}

/**
 * Ensure every companion a component needs is present on the node, adding the
 * missing ones (and their transitive companions) first so _components ends up
 * in editor order (e.g. UITransform → Widget → SafeArea). Idempotent: a
 * companion already on the node is skipped, never duplicated. `added` collects
 * the types actually created, for the op summary.
 */
function ensureCompanions(doc, nodeIdx, type, taken, added) {
    for (const companion of COMPANIONS_FOR[type] ?? []) {
        const present = doc.componentIndices(nodeIdx)
            .some(c => doc.getObject(c).__type__ === companion);
        if (present) continue;
        ensureCompanions(doc, nodeIdx, companion, taken, added);
        const compIdx = attachCreatedComponent(doc, nodeIdx, createComponent(companion), taken);
        doc.getObject(nodeIdx)._components.push({ __id__: compIdx });
        added.push(companion);
    }
}

function removeComponent(doc, op, ctx) {
    const idx = resolveEditableNode(doc, requireString(op, 'node'), { allowStub: true });
    if (doc.isInstanceStub(idx)) {
        // A component MOUNTED on the instance is a regular object of this
        // file — physically removed here. Otherwise the component lives in
        // the source prefab and removal is recorded as a removedComponents
        // entry on the instance (instances.js).
        const hit = findMountedComponent(doc, idx, op, ctx, { optional: true });
        if (hit) return removeMountedComponent(doc, op, ctx, idx, hit);
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
 * Physically remove a mounted component: drop it from its
 * cc.MountedComponentsInfo.components (an emptied record goes entirely —
 * with its TargetInfo it becomes unreachable and is GC'd on renumber).
 * NO removedComponents entry — the component is not from the source prefab.
 * External-reference rules mirror plain remove_component.
 */
function removeMountedComponent(doc, op, ctx, stubIdx, hit) {
    const component = hit.comp;
    const nodePath = doc.nodePath(stubIdx);
    const label = describeComponentType(component.__type__, ctx);
    const where = hit.mountTarget && hit.mountTarget !== '/'
        ? `${nodePath}→${hit.mountTarget}` : nodePath;

    // Same editor rule as on plain nodes, judged against the other
    // components mounted at the same target node. force does not bypass.
    const dependents = (REQUIRED_COMPANIONS[component.__type__] ?? []).filter(dep =>
        hit.entry.componentIndices.some(c =>
            c !== hit.compIdx && doc.getObject(c)?.__type__ === dep));
    if (dependents.length > 0) {
        throw new OperationError(
            `Cannot remove mounted ${component.__type__} from "${where}" — required by ` +
            `${dependents.join(', ')} mounted on the same node. Remove those components first.`
        );
    }

    const removed = new Set([hit.compIdx]);

    // Prune targetOverrides sourced from the dying component (mirror of
    // plain remove_component)
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

    // Detach first, then judge remaining references by reachability
    hit.entry.obj.components = hit.entry.obj.components.filter(
        r => !(isRef(r) && r.__id__ === hit.compIdx));
    let droppedEntry = false;
    if (hit.entry.obj.components.length === 0) {
        const instance = doc.instanceOf(stubIdx);
        instance.mountedComponents = instance.mountedComponents.filter(
            r => !(isRef(r) && r.__id__ === hit.entry.ref.__id__));
        droppedEntry = true;
    }

    const nulled = resolveExternalRefs(
        doc, removed, op.force, `mounted ${label} on "${where}" is referenced from outside`
    );

    return {
        op: 'remove_component',
        target: nodePath,
        summary: `removed mounted ${label} from "${where}"` +
            `${droppedEntry ? ' (last one — dropped the MountedComponentsInfo record)' : ''}` +
            `${nulled ? ` (nulled ${nulled} external refs)` : ''}`,
        nodeIdx: stubIdx
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
    // Light components: the HDR field and its formerlySerializedAs twin.
    // NOTE: the LDR field (_illuminanceLDR / _luminanceLDR) is intentionally
    // NOT mirrored — it is HDR × standard-exposure (≈ HDR/38400), not an equal
    // twin, and the editor itself leaves it at default when HDR is bumped
    // (3.8 defaults to the HDR pipeline). LDR-pipeline projects must set it
    // explicitly. See CODE_REVIEW finding #8.
    'cc.DirectionalLight': { _illuminanceHDR: '_illuminance', _illuminance: '_illuminanceHDR' },
    'cc.SphereLight': { _luminanceHDR: '_luminance', _luminance: '_luminanceHDR' },
    'cc.SpotLight': { _luminanceHDR: '_luminance', _luminance: '_luminanceHDR' }
};

function syncPairedField(container, key, value) {
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

    guardTypedRefArrayWrite(doc, container, key, existing, isReference, property);

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
        const merged = mergeTyped(standalone, value, property);
        doc.objects[existing.__id__] = merged;
        // Getter/setter twins live on the standalone object (keyed by its own
        // __type__) — mirror each field the merge touched, normalizing the
        // underscore twin the same way mergeTyped did.
        for (const rawK of Object.keys(value)) {
            const k = rawK in merged ? rawK : `_${rawK}`;
            syncPairedField(merged, k, merged[k]);
        }
    } else {
        container[key] = isReference ? value : mergeTyped(existing, value, property);
        syncPairedField(container, key, container[key]);
    }

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
    const idx = doc.resolveNode(requireString(op, 'node'));
    const property = requireString(op, 'property');
    const { compIdx, component, mounted } = resolveWritableComponent(doc, idx, op, ctx);
    const isScript = !component.__type__.startsWith('cc.');

    setPropertyOnComponent(doc, compIdx, property, op.value, ctx, { isScript });

    const path = doc.nodePath(idx);
    return {
        op: 'set_component_property',
        target: path,
        summary: `${path}.${describeComponentType(component.__type__, ctx)}` +
            `${mounted ? ' (mounted)' : ''}.${property} = ${JSON.stringify(op.value)}`,
        nodeIdx: idx
    };
}

/**
 * Component addressed by a property-write op. On a plain node — the node's
 * own components; on a collapsed instance stub — the components MOUNTED on
 * it (regular objects of this file, so set_component_property/set_asset_ref
 * apply verbatim). Source-prefab components are rejected with the
 * set_instance_property hint (inside findMountedComponent).
 */
function resolveWritableComponent(doc, idx, op, ctx) {
    if (doc.isInstanceStub(idx)) {
        const hit = findMountedComponent(doc, idx, op, ctx);
        return { compIdx: hit.compIdx, component: hit.comp, mounted: true };
    }
    const compIdx = findComponent(doc, idx, op.component, op.componentIndex, ctx);
    return { compIdx, component: doc.getObject(compIdx), mounted: false };
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
    const idx = doc.resolveNode(requireString(op, 'node'));
    const property = requireString(op, 'property');
    const { compIdx, component } = resolveWritableComponent(doc, idx, op, ctx);

    const value = op.asset === null
        ? null
        : resolveAssetValue(ctx, requireString(op, 'asset'), op.expectedType);
    const { container, key, segments } = locateProperty(doc, component, property, {
        allowCreate: !component.__type__.startsWith('cc.')
    });
    // An asset ({__uuid__}) never belongs in an array of {__id__} references
    // to typed objects — reject an append/hole write there (footgun guard).
    guardTypedRefArrayWrite(doc, container, key, container[key], false, property);
    // Same supersede rule as setPropertyOnComponent (asset values are never
    // instance refs, so only the drop side applies here)
    dropTargetOverrides(doc, compIdx, segments.map(String));
    container[key] = value;
    syncPairedField(container, key, value);

    const path = doc.nodePath(idx);
    return {
        op: 'set_asset_ref',
        target: path,
        summary: `${path}.${describeComponentType(component.__type__, ctx)}.${property} = ${value ? value.__uuid__ : 'null'}`,
        nodeIdx: idx
    };
}

// ----------------------------------------------- array-element operations
//
// A CCClass[] property (e.g. CardsBase.entries: CardEntry[]) serializes as an
// array of {__id__} references to standalone typed objects, NOT inline objects
// (README/docs/array-element-ops-analysis.md). set_component_property edits the
// FIELDS of existing elements (it follows the ref), but changing the SET of
// elements needs object allocation + a reference, which a leaf-value writer
// cannot do — these two ops are that missing half.

/** cc value-types serialized INLINE inside an array (no {__id__} indirection) */
const INLINE_VALUE_TYPES = new Set([
    'cc.Vec2', 'cc.Vec3', 'cc.Vec4', 'cc.Color', 'cc.Size', 'cc.Rect', 'cc.Quat', 'cc.Mat4'
]);

/** __type__s of the standalone objects an array's {__id__} elements point at */
function typedRefTargets(doc, arr) {
    const types = [];
    for (const el of arr) {
        if (!isRef(el)) continue;
        const t = doc.getObject(el.__id__);
        if (t && t.__type__ && !doc.isNode(t)) types.push(t.__type__);
    }
    return types;
}

/**
 * Footgun guard (docs §3a): writing a bare value into the append slot or a
 * null hole of an array whose elements are {__id__} references to typed
 * standalone objects (CardEntry[], …) silently corrupts the file — the engine
 * expects a reference, not an inline object. Reject with a pointer to the
 * dedicated ops. A proper reference/asset write into an EXISTING index is
 * unaffected (that is the safe merge-through-ref path).
 */
function guardTypedRefArrayWrite(doc, container, key, existing, isReference, property) {
    if (isReference) return;
    if (!Array.isArray(container) || typeof key !== 'number') return;
    if (existing !== undefined && existing !== null) return;
    const targets = typedRefTargets(doc, container);
    if (targets.length === 0) return;
    throw new OperationError(
        `"${property}" targets ${existing === undefined ? 'the append slot' : 'a null hole'} of an ` +
        `array of references to typed objects (${targets[0]}). Writing a bare value there would ` +
        `corrupt the file. Use op "insert_array_element" to add an element ` +
        `(or "remove_array_element" to remove one).`
    );
}

/** Resolve the array a "node/component/property" op addresses, plus context */
function locateArrayProperty(doc, op, ctx) {
    const idx = doc.resolveNode(requireString(op, 'node'));
    const property = requireString(op, 'property');
    const { component, mounted } = resolveWritableComponent(doc, idx, op, ctx);
    const { container, key } = locateProperty(doc, component, property);
    const arr = container[key];
    if (!Array.isArray(arr)) {
        throw new OperationError(
            `"${property}" is not an array on ${component.__type__} — ` +
            `insert_array_element/remove_array_element target an array-valued property.`
        );
    }
    return { nodeIdx: idx, path: doc.nodePath(idx), property, component, mounted, arr };
}

/** Pick the element type, validating an explicit `type` against the neighbor's */
function elementType(explicit, neighborType, property) {
    if (explicit !== undefined && neighborType && explicit !== neighborType) {
        throw new OperationError(
            `type "${explicit}" does not match the existing elements of "${property}" (${neighborType})`
        );
    }
    const type = explicit ?? neighborType;
    if (!type) {
        throw new OperationError(
            `Cannot determine the element type for "${property}" — pass "type" (the element __type__).`
        );
    }
    return type;
}

/**
 * Deep-clone a standalone value/data-struct element, allocating FRESH objects
 * for every OWNED reference so the copy shares no mutable object with the
 * original (docs §6: mandatory non-null nested refs like CardEntry.config must
 * become their own new objects, never an alias). References to nodes, other
 * components, and assets ({__uuid__}) are structural links kept by value.
 * A memo preserves internal sharing and breaks cycles. Returns the new index.
 */
function cloneOwnedElement(doc, srcIdx) {
    const memo = new Map();
    const alloc = (oldIdx) => {
        if (memo.has(oldIdx)) return memo.get(oldIdx);
        const newIdx = doc.addObject(null); // reserve the slot first (cycle-safe)
        memo.set(oldIdx, newIdx);
        doc.objects[newIdx] = cloneContent(doc.getObject(oldIdx));
        return newIdx;
    };
    const cloneContent = (value) => {
        if (value === null || typeof value !== 'object') return value;
        if (isRef(value)) {
            const t = doc.getObject(value.__id__);
            const owned = t && t.__type__ && !doc.isNode(t) && !isRef(t.node);
            return { __id__: owned ? alloc(value.__id__) : value.__id__ };
        }
        if (Array.isArray(value)) return value.map(cloneContent);
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = cloneContent(v);
        return out;
    };
    return alloc(srcIdx);
}

/**
 * Owned subtree of a standalone element: itself plus the transitive closure of
 * OWNED references (stopping at nodes/components — those are external links).
 * Mirrors SceneDocument.subtreeObjectIds for the CCClass[]-element case, so the
 * shared reachability guard (resolveExternalRefs) applies unchanged.
 */
function valueSubtreeIds(doc, startIdx) {
    const owned = new Set();
    const stack = [startIdx];
    const collect = (value) => {
        if (value === null || typeof value !== 'object') return;
        if (isRef(value)) {
            const t = doc.getObject(value.__id__);
            if (t && t.__type__ && !doc.isNode(t) && !isRef(t.node)) stack.push(value.__id__);
            return;
        }
        if (Array.isArray(value)) { value.forEach(collect); return; }
        for (const k of Object.keys(value)) {
            if (k !== '__id__') collect(value[k]);
        }
    };
    while (stack.length) {
        const idx = stack.pop();
        if (owned.has(idx)) continue;
        const obj = doc.getObject(idx);
        if (!obj) continue;
        owned.add(idx);
        collect(obj);
    }
    return owned;
}

/**
 * insert_array_element {node, component?/componentIndex?, property, index?,
 *   from?, type?, value?}
 *
 * Adds one element to an array-valued property. For an array of {__id__}
 * references to typed objects, a NEIGHBOR element (from, default index 0) is
 * deep-cloned as the structural skeleton — this is where the full field set
 * comes from, since a user CCClass has no default registry (docs R2) — and
 * `value` is merged over the top-level fields. Inline value-type arrays
 * (cc.Vec2[]) and scalar arrays are supported too. Nested reference fields
 * (config, members) are edited afterwards with set_component_property against
 * the new element's index.
 */
function insertArrayElement(doc, op, ctx) {
    const { nodeIdx, path, property, component, mounted, arr } = locateArrayProperty(doc, op, ctx);
    const at = childInsertIndex(op.index, arr.length);
    const value = op.value === undefined ? undefined : transformValue(doc, op.value, ctx);

    // Structural template: an explicit `from` index, else the first non-null
    // neighbor. Empty arrays have neither — construction is driven by `type`.
    let neighbor;
    if (op.from !== undefined) {
        if (!Number.isInteger(op.from) || op.from < 0 || op.from >= arr.length) {
            throw new OperationError(
                `"from" index ${JSON.stringify(op.from)} out of range for "${property}" (length ${arr.length})`
            );
        }
        neighbor = arr[op.from];
    } else {
        neighbor = arr.find(e => e != null);
    }

    let inserted;
    let note;
    const neighborObj = isRef(neighbor) ? doc.getObject(neighbor.__id__) : null;
    const neighborIsOwned = neighborObj?.__type__ &&
        !doc.isNode(neighborObj) && !isRef(neighborObj.node);
    if (isRef(neighbor) && neighborIsOwned) {
        // Array that OWNS standalone data structs (CardEntry[]): clone the
        // neighbor deeply (fresh owned sub-objects), then merge value.
        const srcIdx = neighbor.__id__;
        const type = elementType(op.type, neighborObj.__type__, property);
        const newIdx = cloneOwnedElement(doc, srcIdx);
        if (value !== undefined) doc.objects[newIdx] = mergeTyped(doc.getObject(newIdx), value, property);
        inserted = { __id__: newIdx };
        const fromN = op.from ?? arr.indexOf(neighbor);
        note = ` (${type}, cloned from ${property}[${fromN}])`;
    } else if (isRef(neighbor)) {
        // Array of references to EXISTING nodes/components (pipeControllers:
        // Foo[]): there is nothing to clone — the new element is itself a
        // reference. Require an explicit reference value ($node/$component).
        if (!(value && typeof value === 'object' && '__id__' in value)) {
            throw new OperationError(
                `"${property}" holds references to existing objects (${neighborObj?.__type__ ?? 'node'}) — ` +
                `pass value as a reference ({"$node": "..."} or {"$component": {...}}) for the new ` +
                `element; there is nothing to clone.`
            );
        }
        inserted = value;
        note = ' (reference)';
    } else if (neighbor && typeof neighbor === 'object' && neighbor.__type__) {
        // Inline value-type array (cc.Vec2[]): build an inline object.
        const type = elementType(op.type, neighbor.__type__, property);
        const base = JSON.parse(JSON.stringify(neighbor));
        inserted = value !== undefined ? mergeTyped(base, value, property) : base;
        note = ` (inline ${type})`;
    } else if (arr.length === 0) {
        // Empty array: nothing to copy, so `type` is required and the field set
        // comes solely from `value` (docs R2 — no defaults to fall back on).
        const type = elementType(op.type, undefined, property);
        const body = value !== undefined ? valueAsFields(value, property) : {};
        if (INLINE_VALUE_TYPES.has(type)) {
            inserted = { __type__: type, ...body };
            note = ` (inline ${type}, from value only)`;
        } else {
            inserted = { __id__: doc.addObject({ __type__: type, ...body }) };
            note = ` (${type}, from value only — verify its fields against the source)`;
        }
    } else {
        // Scalar array (numbers/strings): insert `value` verbatim.
        if (value === undefined) {
            throw new OperationError(
                `"${property}" holds scalar values — pass "value" for the new element.`
            );
        }
        inserted = value;
        note = '';
    }

    arr.splice(at, 0, inserted);
    return {
        op: 'insert_array_element',
        target: path,
        summary: `${path}.${describeComponentType(component.__type__, ctx)}` +
            `${mounted ? ' (mounted)' : ''}: inserted into ${property}[${at}]${note}`,
        nodeIdx
    };
}

/** A plain value object → its serializable fields (drops a stray __type__) */
function valueAsFields(value, property) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new OperationError(
            `"value" for a new element of "${property}" must be an object of fields`
        );
    }
    const { __type__, ...fields } = value;
    return fields;
}

/**
 * remove_array_element {node, component?/componentIndex?, property, index, force?}
 *
 * Removes one element from an array-valued property. For a reference element,
 * its owned subtree becomes unreachable and is garbage-collected on renumber;
 * reachable references INTO it from elsewhere block the removal (or are nulled
 * with force) exactly like remove_node/remove_component. Inline/scalar elements
 * are just spliced out.
 */
function removeArrayElement(doc, op, ctx) {
    const { nodeIdx, path, property, component, mounted, arr } = locateArrayProperty(doc, op, ctx);
    const index = op.index;
    if (!Number.isInteger(index) || index < 0 || index >= arr.length) {
        throw new OperationError(
            `"index" ${JSON.stringify(index)} out of range for "${property}" (length ${arr.length})`
        );
    }

    const removedEl = arr[index];
    arr.splice(index, 1);

    let note = '';
    if (isRef(removedEl)) {
        const removed = valueSubtreeIds(doc, removedEl.__id__);
        const nulled = resolveExternalRefs(
            doc, removed, op.force, `element ${index} of "${property}" is referenced from outside`
        );
        note = nulled
            ? ` (nulled ${nulled} external refs)`
            : ` (${removed.size} object(s) freed on save)`;
    }

    return {
        op: 'remove_array_element',
        target: path,
        summary: `${path}.${describeComponentType(component.__type__, ctx)}` +
            `${mounted ? ' (mounted)' : ''}: removed ${property}[${index}]${note}`,
        nodeIdx
    };
}
