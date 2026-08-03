/**
 * TerrainBuilder - compile a compact spec into a `.terrain` binary
 *
 * Counterpart of PrefabBuilder / AnimGraphBuilder for terrain assets: the spec describes
 * the geometry (blocks, tile size, weight/light map resolution), the height source (flat,
 * inline rows, `.raw` or grayscale `.png`) and the texture palette; `compile()` turns that
 * into the exact V8 binary the editor writes, via `src/utils/terrainBin.js` — which owns
 * ALL format knowledge. Nothing here duplicates the layout.
 *
 * Coordinates are LOCAL METRES: X along the width, Z along the height, heights in metres.
 * A terrain is anchored at its node's origin (local X in [0, width], Z in [0, height]) and
 * the terrain shader applies only the node's world POSITION — rotation and scale are
 * ignored (terrain.ts, vertices offset by `cc_matWorld[3]`).
 */

import {
    materialize,
    writeTerrain,
    validateTerrainData,
    validateTerrainCapacity,
    heightToRaw,
    rawToHeight,
    snapTileSize,
    isTileSizeStable,
    vertexCounts,
    blockIndex,
    TERRAIN_HEIGHT_FMIN,
    TERRAIN_HEIGHT_FMAX,
    TERRAIN_MAX_BLEND_LAYERS,
    TERRAIN_MAX_LAYER_COUNT,
    TERRAIN_BLOCK_TILE_COMPLEXITY,
} from '../utils/terrainBin.js';
import { buildHeightGrid, HeightmapError } from '../utils/heightmap.js';
import { resolveBuiltin } from '../core/builtins.js';
import { terrainMeta } from './MetaGenerator.js';

export class TerrainBuildError extends Error {}

/** Spec keys accepted by {@link TerrainBuilder#compile} */
const SPEC_KEYS = [
    'blockCount', 'tileSize', 'weightMapSize', 'lightMapSize',
    'baseHeight', 'heightmap', 'layers', 'fillLayer',
];

/** Keys accepted inside `spec.layers[i]` */
const LAYER_KEYS = ['detailMap', 'normalMap', 'tileSize', 'roughness', 'metallic'];

/**
 * Keys an agent reaches for when it wants "a 200x200 m terrain". There is no metres-based
 * size key — the extent is `blockCount * 32 * tileSize` — so the rejection has to carry
 * that derivation, otherwise every spelling is a dead end.
 */
const SIZE_KEYS = new Set(['size', 'width', 'height', 'depth', 'sizeInMetres', 'sizeInMeters', 'extent']);

/** `— terrain size is set through …` tail for a `size`-flavoured unknown key */
function sizeKeyHint(spec, key) {
    const wanted = Number(Array.isArray(spec[key]) ? spec[key][0] : spec[key]);
    const example = Number.isFinite(wanted) && wanted > 0
        ? ` For ~${wanted} m at tileSize 1, use blockCount [${Math.max(1, Math.round(wanted / TERRAIN_BLOCK_TILE_COMPLEXITY))}, ` +
          `${Math.max(1, Math.round(wanted / TERRAIN_BLOCK_TILE_COMPLEXITY))}] ` +
          `(${Math.max(1, Math.round(wanted / TERRAIN_BLOCK_TILE_COMPLEXITY)) * TERRAIN_BLOCK_TILE_COMPLEXITY} m), ` +
          'or nudge tileSize to hit the exact metre count.'
        : '';
    return ' — there is no metres-based size key: the extent is blockCount * ' +
           `${TERRAIN_BLOCK_TILE_COMPLEXITY} * tileSize metres per axis.${example}`;
}

