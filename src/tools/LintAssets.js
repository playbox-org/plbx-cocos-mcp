/**
 * LintAssets - MCP tool: project hygiene checks
 *
 * Three checks (mechanics here, policy in the SKILL):
 * - names:    cryptic/auto-generated asset names (mesh_001, Sprite(2), …);
 *             renaming is safe — the UUID lives in .meta
 * - scales:   model import sizes scattered orders of magnitude apart
 *             (hints that per-node scale corrections are hiding everywhere)
 * - wrappers: prefabs whose ROOT carries a renderer or a non-identity scale
 *             (violates the Root → Visual wrapper convention)
 */

import * as fs from 'fs';
import * as path from 'path';
import { BaseTool } from './BaseTool.js';
import { SceneDocument } from '../document/SceneDocument.js';
import { AssetIndex } from '../core/AssetIndex.js';
import { AssetInspector } from '../core/AssetInspector.js';

const CHECKS = ['names', 'scales', 'wrappers'];
const VISUAL_ROOT_TYPES = ['cc.MeshRenderer', 'cc.SkinnedMeshRenderer', 'cc.Sprite'];
const NAMED_TYPES = ['fbx', 'gltf', 'image', 'prefab', 'material', 'audio-clip', 'scene'];

/** Auto-generated / meaningless name patterns (checked against the basename without extension) */
const CRYPTIC_PATTERNS = [
    [/^(mesh|node|model|object|obj|sprite|image|img|tex|texture|material|mat|prefab|asset|untitled|new|noname|unnamed|default|cube|plane|sphere|cylinder|cone|torus|circle|polysurface|pcube|psphere|pplane|pcylinder)[ _\-.]*\d*$/i,
        'generic auto-name'],
    [/\(\d+\)$/, 'editor duplicate suffix "(N)"'],
    [/[ _-]copy(?:[ _-]?\d+)?$/i, 'copy suffix'],
    [/^\d+$/, 'purely numeric name'],
    [/^(final|temp|tmp|test|wip)[ _\-.]*\d*$/i, 'placeholder name']
];

export class LintAssets extends BaseTool {
    get name() {
        return 'lint_assets';
    }

    get description() {
        return 'Lint project assets: cryptic auto-generated names (mesh_001, Sprite(2) — renaming is safe, ' +
               'the UUID lives in .meta), model import sizes scattered more than N× apart, and prefabs ' +
               'violating the wrapper convention (renderer or non-identity scale on the prefab ROOT). ' +
               'Checks: names, scales, wrappers (default: all). ' +
               'Args: {checks?: array of "names"|"scales"|"wrappers", folder?, scaleRatio?: number}.';
    }

    get inputSchema() {
        return {
            type: 'object',
            properties: {
                checks: {
                    type: 'array',
                    items: { type: 'string', enum: CHECKS },
                    description: 'Subset of checks to run (default: all)'
                },
                folder: {
                    type: 'string',
                    description: 'Restrict to a folder (relative to project root or assets/)'
                },
                scaleRatio: {
                    type: 'number',
                    description: 'Scales check: flag models whose max dimension deviates from the median by more than this factor (default 10)',
                    default: 10
                }
            }
        };
    }

