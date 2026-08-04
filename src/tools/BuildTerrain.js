/**
 * BuildTerrain - MCP tool: compile a compact spec into a .terrain asset
 *
 * Counterpart of build_prefab/build_animgraph for terrains: geometry, heights and the
 * texture palette expand into the editor's own V8 binary, plus a .meta with a fresh UUID
 * so the asset is referencable from a cc.Terrain component immediately.
 *
 * The binary is written atomically (temp + rename) — a truncated .terrain is not
 * recoverable and the editor would import it as a corrupt asset.
 */

import * as fs from 'fs';
import * as path from 'path';
import { BaseTool } from './BaseTool.js';
import { TerrainBuilder, TerrainBuildError } from '../document/TerrainBuilder.js';
import { AssetIndex } from '../core/AssetIndex.js';
import { writeMeta, ensureParentDirMetas, resolveAssetMeta } from '../document/MetaGenerator.js';
import { resolveInAssets } from '../utils/assetPaths.js';
import { writeFileAtomic } from '../utils/fsAtomic.js';
import { readTerrainInfo } from '../utils/terrainBin.js';
import { terrainCard } from './terrainCard.js';

export class BuildTerrain extends BaseTool {
    get name() {
        return 'build_terrain';
    }

    get description() {
        return 'Create a new Cocos Creator terrain (.terrain binary plus .meta with a fresh UUID) ' +
               'from a compact spec: block grid, tile size, heights (flat, inline rows, 16-bit .raw ' +
               'or grayscale .png) and the texture layer palette. Coordinates are local metres ' +
               '(x = width, z = depth, heights are Y in metres); the terrain is anchored at its node ' +
               'origin and the shader uses only the node position — rotation/scale are ignored. ' +
               'Args: {outputPath (required), spec (required object), overwrite?: boolean}. ' +
               'Spec: {blockCount?: [x,z] (default [1,1]; each block = 32x32 tiles, so the size in ' +
               'METRES is blockCount * 32 * tileSize per axis — [4,4] at tileSize 1 is 128x128 m; ' +
               'there is no metres-based size key), tileSize?: 1 (metres per tile), ' +
               'weightMapSize?: 128 (texels per block side; power of two, 4..1024 — the editor\'s ' +
               'own Terrain panel offers 128/256/512/1024), lightMapSize?: 128, ' +
               'baseHeight?: 0 (metres), ' +
               'heightmap?: {source: "Art/hills.png"|"Art/hills.raw"|"inline", rows?: [[metres]], ' +
               'min?: 0, max?: 20 (metres, for .raw/.png sources only — inline rows are already metres), ' +
               'width?, height?: source dimensions in PIXELS (.raw only), bitDepth?: 16}, ' +
               'layers?: [{detailMap: "Art/Ground.png"|uuid, normalMap?, tileSize?: 1 (metres per ' +
               'texture repeat), roughness?: 1, metallic?: 0}], ' +
               'fillLayer?: 0 (paint every block with this slot; -1 = none)}. ' +
               'SIZE COST: the weight data alone is blockCount[0]*blockCount[1]*weightMapSize^2*4 bytes ' +
               'and the file is padded up to the next power of two — 4x4 blocks at weightMapSize 128 is ' +
               '2 MB, 16x16 is 32 MB, 32x32 is 128 MB (32x32 at weightMapSize 32 is 8 MB); ' +
               'use weightMapSize 32 or 64 for large maps. ' +
               'Attach the result with add_component cc.Terrain + set_asset_ref {property: "asset"}.';
    }

    get inputSchema() {
        return {
            type: 'object',
            properties: {
                outputPath: {
                    type: 'string',
                    description: 'Target .terrain path relative to project root, e.g. "assets/Maps/Ground.terrain"'
                },
                spec: {
                    type: 'object',
                    description: 'Terrain spec (see tool description)'
                },
                overwrite: {
                    type: 'boolean',
                    description: 'Allow replacing an existing .terrain (its .meta/UUID is preserved)',
                    default: false
                }
            },
            required: ['outputPath', 'spec']
        };
    }

    get aliases() {
        return { path: 'outputPath', terrainPath: 'outputPath', filePath: 'outputPath' };
    }

