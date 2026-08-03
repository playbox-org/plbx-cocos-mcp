# Terrain Support — Research & Implementation Plan

> ## STATUS: EXECUTED — 2026-08-03
>
> Phases **T0–T5 are landed and green**: 1127 tests / 0 fail, **22 MCP tools** (19 + `query_terrain`
> + `build_terrain` + `edit_terrain`), **46** component templates (not 44). Shipped modules:
> `src/utils/terrainBin.js`, `src/utils/heightmap.js`, `src/utils/fsAtomic.js`,
> `src/document/TerrainBuilder.js`, `src/document/terrainOps.js`,
> `src/tools/{QueryTerrain,BuildTerrain,EditTerrain}.js`, templates `cc.Terrain` +
> `cc.TerrainCollider`, and the read-side wiring (AssetInspector card + memoization,
> `GetAssetInfo#formatTerrain`, AssetIndex `terrain` alias, Bounds contributor with
> `translationOnly` merging, `Validator#checkTerrain`, PropertyExtractor `__asset` allowlist).
> T5 landed the same day: the `lint_assets` `terrain` check (now five checks, default-on), the
> `find_asset_references` structural `.terrain` branch, and the documentation (README format notes,
> CLAUDE.md, this file).
>
> **Still open:** all of **Part 4** (the `cocos-scene-builder` skill), plus the pending
> editor-re-save verifications in Part 5.
>
> **How to read this file.** Part 1 is verified research and held up under implementation. Parts 2–3
> are the plan *as written before the code existed*; where reality diverged, **Part 6** (added
> 2026-08-03) is authoritative and Part 5 records which open questions are now closed. Do not treat
> a Part 2/3 signature, spec key or bound as current API — read the module.

Research + implementation plan for adding Cocos Creator 3.x Terrain support to the plbx-cocos-mcp
toolset and the `cocos-scene-builder` skill. Research verified 2026-08-02 against:

- Engine sources: `/Applications/Cocos/Creator/3.8.8/…/resources/3d/engine/cocos/terrain/`
  (`terrain-asset.ts`, `terrain.ts`, `height-field.ts`, `terrain-lod.ts`). **3.8.7 and 3.8.8 are
  byte-identical** across the whole `cocos/terrain/` directory, the terrain effects and the editor
  importer — one implementation covers both zombie-miner (3.8.7) and guligames-legendale-c7 (3.8.8).
- A real editor-saved project: `project-example/guligames-legendale-c7` — its
  `assets/Art/terrain.terrain` (V8 binary, decoded byte-by-byte below), the `cc.Terrain` component
  in `assets/scene.scene`, and the `library/` importer artifacts.
- The editor importer itself, decrypted from `app.asar`
  (`engine-extensions/…/handler/assets/terrain.ccc`) via the app's own Electron
  (`ELECTRON_RUN_AS_NODE=1`), same technique as `scripts/harvest-builtins.mjs`.

---

## Part 1 — Research summary (verified facts)

### 1.1 The `.terrain` asset is a raw native binary

The file in `assets/` starts with the version magic — there is no JSON wrapper. The editor importer
(`importer: "terrain"`, meta `ver: "1.1.50"`, `files: [".bin", ".json"]`, **always empty
`userData`** — the terrain importer has no userData config at all):

1. copies the source **verbatim** to `library/<xx>/<uuid>.bin` (`cmp`-verified identical), and
2. parses it with the engine's own `TerrainAsset._loadNativeData`, lifting **only the layer table**
   into `library/<xx>/<uuid>.json` — a normal flat serialized array
   (`cc.TerrainAsset {_native: ".bin", _layerInfos: [...]}` + `cc.TerrainLayerInfo` objects), plus a
   texture dependency list.

Heights/weights/geometry live **only in the binary**. The library `.json` `_layerInfos` and the
binary layer-info section are redundant encodings of the same data; the importer derives the JSON
from the binary, so offline texture wiring inside the binary is picked up automatically on
re-import.

### 1.2 Binary format V8 (`_exportNativeData`, terrain-asset.ts:570-633)

All values little-endian, packed, no alignment. Byte-verified on
`guligames-legendale-c7/assets/Art/terrain.terrain`:

| # | Field | Type | Notes |
|---|-------|------|-------|
| 1 | version | i32 | `0x01010008` (V8; 3.8.x editors write V8 exclusively). `0x01010111` = "default/empty" sentinel: header only, all class defaults |
| 2 | tileSize | f64 | f32 before V7. Snapped on load: `Math.floor(t*100)/100` |
| 3 | blockCount[2] | i32 ×2 | default `[1,1]` |
| 4 | weightMapSize | i16 | default 128 |
| 5 | lightMapSize | i16 | default 128 |
| 6 | heights | i32 count + u16 ×N | N = `(bc0*32+1)*(bc1*32+1)`; row-major, X fastest, one shared grid |
| 7 | normals | i32 count + f32 ×N | ≥V6. **Count 0 is legal and what the editor writes** (real file has 0); engine rebuilds via `_buildNormals` when `normals.length !== vertexCount*3` |
| 8 | weights | i32 count + u8 ×N | N = `(wms*bc0)*(wms*bc1)*4` — one logical RGBA8 map over the whole terrain; default fill `(255,0,0,0)` |
| 9 | layerBuffer | i32 count + i16 ×N | ≥V2. N = `bc0*bc1*4` — 4 palette slots per block, `-1` = empty; block-major `blockId = yBlock*bc0 + xBlock` |
| 10 | layerInfos | i32 count + records | ≥V3 (V4 adds normalMapId/roughness/metallic; f64 since V7). Record: `slot` i32, `tileSize` f64, `detailMapId` string, `normalMapId` string (`""` if none), `roughness` f64, `metallic` f64. String = i32 charCount + 1 byte/char (ASCII only — UUIDs) |

**Padding:** `_exportNativeData` returns the whole `TerrainBuffer` backing buffer (capacity min
2048, doubled on demand) — real 67 922-byte payload sits in a 131 072-byte file, tail all zeros.
Parse structurally, never by file length; **a byte-exact writer must reproduce the pow-2 zero
padding** (min 2048).

**Height encoding:** u16, world Y = `(raw − 32768) * (1/128)` (V8; pre-V8 files use 1/512 and are
migrated on load). Range ±256 m, resolution 7.8125 mm. Flat terrain = every sample `32768`
(`TERRAIN_HEIGHT_BASE`). Clamp writes to `TERRAIN_HEIGHT_FMIN/FMAX` (−256 … +255.99).