/**
 * `weightMapSize` bounds — an EDITOR convention, not an engine constraint.
 *
 * The engine validates nothing: `weightMapSize` is a plain `@serializable` field stored as an
 * i16 (terrain.ts:83-85), there is no power-of-two check anywhere in `cocos/terrain/`, and the
 * per-block weight texture is NPOT-safe as created (`Texture2D.create(wms, wms, RGBA8888)` with
 * LINEAR filters, CLAMP_TO_EDGE wrap and no mipmaps, terrain.ts:932-936). The resampler's
 * `/(weightMapSize - 1)` (terrain.ts:2682) only needs `>= 2`, not a power of two.
 *
 * What IS real is the editor's Terrain panel, whose `weightMapSize` control is a `ui-select`
 * offering exactly `128 / 256 / 512 / 1024` (harvested from the panel's Vue template in
 * `app.asar`). {@link WEIGHT_MAP_SIZE_MAX} therefore has to be 1024 — otherwise an
 * editor-authored 1024 terrain could be lowered but never restored. The lower bound stays 4 so
 * tiny test terrains are cheap; the editor never authors those, and the error message says so.
 */
export const WEIGHT_MAP_SIZE_MIN = 4;
export const WEIGHT_MAP_SIZE_MAX = 1024;

/** The four `weightMapSize`/`lightMapSize` values the 3.8.x editor panel offers */
export const EDITOR_MAP_SIZES = [128, 256, 512, 1024];

/** Layer defaults, matching `TerrainLayer` (terrain-asset.ts:88-105) */
const LAYER_DEFAULTS = { tileSize: 1, roughness: 1, metallic: 0 };

function isPowerOfTwo(n) {
    return Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
}

function show(v) {
    if (typeof v === 'number') return String(v);
    return JSON.stringify(v) ?? String(v);
}

/**
 * Validate a `tileSize` in metres and return the value that will actually be in effect
 * (the engine snaps every loaded tileSize with `Math.floor(t * 100) / 100`).
 *
 * Shared with `edit_terrain`'s `set_info` so both tools accept exactly the same numbers and
 * explain a snap the same way.
 *
 * @param {*} value - Candidate tile size
 * @param {string} what - Argument path for messages, e.g. `spec.tileSize`
 * @param {string[]|null} [notes] - Collector for the "was snapped" note
 * @returns {number} the snapped tile size
 * @throws {TerrainBuildError}
 */
export function checkTileSize(value, what, notes = null) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        throw new TerrainBuildError(`${what} must be a finite number > 0, got ${show(value)}`);
    }
    // Reject BEFORE the snap: anything under 0.01 m floors to 0 and the geometry
    // validator would then complain about "0", never mentioning what was typed.
    if (snapTileSize(value) <= 0) {
        throw new TerrainBuildError(
            `${what} = ${show(value)} m is floored to 0 by the engine's load-time snap ` +
            '(Math.floor(t * 100) / 100) — the smallest usable tile size is 0.01 m'
        );
    }
    if (!isTileSizeStable(value)) {
        const snapped = snapTileSize(value);
        notes?.push(
            `tileSize ${value} is snapped to ${snapped} on load ` +
            '(the engine applies Math.floor(t * 100) / 100) — the file stores the snapped value'
        );
        return snapped;
    }
    return value;
}

/**
 * Validate a `weightMapSize` against the pow-2 / 4..1024 guard (see
 * {@link WEIGHT_MAP_SIZE_MIN}). Shared with `edit_terrain`'s `set_info`.
 * @param {*} value
 * @param {string} what - Argument path for messages
 * @returns {number}
 * @throws {TerrainBuildError}
 */
export function checkWeightMapSize(value, what) {
    if (!isPowerOfTwo(value) || value < WEIGHT_MAP_SIZE_MIN || value > WEIGHT_MAP_SIZE_MAX) {
        throw new TerrainBuildError(
            `${what} = ${show(value)} must be a power of two in ` +
            `${WEIGHT_MAP_SIZE_MIN}..${WEIGHT_MAP_SIZE_MAX}. Power-of-two and this range are the ` +
            `editor UI's convention — its Terrain panel offers ${EDITOR_MAP_SIZES.join('/')} — ` +
            'not an engine constraint: the engine stores weightMapSize as a plain i16 and ' +
            'validates nothing. Smaller powers of two down to ' +
            `${WEIGHT_MAP_SIZE_MIN} are accepted for tiny test terrains, but the editor never ` +
            'authors them'
        );
    }
    return value;
}

