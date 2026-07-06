/**
 * ApplyEdits - MCP tool: batch semantic edits on a .scene/.prefab file
 *
 * LLMs must never Edit/Write scene files directly (700KB, fragile __id__
 * indexing) — this tool is the only sanctioned write path. Operations are
 * applied in memory, the document is renumbered and validated, and only a
 * fully valid result is written (atomically). dryRun previews everything
 * without touching disk.
 */

import * as fs from 'fs';
import * as path from 'path';
import { BaseTool } from './BaseTool.js';
import { SceneDocument } from '../document/SceneDocument.js';
import { applyOperations } from '../document/operations.js';
import { Validator } from '../document/Validator.js';
import { renderSubtree } from '../document/MiniTree.js';
import { AssetIndex } from '../core/AssetIndex.js';
import { compressUuid } from '../utils/uuid.js';

const OPS_DOC = `Operations (applied in order, all-or-nothing):
- set_node_property {node, property: name|active|layer|mobility|position|rotation|scale, value}
  position/scale take {x?,y?,z?} (merged), rotation takes euler degrees {x?,y?,z?} (quaternion derived automatically)
- add_node {parent, name, position?, rotation?, scale?, layer?, active?, index?}
- remove_node {node, force?} (force nulls external references into the subtree)
- reparent {node, newParent, index?}
- add_component {node, type, properties?} (type: cc.* template or custom script name)
- remove_component {node, component?, componentIndex?, force?, target?} (force nulls external references to the component; cc.UITransform is protected while UI components need it. On a prefab-instance stub: target = node path inside the source prefab ("" = root), the removal is recorded in the instance's removedComponents — the source prefab is untouched; undo with restore_instance_component)
- set_component_property {node, component?, componentIndex?, property, value}
  value forms: raw JSON | {x?,y?,..} merged into typed values | {"$node": "path"} | {"$asset": "path|uuid", "$type"?} | {"$component": {node, type, target?}}
  References INTO collapsed prefab instances work: {"$node": "Stub/Inner/Node"} (path continues inside the stub) and {"$component": {node: "Stub", target: "Inner/Node", type: "T"}} serialize as null + a targetOverride record (the editor's own form); overwriting with a plain value removes the record
- set_asset_ref {node, component?, componentIndex?, property, asset, expectedType?} (asset: project path, UUID or "uuid@subId"; null clears)
- instantiate_prefab {parent, prefab, name?, position?, rotation?, scale?, index?} (prefab: .prefab path/UUID, or a model file / "model.fbx@subId" for its gltf-scene prefab; creates a collapsed instance stub)
- set_instance_property {node, target?, component?, componentIndex?, property, value}
  node = the instance stub in this file; target = node path INSIDE the source prefab ("" = its root; discover paths with inspect_node on the stub). Without component: name|active|layer|mobility|position|rotation|scale. With component: any field (value forms as in set_component_property) — e.g. replace an embedded model material: {node: "Zombie", target: "Mesh", component: "cc.SkinnedMeshRenderer", property: "materials[0]", value: {"$asset": "Materials/Zombie.mtl"}}. Stored as propertyOverrides; same target+property updates in place. Reference values work too: {"$node"}/{"$component"} to plain scene objects serialize into the override value; references into a collapsed instance (this one or another) become a targetOverride record with sourceInfo (the editor's own form)
- remove_instance_override {node, target?, component?, componentIndex?, property} (reverts an override — property or reference — back to the source prefab value)
- restore_instance_component {node, target?, component?, componentIndex?} (undoes remove_component on an instance: deletes the removedComponents entry)

Node addressing: "Canvas/Panel/BuyBtn" path from root, "/" = root, node _id, "Name[i]" or "[i]" disambiguate same-named/positional siblings.
Prefab instances inside scenes are collapsed stubs: their internals are not in the file. Inspect them with inspect_node (shows internals + target paths), override properties with set_instance_property, remove/reparent the whole instance, or edit the source .prefab; anything else is rejected.`;

export class ApplyEdits extends BaseTool {
    get name() {
        return 'apply_edits';
    }

    get description() {
        return 'Apply a batch of semantic edit operations to a Cocos Creator .scene or .prefab file. ' +
               'Validates invariants and writes atomically; use dryRun to preview. ' +
               'Returns the minified subtree around every change. ' +
               'Args: {filePath (required), ops (required array), dryRun?: boolean}. ' + OPS_DOC;
    }