**Constants** (terrain-asset.ts:28-52): block = 32×32 tiles = 33×33 vertices
(`TERRAIN_BLOCK_TILE_COMPLEXITY`/`_VERTEX_COMPLEXITY`), `TERRAIN_MAX_BLEND_LAYERS = 4` (per block),
`TERRAIN_MAX_LAYER_COUNT = 256` (palette), defaults `tileSize 1`, `weightMapSize 128`,
`lightMapSize 128`, `blockCount [1,1]`. `size = bc * 32 * tileSize` metres per axis.

**Weight↔layer semantics:** weight channel R blends `blockLayers[0]`, G→[1], B→[2], A→[3];
weight-map texel index `j * (wms*bc0) + i`. Layer detail-map ids are stored as full
`<uuid>@<subId>` strings — real data uses `@6c48a` (= `nameToId('texture')`, the texture sub-asset
of an image).

**Height sampling** (`getHeightAt`, terrain.ts:1876-1914): grid-cell interpolation that splits the
quad by the `dx+dz<=1` diagonal and extrapolates the far corner (`m=(b+c)/2; d=2m−a`), then
double-lerp — **not** plain bilinear. Port exactly.

### 1.3 `cc.Terrain` component serialization (16 keys, editor-saved shape)

```json
{
  "__type__": "cc.Terrain",
  "_name": "", "_objFlags": 0, "__editorExtras__": {},
  "node": { "__id__": N }, "_enabled": true, "__prefab": null,
  "__asset": { "__uuid__": "665a0471-…", "__expectedType__": "cc.TerrainAsset" },
  "_effectAsset": null,
  "_lightmapInfos": [],
  "_receiveShadow": true,
  "_useNormalmap": false,
  "_usePBR": false,
  "_lodEnable": false,
  "_lodBias": 0,
  "_id": "…"
}
```

- **The asset key is `__asset` (double underscore)** — the `@serializable` member is
  `protected __asset` (terrain.ts:1208-1211); `_asset` is only a getter/setter facade. Unique among
  our supported components.
- Engine defaults: `_receiveShadow: false`, `_useNormalmap: false` (lowercase m), `_usePBR: false`,
  `_lodEnable: false`, `_lodBias: 0`, `_effectAsset: null`, `_lightmapInfos: []` (the real scene has
  `_receiveShadow: true` — a user flip, not the default).
- `_effectAsset: null` → engine falls back to `TERRAIN_EFFECT_UUID =
  "1d08ef62-a503-4ce2-8b9a-46c90873f7d3"` (legacy `terrain.effect`, terrain.ts:53). The
  surface-based `builtin-terrain.effect` is `a0fd9f76-74fe-423c-92d9-298906c189ba`. Both (plus
  `default_file_content/terrain/default.terrain`, `default_prefab/Terrain.prefab`,
  `default-layer-texture.jpg`) are **already in `src/assets-data/builtins-3.8.json`** — the builtin
  resolution layer needs zero changes.
- `_lightmapInfos: TerrainBlockLightmapInfo[]` — filled only by editor lightmap baking (one per
  block); empty when unbaked. Never generated offline.
- **Runtime-only, never serialized:** the per-block `Node('TerrainBlock')` children (flagged
  `DontSave|HideInHierarchy`), `_layerList`, buffers, LOD state. An offline tool must never expect
  or emit them.
- Terrain geometry is anchored at the node origin, local X∈[0,width], Z∈[0,height]; **the terrain
  shader applies node worldPosition only — node rotation/scale are ignored** (vertices are offset by
  `cc_matWorld[3]`).

### 1.4 Editor behavior relevant to offline editing

- The editor never patches the binary in place — every save is a fresh full `_exportNativeData()`
  dump through asset-db.
- "Create → Terrain" copies the shipped `default.terrain` (2048 bytes: `11 01 01 01` + zeros — the
  `0x01010111` sentinel); real buffers appear on first sculpt+save.
- Offline rewrite of the binary → mtime change → asset-db classifies it as `change` → full clean
  re-import (`.bin` re-copied, `.json` + depends regenerated). **UUID comes from the `.meta` and is
  preserved** — same contract `create_asset_meta` already relies on. Safest: rewrite the binary
  only, leave an existing meta untouched.
- Meta `ver` must be `"1.1.50"` (shared scene-family constant, same in 3.8.7): a lower ver just
  triggers re-import; a **higher** ver makes the editor skip the import with a warning.
- **Hazard:** while the editor's Terrain panel has unsaved changes, its save overwrites the whole
  file from memory, silently discarding any offline edit. Editing discipline must forbid touching a
  `.terrain` that is being edited in an open Terrain panel.
- `profiles/v2/packages/scene.json` holds only editor brush state (keyed by component `_id`) — safe
  to ignore.

### 1.5 What the editor's terrain tools mutate (op-completeness checklist)

| Editor operation | Data mutated |
|---|---|
| Sculpt height | `heights[]` (+ normals recompute) |
| Paint weights | `weights[]` + block `layerBuffer` slot assignment |
| Add/remove/edit palette layer | binary `layerInfos` (+ library JSON `_layerInfos`) |
| Resize blockCount / weightMapSize / tileSize | everything, overlap-preserving (`Terrain.rebuild`: heights copy old rect / new = 32768; layerBuffer copy old blocks / new = −1; weights per-block copied, or diagonal-split-resampled when weightMapSize changes (`sampleOldWeight`, terrain.ts:2635-2668 — same `m=(b+c)/2` extrapolation scheme as `getHeightAt`, **not plain bilinear**, sample coords clamped to oldWeightMapSize−1) / new = `(255,0,0,0)`; lightmaps reset — `Terrain.rebuild` calls `_resetLightmap(false)` **unconditionally** (terrain.ts:1576), so ANY resize drops the bake, not just a `blockCount` change) |
| Import heightmap | `heights[]` from a sampled HeightField |
| Bake lightmaps | component `_lightmapInfos` (editor-only) |
| Component toggles (shadow/PBR/normalmap/LOD/effect) | scene file only |

Full coverage of "everything configurable about Terrain" = component fields (already reachable via
`apply_edits` once a template exists) + the five asset mutations above (need a new binary-edit
path) + **physics** (see §1.6), minus lightmap baking (editor-only by nature).

### 1.6 Physics: `cc.TerrainCollider`