/**
 * Validate a `lightMapSize`. Shared with `edit_terrain`'s `set_info`.
 *
 * Deliberately laxer than the editor's `ui-select` (128/256/512/1024): nothing reads this
 * number except the editor's own baker, so an odd value cannot corrupt anything — but the
 * message names the four the editor offers so an agent picks one of them.
 * @param {*} value
 * @param {string} what - Argument path for messages
 * @returns {number}
 * @throws {TerrainBuildError}
 */
export function checkLightMapSize(value, what) {
    if (!Number.isInteger(value) || value < 1 || value > 32767) {
        throw new TerrainBuildError(
            `${what} = ${show(value)} must be an integer in 1..32767 ` +
            '(lightmap data itself is baked by the editor; this only sizes it). ' +
            `The editor panel only ever offers ${EDITOR_MAP_SIZES.join('/')} — prefer one of those`
        );
    }
    return value;
}

/**
 * Resolve a layer texture reference into the `"<uuid>@<subId>"` id the binary stores.
 *
 * Accepts a project path, a full/compressed UUID, an explicit `"<uuid>@<subId>"`, or an
 * engine builtin (`db://internal/default-terrain/default-layer-texture.jpg`). A bare image
 * resolves to its `texture` sub-asset (`@6c48a`) — the same shape `PrefabBuilder`
 * uses for sprite frames, and the shape every editor-written terrain contains.
 *
 * Exported for reuse by the (future) `edit_terrain` ops, which must resolve textures
 * identically.
 *
 * @param {object|null} assetIndex - AssetIndex, or null when there is no project
 * @param {string} ref - Path / UUID / "uuid@subId" / builtin path
 * @param {string} what - Spec path for error messages, e.g. `layers[0].detailMap`
 * @returns {string} `"<uuid>@<subId>"`
 * @throws {TerrainBuildError} with the alternatives listed
 */
export function resolveTextureRef(assetIndex, ref, what) {
    if (typeof ref !== 'string' || ref === '') {
        throw new TerrainBuildError(`${what} must be a non-empty string (project path, UUID or "uuid@subId")`);
    }
    if (!assetIndex) {
        throw new TerrainBuildError(`${what}: texture resolution requires a project (assetIndex)`);
    }
    const resolved = assetIndex.resolve(ref) ?? resolveBuiltin(ref);
    if (!resolved) {
        throw new TerrainBuildError(
            `${what}: texture not found: "${ref}" (checked project path, UUID, compressed UUID ` +
            `and engine builtins).${suggestTextures(assetIndex, ref)}`
        );
    }

    const { entry, subAsset } = resolved;
    if (subAsset) {
        if (subAsset.importer !== 'texture') {
            throw new TerrainBuildError(
                `${what}: "${ref}" is a ${subAsset.importer || 'sub-asset'}, not a texture — ` +
                `a terrain layer needs the image's texture sub-asset. ${subAssetHint(entry)}`
            );
        }
        return `${entry.uuid}@${subAsset.id}`;
    }

    const texture = (entry.subAssets ?? []).find(s => s.importer === 'texture');
    if (!texture) {
        throw new TerrainBuildError(
            `${what}: "${ref}" (${entry.importer}) has no texture sub-asset — a terrain layer ` +
            `needs an image asset. ${subAssetHint(entry)}`
        );
    }
    return `${entry.uuid}@${texture.id}`;
}

/** "Did you mean" list: project images whose file name looks like `ref` */
function suggestTextures(assetIndex, ref) {
    const needle = ref.split(/[\\/]/).pop().toLowerCase();
    const stem = needle.replace(/\.[^.]*$/, '');
    if (!stem) return '';
    const hits = (assetIndex.entries ?? [])
        .filter(e => (e.subAssets ?? []).some(s => s.importer === 'texture'))
        .filter(e => e.name.toLowerCase().includes(stem) || stem.includes(e.name.toLowerCase().replace(/\.[^.]*$/, '')))
        .slice(0, 5);
    if (hits.length === 0) {
        return ' Use list_assets {type: "image"} to see the project\'s textures.';
    }
    return ` Similar textures: ${hits.map(e => e.path).join(', ')}.`;
}

function subAssetHint(entry) {
    const subs = (entry.subAssets ?? []).map(s => `@${s.id} (${s.importer})`);
    return subs.length
        ? `Sub-assets of "${entry.path}": ${subs.join(', ')}.`
        : `"${entry.path}" has no sub-assets — use get_asset_info on it.`;
}