    async execute(args, projectRoot) {
        // Containment is checked on RESOLVED paths (assetPaths.js): a symlink under assets/
        // pointing outside the project must not pass it and take the write with it.
        const { path: outputPath, requested, assetsRoot, inside } = resolveInAssets(projectRoot, args.outputPath);
        if (!requested.endsWith('.terrain')) {
            return this.error('outputPath must end with .terrain');
        }
        if (!inside) {
            return this.error('outputPath must be inside the project\'s assets/ directory');
        }
        // Whether the BINARY pre-existed decides both the overwrite guard and, further down,
        // whether the rollback may unlink it — a question distinct from whether a `.meta` exists
        const binaryExisted = fs.existsSync(outputPath);
        if (binaryExisted && !args.overwrite) {
            return this.error(`${args.outputPath} already exists — pass overwrite: true to replace it`);
        }
        // mkdirSync would otherwise throw EEXIST/ENOTDIR out of the tool
        const parent = path.dirname(outputPath);
        if (fs.existsSync(parent) && !fs.statSync(parent).isDirectory()) {
            return this.error(
                `${path.dirname(args.outputPath)} exists but is not a directory — pick another path`
            );
        }

        const assetIndex = AssetIndex.shared(projectRoot);
        let buffer;
        let notes;
        try {
            ({ buffer, notes } = new TerrainBuilder(assetIndex, projectRoot).compile(args.spec));
        } catch (err) {
            if (err instanceof TerrainBuildError) {
                return this.error(`${err.message}\n\nNothing was written.`);
            }
            throw err;
        }

        // Meta: reuse an existing one so overwrites keep the UUID; resolved
        // BEFORE writing the binary so an unusable .meta aborts with nothing written
        const metaPath = `${outputPath}.meta`;
        const { uuid, newMeta, error } = resolveAssetMeta(
            metaPath, args.outputPath, () => TerrainBuilder.createMeta());
        if (error) return this.error(error);

        // Everything below touches the filesystem. `undo` unwinds exactly what THIS call
        // created, so a mid-way ENOSPC/EACCES/ENAMETOOLONG leaves no orphan binary, no
        // meta-less directory and no half-imported asset — the "Nothing was written."
        // promise the error paths above already make. Overwriting an existing binary is the ONE
        // step outside that promise (the previous bytes are gone once the rename lands), so the
        // failure report distinguishes "before the rename" from "after it".
        const undo = [];
        let binaryWritten = false;
        try {
            for (const dir of this.#missingDirs(path.dirname(outputPath))) {
                fs.mkdirSync(dir);
                undo.push(() => fs.rmdirSync(dir));
            }
            writeFileAtomic(outputPath, buffer);
            binaryWritten = true;
            // Only unlink a file we created: an overwrite would be someone else's data. The
            // predicate is whether the BINARY pre-existed — `newMeta` answers a different
            // question, and a leftover `.meta` beside a missing binary makes the two disagree.
            if (!binaryExisted) undo.push(() => fs.unlinkSync(outputPath));
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
                (binaryExisted && binaryWritten
                    ? `WARNING: ${args.outputPath} had ALREADY been replaced with the new data when ` +
                      'this failed — an overwrite is not undoable, so the previous heights, layers ' +
                      'and weights are gone. Everything else this call created was rolled back. ' +
                      'Re-read the file with query_terrain before deciding what to do.'
                    : 'Nothing was written.')
            );
        }
        AssetIndex.invalidate(projectRoot);

        // Re-READ what landed on disk, never report the spec back
        const info = readTerrainInfo(outputPath);
        return this.success(this.#report(args, uuid, newMeta, info, notes, assetIndex));
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

    #report(args, uuid, newMeta, info, notes, assetIndex) {
        const lines = [
            `# Built ${args.outputPath}`,
            '',
            `UUID: ${uuid}${newMeta ? ' (new .meta written)' : ' (existing .meta kept)'}`,
            ''
        ];
        lines.push(...terrainCard(info, assetIndex));

        const warnings = mergeWarnings(notes, info?.warnings ?? []);
        if (warnings.length) {
            lines.push('', '## Warnings');
            warnings.forEach(w => lines.push(`- ${w}`));
        }

        lines.push(
            '',
            'Attach it with: apply_edits {op: "add_component", type: "cc.Terrain"} on a scene node, ' +
            'then {op: "set_asset_ref", property: "asset", asset: "<this path>"}. ' +
            'Collider: add_component cc.TerrainCollider + set_asset_ref {property: "terrain"} ' +
            '(static bodies only — a dynamic RigidBody is engine-unsupported). ' +
            'Open the project in Cocos Creator (or its asset-db refresh) to import the new asset — ' +
            'library/ stays stale until then. ' +
            'Never run this while the editor has this terrain open in its Terrain panel: ' +
            'the panel saves its whole in-memory copy and would silently overwrite this file.'
        );
        return lines.join('\n');
    }
}

/**
 * Builder notes + the format-level warnings `readTerrainInfo` derives from the bytes.
 *
 * The two lists overlap in exactly one place: when `fillLayer` is off, the builder
 * already says "no block references them yet" and terrainBin then reports every unused
 * palette slot separately — one fact, N + 1 warnings.
 */
function mergeWarnings(notes, fileWarnings) {
    const fillIsOff = notes.some(n => n.startsWith('fillLayer is off'));
    const kept = fillIsOff
        ? fileWarnings.filter(w => !/^layer slot \d+ is defined but no block uses it/.test(w))
        : fileWarnings;
    return [...notes, ...kept];
}