`cc.TerrainCollider` exists (`cocos/physics/framework/components/colliders/terrain-collider.ts`,
with physx/bullet/cannon backend shapes): serialized `_terrain: TerrainAsset|null` plus the
`Collider` base fields (`_material`, `_isTrigger`, `_center`). It is the ONLY way to make a terrain
collidable — a `MeshCollider` cannot cook a heightfield (a terrain has no mesh asset). Engine
limitation: TerrainCollider on a **dynamic** RigidBody is unsupported (warnID 9630) — static/none
only.

---

## Part 2 — Design decisions

1. **`.terrain` is a binary native asset — it never goes through `SceneDocument`.** New
   `src/utils/terrainBin.js` (reader **and** writer), styled after `src/utils/glb.js`. Reader
   accepts V1–V8 + the `0x01010111` sentinel (applying the documented per-version guards and the
   pre-V8 1/512→1/128 height migration); writer emits **V8 only**, `normals` count 0 (matches
   editor output; engine rebuilds), pow-2 zero padding (min 2048). Acceptance bar: byte-identical
   round-trip on a real editor-saved `.terrain` (golden), same standard as the scene write layer.

2. **Tool surface: three new tools** (19 → 22), mirroring the read/build/edit split the repo
   already uses. Semantic operations only — the LLM never patches bytes, same iron rule as
   `.scene`/`.prefab`:
   - `query_terrain` — read/inspect a `.terrain` in depth (the compact card stays in
     `get_asset_info`).
   - `build_terrain` — create a new `.terrain` + `.meta` from a compact spec (composition copied
     from `build_animgraph`: meta-first, overwrite guard, `AssetIndex.invalidate`, next-step hint).
   - `edit_terrain` — all-or-nothing batch of semantic ops over an existing `.terrain`
     (resize/layers/heights/weights), with `dryRun`. Separate from `apply_edits` because the target
     is a binary asset, not a scene document; `apply_edits` keeps its 15 ops unchanged.
   - Component-side editing (attach asset, toggles, effect) rides the **existing**
     `add_component`/`set_asset_ref`/`set_component_property` once the template + importer mapping
     land.

3. **Never touch `library/`.** After an offline `.terrain` write the library `.json` goes stale
   until the editor re-imports (mtime-driven, automatic, verified). Tools and skill state this
   explicitly. Existing metas are never rewritten (no UUID churn).

4. **`cc.Terrain` template uses engine defaults** with the exact 16-key set/order from the
   editor-saved scene (§1.3). The `__asset` quirk needs only a tiny per-type alias for the bare
   `asset` spelling — `property: "_asset"` ALREADY resolves to `__asset` today via
   `locateProperty`'s underscore-tolerance retry (operations.js:377-380: missing `_asset` →
   `__asset` found); `PAIRED_FIELDS` is NOT involved (only one serialized field — `_asset` is a
   facade, unlike `AnimationController._graph`/`graph`).

5. **`cc.Terrain` does NOT join `VISUAL_ROOT_TYPES`** — terrain is a legitimate root-level world
   object; the wrapper rule doesn't apply (the engine's own `default_prefab/Terrain.prefab` would
   otherwise warn).

6. **Coordinates:** all tool inputs/outputs use **local metres** (x along width, z along height,
   heights in metres) by default, with explicit vertex/texel index forms available for exact work.
   Docs state the node-worldPosition-only anchoring (rotation/scale ignored by the shader) — this
   also dictates the Bounds contributor's translation-only matrix.

7. **Heightmap sources** for `build_terrain`/`edit_terrain`: (a) inline 2D JSON array of metres,
   (b) raw 16-bit LE `.raw` + dimensions, (c) grayscale PNG 8/16-bit via a minimal zero-dep decoder
   (`node:zlib` inflate + unfilter; non-interlaced, color type 0 only — anything else refused with a
   clear error). Values are resampled to the vertex grid with the engine's `importHeightField`
   sampling scheme.

8. **`weightMapSize` guard** (applies to BOTH `build_terrain` and `edit_terrain set_info`): power
   of two, assumed range 4…512. The engine itself does not constrain the field — the range comes
   from the editor UI and is an **assumed bound** until the pending editor re-save check confirms
   it (Part 5).
   → **WRONG ON BOTH ENDS, corrected during implementation (2026-08-03).** The editor's Terrain
   panel offers exactly `128/256/512/1024` — for `weightMapSize` **and** `lightMapSize` — and there
   is no power-of-two check anywhere in `cocos/terrain/` (the per-block weight texture is NPOT-safe:
   `LINEAR` + `CLAMP_TO_EDGE`, no mipmaps). Shipped guard: power of two in **4…1024** (1024 is
   mandatory — otherwise an editor-authored 1024 terrain could be lowered but never restored; 4 is
   kept for cheap test terrains and the error message says the editor never authors those). See
   Part 6.1.

9. **Read/write symmetry.** Everything the tools can write must be dumpable back out:
   `query_terrain` exposes height-grid export (engine `exportHeightField` counterpart) and
   per-point weight sampling — otherwise relative edits ("lower this hill", before/after diffs) and
   paint verification are blind.

---

## Part 3 — Implementation plan

### Phase T0 — binary layer + fixtures (foundation)

**`src/utils/terrainBin.js`** (new):
- `readTerrain(buffer)` → `{version, tileSize, blockCount, weightMapSize, lightMapSize, heights (Uint16Array), normals (Float32Array), weights (Uint8Array), layerBuffer (Int16Array), layers: [{slot, tileSize, detailMapId, normalMapId, roughness, metallic}]}` | `null` on unrecognized magic (glb.js convention: null, not throw, for "not a terrain"); structural errors (truncated stream, count overflow vs remaining bytes) throw with offsets.
- `readTerrainInfo(filePath)` — cheap header+stats card (no full weight copy retained): version, tileSize, blockCount, size in metres, weightMapSize, lightMapSize, height min/max (metres), layer table, per-block layer usage, `isDefaultSentinel`.
- `writeTerrain(data)` → Buffer, V8, normals `[]`, pow-2 padding; validates all invariants (array lengths vs blockCount/wms, layer slots < 256, ASCII ids, height range) before writing.
- `heightAt(data, x, z)` — exact port of `getHeightAt` (diagonal-split interpolation). Null condition ported verbatim (terrain.ts:1887-1889): null when `floor(x/tileSize)` or `floor(z/tileSize)` is outside `[0, vertexCount−1]` — the engine tolerates up to one tile beyond the far edge and clamps the cell.
- `weightAt(data, x, z)` — port of `getWeightAt`/`getMaxWeightLayerAt` (terrain.ts:2034, :2089): the 4 channel weights + the dominant layer slot at a point. The metres→texel mapping is **block-local** (`weightTexelAt`, shared with the write side): the engine uploads one `wms×wms` CLAMP_TO_EDGE texture per block (terrain.ts:920-955) sampled with block-local uv (terrain.ts:1170), and its own resampler maps `u/(wms−1)*(oldWms−1)` inside a per-block window (terrain.ts:2670-2683) — a global mapping would blend across block seams, which nothing in the engine does.
- Palette maintenance: `compactPalette(data)` / `removeLayer(data, slot)` — re-index `layers[].slot` to the array index, remap every `layerBuffer` reference and left-pack the affected blocks' channels (weights moved along). This is the format-level counterpart of the dense-palette invariant the writer enforces; T4's `remove_layer`/`set_layer` build on it instead of re-deriving it.
- Authoring guards: `validateTerrainGeometry` / `validateTerrainCapacity` (+ `TERRAIN_MAX_BLOCKS`, `TERRAIN_MAX_WEIGHT_TEXELS`) run BEFORE `materialize` allocates, so a spec-supplied `blockCount`/`weightMapSize` cannot turn into a multi-GB allocation. Non-finite heights/weights are rejected rather than silently stored as raw 0 (= −256 m).
- `exportHeights(data, region?, sampleCount?)` — engine `exportHeightField` counterpart (terrain.ts:1641): dump the height grid (metres) as rows, whole terrain or a region.
- `defaultSentinel()` → the 2048-byte `0x01010111` buffer (byte-identical to the shipped `default.terrain`).