export class TerrainBuilder {
    #assetIndex;
    #projectRoot;

    /**
     * @param {object|null} assetIndex - AssetIndex for layer-texture resolution
     * @param {string|null} projectRoot - Needed only for file-based heightmap sources
     */
    constructor(assetIndex = null, projectRoot = null) {
        this.#assetIndex = assetIndex;
        this.#projectRoot = projectRoot;
    }

    /**
     * Compile a spec into terrain data plus the exact bytes to write.
     *
     * ```jsonc
     * {
     *   "blockCount": [2, 2],       // default [1,1]; each block is 32x32 tiles
     *   "tileSize": 1,              // metres per tile, default 1
     *   "weightMapSize": 128,       // power of two, 4..1024 (editor panel: 128/256/512/1024)
     *   "lightMapSize": 128,        // default 128
     *   "baseHeight": 0,            // metres; flat terrain, or an offset under a heightmap
     *   "heightmap": {"source": "Art/hills.png", "min": 0, "max": 20},
     *   "layers": [{"detailMap": "Art/Ground.png", "normalMap": null,
     *               "tileSize": 1, "roughness": 1, "metallic": 0}],
     *   "fillLayer": 0              // paint every block with this slot; -1 = leave unassigned
     * }
     * ```
     *
     * @param {object} spec
     * @returns {{data: object, buffer: Buffer, notes: string[]}} `buffer` is the padded V8
     *   file; `data` is the in-memory struct (same shape `readTerrain` returns)
     * @throws {TerrainBuildError} on any invalid spec — nothing is written by this class
     */
    compile(spec) {
        if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
            throw new TerrainBuildError('spec must be an object');
        }
        for (const key of Object.keys(spec)) {
            if (!SPEC_KEYS.includes(key)) {
                throw new TerrainBuildError(
                    `spec: unknown key "${key}" — supported: ${SPEC_KEYS.join(', ')}` +
                    (SIZE_KEYS.has(key) ? sizeKeyHint(spec, key) : '')
                );
            }
        }
        const notes = [];

        const blockCount = this.#blockCount(spec.blockCount);
        const tileSize = this.#tileSize(spec.tileSize, notes);
        const weightMapSize = this.#weightMapSize(spec.weightMapSize);
        const lightMapSize = this.#lightMapSize(spec.lightMapSize);

        // Capacity first: the buffers below are sized from the spec, so an absurd
        // blockCount/weightMapSize pair must be refused BEFORE anything is allocated.
        const skeleton = { blockCount, tileSize, weightMapSize, lightMapSize };
        try {
            validateTerrainCapacity(skeleton);
        } catch (err) {
            throw new TerrainBuildError(err.message);
        }

        const data = materialize({
            ...skeleton,
            heights: null,
            weights: null,
            layerBuffer: null,
            layers: [],
        });

        this.#applyHeights(data, spec, notes);
        this.#applyLayers(data, spec, notes);