    async execute(args, projectRoot) {
        const index = new AssetIndex(projectRoot);
        const inspector = new AssetInspector(projectRoot, index);
        const checks = args.checks?.length ? args.checks : CHECKS;
        const folder = args.folder;

        const sections = [];
        if (checks.includes('names')) sections.push(this.#lintNames(index, folder));
        if (checks.includes('scales')) sections.push(this.#lintScales(index, inspector, folder, args.scaleRatio ?? 10));
        if (checks.includes('wrappers')) sections.push(this.#lintWrappers(index, projectRoot, folder));

        const total = sections.reduce((n, s) => n + s.count, 0);
        const lines = [`# Asset lint — ${total} finding(s)`, ''];
        for (const s of sections) {
            lines.push(`## ${s.title} (${s.count})`, ...s.lines, '');
        }
        return this.success(lines.join('\n').trimEnd());
    }

    #list(index, folder, type) {
        return index.list(folder ? { folder, type } : { type });
    }

    #lintNames(index, folder) {
        const lines = [];
        for (const type of NAMED_TYPES) {
            for (const entry of this.#list(index, folder, type)) {
                const base = entry.name.replace(/\.[^.]+$/, '');
                for (const [pattern, why] of CRYPTIC_PATTERNS) {
                    if (pattern.test(base)) {
                        lines.push(`- ${entry.path} — ${why}`);
                        break;
                    }
                }
            }
        }
        if (!lines.length) lines.push('OK — no cryptic names.');
        return { title: 'Cryptic names', count: lines[0].startsWith('OK') ? 0 : lines.length, lines };
    }

    #lintScales(index, inspector, folder, ratio) {
        const models = [];
        for (const entry of this.#list(index, folder, 'model')) {
            const info = inspector.inspect(entry.uuid);
            const dims = (info?.meshes ?? [])
                .filter(m => m.aabb)
                .map(m => Math.max(m.aabb.size.x, m.aabb.size.y, m.aabb.size.z));
            if (dims.length) models.push({ path: entry.path, maxDim: Math.max(...dims) });
        }

        const lines = [];
        if (models.length < 2) {
            lines.push(`OK — ${models.length} measurable model(s), nothing to compare.`);
            return { title: 'Model scale spread', count: 0, lines };
        }

        const sorted = [...models].sort((a, b) => a.maxDim - b.maxDim);
        const median = sorted[Math.floor(sorted.length / 2)].maxDim;
        const spread = sorted[sorted.length - 1].maxDim / sorted[0].maxDim;
        const outliers = sorted.filter(m => m.maxDim > median * ratio || m.maxDim < median / ratio);

        if (!outliers.length) {
            lines.push(`OK — ${models.length} models within ${ratio}× of the median (${fmt(median)}); total spread ${fmt(spread)}×.`);
            return { title: 'Model scale spread', count: 0, lines };
        }
        lines.push(
            `${models.length} measurable models, median max-dimension ${fmt(median)}, total spread ${fmt(spread)}×.`,
            `Outliers beyond ${ratio}× of the median — consider normalizing import scale ` +
            `(or record the reference scale in cocos-conventions.md):`
        );
        for (const m of outliers) {
            lines.push(`- ${m.path} — max dimension ${fmt(m.maxDim)} (${fmt(m.maxDim / median)}× median)`);
        }
        return { title: 'Model scale spread', count: outliers.length, lines };
    }

    #lintWrappers(index, projectRoot, folder) {
        const lines = [];
        for (const entry of this.#list(index, folder, 'prefab')) {
            let doc;
            try {
                doc = SceneDocument.load(path.join(projectRoot, entry.path));
            } catch {
                lines.push(`- ${entry.path} — cannot parse`);
                continue;
            }
            if (!doc.isPrefab) continue;
            const rootIdx = doc.root.idx;
            if (doc.isInstanceStub(rootIdx)) continue; // variant-style prefab, skip

            const rootVisuals = doc.componentIndices(rootIdx)
                .map(i => doc.getObject(i).__type__)
                .filter(t => VISUAL_ROOT_TYPES.includes(t));
            for (const t of rootVisuals) {
                lines.push(`- ${entry.path} — root carries ${t}; move it to a Visual child (wrapper rule)`);
            }
            const s = doc.root.node._lscale;
            if (s && (s.x !== 1 || s.y !== 1 || s.z !== 1)) {
                lines.push(
                    `- ${entry.path} — root scale is (${fmt(s.x)}, ${fmt(s.y)}, ${fmt(s.z)}); ` +
                    `keep the root at scale 1 and put the correction on the Visual child`
                );
            }
        }
        if (!lines.length) lines.push('OK — all prefabs follow the wrapper convention.');
        return { title: 'Prefab wrapper rule', count: lines[0].startsWith('OK') ? 0 : lines.length, lines };
    }
}

function fmt(n) {
    if (n >= 100) return String(Math.round(n));
    return String(Math.round(n * 10000) / 10000);
}
