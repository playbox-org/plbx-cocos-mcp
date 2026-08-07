/**
 * BuildAnimGraph - MCP tool: compile a compact spec into a .animgraph asset
 *
 * Counterpart of build_prefab for animation graphs: states/transitions/
 * variables expand into the exact editor-serialized object shapes (Entry/
 * Exit/Any and event bindings included), plus a .meta with a fresh UUID so
 * the graph is immediately referencable from an AnimationController.
 *
 * Filesystem ordering and rollback are build_terrain's (BuildTerrain.js): every failure after
 * the first write unwinds what this call created, and an overwrite moves the previous file
 * aside first, so a failure after the rename can still put it back.
 */

import * as fs from 'fs';
import * as path from 'path';
import { BaseTool } from './BaseTool.js';
import { AnimGraphBuilder, AnimGraphBuildError } from '../document/AnimGraphBuilder.js';
import { parseAnimGraph, formatAnimGraphText } from '../document/AnimGraphReader.js';
import { AssetIndex } from '../core/AssetIndex.js';
import { writeMeta, ensureParentDirMetas, resolveAssetMeta } from '../document/MetaGenerator.js';
import { resolveInAssets } from '../utils/assetPaths.js';
import { tempPathFor } from '../utils/fsAtomic.js';

export class BuildAnimGraph extends BaseTool {
    get name() {
        return 'build_animgraph';
    }

    get description() {
        return 'Create a new Cocos Creator animation graph (.animgraph plus .meta with a fresh UUID) ' +
               'from a compact spec. Entry/Exit/Any states and event bindings are generated automatically. ' +
               'Args: {outputPath (required), spec (required object), overwrite?: boolean}. ' +
               'Spec: {variables?: {Name: {type: "float"|"boolean"|"integer"|"trigger", value?}}, ' +
               'states: [{name, clip: "Models/X.glb[@subId]"|"clip.anim"|uuid, speed?}], ' +
               'transitions: [{from, to, when?: "Speed > 0.1", trigger?: "Jump", duration?, exit?, exitTime?}]}. ' +
               '"Entry"/"Any" are valid from-states; a Motion-source transition with no conditions defaults ' +
               'to exit-time behavior ([exit]). Use get_asset_info on a model to list its animation clips, ' +
               'then reference the graph via add_component AnimationController + set_asset_ref graph.';
    }

    get inputSchema() {
        return {
            type: 'object',
            properties: {
                outputPath: {
                    type: 'string',
                    description: 'Target .animgraph path relative to project root, e.g. "assets/Art/Animations/Zombie.animgraph"'
                },
                spec: {
                    type: 'object',
                    description: 'Animation graph spec (see tool description)'
                },
                overwrite: {
                    type: 'boolean',
                    description: 'Allow replacing an existing .animgraph (its .meta/UUID is preserved)',
                    default: false
                }
            },
            required: ['outputPath', 'spec']
        };
    }