        try {
            validateTerrainData(data);
        } catch (err) {
            throw new TerrainBuildError(err.message);
        }
        let buffer;
        try {
            buffer = writeTerrain(data);
        } catch (err) {
            throw new TerrainBuildError(err.message);
        }
        return { data, buffer, notes };
    }

    // --- geometry ----------------------------------------------------------

    #blockCount(value) {
        if (value === undefined) return [1, 1];
        if (!Array.isArray(value) || value.length !== 2) {
            throw new TerrainBuildError(
                `spec.blockCount must be an array of two integers [x, z], got ${show(value)}`
            );
        }
        value.forEach((v, i) => {
            if (!Number.isInteger(v) || v < 1) {
                throw new TerrainBuildError(
                    `spec.blockCount[${i}] = ${show(v)} must be an integer >= 1 ` +
                    `(each block is ${TERRAIN_BLOCK_TILE_COMPLEXITY}x${TERRAIN_BLOCK_TILE_COMPLEXITY} tiles)`
                );
            }
        });
        return [value[0], value[1]];
    }

    #tileSize(value, notes) {
        if (value === undefined) return 1;
        return checkTileSize(value, 'spec.tileSize', notes);
    }

    #weightMapSize(value) {
        if (value === undefined) return 128;
        return checkWeightMapSize(value, 'spec.weightMapSize');
    }

    #lightMapSize(value) {
        if (value === undefined) return 128;
        return checkLightMapSize(value, 'spec.lightMapSize');
    }

    // --- heights ------------------------------------------------------------

    #applyHeights(data, spec, notes) {
        const base = spec.baseHeight ?? 0;
        if (typeof base !== 'number' || !Number.isFinite(base)) {
            throw new TerrainBuildError(`spec.baseHeight must be a finite number of metres, got ${show(base)}`);
        }
        this.#checkHeightRange(base, 'spec.baseHeight');

        if (spec.heightmap === undefined || spec.heightmap === null) {
            const raw = heightToRaw(base, true);
            data.heights.fill(raw);
            const stored = rawToHeight(raw);
            if (stored !== base) {
                notes.push(
                    `baseHeight ${base} m quantized to ${stored} m (heights are stored as 1/128 m steps)`
                );
            }
            return;
        }

        const [vx, vz] = vertexCounts(data.blockCount);
        let grid;
        try {
            grid = buildHeightGrid(spec.heightmap, {
                vertexCount: [vx, vz],
                tileCount: [vx - 1, vz - 1],
                projectRoot: this.#projectRoot,
            });
        } catch (err) {
            if (err instanceof HeightmapError) throw new TerrainBuildError(err.message);
            // fs errors (EACCES, EISDIR, …) reach the caller as a build error too
            throw new TerrainBuildError(`spec.heightmap: ${err.message}`);
        }
        notes.push(...grid.notes);
        if (base !== 0) {
            notes.push(`baseHeight ${base} m added as an offset on top of the heightmap`);
        }

        let clamped = 0;
        let low = Infinity;
        let high = -Infinity;
        for (let i = 0; i < grid.heights.length; i++) {
            const metres = grid.heights[i] + base;
            if (metres < low) low = metres;
            if (metres > high) high = metres;
            if (metres < TERRAIN_HEIGHT_FMIN || metres > TERRAIN_HEIGHT_FMAX) clamped++;
            data.heights[i] = heightToRaw(metres, true);
        }
        if (clamped > 0) {
            notes.push(
                `${clamped} of ${grid.heights.length} height sample(s) fell outside the ` +
                `representable range [${TERRAIN_HEIGHT_FMIN}, ${TERRAIN_HEIGHT_FMAX}] m ` +
                `(sampled ${low.toFixed(3)}..${high.toFixed(3)} m) and were clamped`
            );
        }
    }

    #checkHeightRange(metres, what) {
        if (metres < TERRAIN_HEIGHT_FMIN || metres > TERRAIN_HEIGHT_FMAX) {
            throw new TerrainBuildError(
                `${what} = ${metres} m is outside the representable height range ` +
                `[${TERRAIN_HEIGHT_FMIN}, ${TERRAIN_HEIGHT_FMAX}] m`
            );
        }
    }

    // --- layers -------------------------------------------------------------

    #applyLayers(data, spec, notes) {
        const specLayers = spec.layers ?? [];
        if (!Array.isArray(specLayers)) {
            throw new TerrainBuildError('spec.layers must be an array of layer objects');
        }
        if (specLayers.length > TERRAIN_MAX_LAYER_COUNT) {
            throw new TerrainBuildError(
                `spec.layers has ${specLayers.length} entries, the palette holds at most ` +
                `${TERRAIN_MAX_LAYER_COUNT}`
            );
        }

        data.layers = specLayers.map((layer, i) => this.#compileLayer(layer, i));

        if (data.layers.length === 0) {
            if (spec.fillLayer !== undefined && spec.fillLayer !== null && spec.fillLayer !== -1) {
                throw new TerrainBuildError(
                    `spec.fillLayer = ${show(spec.fillLayer)} but spec.layers is empty — ` +
                    'define the layer first'
                );
            }
            notes.push(
                'no layers defined — every block keeps an empty palette and the terrain renders ' +
                'the effect\'s flat grey fallback; add a layer with a detailMap to see textures'
            );
            return;
        }

        const fill = this.#fillLayer(spec, data.layers.length);
        if (fill < 0) {
            notes.push(
                `fillLayer is off — the ${data.layers.length} palette layer(s) are defined but no ` +
                'block references them yet (paint them in the editor)'
            );
            return;
        }

        // Assign the slot to channel 0 of every block. materialize() already filled the
        // weight map with (255, 0, 0, 0), i.e. channel 0 at full strength everywhere.
        const [bc0, bc1] = data.blockCount;
        for (let by = 0; by < bc1; by++) {
            for (let bx = 0; bx < bc0; bx++) {
                const base = blockIndex(bx, by, data.blockCount) * TERRAIN_MAX_BLEND_LAYERS;
                data.layerBuffer[base] = fill;
                for (let k = 1; k < TERRAIN_MAX_BLEND_LAYERS; k++) data.layerBuffer[base + k] = -1;
            }
        }
        // Only DISCLOSE the default. With an explicit fillLayer the note would restate the
        // caller's own argument and duplicate the "used by N block(s)" line of the card.
        if (spec.fillLayer === undefined) {
            notes.push(
                `every block is painted with layer ${fill} ` +
                `("${specLayers[fill].detailMap}") at full weight ` +
                '(fillLayer defaults to 0 when layers are defined — pass fillLayer: -1 to leave blocks unpainted)'
            );
        }
    }

    #fillLayer(spec, layerCount) {
        const value = spec.fillLayer;
        if (value === undefined) return 0;
        if (value === null || value === -1) return -1;
        if (!Number.isInteger(value) || value < 0 || value >= layerCount) {
            throw new TerrainBuildError(
                `spec.fillLayer = ${show(value)} must be a layer index in 0..${layerCount - 1} ` +
                '(or -1/null for none)'
            );
        }
        return value;
    }

    #compileLayer(layer, i) {
        const what = `spec.layers[${i}]`;
        if (!layer || typeof layer !== 'object' || Array.isArray(layer)) {
            throw new TerrainBuildError(`${what} must be an object with a "detailMap"`);
        }
        for (const key of Object.keys(layer)) {
            if (!LAYER_KEYS.includes(key)) {
                throw new TerrainBuildError(
                    `${what}: unknown key "${key}" — supported: ${LAYER_KEYS.join(', ')}`
                );
            }
        }
        if (layer.detailMap === undefined || layer.detailMap === null) {
            throw new TerrainBuildError(
                `${what}.detailMap is required — a layer without a detail texture is dropped by ` +
                'the editor on re-save'
            );
        }

        const detailMapId = resolveTextureRef(this.#assetIndex, layer.detailMap, `${what}.detailMap`);
        const normalMapId = layer.normalMap === undefined || layer.normalMap === null
            ? '' // the binary stores an ABSENT normal map as "", never null
            : resolveTextureRef(this.#assetIndex, layer.normalMap, `${what}.normalMap`);

        const out = { slot: i, tileSize: LAYER_DEFAULTS.tileSize, detailMapId, normalMapId,
            roughness: LAYER_DEFAULTS.roughness, metallic: LAYER_DEFAULTS.metallic };

        if (layer.tileSize !== undefined) {
            if (typeof layer.tileSize !== 'number' || !Number.isFinite(layer.tileSize) || layer.tileSize <= 0) {
                throw new TerrainBuildError(
                    `${what}.tileSize must be a finite number > 0 (metres per texture repeat), ` +
                    `got ${show(layer.tileSize)}`
                );
            }
            out.tileSize = layer.tileSize;
        }
        for (const key of ['roughness', 'metallic']) {
            if (layer[key] === undefined) continue;
            const v = layer[key];
            if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
                throw new TerrainBuildError(`${what}.${key} must be a number in 0..1, got ${show(v)}`);
            }
            out[key] = v;
        }
        return out;
    }

    /**
     * Standard `.terrain.meta` content (shape verified against the editor-saved
     * `test/fixtures/golden/terrain/terrain.terrain.meta`).
     * @returns {object}
     */
    static createMeta() {
        return terrainMeta();
    }
}
