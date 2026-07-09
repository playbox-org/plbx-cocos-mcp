/**
 * ComputeRotation - MCP tool: exact rotation math (quat ↔ euler YZX,
 * composition, aiming)
 *
 * The rotation twin of compute_fit_scale: the LLM must never do quaternion
 * arithmetic by hand. Angles are euler degrees in the engine's YZX order;
 * conversions use the verified ports of cc.Quat.fromEuler/toEuler.
 */

import * as fs from 'fs';
import * as path from 'path';
import { BaseTool } from './BaseTool.js';
import { SceneDocument, isRef } from '../document/SceneDocument.js';
import { AssetIndex } from '../core/AssetIndex.js';
import { loadSourcePrefabByUuid, instanceOverrideValue } from '../document/instances.js';
import {
    eulerToQuat, quatToEulerYZX, quatMultiply, quatConjugate, quatNormalize,
    quatFromAxisAngle, quatFromTo, quatRotateVec3, vec3Normalize, vec3Cross, vec3Dot
} from '../utils/math3d.js';

const IDENTITY_QUAT = { x: 0, y: 0, z: 0, w: 1 };

const NAMED_AXES = {
    x: { x: 1, y: 0, z: 0 }, y: { x: 0, y: 1, z: 0 }, z: { x: 0, y: 0, z: 1 },
    '-x': { x: -1, y: 0, z: 0 }, '-y': { x: 0, y: -1, z: 0 }, '-z': { x: 0, y: 0, z: -1 }
};

export class ComputeRotation extends BaseTool {
    get name() {
        return 'compute_rotation';
    }

    get description() {
        return 'Exact rotation math for Cocos nodes — use instead of doing quaternion/euler ' +
               'arithmetic by hand. Angles are euler degrees in the engine\'s YZX order. Modes: ' +
               '"convert" (quat ↔ euler), ' +
               '"compose" (rotate an existing rotation by N degrees around a world or local axis), ' +
               '"orient" (make a local axis point in a world direction, optional up vector). ' +
               'The current rotation can be read straight from a file: pass filePath + node ' +
               '(works for prefab-instance stubs too) — that also makes world-axis math account ' +
               'for parent rotations and returns a ready-to-apply op. ' +
               'Args: {mode (required), euler? | quat? | filePath?+node?, ' +
               'axis? ("x"/"y"/"z"/"-x"/… or {x,y,z}; compose: rotation axis, orient: the local axis to aim), ' +
               'degrees? (compose), space?: "world"|"local" (compose, default world), ' +
               'direction? ({x,y,z} world, orient), up? ({x,y,z} world, orient)}.';
    }

    get inputSchema() {
        return {
            type: 'object',
            properties: {
                mode: {
                    type: 'string',
                    enum: ['convert', 'compose', 'orient'],
                    description: 'convert: quat↔euler; compose: rotate around an axis; orient: aim a local axis'
                },
                euler: { type: 'object', description: 'Euler degrees {x?,y?,z?} (YZX order) — base rotation' },
                quat: { type: 'object', description: 'Quaternion {x,y,z,w} — base rotation' },
                filePath: {
                    type: 'string',
                    description: 'Alternative base: .scene/.prefab file (relative to project root) containing the node'
                },
                node: {
                    type: 'string',
                    description: 'Node path or _id inside filePath — its current rotation becomes the base (instance stubs read the _lrot override)'
                },
                axis: {
                    description: 'compose: rotation axis; orient: the LOCAL axis to aim. "x"|"y"|"z"|"-x"|"-y"|"-z" or {x,y,z}'
                },
                degrees: { type: 'number', description: 'compose: rotation angle in degrees' },
                space: {
                    type: 'string',
                    enum: ['world', 'local'],
                    description: 'compose: axis frame (default world; world needs filePath+node when parents are rotated)',
                    default: 'world'
                },
                direction: { type: 'object', description: 'orient: world direction {x,y,z} the axis must point at' },
                up: { type: 'object', description: 'orient: optional world up {x,y,z} — fixes the roll around the aimed axis' }
            },
            required: ['mode']
        };
    }

    async execute(args, projectRoot) {
        try {
            const base = readBase(args, projectRoot);
            switch (args.mode) {
                case 'convert':
                    return this.success(render('Convert', base.quat, base, args));
                case 'compose':
                    return this.success(render('Compose', compose(args, base), base, args));
                case 'orient':
                    return this.success(render('Orient', orient(args, base), base, args));
                default:
                    return this.error(`Unknown mode "${args.mode}" (convert | compose | orient)`);
            }
        } catch (err) {
            return this.error(err.message);
        }
    }
}