**Fixtures/tests:**
- `test/fixtures/golden/terrain/`: copy the unmodified editor-saved `terrain.terrain` (+`.meta`, + library `.json` for importer-shape reference) from guligames-legendale-c7. Round-trip test: read → write → **byte-identical** (131 072 bytes incl. padding). Plus a sentinel-file round-trip.
- `test/fixtures/mock-project/assets/Maps/`: a small generated `1×1`-block terrain + meta for downstream tests (flagged for one-time editor re-save verification, same as the template catalog).
- Unit tests: height encode/decode quantization, clamping, pre-V8 migration read, `heightAt` against hand-computed samples, writer invariant rejections.

### Phase T1 — read side

- **`AssetInspector`**: `case 'terrain'` → `#inspectTerrain(entry)` using `readTerrainInfo`; layer texture UUIDs resolved to names via the index (sub-asset `@6c48a` handled by `AssetIndex.label()` already). AssetInspector has no cache today — add a small memoization keyed by file path + mtime, mirroring Bounds' `#meshCache` pattern (Bounds.js:193-205).
- **`GetAssetInfo`**: `#formatTerrain(lines, info)` card — size (m), blocks, vertex grid, tileSize, weight/light map sizes, height range, layers (`slot → texture name, tileSize, roughness/metallic, weight coverage %`), sentinel note ("empty default terrain — no sculpt data yet").
- **`AssetIndex`**: `TYPE_ALIASES.terrain = ['terrain']` — listing already works today via the raw-importer fallback (`list()` AssetIndex.js:229); the alias makes `terrain` a documented knownType even in projects without terrains.
- **New tool `query_terrain`** (`src/tools/QueryTerrain.js`): args `{terrainPath | uuid, heightAt?: [[x,z],…], weightAt?: [[x,z],…], exportHeights?: {region?, format: "rows"|"raw16"}, blocks?: bool}` → full text report: everything in the card + per-block layer/weight usage table, height stats (min/max/mean), sampled heights (answers "is Y on the ground?"), sampled weights + dominant layer (verifies `paint_layer`), height-grid dump for relative editing/diffs, warnings (layerBuffer slot with no layerInfo, weights not covering a used slot, non-ASCII/unresolvable texture ids, **layers carry normal maps while the scene component would need `_useNormalmap: true`** — cross-file pairing note). Alias `filePath` → `terrainPath`.
- **`Bounds.js`**: spans TWO methods. `#collectComponents` gains a `cc.Terrain` branch: analytic AABB — X∈[0, bc0·32·tileSize], Z∈[0, bc1·32·tileSize], Y from height min/max via `readTerrainInfo` — pushed with a `translationOnly: true` flag on the box; `computeSubtree`'s two merge loops (Bounds.js:56-65) must honor the flag by extracting only the translation column of the composed matrix (`worldMat * box.matrix`) instead of `transformAabb` with full TRS — otherwise ancestor rotation/scale would inflate the AABB, which the engine ignores (§1.3). `out.skipped` with a reason when the asset is missing/unreadable/sentinel (sentinel → Y span [0,0], still measurable, note in source).
- **`Validator.js`**: `#checkTerrain(warnings)` — warnings only (golden corpus must stay 0-error): `__asset: null` (renders nothing), asset UUID resolving to a non-`terrain` importer, `_lightmapInfos.length` ∉ {0, bc0·bc1} when the asset is readable, layers-with-normalMap while `_useNormalmap: false` / roughness-metallic-in-use while `_usePBR: false` (silent-invisible class, like the wrong-material note), `cc.TerrainCollider` next to a **dynamic** `cc.RigidBody` (engine-unsupported, warnID 9630). Asset existence itself is already covered by `#checkAssetRefs` (builtin-aware).
- **Snapshot tests**: additive-only additions to `readSnapshots` (new card lines), `test/tools/QueryTerrain.test.js`, bounds tests over the mock-project terrain.

### Phase T2 — scene-side write (component + collider)

- **`ComponentTemplates.js`**:
  - `'cc.Terrain'` template — 16-key editor shape (§1.3), engine defaults. `ALIASES` derives
    `"Terrain"` automatically.
  - `'cc.TerrainCollider'` template (§1.6) — `Collider` base fields (`_material: null`,
    `_isTrigger: false`, `_center: Vec3 0`) + `_terrain: null`; field set/order harvested from an
    editor-saved component (one-time re-save check, same lane as the rest of the catalog).
  - Update the "~44 templates" counts in tool descriptions.
