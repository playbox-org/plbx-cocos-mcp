/**
 * CreateAssetMeta - MCP tool: generate .meta files offline for assets created
 * outside the editor (agent-written scripts, materials, images, …)
 *
 * The editor trusts a brought-along meta: the UUID is kept and the asset is
 * imported into library/ on the next open, so references made now stay valid.
 * Idempotent — anything that already has a .meta is skipped, so re-runs never
 * mint conflicting UUIDs. Models (.fbx/.glb/.gltf) are refused: their metas
 * derive from model content and the MCP itself needs the editor's library/
 * artifacts (see MetaGenerator.js).
 */

import * as fs from 'fs';
import * as path from 'path';
import { BaseTool } from './BaseTool.js';
import { AssetIndex } from '../core/AssetIndex.js';
import {
    writeMetaFile, ensureParentDirMetas, MetaGenerationError
} from '../document/MetaGenerator.js';

export class CreateAssetMeta extends BaseTool {
    get name() {
        return 'create_asset_meta';
    }

    get description() {
        return 'Generate .meta file(s) offline for assets created outside the editor, so scripts/assets ' +
               'written by tools are immediately importable — the editor keeps the UUID on next open. ' +
               'Idempotent: existing .meta files are never touched. Parent folders get metas too. ' +
               'Supported: .ts/.js scripts, .scene, .prefab, .mtl, .pmtl, .anim, .animgraph, .json, ' +
               '.effect, .rt, .ttf, audio (.mp3/.wav/.ogg/...), images (.png/.jpg/... — imageType ' +
               '"texture" default, or "sprite-frame" for UI sprites), directories. ' +
               'NOT supported: models (.fbx/.glb/.gltf) — those still need one editor import. ' +
               'Args: {path (file or folder, required), recursive?: boolean (folders; default true), ' +
               'imageType?: "texture"|"sprite-frame"}.';
    }

    get inputSchema() {
        return {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: 'Asset file or folder, relative to project root (or to assets/), e.g. "assets/Scripts/Spin.ts"'
                },
                recursive: {
                    type: 'boolean',
                    description: 'For a folder: also generate metas for everything beneath it (default true)',
                    default: true
                },
                imageType: {
                    type: 'string',
                    enum: ['texture', 'sprite-frame'],
                    description: 'Image assets: meta type — "texture" (3D/material use, default) or "sprite-frame" (UI sprites)',
                    default: 'texture'
                }
            },
            required: ['path']
        };
    }

    get aliases() {
        return { assetPath: 'path', filePath: 'path', folder: 'path', asset: 'path' };
    }

    async execute(args, projectRoot) {
        const assetsRoot = path.resolve(projectRoot, 'assets');
        const abs = this.#resolve(args.path, projectRoot);
        if (!abs) {
            return this.error(`Path not found: ${args.path} (relative to project root or assets/)`);
        }
        if (abs !== assetsRoot && !abs.startsWith(assetsRoot + path.sep)) {
            return this.error('Path must be inside the project\'s assets/ directory — ' +
                'the editor only imports (and needs .meta for) files under assets/.');
        }

        const isDir = fs.statSync(abs).isDirectory();
        const targets = [];
        if (isDir) {
            if (abs !== assetsRoot) targets.push(abs); // the assets root itself has no meta
            if (args.recursive ?? true) this.#walk(abs, targets);
        } else {
            targets.push(abs);
        }

        const created = [];
        const skipped = [];
        const refused = [];
        // Ancestors first: every folder on the way needs a meta before its content
        for (const { dir, meta } of ensureParentDirMetas(abs, assetsRoot)) {
            created.push({ path: dir, uuid: meta.uuid, dir: true });
        }
        for (const target of targets) {
            const rel = path.relative(projectRoot, target).replaceAll('\\', '/');
            try {
                const { meta, created: isNew } = writeMetaFile(target, { imageType: args.imageType });
                if (isNew) created.push({ path: target, uuid: meta.uuid });
                else skipped.push(rel);
            } catch (err) {
                if (err instanceof MetaGenerationError) refused.push({ path: rel, reason: err.message });
                else throw err;
            }
        }

        if (created.length > 0) AssetIndex.invalidate(projectRoot);

        // A single explicitly named file that cannot get a meta is a plain error
        // (parent-folder metas created above are idempotent and stay — harmless)
        if (!isDir && refused.length === 1) {
            return this.error(refused[0].reason);
        }

        return this.success(this.#report(created, skipped, refused, projectRoot));
    }

    /** Resolve relative to project root, falling back to assets/<path> */
    #resolve(ref, projectRoot) {
        for (const rel of [ref, path.join('assets', ref)]) {
            const abs = path.resolve(projectRoot, rel);
            if (fs.existsSync(abs)) return abs;
        }
        return null;
    }

    /** Depth-first listing of dirs+files under `dir`, skipping .meta and dotfiles */
    #walk(dir, out) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            if (entry.name.startsWith('.') || entry.name.endsWith('.meta')) continue;
            const full = path.join(dir, entry.name);
            out.push(full);
            if (entry.isDirectory()) this.#walk(full, out);
        }
    }

    #report(created, skipped, refused, projectRoot) {
        const rel = p => path.relative(projectRoot, p).replaceAll('\\', '/');
        const lines = [`# create_asset_meta: ${created.length} created, ${skipped.length} skipped (meta exists), ${refused.length} refused`];
        if (created.length) {
            lines.push('', '## Created');
            for (const c of created) lines.push(`- ${rel(c.path)}${c.dir ? '/' : ''} → ${c.uuid}`);
        }
        if (refused.length) {
            lines.push('', '## Refused');
            for (const r of refused) lines.push(`- ${r.path}: ${r.reason}`);
        }
        if (created.length) {
            lines.push('', 'The editor will import these into library/ on the next open, keeping the UUIDs — ' +
                'references made now stay valid. No editor needed to use them from MCP tools.');
        }
        return lines.join('\n');
    }
}