/**
 * Base rotation from euler / quat / a node in a file, plus the parent-chain
 * world rotation (identity when no node is given — world-axis math then
 * assumes unrotated parents, which the report calls out).
 */
function readBase(args, projectRoot) {
    if (args.node !== undefined || args.filePath !== undefined) {
        if (typeof args.filePath !== 'string' || typeof args.node !== 'string') {
            throw new Error('Pass filePath AND node together');
        }
        const filePath = path.resolve(projectRoot, args.filePath);
        if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
        const doc = SceneDocument.load(filePath);
        const nodeIdx = doc.resolveNode(args.node);
        // ctx lets a stub fall back to its source prefab root's own rotation
        const ctx = { projectRoot, assetIndex: AssetIndex.shared(projectRoot) };
        return {
            quat: quatNormalize(nodeRotation(doc, nodeIdx, ctx)),
            parentQuat: parentChainRotation(doc, nodeIdx, ctx),
            nodeRef: args.node,
            filePath: args.filePath,
            isStub: doc.isInstanceStub(nodeIdx),
            fromFile: doc.nodePath(nodeIdx)
        };
    }
    if (args.quat !== undefined) {
        const { x, y, z, w } = args.quat;
        if ([x, y, z, w].some(v => typeof v !== 'number')) {
            throw new Error('quat must be {x,y,z,w} numbers');
        }
        return { quat: quatNormalize(args.quat), parentQuat: null };
    }
    if (args.euler !== undefined) {
        return { quat: eulerToQuat(args.euler), parentQuat: null, euler: args.euler };
    }
    if (args.mode === 'orient') return { quat: IDENTITY_QUAT, parentQuat: null };
    throw new Error('Pass the base rotation: euler {x?,y?,z?}, quat {x,y,z,w}, or filePath + node');
}

/**
 * Current local rotation of a node. A stub reads its _lrot/_euler override
 * (keyed by the stub root's fileId, so an override on an INNER node is not
 * mistaken for the stub's own rotation) and, absent one, falls back to the
 * source prefab root's own rotation — mirroring Bounds.js#overrideValue.
 */
function nodeRotation(doc, nodeIdx, ctx) {
    const node = doc.getObject(nodeIdx);
    if (doc.isInstanceStub(nodeIdx)) {
        const instance = doc.instanceOf(nodeIdx);
        const info = isRef(node._prefab) ? doc.getObject(node._prefab.__id__) : null;
        const rootFileId = info?.fileId;
        const lrot = instanceOverrideValue(doc, instance, rootFileId, '_lrot');
        if (lrot) return lrot;
        const euler = instanceOverrideValue(doc, instance, rootFileId, '_euler');
        if (euler) return eulerToQuat(euler);
        // No transform override — inherit the source prefab root's rotation.
        if (ctx && typeof info?.asset?.__uuid__ === 'string') {
            try {
                const { doc: sourceDoc } = loadSourcePrefabByUuid(ctx, info.asset.__uuid__);
                const rootNode = sourceDoc.getObject(sourceDoc.root.idx);
                return rootNode._lrot ??
                    (rootNode._euler ? eulerToQuat(rootNode._euler) : IDENTITY_QUAT);
            } catch { /* source unreadable — assume identity */ }
        }
        return IDENTITY_QUAT;
    }
    return node._lrot ?? (node._euler ? eulerToQuat(node._euler) : IDENTITY_QUAT);
}

/** World rotation of the node's PARENT chain (topmost ancestor applied first) */
function parentChainRotation(doc, nodeIdx, ctx) {
    const chain = [];
    let idx = doc.getObject(nodeIdx)._parent?.__id__;
    while (idx !== undefined && idx !== doc.root.idx) {
        chain.unshift(idx);
        idx = doc.getObject(idx)._parent?.__id__;
    }
    let q = IDENTITY_QUAT;
    for (const ancestor of chain) {
        q = quatMultiply(q, nodeRotation(doc, ancestor, ctx));
    }
    return q;
}

function parseAxis(axis, what) {
    if (typeof axis === 'string') {
        const named = NAMED_AXES[axis.toLowerCase()];
        if (!named) {
            throw new Error(`Unknown axis "${axis}" for ${what} — use x|y|z|-x|-y|-z or {x,y,z}`);
        }
        return named;
    }
    if (axis && typeof axis === 'object') {
        const v = { x: axis.x ?? 0, y: axis.y ?? 0, z: axis.z ?? 0 };
        return vec3Normalize(v);
    }
    throw new Error(`"axis" is required for ${what} — x|y|z|-x|-y|-z or {x,y,z}`);
}

