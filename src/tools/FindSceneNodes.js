/**
 * FindSceneNodes - MCP tool for finding nodes by pattern, component and/or world XZ region
 *
 * SOLID: S - Single tool, single purpose
 *
 * `region` answers "what already stands here?" in one call instead of one get_node_bounds per
 * candidate, and prints each footprint — the follow-up question is always the overlap.
 */

import * as fs from 'fs';
import * as path from 'path';
import { BaseTool } from './BaseTool.js';
import { SceneMinifier } from '../core/SceneMinifier.js';
import { SceneDocument, isRef } from '../document/SceneDocument.js';
import { BoundsCalculator } from '../document/Bounds.js';
import { buildBoundsContext, fmt } from './measure.js';

/** Region key sets: an axis-aligned rectangle or a circle, both in WORLD XZ metres */
const RECT_KEYS = ['x', 'z', 'width', 'depth'];
const CIRCLE_KEYS = ['center', 'radius'];

export class FindSceneNodes extends BaseTool {
    get name() {
        return 'find_scene_nodes';
    }

    get description() {
        return 'Find nodes in a Cocos Creator scene by name pattern (regex supported), by ' +
               'component and/or by WORLD XZ region: a cc.* type ("cc.Camera") or a custom script name ' +
               '("PlayerController") — components mounted on prefab instances match too. ' +
               'region: {x, z, width, depth} or {center: [x, z], radius} keeps only nodes whose world ' +
               'AABB footprint overlaps it (nodes with nothing measurable are matched by their world ' +
               'position), and prints that footprint — the "what already stands in this area" query ' +
               'for placement, occupancy and cleanup. Terrain-local XZ equals world XZ only when the ' +
               'terrain node sits at the origin. Screen-space nodes (anything under a cc.Canvas) are ' +
               'left out of a region query and counted in a footer — a Canvas lays its subtree out in ' +
               'PIXELS, not metres — and a cc.UITransform rect never contributes to a footprint. ' +
               'Each match shows its full root-anchored path — reuse it verbatim as the ' +
               '`node` argument of inspect_node/get_node_bounds/apply_edits — and its #N ' +
               'nodeId (inspect_node only). ' +
               'Args: {scenePath (required), pattern?, component?, region?} — at least one of ' +
               'pattern/component/region.';
    }

    get aliases() {
        return { filePath: 'scenePath' };
    }

    get inputSchema() {
        return {
            type: 'object',
            properties: {
                scenePath: {
                    type: 'string',
                    description: 'Path to scene file relative to project root'
                },
                pattern: {
                    type: 'string',
                    description: 'Name pattern to search for (regex supported)'
                },
                component: {
                    type: 'string',
                    description: 'Only nodes carrying this component: cc.* type or custom script name (mounted components on prefab instances match too)'
                },
                region: {
                    type: 'object',
                    description: 'Only nodes whose world AABB footprint overlaps this area of the XZ ' +
                                 'plane: {x, z, width, depth} (metres, x/z are the near corner) or ' +
                                 '{center: [x, z], radius}. Y is ignored — occupancy is a footprint ' +
                                 'question. Nodes under a cc.Canvas are excluded (screen pixels, not ' +
                                 'metres) and UITransform rects never count toward a footprint. ' +
                                 'Matches print their world x/z extent'
                }
            },
            required: ['scenePath']
        };
    }

    async execute(args, projectRoot) {
        const scenePath = path.resolve(projectRoot, args.scenePath);

        if (!fs.existsSync(scenePath)) {
            return this.error(`Scene file not found: ${scenePath}`);
        }
        if (args.pattern === undefined && args.component === undefined && args.region === undefined) {
            return this.error(
                'Pass "pattern" (name regex), "component" (cc.* type or script name) and/or ' +
                '"region" ({x, z, width, depth} or {center, radius} in world XZ metres)'
            );
        }

        let region = null;
        if (args.region !== undefined) {
            try {
                region = parseRegion(args.region);
            } catch (err) {
                return this.error(err.message);
            }
        }

        try {
            const minifier = new SceneMinifier(scenePath, projectRoot);
            let matches = minifier.findNodes(args.pattern ?? null, args.component ?? null);

            let placed = null;
            let uiExcluded = 0;
            if (region) {
                // Node ids ARE array indices in both readers, so a match maps straight over
                const doc = SceneDocument.load(scenePath);
                const calculator = new BoundsCalculator(buildBoundsContext(projectRoot));
                const uiCache = new Map();
                placed = new Map();
                matches = matches.filter((m) => {
                    const node = doc.getObject(m.id);
                    if (!node || !doc.isNode(node)) return false;
                    // A Canvas subtree is laid out in PIXELS, not placed on the ground: its rects
                    // and positions answer no question about world XZ occupancy, and their numbers
                    // are large enough to overlap any region asked about
                    if (isScreenSpace(doc, m.id, uiCache)) { uiExcluded++; return false; }
                    // …and a 3D node's own box must not inherit pixels from a UI descendant either
                    const world = calculator.computeSubtree(doc, m.id, { skipUI: true }).world;
                    const footprint = world
                        ? { minX: world.min.x, maxX: world.max.x, minZ: world.min.z, maxZ: world.max.z, measured: true }
                        : pointFootprint(calculator.worldPosition(doc, m.id));
                    if (!overlaps(footprint, region)) return false;
                    placed.set(m.id, footprint);
                    return true;
                });
            }

            // Pattern-only keeps the historical header shape (main-branch
            // clients); component/region add their clause explicitly
            const criteria = [
                args.pattern !== undefined
                    ? (args.component === undefined && args.region === undefined
                        ? `"${args.pattern}"`
                        : `name ~ "${args.pattern}"`)
                    : null,
                args.component !== undefined ? `component = ${args.component}` : null,
                region ? `region ${describeRegion(region)}` : null
            ].filter(Boolean).join(', ');

            let output = `# Nodes matching ${criteria}\n\n` +
                         `Found: ${matches.length}\n\n` +
                         matches.map(m => {
                             const line = `- ${m.active ? '●' : '○'} ${m.path ?? m.name} #${m.id} ` +
                                          `[${m.components.join(', ')}]`;
                             const f = placed?.get(m.id);
                             if (!f) return line;
                             return `${line} @ x ${fmt(f.minX)}..${fmt(f.maxX)}, z ${fmt(f.minZ)}..${fmt(f.maxZ)}` +
                                    (f.measured ? '' : ' (position only — nothing measurable)');
                         }).join('\n');

            if (matches.length > 0) {
                output += '\n\nPaths are root-anchored `node` addresses for inspect_node / ' +
                          'get_node_bounds / apply_edits; #N is the nodeId for inspect_node only.';
                if (region) {
                    output += '\nExtents are WORLD XZ; get_node_bounds {perChild: true} on a group ' +
                              'gives the same per-child boxes without a name/component filter.';
                }
            }
            if (region && uiExcluded > 0) {
                output += `\n\n${uiExcluded} node(s) under a cc.Canvas matched the other criteria but ` +
                          'were left out: a Canvas lays its subtree out in screen PIXELS, which is not ' +
                          'the world XZ plane a region asks about. Drop `region` to see them.';
            }

            return this.success(output);
        } catch (err) {
            return this.error(err.message);
        }
    }
}

