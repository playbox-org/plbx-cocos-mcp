/**
 * ComputeFitScale - MCP tool: exact scale math for meshes/sprites/prefabs/nodes
 *
 * The LLM must never do this arithmetic itself: given a target
 * size on one or more axes, this tool measures the object and returns the
 * uniform scale factor (fit-inside when several axes are constrained) plus
 * a ready-to-apply operation.
 */

import * as fs from 'fs';
import * as path from 'path';
import { BaseTool } from './BaseTool.js';
import { SceneDocument } from '../document/SceneDocument.js';
import { BoundsCalculator } from '../document/Bounds.js';
import { loadSourcePrefab } from '../document/instances.js';
import { buildBoundsContext, fmt, fmtVec } from './measure.js';

const AXES = [
    ['targetWidth', 'x'],
    ['targetHeight', 'y'],
    ['targetDepth', 'z']
];

export class ComputeFitScale extends BaseTool {
    get name() {
        return 'compute_fit_scale';
    }

    get description() {
        return 'Measure an asset (mesh/model, sprite, prefab) or a node subtree and compute the uniform ' +
               'scale factor to hit a target size. Pass targetWidth/targetHeight/targetDepth in world units ' +
               '(UI: pixels); with several targets the factor fits inside all of them. Without targets it ' +
               'just reports the measured size. Use instead of doing scale arithmetic by hand.';
    }

    get inputSchema() {
        return {
            type: 'object',
            properties: {
                asset: {
                    type: 'string',
                    description: 'Asset to measure: project path, UUID or "uuid@subId" ' +
                                 '(model/mesh, sprite/image, .prefab or model gltf-scene)'
                },
                filePath: {
                    type: 'string',
                    description: 'Alternative to asset: .scene/.prefab file (relative to project root) containing the node'
                },
                node: {
                    type: 'string',
                    description: 'Node path or _id inside filePath — measures the node subtree in its own frame'
                },
                targetWidth: { type: 'number', description: 'Desired size along X' },
                targetHeight: { type: 'number', description: 'Desired size along Y' },
                targetDepth: { type: 'number', description: 'Desired size along Z' }
            }
        };
    }

    async execute(args, projectRoot) {
        const ctx = buildBoundsContext(projectRoot);
        try {
            const measured = args.asset !== undefined
                ? measureAsset(ctx, args.asset)
                : measureNode(ctx, args, projectRoot);

            const targets = AXES
                .filter(([key]) => typeof args[key] === 'number')
                .map(([key, axis]) => ({ axis, value: args[key] }));

            return this.success(renderReport(measured, targets, args));
        } catch (err) {
            return this.error(err.message);
        }
    }
}

function measureAsset(ctx, ref) {
    const resolved = ctx.assetIndex.resolve(ref);
    if (!resolved) throw new Error(`Asset not found: "${ref}"`);
    const { entry, subAsset } = resolved;

    // Mesh sub-asset or model file → mesh AABB
    const wantsMesh = subAsset?.importer === 'gltf-mesh' ||
        (!subAsset && (entry.importer === 'fbx' || entry.importer === 'gltf'));
    if (wantsMesh) {
        const info = ctx.assetInspector.inspect(entry.uuid);
        const meshes = info?.meshes ?? [];
        const mesh = subAsset
            ? meshes.find(m => m.uuid === `${entry.uuid}@${subAsset.id}`)
            : (meshes.length === 1 ? meshes[0] : null);
        if (!mesh && !subAsset && meshes.length > 1) {
            throw new Error(
                `"${ref}" has ${meshes.length} meshes — pick one: ` +
                meshes.map(m => `${entry.path}@${m.uuid.split('@')[1]} (${m.name})`).join(', ')
            );
        }
        if (!mesh?.aabb) {
            throw new Error(`Mesh AABB unavailable for "${ref}" (no library/ cache; for .fbx open the project in the editor once)`);
        }
        return {
            what: `mesh ${mesh.name} (${entry.path})`,
            size: mesh.aabb.size,
            units: 'world units'
        };
    }

    // Sprite / image → raw pixel size
    if (entry.importer === 'image') {
        const info = ctx.assetInspector.inspect(ref);
        const frame = info?.spriteFrame;
        if (!frame) throw new Error(`"${ref}" has no sprite-frame data (imported as plain texture?)`);
        return {
            what: `sprite ${entry.path}`,
            size: { x: frame.rawSize.width, y: frame.rawSize.height, z: 0 },
            units: 'pixels'
        };
    }

    // Prefab (.prefab asset or a model's gltf-scene) → its computed bounds
    if (entry.importer === 'prefab' || subAsset?.importer === 'gltf-scene') {
        const source = loadSourcePrefab(ctx, ref);
        const bounds = new BoundsCalculator(ctx).computeSubtree(source.doc, source.doc.root.idx);
        if (!bounds.local) {
            throw new Error(`Prefab "${ref}" has no measurable contents (${bounds.skipped.map(s => s.reason).join('; ') || 'empty'})`);
        }
        return {
            what: `prefab ${source.label}`,
            size: bounds.local.size,
            units: 'world units',
            note: 'measured at prefab-root scale 1'
        };
    }

    throw new Error(`Cannot measure "${ref}" (importer: ${subAsset?.importer ?? entry.importer}) — expected mesh/model, sprite or prefab`);
}

