/**
 * LintAssets - MCP tool: project hygiene checks
 *
 * Four checks (mechanics here, policy in the SKILL):
 * - names:     cryptic/auto-generated asset names (mesh_001, Sprite(2), …);
 *              renaming is safe — the UUID lives in .meta
 * - scales:    model import sizes scattered orders of magnitude apart
 *              (hints that per-node scale corrections are hiding everywhere)
 * - wrappers:  prefabs whose ROOT carries a renderer or a non-identity scale
 *              (violates the Root → Visual wrapper convention)
 * - materials: a renderer uses a material embedded in a model file while
 *              another usage of the same mesh uses a project material — the
 *              mesh renders (no missing-material warning) but doesn't match
 *              the project's look; someone probably forgot to assign it
 */

import * as fs from 'fs';
import * as path from 'path';
import { BaseTool } from './BaseTool.js';
import { SceneDocument, isRef } from '../document/SceneDocument.js';
import { loadSourcePrefabByUuid } from '../document/instances.js';
import { AssetIndex } from '../core/AssetIndex.js';
import { AssetInspector } from '../core/AssetInspector.js';
import { VISUAL_ROOT_TYPES, MESH_RENDERERS } from '../document/componentTypes.js';

const CHECKS = ['names', 'scales', 'wrappers', 'materials'];
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
               'the UUID lives in .meta), model import sizes scattered more than N× apart, prefabs ' +
               'violating the wrapper convention (renderer or non-identity scale on the prefab ROOT), ' +
               'and material consistency (a mesh rendered with its embedded fbx material in one place ' +
               'but a project material elsewhere — likely a forgotten assignment). ' +
               'Checks: names, scales, wrappers, materials (default: all). ' +
               'Args: {checks?: array of "names"|"scales"|"wrappers"|"materials", folder?, scaleRatio?: number}.';
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
        const index = AssetIndex.shared(projectRoot);
        const inspector = new AssetInspector(projectRoot, index);
        const checks = args.checks?.length ? args.checks : CHECKS;
        const folder = args.folder;

        const sections = [];
        if (checks.includes('names')) sections.push(this.#lintNames(index, folder));
        if (checks.includes('scales')) sections.push(this.#lintScales(index, inspector, folder, args.scaleRatio ?? 10));
        if (checks.includes('wrappers')) sections.push(this.#lintWrappers(index, projectRoot, folder));
        if (checks.includes('materials')) sections.push(this.#lintMaterials(index, projectRoot, folder));

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

    /**
     * Collect every mesh-renderer usage across scenes and prefabs — plain
     * nodes read directly, collapsed instances through their source prefab
     * with _materials overrides applied — then flag meshes rendered with an
     * embedded model material in one place but a project material in another.
     */
    #lintMaterials(index, projectRoot, folder) {
        const ctx = { assetIndex: index, projectRoot };
        const usages = []; // {meshUuid, materialUuid, file, where}

        for (const type of ['scene', 'prefab']) {
            for (const entry of this.#list(index, folder, type)) {
                let doc;
                try {
                    doc = SceneDocument.load(path.join(projectRoot, entry.path));
                } catch {
                    continue; // unparsable files are reported by the wrappers check
                }
                this.#collectRendererUsages(doc, entry.path, ctx, usages);
            }
        }

        // Group by mesh; a mesh is inconsistent when both kinds are present
        const byMesh = new Map();
        for (const u of usages) {
            if (!u.meshUuid || !u.materialUuid) continue;
            if (!byMesh.has(u.meshUuid)) byMesh.set(u.meshUuid, []);
            byMesh.get(u.meshUuid).push(u);
        }

        const lines = [];
        for (const [meshUuid, meshUsages] of byMesh) {
            const embedded = meshUsages.filter(u => this.#isEmbeddedMaterial(index, u.materialUuid));
            const project = meshUsages.filter(u => !this.#isEmbeddedMaterial(index, u.materialUuid));
            if (!embedded.length || !project.length) continue;

            const projectNames = [...new Set(project.map(u => index.label(u.materialUuid) ?? u.materialUuid))];
            lines.push(
                `- mesh ${index.label(meshUuid) ?? meshUuid}: rendered with the embedded model material at ` +
                embedded.map(u => `${u.file} "${u.where}"`).join(', ') +
                ` — but with project material ${projectNames.join(' / ')} at ` +
                project.map(u => `${u.file} "${u.where}"`).join(', ') +
                '. Probably a forgotten material assignment.'
            );
        }

        if (!lines.length) lines.push('OK — no mesh mixes embedded and project materials.');
        return {
            title: 'Material consistency',
            count: lines[0].startsWith('OK') ? 0 : lines.length,
            lines
        };
    }

    /** Renderer usages in a document: direct components + collapsed instances */
    #collectRendererUsages(doc, file, ctx, usages) {
        const walk = (docLike, nodeIdx, label) => {
            for (const compIdx of docLike.componentIndices(nodeIdx)) {
                const comp = docLike.getObject(compIdx);
                if (!MESH_RENDERERS.includes(comp.__type__)) continue;
                const meshUuid = comp._mesh?.__uuid__;
                for (const mat of comp._materials ?? []) {
                    usages.push({ meshUuid, materialUuid: mat?.__uuid__, file, where: label });
                }
            }
        };

        const enter = (nodeIdx, label) => {
            if (doc.isInstanceStub(nodeIdx)) {
                this.#collectInstanceUsages(doc, nodeIdx, label, file, ctx, usages);
                return;
            }
            walk(doc, nodeIdx, label);
            for (const childIdx of doc.childIndices(nodeIdx)) {
                const childLabel = `${label === '/' ? '' : label}/${doc.nodeName(childIdx) ?? '<unnamed>'}`;
                enter(childIdx, childLabel);
            }
        };
        enter(doc.root.idx, '/');
    }

    /**
     * Renderer usages inside a collapsed instance: source prefab values with
     * this instance's single-hop _materials overrides applied. Stubs nested
     * inside the source are skipped — their own asset file is scanned anyway.
     */
    #collectInstanceUsages(doc, stubIdx, label, file, ctx, usages) {
        const info = doc.getObject(doc.getObject(stubIdx)._prefab.__id__);
        if (typeof info.asset?.__uuid__ !== 'string') return;
        let source;
        try {
            source = loadSourcePrefabByUuid(ctx, info.asset.__uuid__);
        } catch {
            return; // no library/ cache — nothing to inspect
        }

        // fileId → {propertyPath tail → value} for _materials overrides
        const overrides = new Map();
        const instance = doc.instanceOf(stubIdx);
        for (const ref of instance?.propertyOverrides ?? []) {
            if (!isRef(ref)) continue;
            const o = doc.getObject(ref.__id__);
            if (o?.__type__ !== 'CCPropertyOverrideInfo' || o.propertyPath?.[0] !== '_materials') continue;
            const target = isRef(o.targetInfo) ? doc.getObject(o.targetInfo.__id__) : null;
            if (target?.localID?.length !== 1) continue;
            if (!overrides.has(target.localID[0])) overrides.set(target.localID[0], []);
            overrides.get(target.localID[0]).push(o);
        }

        const sdoc = source.doc;
        const walk = (nodeIdx, innerLabel) => {
            if (sdoc.isInstanceStub(nodeIdx)) return;
            for (const compIdx of sdoc.componentIndices(nodeIdx)) {
                const comp = sdoc.getObject(compIdx);
                if (!MESH_RENDERERS.includes(comp.__type__)) continue;
                const compInfo = isRef(comp.__prefab) ? sdoc.getObject(comp.__prefab.__id__) : null;
                const materials = (comp._materials ?? []).map(m => m?.__uuid__);
                for (const o of overrides.get(compInfo?.fileId) ?? []) {
                    // ["_materials", "N"] replaces one slot; ignore other shapes
                    if (o.propertyPath.length === 2 && /^\d+$/.test(o.propertyPath[1])) {
                        materials[Number(o.propertyPath[1])] = o.value?.__uuid__;
                    }
                }
                for (const materialUuid of materials) {
                    usages.push({
                        meshUuid: comp._mesh?.__uuid__, materialUuid,
                        file, where: innerLabel
                    });
                }
            }
            for (const childIdx of sdoc.childIndices(nodeIdx)) {
                walk(childIdx, `${innerLabel}→${sdoc.nodeName(childIdx) ?? '<unnamed>'}`);
            }
        };
        walk(sdoc.root.idx, label);
    }

    /** Material baked into a model file (gltf-material sub-asset) vs a project .mtl */
    #isEmbeddedMaterial(index, materialUuid) {
        if (!materialUuid?.includes('@')) return false;
        return index.resolve(materialUuid)?.subAsset?.importer === 'gltf-material';
    }
}

function fmt(n) {
    if (n >= 100) return String(Math.round(n));
    return String(Math.round(n * 10000) / 10000);
}
