/**
 * BuildPrefab - MCP tool: compile a compact spec into a full .prefab asset
 *
 * ~30 spec lines expand deterministically into correct Cocos 3.8.x JSON
 * plus a .meta with a fresh UUID, so the prefab is immediately referencable.
 * Enforces the wrapper convention: `visual` renderers land on a child node,
 * never the root.
 *
 * Filesystem ordering and rollback are build_terrain's (BuildTerrain.js): every failure after
 * the first write unwinds what this call created, and an overwrite moves the previous file
 * aside first, so a failure after the rename can still put it back.
 */

import * as fs from 'fs';
import * as path from 'path';
import { BaseTool } from './BaseTool.js';
import { PrefabBuilder, PrefabBuildError } from '../document/PrefabBuilder.js';
import { Validator } from '../document/Validator.js';
import { renderSubtree } from '../document/MiniTree.js';
import { AssetIndex } from '../core/AssetIndex.js';
import { writeMeta, ensureParentDirMetas, resolveAssetMeta } from '../document/MetaGenerator.js';
import { resolveInAssets } from '../utils/assetPaths.js';
import { tempPathFor } from '../utils/fsAtomic.js';

export class BuildPrefab extends BaseTool {
    get name() {
        return 'build_prefab';
    }

    get description() {
        return 'Create a new Cocos Creator .prefab (plus .meta with a fresh UUID) from a compact spec. ' +
               'Args: {outputPath (required), spec (required object), overwrite?: boolean}. ' +
               'Wrapper convention built in: use spec.visual for the model/sprite — it becomes a Visual ' +
               'child node, keeping the root clean for logic/tweens/colliders. ' +
               'Spec: {name?, layer? (number|"default"|"ui_2d"|...), ' +
               'visual?: {mesh: "path[@subId]" or a primitive alias ("box"|"plane"|"sphere"|"cylinder"|"capsule"|"cone"|"quad"|"torus", ' +
               'engine builtin, default material auto-assigned) | sprite: "path.png", material?, scale?: number|{x,y,z}, position?, rotation?}, ' +
               'root?: {components?: [{type, properties?}], children?: [{name, position?, rotation?, scale?, layer?, active?, ' +
               'mesh?, sprite?, material?, components?, children?}]}}. ' +
               'Component types: any of the ~46 built-in cc.* templates — UI/2D (UITransform, Sprite, Label, ' +
               'RichText, Button, Widget, Canvas, SafeArea, Mask, Graphics, Layout, ProgressBar, Slider...), ' +
               '3D (MeshRenderer, SkinnedMeshRenderer, SpriteRenderer, Camera, lights, Line, Billboard, Terrain), ' +
               'physics 3D+2D (RigidBody, colliders incl. TerrainCollider), particles (ParticleSystem, ParticleSystem2D), ' +
               'Animation/SkeletalAnimation/AnimationController/AudioSource — or custom script names ' +
               '(an unknown type returns the full template list). ' +
               'Component `properties` take the same value forms as apply_edits set_component_property: an ' +
               'object value needs its "__type__" ({"__type__": "cc.Size", width, height} — a script ' +
               'component starts with no fields, so there is nothing for the type to be read from), and a ' +
               'custom @ccclass value is hoisted into its own object with an {__id__} reference like the ' +
               'editor does.';
    }

    get inputSchema() {
        return {
            type: 'object',
            properties: {
                outputPath: {
                    type: 'string',
                    description: 'Target .prefab path relative to project root, e.g. "assets/Prefabs/Crate.prefab"'
                },
                spec: {
                    type: 'object',
                    description: 'Prefab spec (see tool description)'
                },
                overwrite: {
                    type: 'boolean',
                    description: 'Allow replacing an existing .prefab (its .meta/UUID is preserved)',
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
        if (!requested.endsWith('.prefab')) {
            return this.error('outputPath must end with .prefab');
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
        const defaultName = path.basename(outputPath, '.prefab');
        let doc;
        let notes;
        try {
            ({ doc, notes } = new PrefabBuilder(assetIndex).compile(args.spec, defaultName));
        } catch (err) {
            if (err instanceof PrefabBuildError || err.name === 'OperationError') {
                return this.error(`${err.message}\n\nNothing was written.`);
            }
            throw err;
        }

        const { errors, warnings } = new Validator(doc, assetIndex, { projectRoot }).validate();
        if (errors.length > 0) {
            return this.error(
                `Compiled prefab failed validation — nothing was written:\n` +
                errors.map(e => `- ${e}`).join('\n')
            );
        }

        // Meta: reuse an existing one so overwrites keep the UUID; resolved
        // BEFORE writing the prefab so an unusable .meta aborts with nothing written
        const metaPath = `${outputPath}.meta`;
        const { uuid, newMeta, error } = resolveAssetMeta(
            metaPath, args.outputPath, () => PrefabBuilder.createMeta(doc.getObject(0)._name));
        if (error) return this.error(error);

        // Everything below touches the filesystem. `undo` unwinds exactly what THIS call created,
        // so a refused folder meta (a symlink at `assets/New.meta`) or a mid-way ENOSPC/EACCES
        // leaves no orphan prefab and no meta-less directory — the "Nothing was written." the
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
            // Only a FILE is moved aside: renaming a directory named `X.prefab` away would turn
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
            // with no prefab reuses its uuid).
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
        // The overwrite is committed, so the set-aside previous prefab is dead weight. Best
        // effort: a stray dotfile is not worth failing a build that already succeeded.
        if (aside) { try { fs.unlinkSync(aside); } catch { /* best effort */ } }
        AssetIndex.invalidate(projectRoot);
        const metaCreated = newMeta !== null;

        const lines = [
            `# Built ${args.outputPath}`,
            '',
            `UUID: ${uuid}${metaCreated ? ' (new .meta written)' : ' (existing .meta kept)'}`,
            `Objects: ${doc.objects.length}`,
            '',
            '## Structure',
            '',
            renderSubtree(doc, doc.root.idx, { maxDepth: 4 })
        ];
        if (notes.length || warnings.length) {
            lines.push('', '## Warnings');
            notes.forEach(n => lines.push(`- ${n}`));
            warnings.forEach(w => lines.push(`- ${w}`));
        }
        lines.push('', 'Open the project in Cocos Creator (or its asset-db refresh) to import the new asset.');
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