    get inputSchema() {
        return {
            type: 'object',
            properties: {
                filePath: {
                    type: 'string',
                    description: 'Path to .scene or .prefab file relative to project root'
                },
                ops: {
                    type: 'array',
                    description: 'Operations to apply in order (see tool description for shapes)',
                    items: { type: 'object' },
                    minItems: 1
                },
                dryRun: {
                    type: 'boolean',
                    description: 'Preview: apply + validate in memory, report, but do not write',
                    default: false
                }
            },
            required: ['filePath', 'ops']
        };
    }

    async execute(args, projectRoot) {
        const filePath = path.resolve(projectRoot, args.filePath);
        if (!filePath.startsWith(path.resolve(projectRoot) + path.sep)) {
            return this.error('filePath must stay inside the project root');
        }
        if (!fs.existsSync(filePath)) {
            return this.error(`File not found: ${filePath}`);
        }

        let doc;
        try {
            doc = SceneDocument.load(filePath);
        } catch (err) {
            return this.error(`Cannot parse ${args.filePath}: ${err.message}`);
        }

        const assetIndex = AssetIndex.shared(projectRoot);
        const ctx = { assetIndex, projectRoot, scriptNameByCompressed: this.#scriptNames(assetIndex) };

        let results;
        try {
            results = applyOperations(doc, args.ops, ctx);
        } catch (err) {
            return this.error(`${err.message}\n\nNothing was written.`);
        }

        const { dropped } = doc.renumber();
        const { errors, warnings } = new Validator(doc, assetIndex, { projectRoot }).validate();
        if (errors.length > 0) {
            return this.error(
                `Edits produced an invalid document — nothing was written:\n` +
                errors.map(e => `- ${e}`).join('\n')
            );
        }

        const dryRun = args.dryRun === true;
        if (!dryRun) {
            doc.save(filePath);
        }

        return this.success(this.#report({ args, doc, results, warnings, dropped, dryRun, ctx }));
    }

    /** compressed script UUID → readable name, for subtree rendering */
    #scriptNames(assetIndex) {
        const map = new Map();
        for (const entry of assetIndex.list({ type: 'script' })) {
            map.set(compressUuid(entry.uuid), entry.name.replace(/\.[jt]s$/, ''));
        }
        return map;
    }

    #report({ args, doc, results, warnings, dropped, dryRun, ctx }) {
        const lines = [];
        lines.push(dryRun
            ? `# DRY RUN — ${args.filePath} NOT modified`
            : `# Applied ${results.length} op(s) to ${args.filePath}`);
        lines.push('');
        results.forEach((r, i) => lines.push(`${i + 1}. [${r.op}] ${r.summary}`));
        if (dropped > 0) lines.push(`\nGarbage-collected ${dropped} unreachable object(s).`);

        // One subtree per distinct affected area (indices are valid post-renumber
        // only via re-resolution, so resolve by recorded path)
        const shown = new Set();
        const covered = (anchor) =>
            shown.has(anchor) ||
            [...shown].some(s => s === '/' || anchor.startsWith(`${s}/`));
        const trees = [];
        for (const r of results) {
            const anchor = r.target === '/' ? '/' : r.target;
            if (covered(anchor)) continue;
            shown.add(anchor);
            try {
                const idx = doc.resolveNode(anchor);
                trees.push(renderSubtree(doc, idx, {
                    maxDepth: 2,
                    scriptNames: ctx.scriptNameByCompressed ?? undefined
                }));
            } catch {
                // Node was removed — show its parent instead
                const parentPath = anchor.includes('/') ? anchor.slice(0, anchor.lastIndexOf('/')) : '/';
                if (!shown.has(parentPath)) {
                    shown.add(parentPath);
                    try {
                        const idx = doc.resolveNode(parentPath);
                        trees.push(renderSubtree(doc, idx, { maxDepth: 1, scriptNames: ctx.scriptNameByCompressed ?? undefined }));
                    } catch { /* root always resolves; ignore */ }
                }
            }
        }
        if (trees.length) {
            lines.push('', '## Result subtrees', '');
            lines.push(trees.join('\n---\n'));
        }

        if (warnings.length) {
            lines.push('', '## Warnings');
            warnings.forEach(w => lines.push(`- ${w}`));
        }
        if (dryRun) {
            lines.push('', 'Re-run with dryRun: false to write.');
        }
        return lines.join('\n');
    }
}