    async execute(args, projectRoot) {
        // Containment is checked on RESOLVED paths (assetPaths.js): a symlink under assets/
        // pointing outside the project must not pass it and take the write with it.
        const { path: outputPath, requested, assetsRoot, inside } = resolveInAssets(projectRoot, args.outputPath);
        if (!requested.endsWith('.animgraph')) {
            return this.error('outputPath must end with .animgraph');
        }
        if (!inside) {
            return this.error('outputPath must be inside the project\'s assets/ directory');
        }
        // Whether the FILE pre-existed decides both the overwrite guard and, further down,
        // whether the rollback may unlink it — a question distinct from whether a `.meta` exists
        const fileExisted = fs.existsSync(outputPath);
        if (fileExisted && !args.overwrite) {
            return this.error(`${args.outputPath} already exists — pass overwrite: true to replace it`);
        }

        const assetIndex = AssetIndex.shared(projectRoot);
        let doc;
        let notes;
        try {
            ({ doc, notes } = new AnimGraphBuilder(assetIndex).compile(args.spec));
        } catch (err) {
            if (err instanceof AnimGraphBuildError) {
                return this.error(`${err.message}\n\nNothing was written.`);
            }
            throw err;
        }

        // Meta: reuse an existing one so overwrites keep the UUID; resolved
        // BEFORE writing the graph so an unusable .meta aborts with nothing written
        const metaPath = `${outputPath}.meta`;
        const { uuid, newMeta, error } = resolveAssetMeta(
            metaPath, args.outputPath, () => AnimGraphBuilder.createMeta());
        if (error) return this.error(error);

        // Everything below touches the filesystem. `undo` unwinds exactly what THIS call created,
        // so a refused folder meta (a symlink at `assets/New.meta`) or a mid-way ENOSPC/EACCES
        // leaves no orphan graph and no meta-less directory — the "Nothing was written." the
        // error paths above already promise. An overwrite keeps the previous file by moving it
        // ASIDE; only a failing move BACK (`aside` still set after the rollback) leaves it out
        // of place.
        const undo = [];
        let aside = null;
        try {
            for (const dir of this.#missingDirs(path.dirname(outputPath))) {
                fs.mkdirSync(dir);
                undo.push(() => fs.rmdirSync(dir));
            }
            // Only a FILE is moved aside: renaming a directory named `X.animgraph` away would turn
            // the clean EISDIR from the save below into a silently displaced folder.
            if (fileExisted && fs.statSync(outputPath).isFile()) {
                // Same directory, so this rename is atomic too; assigned only once it landed, or
                // the rollback would look for a file that was never moved.
                const stash = tempPathFor(outputPath);
                fs.renameSync(outputPath, stash);
                aside = stash;
                undo.push(() => { fs.renameSync(aside, outputPath); aside = null; });
            }
            doc.save(outputPath);
            // On an overwrite the restore rename above replaces the new file, so unlinking is only
            // for a path we created — and `newMeta` answers a different question (a leftover .meta
            // with no graph reuses its uuid).
            if (!fileExisted) undo.push(() => fs.unlinkSync(outputPath));
            if (newMeta) {
                // Registered BEFORE the write: a failure during it must still unwind a partial meta.
                undo.push(() => fs.unlinkSync(metaPath));
                writeMeta(metaPath, newMeta);
            }
            // Folders created above need their own metas too. Registered through the callback
            // rather than from the return value, so a failure PART-WAY up the chain still unwinds
            // the metas already written instead of orphaning them.
            ensureParentDirMetas(outputPath, assetsRoot, {
                onCreated: ({ metaPath: dirMetaPath }) => undo.push(() => fs.unlinkSync(dirMetaPath)),
            });
        } catch (err) {
            for (const step of undo.reverse()) {
                try { step(); } catch { /* best effort — report the original failure */ }
            }
            return this.error(
                `Cannot write ${args.outputPath}: ${err.message}\n\n` +
                (aside
                    ? `WARNING: the previous ${args.outputPath} was moved aside and could NOT be ` +
                      `moved back. Its bytes are intact as "${path.basename(aside)}" in the same ` +
                      `folder — rename that file to "${path.basename(outputPath)}" by hand; the ` +
                      'target itself now holds either this call\'s new data or nothing. Everything ' +
                      'else this call created was rolled back.'
                    : 'Nothing was written.')
            );
        }
        // The overwrite is committed, so the set-aside previous graph is dead weight. Best
        // effort: a stray dotfile is not worth failing a build that already succeeded.
        if (aside) { try { fs.unlinkSync(aside); } catch { /* best effort */ } }
        AssetIndex.invalidate(projectRoot);

        const model = parseAnimGraph(doc.objects, assetIndex);
        const lines = [
            `# Built ${args.outputPath}`,
            '',
            `UUID: ${uuid}${newMeta ? ' (new .meta written)' : ' (existing .meta kept)'}`,
            `Objects: ${doc.objects.length}`,
            '',
            formatAnimGraphText(path.basename(outputPath), model)
        ];
        if (notes.length) {
            lines.push('', '## Warnings');
            notes.forEach(n => lines.push(`- ${n}`));
        }
        lines.push(
            '',
            'Attach it with: apply_edits {op: "add_component", type: "AnimationController"} on the ' +
            'skeleton root, then {op: "set_asset_ref", property: "graph", asset: "<this path>"}. ' +
            'Open the project in Cocos Creator (or its asset-db refresh) to import the new asset.'
        );
        return this.success(lines.join('\n'));
    }

    /**
     * The directories under `dir` that do not exist yet, outermost first — the exact set
     * `mkdirSync(dir, {recursive: true})` would create, so a failed write can remove them
     * again instead of leaving meta-less folders in `assets/` for the editor to find.
     * @param {string} dir - Absolute path of the target's parent directory
     * @returns {string[]}
     */
    #missingDirs(dir) {
        const missing = [];
        let cur = path.resolve(dir);
        while (!fs.existsSync(cur)) {
            missing.unshift(cur);
            const parent = path.dirname(cur);
            if (parent === cur) break;
            cur = parent;
        }
        return missing;
    }
}