function measureNode(ctx, args, projectRoot) {
    if (typeof args.filePath !== 'string' || typeof args.node !== 'string') {
        throw new Error('Pass either "asset", or "filePath" + "node"');
    }
    const filePath = path.resolve(projectRoot, args.filePath);
    if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
    const doc = SceneDocument.load(filePath);
    const nodeIdx = doc.resolveNode(args.node);
    const bounds = new BoundsCalculator(ctx).computeSubtree(doc, nodeIdx);
    if (!bounds.local) {
        throw new Error(
            `"${args.node}" has no measurable contents ` +
            `(${bounds.skipped.map(s => s.reason).join('; ') || 'no renderers/UITransform below it'})`
        );
    }

    const node = doc.getObject(nodeIdx);
    const isStub = doc.isInstanceStub(nodeIdx);
    return {
        what: `node "${doc.nodePath(nodeIdx)}" in ${args.filePath}`,
        size: bounds.local.size,
        units: 'world units',
        note: 'size is in the node\'s own frame (its current scale NOT applied)',
        nodeRef: args.node,
        filePath: args.filePath,
        isStub,
        currentScale: isStub ? null : (node._lscale ?? { x: 1, y: 1, z: 1 })
    };
}

function renderReport(measured, targets, args) {
    const lines = [`# Fit scale: ${measured.what}`, ''];
    lines.push(`Measured size: ${fmtVec(measured.size)} ${measured.units}` +
        (measured.note ? ` — ${measured.note}` : ''));

    if (targets.length === 0) {
        lines.push('', 'No target given — pass targetWidth/targetHeight/targetDepth to get a scale factor.');
        return lines.join('\n');
    }

    const factors = targets.map(({ axis, value }) => {
        const current = measured.size[axis];
        if (!(current > 0)) {
            throw new Error(`Cannot fit along ${axis}: measured size is ${current}`);
        }
        return { axis, value, factor: value / current };
    });
    const uniform = Math.min(...factors.map(f => f.factor));

    lines.push('');
    for (const f of factors) {
        lines.push(`- ${f.axis}: ${fmt(measured.size[f.axis])} → ${fmt(f.value)} (factor ${fmt(f.factor)})`);
    }
    lines.push('', `**Uniform scale factor: ${fmt(uniform)}**` +
        (factors.length > 1 ? ' (fits inside all targets)' : ''));

    const resulting = {
        x: measured.size.x * uniform,
        y: measured.size.y * uniform,
        z: measured.size.z * uniform
    };
    lines.push(`Resulting size at that factor: ${fmtVec(resulting)}`);

    if (measured.nodeRef) {
        const s = measured.currentScale;
        if (s) {
            const suggested = { x: s.x * uniform, y: s.y * uniform, z: s.z * uniform };
            lines.push('', 'Apply with:', '```json',
                JSON.stringify({
                    op: 'set_node_property', node: measured.nodeRef,
                    property: 'scale', value: roundVec(suggested)
                }), '```',
                `(current scale ${fmtVec(s)} × ${fmt(uniform)})`);
        } else {
            lines.push('', 'Apply with:', '```json',
                JSON.stringify({
                    op: 'set_instance_property', node: measured.nodeRef,
                    property: 'scale', value: roundVec({ x: uniform, y: uniform, z: uniform })
                }), '```',
                '(instance stub — factor is relative to the current scale override, adjust if one is set)');
        }
    } else {
        lines.push('', `Apply to the node carrying this asset, e.g. scale ${fmt(uniform)} on the Visual wrapper child.`);
    }
    return lines.join('\n');
}

function roundVec(v) {
    const r = (n) => Math.round(n * 10000) / 10000;
    return { x: r(v.x), y: r(v.y), z: r(v.z) };
}
