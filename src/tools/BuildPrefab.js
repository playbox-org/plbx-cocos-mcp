/**
 * BuildPrefab - MCP tool: compile a compact spec into a full .prefab asset
 *
 * ~30 spec lines expand deterministically into correct Cocos 3.8.x JSON
 * plus a .meta with a fresh UUID, so the prefab is immediately referencable.
 * Enforces the wrapper convention: `visual` renderers land on a child node,
 * never the root.
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
               '(an unknown type returns the full template list).';
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
        if (fs.existsSync(outputPath) && !args.overwrite) {
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

        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        doc.save(outputPath);
        if (newMeta) {
            writeMeta(metaPath, newMeta);
        }
        // Folders created by mkdirSync need their own metas too
        ensureParentDirMetas(outputPath, assetsRoot);
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
}
