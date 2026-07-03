/**
 * Semantic edit operations over a SceneDocument
 *
 * Ops never touch raw __id__ values from the caller's side: nodes are
 * addressed by path or stable _id (ROADMAP decision 3). New objects are
 * appended; canonical order is restored by doc.renumber() before save.
 *
 * Prefab-instance stubs (collapsed instances) are guarded: their content
 * lives in the source prefab, so Phase 1 only allows removing/reparenting
 * the whole instance. Property overrides are Phase 2.
 *
 * SOLID: S - semantic mutations only; document mechanics live in SceneDocument
 */

import { isRef } from './SceneDocument.js';
import {
    createComponent, createScriptComponent, resolveTemplateType, templateTypes
} from './ComponentTemplates.js';
import { generateFileId } from '../utils/fileId.js';
import { eulerToQuat } from '../utils/math3d.js';
import { compressUuid, isCompressedUuid } from '../utils/uuid.js';

/** Builtin engine layers (cocos/scene-graph/layers.ts) */
const LAYERS = {
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

export class OperationError extends Error {}

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
    set_component_property: setComponentProperty,
    set_asset_ref: setAssetRef
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

function requireString(op, field) {
    if (typeof op[field] !== 'string') {
        throw new OperationError(`"${field}" (string) is required`);
    }
    return op[field];
}

function resolveEditableNode(doc, ref, { allowStub = false } = {}) {
    const idx = doc.resolveNode(ref);
    if (!allowStub && doc.isInstanceStub(idx)) {
        throw new OperationError(
            `"${doc.nodePath(idx)}" is a prefab instance (collapsed stub). ` +
            `Phase 1 cannot edit instance internals — edit the source .prefab asset instead ` +
            `(instance overrides arrive in Phase 2). remove_node/reparent of the whole instance are allowed.`
        );
    }
    return idx;
}

function resolveLayer(value) {
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
function mergeTyped(existing, given, what) {
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
function parsePropertyPath(path) {
    const segments = [];
    for (const part of String(path).split('.')) {
        const m = part.match(/^([^[\]]*)((?:\[\d+\])*)$/);
        if (!m) throw new OperationError(`Bad property path "${path}"`);
        if (m[1] !== '') segments.push(m[1]);
        for (const idxMatch of m[2].matchAll(/\[(\d+)\]/g)) {
            segments.push(Number(idxMatch[1]));
        }
    }
    if (segments.length === 0) throw new OperationError('Empty property path');
    return segments;
}

/**
 * Navigate to the property container. The head segment tolerates the
 * serialized underscore prefix ("spriteFrame" matches "_spriteFrame").
 */
function locateProperty(component, path, { allowCreate = false } = {}) {
    const segments = parsePropertyPath(path);
    if (typeof segments[0] === 'string' && !(segments[0] in component)) {
        const underscored = `_${segments[0]}`;
        if (underscored in component) segments[0] = underscored;
        else if (!allowCreate || segments.length > 1) {
            const fields = Object.keys(component)
                .filter(k => !['__type__', '_objFlags', '__editorExtras__', 'node', '__prefab'].includes(k));
            throw new OperationError(
                `Component ${component.__type__} has no property "${segments[0]}". ` +
                `Available: ${fields.join(', ')}`
            );
        }
    }
    let container = component;
    for (let i = 0; i < segments.length - 1; i++) {
        const next = container[segments[i]];
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
    return { container, key, leafName: segments[segments.length - 1] };
}

/** Find a component on a node by type/script name or positional index */
function findComponent(doc, nodeIdx, compRef, componentIndex, ctx) {
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
    return matches[componentIndex ?? 0] ?? matches[0];
}

function describeComponentType(type, ctx) {
    if (type.startsWith('cc.')) return type;
    const name = ctx.scriptNameByCompressed?.get?.(type);
    return name ? `${name} (script)` : type;
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
function resolveAssetValue(ctx, ref, expectedType) {
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
function transformValue(doc, value, ctx) {
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
    return value;
}

// ------------------------------------------------------------- operations

function setNodeProperty(doc, op, ctx) {
    const idx = resolveEditableNode(doc, requireString(op, 'node'));
    const node = doc.getObject(idx);
    const property = requireString(op, 'property');
    const value = op.value;

    switch (property) {
        case 'name': {
            if (typeof value !== 'string' || value === '') {
                throw new OperationError('name must be a non-empty string');
            }
            node._name = value;
            // Keep prefab asset name in sync when renaming the prefab root
            if (doc.isPrefab && idx === doc.root.idx) doc.getObject(0)._name = value;
            break;
        }
        case 'active': {
            if (typeof value !== 'boolean') throw new OperationError('active must be a boolean');
            node._active = value;
            break;
        }
        case 'layer': {
            node._layer = resolveLayer(value);
            break;
        }
        case 'mobility': {
            if (![0, 1, 2].includes(value)) throw new OperationError('mobility must be 0, 1 or 2');
            node._mobility = value;
            break;
        }
        case 'position':
            node._lpos = mergeTyped(node._lpos, value, 'position');
            break;
        case 'scale':
            node._lscale = mergeTyped(node._lscale, value, 'scale');
            break;
        case 'rotation': {
            const euler = mergeTyped(node._euler, value, 'rotation (euler degrees)');
            node._euler = euler;
            // _lrot is what the runtime reads — always derive it from euler
            node._lrot = { __type__: 'cc.Quat', ...eulerToQuat(euler) };
            break;
        }
        default:
            throw new OperationError(
                `Unknown node property "${property}". ` +
                `Supported: name, active, layer, mobility, position, rotation, scale`
            );
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

    const at = op.index ?? parent._children.length;
    parent._children.splice(Math.min(at, parent._children.length), 0, { __id__: nodeIdx });

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

    const reachable = doc.reachableIds();
    const external = doc.externalRefsInto(removed)
        .filter(r => reachable.has(r.fromIdx));
    if (external.length > 0 && !op.force) {
        const list = external.slice(0, 10).map(r => {
            const from = doc.getObject(r.fromIdx);
            const owner = isRef(from.node) ? ` on node "${doc.nodePath(from.node.__id__)}"` : '';
            return `${from.__type__}${owner} → .${r.path}`;
        }).join('; ');
        throw new OperationError(
            `"${path}" is referenced from outside the subtree (${external.length} refs): ${list}. ` +
            `Retarget those references first, or pass force: true to null them. ` +
            `(The document is now inconsistent — discard it, do not save.)`
        );
    }
    for (const r of external) {
        nullifyRef(doc.getObject(r.fromIdx), r.path);
    }

    return {
        op: 'remove_node',
        target: path,
        summary: `removed "${path}" (${removed.size} objects${external.length ? `, nulled ${external.length} external refs` : ''})`,
        nodeIdx: node._parent.__id__
    };
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
    const at = Math.min(op.index ?? newParent._children.length, newParent._children.length);
    newParent._children.splice(at, 0, { __id__: idx });
    node._parent = { __id__: newParentIdx };

    const newPath = doc.nodePath(idx);
    return {
        op: 'reparent',
        target: newPath,
        summary: `moved "${oldPath}" → "${newPath}"`,
        nodeIdx: idx
    };
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

    // Wire template placeholders
    const extraIndices = extras.map(e => doc.addObject(e));
    for (const [key, value] of Object.entries(component)) {
        if (value && typeof value === 'object' && '__ref__' in value) {
            component[key] = { __id__: extraIndices[value.__ref__] };
        }
        if (value && typeof value === 'object' && value.__self_node__) {
            component[key] = { __id__: idx };
        }
    }

    node._components.push({ __id__: compIdx });

    // Apply initial properties through the same code path as set_component_property
    const applied = [];
    for (const [prop, raw] of Object.entries(op.properties ?? {})) {
        setPropertyOnComponent(doc, component, prop, raw, ctx, { isScript: !templateType });
        applied.push(prop);
    }

    return {
        op: 'add_component',
        target: path,
        summary: `added ${label} to "${path}"${applied.length ? ` (set: ${applied.join(', ')})` : ''}`,
        nodeIdx: idx
    };
}

function setPropertyOnComponent(doc, component, property, rawValue, ctx, { isScript }) {
    const { container, key } = locateProperty(component, property, { allowCreate: isScript });
    const value = transformValue(doc, rawValue, ctx);
    const existing = container[key];
    const isReference = value && typeof value === 'object' &&
        ('__id__' in value || '__uuid__' in value);
    container[key] = isReference ? value : mergeTyped(existing, value, property);
}

function setComponentProperty(doc, op, ctx) {
    const idx = resolveEditableNode(doc, requireString(op, 'node'));
    const property = requireString(op, 'property');
    const compIdx = findComponent(doc, idx, op.component, op.componentIndex, ctx);
    const component = doc.getObject(compIdx);
    const isScript = !component.__type__.startsWith('cc.');

    setPropertyOnComponent(doc, component, property, op.value, ctx, { isScript });

    const path = doc.nodePath(idx);
    return {
        op: 'set_component_property',
        target: path,
        summary: `${path}.${describeComponentType(component.__type__, ctx)}.${property} = ${JSON.stringify(op.value)}`,
        nodeIdx: idx
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
    const { container, key } = locateProperty(component, property, {
        allowCreate: !component.__type__.startsWith('cc.')
    });
    container[key] = value;

    const path = doc.nodePath(idx);
    return {
        op: 'set_asset_ref',
        target: path,
        summary: `${path}.${describeComponentType(component.__type__, ctx)}.${property} = ${value ? value.__uuid__ : 'null'}`,
        nodeIdx: idx
    };
}
