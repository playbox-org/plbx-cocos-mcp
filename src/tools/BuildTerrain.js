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
import { serializeMeta, ensureParentDirMetas } from '../document/MetaGenerator.js';
import { writeFileAtomic } from '../utils/fsAtomic.js';
import { readTerrainInfo } from '../utils/terrainBin.js';

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
        // realpath BOTH sides (as create_asset_meta does): a symlink under assets/ pointing
        // outside the project must not pass the containment check. The output file does not
        // exist yet, so resolve its closest existing ancestor and re-append the rest.
        const assetsRoot = this.#realpath(path.resolve(projectRoot, 'assets'));
        const outputPath = this.#realpathTarget(path.resolve(projectRoot, args.outputPath));
        if (!outputPath.endsWith('.terrain')) {
            return this.error('outputPath must end with .terrain');
        }
        if (!outputPath.startsWith(assetsRoot + path.sep)) {
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

        // Meta: reuse an existing one so overwrites keep the UUID; resolve it
        // BEFORE writing the binary so a corrupt .meta aborts with nothing written
        const metaPath = `${outputPath}.meta`;
        let uuid;
        let newMeta = null;
        if (fs.existsSync(metaPath)) {
            try {
                uuid = JSON.parse(fs.readFileSync(metaPath, 'utf-8')).uuid;
            } catch (err) {
                return this.error(`Cannot parse existing ${args.outputPath}.meta: ${err.message}\n\nNothing was written.`);
            }
            // A meta that parses but carries no uuid is unusable — importing it would
            // mint a new UUID and orphan every reference. Refuse before writing.
            if (typeof uuid !== 'string' || uuid === '') {
                return this.error(
                    `${args.outputPath}.meta has no "uuid" — delete it and re-run (a fresh .meta ` +
                    'will be generated), or fix it by hand.\n\nNothing was written.'
                );
            }
        } else {
            newMeta = TerrainBuilder.createMeta();
            uuid = newMeta.uuid;
        }

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
                fs.writeFileSync(metaPath, serializeMeta(newMeta), 'utf-8');
                undo.push(() => fs.unlinkSync(metaPath));
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

    /** Canonical path (symlinks resolved); the input itself when it does not exist */
    #realpath(p) {
        try { return fs.realpathSync(p); } catch { return p; }
    }

    /** Canonical path for a file that does not exist yet: realpath the closest existing ancestor */
    #realpathTarget(target) {
        const abs = path.resolve(target);
        const rest = [];
        let cur = abs;
        for (;;) {
            try {
                return path.join(fs.realpathSync(cur), ...rest);
            } catch {
                const parent = path.dirname(cur);
                if (parent === cur) return abs;
                rest.unshift(path.basename(cur));
                cur = parent;
            }
        }
    }

    #report(args, uuid, newMeta, info, notes, assetIndex) {
        const lines = [
            `# Built ${args.outputPath}`,
            '',
            `UUID: ${uuid}${newMeta ? ' (new .meta written)' : ' (existing .meta kept)'}`,
            ''
        ];
        lines.push(...this.#card(info, assetIndex));

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

    /** readTerrainInfo card — the same numbers get_asset_info/query_terrain report */
    #card(info, assetIndex) {
        if (!info) return ['(the written file could not be re-read as a terrain — this is a bug)'];
        const [w, d] = info.size;
        const [vx, vz] = info.vertexCount;
        const [ux, uz] = info.weightMapTexels;
        const lines = [
            '## Terrain',
            `Size: ${w} x ${d} m (${info.blockCount[0]} x ${info.blockCount[1]} blocks, ${vx} x ${vz} vertices)`,
            `tileSize: ${info.tileSize} m | weightMapSize: ${info.weightMapSize} (${ux} x ${uz} texels) | lightMapSize: ${info.lightMapSize}`,
            `Height: ${fmt(info.heightMin)} .. ${fmt(info.heightMax)} m (mean ${fmt(info.heightMean)})${info.isFlat ? ' — flat' : ''}`,
            `File: ${info.fileSize} bytes (${info.payloadLength} payload + ${info.padding} zero padding), ${info.versionLabel}`
        ];
        if (info.fileSize > LARGE_ASSET_BYTES) {
            const blocks = info.blockCount[0] * info.blockCount[1];
            const cheaper = Math.max(4, Math.min(info.weightMapSize, 32));
            const weightBytes = blocks * info.weightMapSize * info.weightMapSize * 4;
            const line = `Large asset: ${mb(info.fileSize)} (${mb(info.padding)} of it pow-2 padding); ` +
                `${mb(weightBytes)} is weight data = ${blocks} blocks x ${info.weightMapSize}^2 texels x 4 channels.`;
            lines.push(cheaper < info.weightMapSize
                ? `${line} weightMapSize ${cheaper} would need about ` +
                  `${mb(blocks * cheaper * cheaper * 4)} of weight data instead.`
                : line);
        }
        if (info.layers.length === 0) {
            lines.push('Layers: none');
        } else {
            lines.push('Layers:');
            for (const layer of info.layers) {
                const label = assetIndex?.label(layer.detailMapId) ?? layer.detailMapId;
                const normal = layer.normalMapId
                    ? `, normal ${assetIndex?.label(layer.normalMapId) ?? layer.normalMapId}`
                    : '';
                const blocks = info.layerUsage.find(u => u.slot === layer.slot)?.blocks.length ?? 0;
                lines.push(
                    `  ${layer.slot}. ${label} (tileSize ${layer.tileSize} m, roughness ${layer.roughness}, ` +
                    `metallic ${layer.metallic}${normal}) — used by ${blocks} block(s)`
                );
            }
        }
        return lines;
    }
}

/** Compact metre formatting: no trailing zeros, null-safe */
function fmt(v) {
    if (v === null || v === undefined) return 'n/a';
    return String(Math.round(v * 1000) / 1000);
}

/** MB with one decimal, for the large-asset note */
function mb(bytes) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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

/**
 * Weight data dominates a terrain binary and grows with
 * `blockCount[0] * blockCount[1] * weightMapSize^2 * 4`, then the whole file is rounded
 * up to the next power of two. A perfectly ordinary "512 x 512 m" request lands 33 MB in
 * `assets/`, so anything above this says so, with the cheaper setting spelled out.
 */
const LARGE_ASSET_BYTES = 8 * 1024 * 1024;
