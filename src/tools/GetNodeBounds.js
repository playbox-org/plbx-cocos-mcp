/**
 * GetNodeBounds - MCP tool: computed world/local AABB of a node subtree
 *
 * Primary scenario: fit a collider or judge placement without
 * opening the editor. `local` is in the queried node's own frame (its own
 * TRS excluded) — directly usable as BoxCollider center/size on that node.
 */

import * as fs from 'fs';
import * as path from 'path';
import { BaseTool } from './BaseTool.js';
import { SceneDocument } from '../document/SceneDocument.js';
import { BoundsCalculator } from '../document/Bounds.js';
import { buildBoundsContext, fmt, fmtVec } from './measure.js';

/** Row cap for `perChild` — a scene root can have hundreds of children */
const MAX_PER_CHILD = 200;

export class GetNodeBounds extends BaseTool {
    get name() {
        return 'get_node_bounds';
    }

    get description() {
        return 'Compute the axis-aligned bounding box of a node and its children in a .scene/.prefab file. ' +
               'Merges mesh AABBs (MeshRenderer/SkinnedMeshRenderer), UITransform rects and collapsed ' +
               'prefab-instance contents. Returns `local` (the node\'s own frame, its own transform excluded — ' +
               'use as BoxCollider center/size on that node) and `world` (document space). ' +
               '3D sizes are in world units; UITransform contributions are in UI pixels. ' +
               'perChild adds one world AABB per DIRECT child — the merged box of a group cannot answer ' +
               '"which child stands at (4, 6)", and the merge already computes every child box anyway; ' +
               'on a collapsed prefab instance those are the SOURCE prefab\'s children, placed by the ' +
               'instance transform. ' +
               'Args: {filePath (required), node (required: "Canvas/Panel/BuyBtn" path, _id, or "/"), ' +
               'perChild?: boolean}.';
    }

    get inputSchema() {
        return {
            type: 'object',
            properties: {
                filePath: {
                    type: 'string',
                    description: 'Path to .scene or .prefab file relative to project root'
                },
                node: {
                    type: 'string',
                    description: 'Node path ("Canvas/Panel/BuyBtn"), node _id, or "/" for the root'
                },
                perChild: {
                    type: 'boolean',
                    description: 'Also list a world AABB per direct child (up to ' +
                                 `${MAX_PER_CHILD} of them), with the world position for children ` +
                                 'that have nothing measurable in them'
                }
            },
            required: ['filePath', 'node']
        };
    }

    async execute(args, projectRoot) {
        const filePath = path.resolve(projectRoot, args.filePath);
        if (!fs.existsSync(filePath)) {
            return this.error(`File not found: ${filePath}`);
        }

        let doc;
        try {
            doc = SceneDocument.load(filePath);
        } catch (err) {
            return this.error(`Cannot parse ${args.filePath}: ${err.message}`);
        }

        let nodeIdx;
        try {
            nodeIdx = doc.resolveNode(args.node);
        } catch (err) {
            return this.error(err.message);
        }

        const ctx = buildBoundsContext(projectRoot);
        // One calculator per call: its caches keep the per-child pass to a matrix walk each
        const calculator = new BoundsCalculator(ctx);
        const result = calculator.computeSubtree(doc, nodeIdx);
        const children = args.perChild === true ? perChildBoxes(calculator, doc, nodeIdx) : null;
        return this.success(renderBoundsReport(doc.nodePath(nodeIdx) ?? '/', result, children));
    }
}

/**
 * World AABB per direct child, falling back to its world POSITION when nothing in it is
 * measurable — for a placement question the position is still an answer. `skipped` says which
 * children could not be enumerated at all, so a short list is never read as a complete one.
 */
function perChildBoxes(calculator, doc, nodeIdx) {
    const { rows, skipped } = calculator.computeChildren(doc, nodeIdx);
    return {
        rows: rows.slice(0, MAX_PER_CHILD),
        total: rows.length,
        omitted: Math.max(0, rows.length - MAX_PER_CHILD),
        skipped,
        inPrefab: doc.isInstanceStub(nodeIdx)
    };
}

function renderAabb(title, aabb) {
    if (!aabb) return [`## ${title}`, 'No measurable contributors.'];
    return [
        `## ${title}`,
        `- size:   ${fmtVec(aabb.size)}`,
        `- center: ${fmtVec(aabb.center)}`,
        `- min:    ${fmtVec(aabb.min)}`,
        `- max:    ${fmtVec(aabb.max)}`
    ];
}

function renderBoundsReport(nodePath, result, children) {
    const lines = [`# Bounds of "${nodePath}"`, ''];
    lines.push(...renderAabb('Local (node\'s own frame — BoxCollider center/size)', result.local));
    lines.push('');
    lines.push(...renderAabb('World', result.world));

    if (children) {
        lines.push('', `## Per child (${children.rows.length}${children.omitted ? ` of ${children.total}` : ''})`);
        lines.push('World AABBs. XZ is the footprint — the axes a placement or occupancy question asks about.');
        if (children.inPrefab && children.rows.length) {
            lines.push(
                'This node is a collapsed prefab instance, so these are the SOURCE PREFAB\'s children ' +
                'placed by the instance transform. Their names address nodes inside the prefab, not ' +
                'the scene — edit them in the prefab, or override them via set_instance_property.'
            );
        }
        // Named where the missing rows would have been: a count with children unread must not
        // be read as "this node has none"
        for (const s of children.skipped) {
            lines.push(`- ! ${s.path}: children NOT listed — ${s.reason}; the count above is a lower bound`);
        }
        for (const c of children.rows) {
            const marker = c.active ? '●' : '○';
            if (!c.world) {
                lines.push(
                    `- ${marker} ${c.name}: nothing measurable — world position ${fmtVec(c.position)}`
                );
                continue;
            }
            const w = c.world;
            lines.push(
                `- ${marker} ${c.name}: x ${fmt(w.min.x)}..${fmt(w.max.x)}, z ${fmt(w.min.z)}..${fmt(w.max.z)}, ` +
                `y ${fmt(w.min.y)}..${fmt(w.max.y)}  size ${fmtVec(w.size)}`
            );
        }
        if (children.omitted) {
            lines.push(`… ${children.omitted} more child(ren) not shown — query a subtree instead.`);
        }
    }

    if (result.contributors.length) {
        lines.push('', '## Contributors');
        for (const c of result.contributors) {
            lines.push(`- ${c.path}: ${c.type} (${c.source})`);
        }
    }
    if (result.skipped.length) {
        lines.push('', '## Skipped (not measurable)');
        for (const s of result.skipped) {
            lines.push(`- ${s.path}: ${s.reason}`);
        }
    }
    return lines.join('\n');
}