function parseRegion(raw) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new Error(
            'region must be an object: {x, z, width, depth} or {center: [x, z], radius} ' +
            '(world XZ metres)'
        );
    }
    const keys = Object.keys(raw);
    const circle = keys.some(k => CIRCLE_KEYS.includes(k));
    const allowed = circle ? CIRCLE_KEYS : RECT_KEYS;
    for (const key of keys) {
        if (!allowed.includes(key)) {
            throw new Error(
                `region: unknown key "${key}" — a region is either {${RECT_KEYS.join(', ')}} or ` +
                `{${CIRCLE_KEYS.join(', ')}}, not a mix`
            );
        }
    }
    if (circle) {
        const c = raw.center;
        if (!Array.isArray(c) || c.length !== 2 || !c.every(v => typeof v === 'number' && Number.isFinite(v))) {
            throw new Error('region.center must be [x, z] in world metres');
        }
        if (typeof raw.radius !== 'number' || !Number.isFinite(raw.radius) || raw.radius <= 0) {
            throw new Error('region.radius must be a number > 0 metres');
        }
        return { kind: 'circle', x: c[0], z: c[1], radius: raw.radius };
    }
    for (const key of RECT_KEYS) {
        if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key])) {
            throw new Error(
                `region.${key} must be a finite number of metres — a rectangle needs all of ` +
                `${RECT_KEYS.join(', ')} (x/z are the near corner)`
            );
        }
    }
    if (raw.width <= 0 || raw.depth <= 0) {
        throw new Error('region.width and region.depth must be > 0 metres');
    }
    return {
        kind: 'rect',
        minX: raw.x,
        maxX: raw.x + raw.width,
        minZ: raw.z,
        maxZ: raw.z + raw.depth
    };
}

function describeRegion(region) {
    if (region.kind === 'circle') {
        return `${fmt(region.radius)} m around (${fmt(region.x)}, ${fmt(region.z)})`;
    }
    return `x ${fmt(region.minX)}..${fmt(region.maxX)}, z ${fmt(region.minZ)}..${fmt(region.maxZ)}`;
}

/**
 * Is this node laid out in SCREEN space? True when it or an ancestor carries a cc.Canvas, which is
 * what makes its subtree's positions and sizes Canvas pixels instead of world metres.
 *
 * The test is the Canvas and not the cc.UITransform on purpose: a UITransform parented into the 3D
 * hierarchy (a world-space sprite, e.g. a zone icon) has a real world POSITION and only its rect is
 * in pixels — `skipUI` handles the rect, and the position is still the answer to a placement question.
 * @param {import('../document/SceneDocument.js').SceneDocument} doc
 * @param {number} nodeIdx
 * @param {Map<number, boolean>} cache - Shared across one call: a Canvas subtree re-walks one chain
 */
function isScreenSpace(doc, nodeIdx, cache) {
    const chain = [];
    let idx = nodeIdx;
    let answer = false;
    const guard = new Set();
    while (idx !== undefined && !guard.has(idx)) {
        guard.add(idx);
        if (cache.has(idx)) { answer = cache.get(idx); break; }
        chain.push(idx);
        if (doc.componentIndices(idx).some(i => doc.getObject(i)?.__type__ === 'cc.Canvas')) {
            answer = true;
            break;
        }
        const parent = doc.getObject(idx)._parent;
        idx = isRef(parent) ? parent.__id__ : undefined;
    }
    for (const i of chain) cache.set(i, answer);
    return answer;
}

function pointFootprint(pos) {
    return { minX: pos.x, maxX: pos.x, minZ: pos.z, maxZ: pos.z, measured: false };
}

function overlaps(f, region) {
    if (region.kind === 'rect') {
        return f.maxX >= region.minX && f.minX <= region.maxX
            && f.maxZ >= region.minZ && f.minZ <= region.maxZ;
    }
    // Distance from the centre to the nearest point of the box
    const dx = Math.max(f.minX - region.x, 0, region.x - f.maxX);
    const dz = Math.max(f.minZ - region.z, 0, region.z - f.maxZ);
    return dx * dx + dz * dz <= region.radius * region.radius;
}