- **`operations.js`**:
  - `IMPORTER_TO_TYPE`: `'terrain': 'cc.TerrainAsset'` (without it `set_asset_ref` can't infer `__expectedType__`). Serves both `cc.Terrain.__asset` and `cc.TerrainCollider._terrain`.
  - Property-key alias (new, tiny): on `cc.Terrain`, bare `asset` → `__asset`. `_asset` already
    resolves via `locateProperty`'s underscore-tolerance (operations.js:377-380) — do NOT build a
    redundant map for it; tests must assert the existing mechanism. Documented in `OPS_DOC`
    (which lives in `src/tools/ApplyEdits.js:20`, not operations.js).
  - No `REQUIRED_COMPANIONS` entry (the editor's Terrain node carries only `cc.Terrain` — verified in the real scene), no `PAIRED_FIELDS` entry (§2.4).
- Tests: add_component (both types) → validate → editor-shape equality vs the golden component (minus `node`/`_id`); set_asset_ref via `asset` alias, `_asset` underscore-tolerance and exact `__asset`; `set_asset_ref {property: "terrain"}` on the collider; snapshot of `inspect_node` on the terrain node of a fixture scene.

### Phase T3 — `build_terrain`

**`src/document/TerrainBuilder.js`** (new; `TerrainBuildError`): `compile(spec)` → binary data + notes. Spec:

```jsonc
{
  "blockCount": [2, 2],          // default [1,1]
  "tileSize": 1,                 // default 1
  "weightMapSize": 128,          // default; guard per §2.8 (shared with edit_terrain set_info)
  "lightMapSize": 128,
  "baseHeight": 0,               // metres, default 0 (flat)
  "heightmap": { "source": "path.png|path.raw|inline", "min": 0, "max": 20, "rows"?: [[…]] },
  "layers": [                    // optional; slot = array index
    { "detailMap": "Art/Textures/Ground.png", "normalMap"?: "…", "tileSize"?: 1, "roughness"?: 1, "metallic"?: 0 }
  ],
  "fillLayer": 0                 // optional: paint whole terrain with this slot (weights 255,0,0,0 + layerBuffer)
}
```

- Layer textures resolved via the injected `assetIndex` (path/uuid/`uuid@subId`); a bare image
  resolves to its `@6c48a` texture sub-asset; unresolvable → rich list-the-alternatives error.
- No layers → `layerBuffer` all −1, weights default fill (engine renders the effect's grey
  fallback) + a note.
- **`src/tools/BuildTerrain.js`**: composition copied from `BuildAnimGraph` — `.terrain` extension
  check, `assets/` containment, `overwrite: true` guard, **meta resolved before writing** (existing
  meta's UUID preserved; corrupt meta aborts with nothing written), write binary, `MetaGenerator`
  meta + `ensureParentDirMetas`, `AssetIndex.invalidate`, report = `# Built …` + UUID + re-read via
  `readTerrainInfo` + "attach with apply_edits: add_component cc.Terrain + set_asset_ref" hint.
- **`MetaGenerator.js`**: `SIMPLE_TYPES['.terrain'] = { importer: 'terrain', ver: '1.1.50', files: ['.bin', '.json'] }` (verified against the real meta and both editors) — this also makes `create_asset_meta` cover editor-external `.terrain` files; `userData` stays `{}` (importer has none, verified).
- Tests: build → byte-parse-back equality, meta shape vs golden meta, overwrite/uuid-preservation, error paths.

### Phase T4 — `edit_terrain`

**`src/document/terrainOps.js`** (new; ops table mirroring `operations.js` style: all-or-nothing, typed `TerrainOpError`, `{op, summary}` results). Load → apply batch → validate invariants → atomic save (temp+rename, pow-2 padding). Ops:

| op | args | semantics |
|---|---|---|
| `set_info` | `tileSize?, blockCount?, weightMapSize?, lightMapSize?` | Overlap-preserving resize, exact `Terrain.rebuild` port: heights copy old rect / new = 32768 (0 m); layerBuffer copy old blocks / new = −1; weights per-block copy, or diagonal-split resample when weightMapSize changes (§1.5 — not plain bilinear); `weightMapSize` guard per §2.8; sentinel files materialize to real buffers first |
| `set_layer` | `slot, detailMap?, normalMap?, tileSize?, roughness?, metallic?` | Add or update palette entry; texture resolution as in T3; explicit `normalMap: null` clears. **The palette is dense** — an ADD may only append (`slot === layers.length`); `slot 0-255` addresses existing entries only, a gap is an error pointing at the next free slot |
| `remove_layer` | `slot` | Removes palette entry via `terrainBin.removeLayer()`: every `layerBuffer` reference to it dropped, the affected blocks' remaining channels **left-packed** (their weights moved along, freed channels zeroed), and the palette **re-indexed** so `slot === array index` stays true (the writer rejects a sparse palette); summary reports affected blocks |
| `set_heights` | `region? {x,z,width,depth (m)}, value? (m) \| rows? \| heightmap? {source,min,max}` | Flatten to `value`, set from inline rows, or sample a heightmap file over the region (whole terrain when omitted); clamp ±256 m, quantize 1/128 |
| `adjust_heights` | `region?, delta (m)` | Relative raise/lower |
| `smooth_heights` | `region?, iterations?` | Box-blur on the height grid (the editor's smooth brush equivalent), same clamp/quantize path |
| `paint_layer` | `layer (slot), region? {…, shape?: rect\|ellipse}, weight (0..1), falloff? (m)` | Writes weights over the region's texels with proportional renormalization of other channels (sum stays 255); auto-assigns the slot into each touched block's `layerBuffer` — error listing the block if all 4 slots are taken by other layers |
| `set_block_layers` | `block: [x,y] \| "all", layers: [slots…]` | Low-level direct `layerBuffer` write (≤4, −1 padding) |

**`src/tools/EditTerrain.js`**: `{terrainPath, operations: […], dryRun?}`; report `# Applied N op(s)` + per-op summaries + resulting `readTerrainInfo` card; nothing written on any failure (`"\n\nNothing was written."` convention). Warn in the report that the editor must not have the same terrain open in its Terrain panel (§1.4 hazard) and that `library/` refreshes on next editor focus. When `set_info` changed `blockCount`, the report appends an explicit next-step hint — "clear `_lightmapInfos` on components using this asset via apply_edits" — instead of relying on the validator warning being seen.

Tests: each op on the mock fixture; resize semantics vs hand-built expectations (incl. weight resampling); paint renormalization sums; full-batch atomicity; golden terrain edited with a no-op batch stays byte-identical.

### Phase T5 — docs, counts, hygiene

- README format notes: new "Terrain" section (binary layout table, version history, component shape, importer behavior) — README is the locked-decision home.
  → **DONE 2026-08-03**, but as five flat bullets in `## Формат Cocos Creator 3.x — верифицированные заметки`, **without** the layout table: that section has no tables and no sub-headings, and a `###` would have been the first one in it. Layout is expressed as dense prose/inline lists instead.
- CLAUDE.md: tool count 19 → 22, one-line layer description (terrainBin, TerrainBuilder, terrainOps), testing note for the terrain golden.
  → **DONE 2026-08-03** (new `### Terrain Layer` section; the `operations.js` op count stays **fifteen** — `edit_terrain` is a separate tool with its own eight-op table, and the CLAUDE.md sentence now says so explicitly so the next reader does not "fix" it).
- `lint_assets`: optional `terrain` check — terrains whose layer textures are missing/deleted, used slots with zero weight coverage (silent-invisible class of bug, like the materials check). Small, reuses `readTerrainInfo`.
  → **DONE 2026-08-03.** Shipped as a fifth, default-on check (`CHECKS = ['names','scales','wrappers','materials','terrain']`, `#lintTerrains`), reading through **AssetInspector** rather than `readTerrainInfo` directly — the inspector memoizes per file identity and already resolves ids to labels, so `detailMapName === null` *is* the "texture missing" finding. The zero-coverage finding reuses `layerUsage` and applies the same per-BLOCK suppression as `terrainInfoFromData` (a block with a single assigned channel never samples its weight map). Per-file `try/catch` + a `card.error` branch, so one unreadable binary cannot abort the lint; empty projects get the `OK — …` zero-count section.
- `find_asset_references`: file-level attribution for `.terrain` files via `readTerrainInfo`'s layer table (same shape as the `.mtl` handling) — layer detail/normal textures live as UUID strings inside the binary and are invisible to the string scan today, breaking the "who uses this texture" promise.
  → **DONE 2026-08-03**, but the rationale above is **wrong** and the shipped code says so explicitly: the ids are plain ASCII inside the binary, so they are invisible only because `.terrain` is in neither `DEEP_EXTENSIONS` nor `SHALLOW_EXTENSIONS` — a lazy `SHALLOW_EXTENSIONS.push('.terrain')` *would* match the bytes. The real reasons for the dedicated structural bucket (`BINARY_EXTENSIONS`) are (a) attribution — `terrain layer 1 .detailMap [sub-asset @6c48a]` instead of a bare occurrence count, and (b) never utf-8-decoding 100+ KB of heights/weights just to count byte coincidences in it. Shape: the branch runs BEFORE the utf-8 read and its substring pre-filter, is skipped for script targets (a binary holds no `__type__`), parses with `readTerrain`, shares the sub-asset-tolerant predicate with the deep pass (extracted as `matchesTarget`), renders its own `## <file> (N)` section and folds into the reference/file totals.

### Dependency order

T0 → T1 → T2 can land independently after T0; T3 needs T0 + MetaGenerator line; T4 needs T0 (+T3's texture-resolution helper); T5 last. Each phase ships with its tests green and snapshots additive-only.

---

## Part 4 — Skill update plan (`skills/cocos-scene-builder`, edits in this repo per memory)

1. **SKILL.md · Tool map table**: three new rows with exact call signatures (`query_terrain`,
   `build_terrain`, `edit_terrain`); asset-kind matching prose gains `.terrain → query_terrain /
   get_asset_info`.
2. **SKILL.md · Import preflight**: `.terrain` joins the fully-offline list ("`build_terrain` writes
   the `.meta` itself — the UUID is valid and referencable immediately"); the *"Only models
   (.fbx/.glb/.gltf) still require the editor"* sentence **stands** (terrain is fully offline) but
   gains "(terrain: see recipe 13)" so it isn't read as excluded-by-omission.
3. **SKILL.md · Editing discipline**: new bullets — never edit a `.terrain` while its Terrain panel
   is open in the editor (silent overwrite hazard); library `.json` is stale until editor re-import
   (harmless, automatic); component toggles via `apply_edits`, terrain data via `edit_terrain`,
   never both mixed in one mental batch.
4. **SKILL.md · When to ask the user**: lightmap baking and art-driven weight painting
   (hand-painted masks) stay editor work — same "the manual part is only X" phrasing as the
   model-unpack bullet.
5. **recipes.md · new `## 13. Terrain`** (arc copied from recipe 7): inspect textures
   (`get_asset_info`) → `build_terrain` with a worked spec → attach (`add_component cc.Terrain` +
   `set_asset_ref {property: "asset"}` — alias note) → collider step mirroring recipe 1 step 5
   (`add_component cc.TerrainCollider` + `set_asset_ref {property: "terrain"}`; static bodies only
   — dynamic RigidBody is engine-unsupported) → sculpt/paint via `edit_terrain` worked ops →
   verify (`query_terrain` + `get_node_bounds`; heightAt for "does the prop sit on the terrain").
   Includes the anatomy notes: node origin = terrain corner, rotation/scale ignored, size =
   blocks×32×tileSize, and the pairing rule: `set_layer` with a `normalMap` ⇒ also
   `set_component_property _useNormalmap: true` (same for roughness/metallic ⇒ `_usePBR`) — a
   normal map in the binary renders as nothing while the component flag is off.
6. **recipes.md · recipe 1b cross-ref**: "for real terrain (sculpted ground, texture blending), see
   recipe 13 — don't ship scaled planes as ground."
7. **Template catalog counts — BOTH occurrences**: recipes.md header (count bump + `cc.Terrain`
   in the 3D list, `cc.TerrainCollider` in physics) AND SKILL.md's own "`add_component` covers ~44
   built-in `cc.*` templates — …" line (SKILL.md:214) with its category list — the two enumerations
   are independent and both go stale otherwise.
8. **verification.md · Tier 1**: the "sits on the ground (min.y ≈ 0 or terrain height)" check
   becomes actionable: `query_terrain {heightAt: [[x,z]]}` vs the prop's bounds min.y.
9. **onboarding.md**: optional Step-2 question only if the project uses terrain (tile size /
   ground-height convention) — keep light.

---

## Part 5 — Risks, open questions, pending verifications

Statuses updated 2026-08-03, after T0–T4 landed.

| Item | Status / mitigation |
|---|---|
| Golden `.terrain` provenance | **CLOSED.** Committed as `test/fixtures/golden/terrain/` — `terrain.terrain` (131 072 B, `cmp`-verified copy), its `.meta`, the importer's `library/…json`, and the editor's shipped 2048-byte `default.terrain`. The layer textures themselves were deliberately NOT copied (only their uuids appear in the binary). Per-file provenance and the never-hand-edit rule live in `test/fixtures/golden/terrain/README.md`. |
| Editor re-save verification of MCP-built terrains | **STILL OPEN** — same pending-verification lane as the template catalog: one-time check that the editor re-saves a `build_terrain`/`edit_terrain` output without diffs (padding, field order) and renders it. Tracked, non-blocking. Note the read→write direction IS proven: the golden 131 072-byte editor save and `default.terrain` round-trip byte-identically. |
| `_objFlags: 512` on the real Terrain node | **CLOSED.** `512 = 1 << 9 = CCObject.Flags.LockedInEditor` (`cocos/core/data/object.ts:45`) — the hierarchy padlock, purely editorial. The engine's own `editor/assets/default_prefab/Terrain.prefab` has `_objFlags: 0` on its Terrain node, so `add_node` emitting 0 is correct and nothing needs to change. |
| `weightMapSize` 4…512 bound | **CLOSED — the assumption was wrong at BOTH ends** (details in Part 6.1). The editor's Terrain panel (Vue template harvested from `app.asar`) is a `ui-select` of exactly `128/256/512/1024`, for `weightMapSize` *and* `lightMapSize`; `tileSize` is `min="0.1" step="0.1" preci="1"` and `blockCount` W/H are `min="1" step="1" preci="0"`. The engine constrains nothing: `weightMapSize` is a plain `@serializable` i16 (terrain.ts:83-85), there is NO power-of-two check anywhere in `cocos/terrain/`, and the per-block weight texture is NPOT-safe as created (`LINEAR`/`CLAMP_TO_EDGE`, no mipmaps, terrain.ts:932-936) — pow-2 is an editor convention. Shipped guard: pow-2 in **4…1024**; `set_info` also skips the check for a value the op leaves unchanged, so an editor-authored terrain is never held hostage by our bound. |
| `cc.TerrainCollider` template field set | **STILL OPEN.** The template ships (`_material`, `_isTrigger`, `_center`, `_terrain`), but its field ORDER is inferred: `_terrain` is the only own `@serializable` member (terrain-collider.ts:95-96) and the base-then-subclass layout comes from 260+ editor-saved samples of *other* colliders, not from an editor-saved `cc.TerrainCollider` — none exists on this machine. One-time editor re-save check pending, same bar as the rest of the catalog. |
| PNG heightmap decoder scope | **As designed.** Grayscale (colour type 0), non-interlaced, 8/16-bit only; every other colour type/bit depth/interlacing is refused with a message naming what was found and pointing at `.raw`/inline rows. Not a general image library. |
| Multi-hop: terrain inside a prefab instance | **As designed** — out of scope, same as all instance internals; `edit_terrain` targets the asset, which is instance-agnostic anyway. (The component-side `asset` alias does reach an instance override: `overridePathForComponent` shares `aliasTopSegment` — see Part 6.6.) |
| Weight painting fidelity | **As designed.** `paint_layer` is region/falloff based, not a brush-stroke emulator; artistic masks remain editor work. |
| lightMapSize semantics | **As designed.** Serialized and resized with `set_info`; lightmap DATA is editor-baked and never fabricated. `#checkTerrain` warns when `_lightmapInfos.length ∉ {0, blocks}`, and `set_info` reports that any resize invalidates a bake (the engine's own `rebuild` calls `_resetLightmap(false)` unconditionally). |
| Engine `readDoubleArray` seek bug (terrain-asset.ts:204-210) | **As designed.** Unused by the format; neither emulated nor "fixed". Recorded in the `terrainBin.js` module header so a future reader does not reconcile our writer with it. |
| Editor re-save verification of mounted-component writes | **STILL OPEN, and unrelated to terrain** — pre-existing item from the mounted-components work, listed here only because it shares the same "one-time editor check" lane. |

---

## Part 6 — Where reality diverged from the plan (added 2026-08-03, post-implementation)

This file is the research record, so the deltas are listed rather than edited away. Where a Part 2/3
statement conflicts with an item here, the item wins; the code wins over both.

1. **`weightMapSize` bound was wrong at both ends** (§2.8, §T4 `set_info`): assumed pow-2 `4…512`,
   actual editor set is `128/256/512/1024` for BOTH `weightMapSize` and `lightMapSize`, and the
   engine enforces nothing at all. Shipped: pow-2 `4…1024`
   (`WEIGHT_MAP_SIZE_MIN`/`WEIGHT_MAP_SIZE_MAX`/`EDITOR_MAP_SIZES` in `TerrainBuilder.js`), with
   `set_info` skipping the guard whenever the passed value equals the file's current one (an LLM that
   echoes the whole info block back must not fail on a terrain that predates our bound). `lightMapSize` is deliberately
   laxer (integer `1…32767`) because nothing but the editor's own baker reads it — the error message
   still names the four values the panel offers. **Stale in code:** the `compile()` docstring in
   `TerrainBuilder.js` and the `build_terrain` tool description both still say `4..512`.

2. **`terrainBin.js` exports far more than §T0 listed.** The plan named ~9 functions; the shipped
   module also exports `materialize`, `terrainInfoFromData`, `payloadLength`, `padToCapacity`,
   `weightTexelIndex`/`weightTexelAt`/`texelPosition`/`weightAtTexel`/`setWeightAtTexel`,
   `blockLayers`/`setBlockLayers`/`maxLayerIndex`, `vertexCounts`/`weightMapDims`/`terrainSize`/
   `expectedCounts`/`blockIndex`, `rawToHeight`/`heightToRaw`/`getVertexHeight`/`setVertexHeight`,
   `snapTileSize`/`isTileSizeStable`, `heightStats`, `versionName`/`isKnownVersion` and the whole
   constant block. Reason: the stated rule "all format knowledge lives in terrainBin" only holds if
   `terrainOps`/`TerrainBuilder`/`QueryTerrain`/`Bounds` never re-derive an index formula — every one
   of those exports exists because some caller would otherwise have recomputed
   `(j * wms * bc0 + i) * 4` or `bc0 * 32 * tileSize` on its own.

3. **`rawTileSize` — a field the plan did not foresee.** The file stores the tileSize *unsnapped*
   (the editor writes `Terrain._tileSize` verbatim; `Math.floor(t*100)/100` is applied on LOAD,
   terrain-asset.ts:491). Byte-exact round-trip therefore needs both values: `readTerrain` returns
   `tileSize` (snapped, what everything computes with) *and* `rawTileSize` (what the file literally
   holds), and `writeTerrain` puts the raw value back only while it still snaps to the effective one
   (`consistentRawTileSize`) — otherwise a read→write of such a file would silently rewrite `0.29`
   as `0.28`.

4. **`weightAt` is NOT a port** (§T0 said "port of `getWeightAt`/`getMaxWeightLayerAt`"). Both engine
   functions are broken: `getWeightAt` (terrain.ts:2034-2083) computes `fx = x / (weightMapSize *
   blockCount[0])` — world metres divided by a TEXEL COUNT — so every in-terrain coordinate lands on
   texel 0; `getMaxWeightLayerAt` (terrain.ts:2089-2124) numerically indexes a `Vec4` (`w[0]` is
   `undefined`), tests `w.y` twice, never tests `w.w`, and derives the block from
   `floor(x / weightMapSize)`, so it always returns channel 0's layer. Only the interpolation KERNEL
   is ported; the metres→texel mapping (block-local, endpoint-inclusive, shared with
   `weightTexelAt`/`texelPosition`) and the argmax are corrected, and the divergence is documented at
   the function.

5. **The `__asset` quirk had a READ-side half the plan missed.** §2.4 only planned the write-side
   alias. But `PropertyExtractor#shouldSkip` hides every `__`-prefixed key as serializer bookkeeping,
   so a `cc.Terrain` rendered in `query_scene_graph`/`inspect_node` had **no asset at all**. Fixed
   with a one-entry allowlist (`#VISIBLE_DUNDER_KEYS = {'__asset'}`) rather than a blanket rule.

6. **There is a SECOND top-segment resolver, and it is not `locateProperty`.**
   `overridePathForComponent` in `instances.js` builds prefab-instance override `propertyPath`s
   independently, with its own underscore tolerance. Left alone, `set_instance_property {property:
   "asset"}` on a `cc.Terrain` would have written a path the engine does not recognize — and because
   the engine applies an override with a bare `targetPropOwner[name] = value`, that is not an error
   but a **silently dead override**. Hence `PROPERTY_ALIASES` is reached through an exported
   `aliasTopSegment(component, seg)` that both resolvers share, and it returns the alias only when
   the aliased key exists on that object.

7. **There was no atomic writer for binaries.** §T4 said "atomic save (temp+rename)" as if it
   existed; `SceneDocument.save` is JSON-only. Shipped as a new util the plan never listed:
   `src/utils/fsAtomic.js` → `writeFileAtomic` (temp file in the SAME directory, dot-prefixed
   `.<name>.tmp-<pid>` so asset-db ignores it, middle-truncated to stay under the 255-BYTE filename
   limit, temp removed on failure).

8. **`ops`, not `operations`.** §T4 specified `edit_terrain {terrainPath, operations, dryRun}`. The
   shipped canonical key is **`ops`** — matching `apply_edits {filePath, ops}` — with `operations`
   kept as an alias, plus the usual `filePath`/`path`/`asset`/`assetPath`/`uuid` → `terrainPath`
   aliases on all three tools.

9. **The sentinel's `layerBuffer` has length 4, not 0.** `TerrainAsset._layerBuffer` initializes to
   `[-1, -1, -1, -1]` (terrain-asset.ts:271), so "header only, all class defaults" is not "all
   buffers empty". `sentinelData()` reproduces that exactly, and `payloadLength` special-cases the
   sentinel to 4 bytes.

10. **Sparse palettes are a real read case the plan glossed over.** §1.2 treated the binary record's
    `slot` and the `layerBuffer` value as the same index. They are not: `_exportNativeData`
    overwrites the binary `slot` with the array position (terrain-asset.ts:613) and, for files ≥ V5,
    the RUNTIME palette is built from the library JSON's `_layerInfos[].slot` into `_layerList`
    (terrain.ts:2458-2470) — the binary table is only read for pre-V5 loads. So `layerBuffer` values
    are palette indices that this module can match to layer records *only while the palette is
    dense*, which is what `validateTerrainData` enforces for everything we write; a file with
    `layers[i].slot !== i` is read, warned about ("not produced by Cocos Creator") and repaired by
    `prepare()`/`compactPalette` rather than silently mis-joined.

11. **`prepare()` does more than "materialize the sentinel"** (§T4 mentioned only the sentinel): it
    also rebuilds buffers whose length disagrees with the declared geometry (what the engine does on
    load, `_buildImp` terrain.ts:2481-2526 — reported loudly, the old contents are gone), drops
    stored normals, stamps V8, and compacts a sparse palette — left-packing every block that loses an
    assignment (weights moved along and renormalized), because a `-1` below a used channel is sampled
    as a null layer.

12. **`terrainInfoFromData` exists for `dryRun`.** The plan assumed the report could always re-read
    the file through `readTerrainInfo`; with `dryRun` there is nothing on disk, so the card builder
    was split into a data-only entry point that reports the file the write *would* produce
    (`payloadLength`/`padToCapacity`).

13. **`heightmap.js` adds one deliberate non-engine behaviour**: a source whose dimensions equal the
    VERTEX grid is copied 1:1 instead of resampled (the engine's `importHeightField` would scale it
    by `w/(w-1)` and clamp the far edge, destroying authored values), and both branches emit a note
    saying which one ran. `.r16`/`.r8` extensions are accepted alongside `.raw`.

14. **AssetInspector's terrain card emits two shapes on purpose** — the flat `heightMin`/`isFlat`/…
    keys plus the nested `height: {…}` block and `null`-instead-of-`""` texture ids that
    `query_terrain`'s JSON uses — so one consumer code path reads either tool. Its memoization key is
    path + **nanosecond** mtime + size, because pow-2 padding makes a rewritten terrain the *same
    length*.

15. **Two op tables, one hardening.** Adding `terrainOps.applyTerrainOperation` surfaced that a bare
    `HANDLERS[op.op]` truthiness check lets `{op: "constructor"}` through via `Object.prototype`;
    both tables now use `Object.hasOwn`, and `validateArgs.normalizeArgs` got the same treatment for
    schema lookups.

16. **`QueryTerrain` grew beyond §T1's arg list**: `sections` (skip the ~25-line preamble when only
    sampling), `format: "text"|"json"`, and hard budgets everywhere — 256 sample points,
    power-of-two-strided default height grids (≤65 per axis, hard caps 513/65536 cells), per-block
    table auto-printed only up to 64 blocks. `exportHeights` also supports `format: "raw16"`.

17. **Both T5 code items shipped differently from the plan's sketch** (details under §T5): the
    `lint_assets` `terrain` check is a normal default-on member of `CHECKS` (not opt-in) and reads
    through `AssetInspector`, not `readTerrainInfo`, because the inspector already memoizes and
    already resolves the texture ids; the `find_asset_references` `.terrain` handling is a third
    `BINARY_EXTENSIONS` bucket with per-layer attribution rather than the `.mtl`-style file-level
    count the plan proposed, and the plan's stated rationale for it is wrong (see §T5). Part 4 (the
    skill) is still untouched.
