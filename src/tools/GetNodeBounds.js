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
import { buildBoundsContext, fmtVec } from './measure.js';

export class GetNodeBounds extends BaseTool {
    get name() {
        return 'get_node_bounds';
    }

    get description() {
        return 'Compute the axis-aligned bounding box of a node and its children in a .scene/.prefab file. ' +
               'Merges mesh AABBs (MeshRenderer/SkinnedMeshRenderer), UITransform rects and collapsed ' +
               'prefab-instance contents. Returns `local` (the node\'s own frame, its own transform excluded — ' +
               'use as BoxCollider center/size on that node) and `world` (document space). ' +
               '3D sizes are in world units; UITransform contributions are in UI pixels.';
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
        const result = new BoundsCalculator(ctx).computeSubtree(doc, nodeIdx);
        return this.success(renderBoundsReport(doc.nodePath(nodeIdx) ?? '/', result));
    }
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

function renderBoundsReport(nodePath, result) {
    const lines = [`# Bounds of "${nodePath}"`, ''];
    lines.push(...renderAabb('Local (node\'s own frame — BoxCollider center/size)', result.local));
    lines.push('');
    lines.push(...renderAabb('World', result.world));

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