/** compose: R(axis, degrees) applied in world or local space */
function compose(args, base) {
    if (typeof args.degrees !== 'number') throw new Error('"degrees" (number) is required for compose');
    const axis = parseAxis(args.axis ?? 'y', 'compose');
    const r = quatFromAxisAngle(axis, args.degrees);
    if ((args.space ?? 'world') === 'local') {
        // Rotate around the node's own axis: post-multiply
        return quatMultiply(base.quat, r);
    }
    // World axis: new_world = R · P · q → new_local = P⁻¹ · R · P · q
    const p = base.parentQuat ?? IDENTITY_QUAT;
    return quatMultiply(quatConjugate(p), quatMultiply(r, quatMultiply(p, base.quat)));
}

/** orient: local axis A looks along world direction D (+ optional up roll) */
function orient(args, base) {
    const a = parseAxis(args.axis, 'orient (the LOCAL axis to aim)');
    if (!args.direction || typeof args.direction !== 'object') {
        throw new Error('"direction" ({x,y,z} world vector) is required for orient');
    }
    const d = vec3Normalize({
        x: args.direction.x ?? 0, y: args.direction.y ?? 0, z: args.direction.z ?? 0
    });

    let world = quatFromTo(a, d);
    if (args.up !== undefined) {
        const up = vec3Normalize({ x: args.up.x ?? 0, y: args.up.y ?? 0, z: args.up.z ?? 0 });
        // Roll around D so the rotated local up lands as close to `up` as possible
        const localUp = Math.abs(a.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 0, y: 0, z: 1 };
        const currentUp = quatRotateVec3(world, localUp);
        const project = (v) => {
            const k = vec3Dot(v, d);
            return { x: v.x - d.x * k, y: v.y - d.y * k, z: v.z - d.z * k };
        };
        const from = project(currentUp);
        const to = project(up);
        const fromLen = Math.hypot(from.x, from.y, from.z);
        const toLen = Math.hypot(to.x, to.y, to.z);
        if (fromLen > 1e-6 && toLen > 1e-6) {
            const angle = Math.atan2(vec3Dot(vec3Cross(from, to), d), vec3Dot(from, to));
            world = quatMultiply(quatFromAxisAngle(d, angle * 180 / Math.PI), world);
        }
    }
    // To the node's local frame (identity parents when no node was given)
    const p = base.parentQuat ?? IDENTITY_QUAT;
    return quatMultiply(quatConjugate(p), world);
}

function render(title, quat, base, args) {
    const q = quatNormalize(quat);
    const euler = roundVec(quatToEulerYZX(q), 4);
    const lines = [`# ${title} rotation`, ''];

    if (base.fromFile) {
        const baseEuler = roundVec(quatToEulerYZX(base.quat), 4);
        lines.push(`Base: current rotation of "${base.fromFile}" — euler ${fmtVec(baseEuler)}`);
        const p = base.parentQuat;
        if (p && Math.abs(p.w) < 0.9999995) {
            lines.push(`Parent chain is rotated (accounted for in world-space math).`);
        }
    } else if (args.mode !== 'convert' && (args.space ?? 'world') === 'world') {
        lines.push('No filePath+node given — world-axis math assumes UNROTATED parents. ' +
            'Pass filePath + node when the node sits under rotated ancestors.');
    }

    lines.push(
        '',
        `**Euler (YZX degrees): ${fmtVec(euler)}**`,
        `Quaternion: {x: ${fmtNum(q.x)}, y: ${fmtNum(q.y)}, z: ${fmtNum(q.z)}, w: ${fmtNum(q.w)}}`,
        ''
    );

    const op = base.nodeRef
        ? (base.isStub
            ? { op: 'set_instance_property', node: base.nodeRef, property: 'rotation', value: euler }
            : { op: 'set_node_property', node: base.nodeRef, property: 'rotation', value: euler })
        : { op: 'set_node_property', node: '<node path>', property: 'rotation', value: euler };
    lines.push('Apply with:', '```json', JSON.stringify(op), '```');
    if (!base.nodeRef) {
        lines.push('(fill in the node path; the op takes euler degrees — the quaternion is derived automatically)');
    }
    lines.push('', 'Verify placement afterwards with get_node_bounds (expected AABB), not by eye.');
    return lines.join('\n');
}

function roundVec(v, digits) {
    const f = 10 ** digits;
    const r = (n) => {
        const x = Math.round(n * f) / f;
        return Object.is(x, -0) ? 0 : x;
    };
    return { x: r(v.x), y: r(v.y), z: r(v.z) };
}

function fmtNum(n) {
    const x = Math.round(n * 1e7) / 1e7;
    return String(Object.is(x, -0) ? 0 : x);
}

function fmtVec(v) {
    return `(${fmtNum(v.x)}, ${fmtNum(v.y)}, ${fmtNum(v.z)})`;
}
