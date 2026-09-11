# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **A written object value keeps its Cocos type.** `set_component_property` / `build_prefab` wrote
  the merge form `{width: 184, height: 184}` verbatim wherever the file had no typed value to take
  the tag from — a `null` field, or any field of a script component `build_prefab` had just created
  (it starts with no fields at all). The engine rebuilds a value from its `__type__`, so an untyped
  one deserializes as a plain object and the component keeps its DEFAULT (`Size(0, 0)`,
  `Color(0, 0, 0, 255)`, an empty array) while `validate_document` reported the file as valid — the
  corruption was silent on both sides. Such a write is now REFUSED, naming the type that fits the
  keys and the spelling that works; merging into a value the file already types is unchanged. The
  same refusal covers an array or scalar written over a typed value (`_contentSize: [184, 184]`),
  and `{"$plain": {…}}` marks a field that really is an untyped dictionary.
- **A custom `@ccclass` value is hoisted into its own object.** The editor serializes a user class
  as a standalone entry of the flat array with an `{__id__}` reference from the owning field
  (verified: `cc.ClickEvent` in `test/fixtures/real-prefabs/Toilets.prefab`); a property write
  inlined it instead, at any nesting depth, so a nested `AnimationSet` → `DirectionFrames` chain
  never deserialized. `set_component_property`, `add_component`/`build_prefab` properties,
  `insert_array_element` values and instance overrides now all produce the editor's shape — only
  the engine's value types (`cc.Vec3`, `cc.Color`, …) stay inline. A `__type__` naming a node,
  scene or prefab-plumbing object is refused rather than minted as a value.
- **`validate_document` finds files written before the fix**: a `cc.*` component field holding an
  untyped object or an array where the 3.8.7 template declares a typed value is reported as a
  warning naming the type and the op that rewrites it.
- **A rotation/position/scale write with no existing value merges onto a TYPED zero.** A node that
  carries only `_lrot` (no `_euler`), or an instance override being created for the first time, used
  to produce an untyped `{y: 90}`.

## [2.0.0] - 2026-08-07

### Breaking

`list_assets` changed its **default** output. The pre-2.0 rows are still reachable — every item
below names the argument that restores them — but a caller that passed no `format` gets something
different.

- **`format` now defaults to `grouped`** (folder hoisted into a header, leaf name per row, the
  type tag hoisted into the header when it is uniform). The pre-2.0 default was one full path per
  line. Restore with `format: "flat"` (`"text"` is the same shape); the row itself is byte-for-byte
  the old one, only the truncation footer is worded differently.
- **The UUID is opt-in**: `uuid: "none" | "compressed" | "full"`, because `resolve()` accepts a
  project-relative path anywhere a UUID works. The default is per format, not global: `grouped`
  prints no UUID and states the omission in a footer, while an explicit `format: "flat"`/`"text"`
  still defaults to the full UUID (so a call that already named a format is unaffected) and `json`
  always carries it. Restore with `uuid: "full"`.
- **Every shape is now sorted by (folder, name) before the 300-row cap — `json` included.**
  Previously rows came out in `AssetIndex`'s unsorted depth-first scan order. Row *contents* of
  `flat`/`text`/`json` are unchanged, but the row **order** is not, and on a project with more than
  300 matches neither is *which* rows survive truncation. No argument restores the old order; a
  caller that depended on it must sort the `json` shape itself.

Old-style call, in full: `{format: "flat", uuid: "full"}`.

### Added

- **Four new MCP tools (18 → 22)**:
  - `query_terrain` — geometry, layer palette, per-block channel table, height stats,
    `heightAt`/`weightAt`/`exportHeights` sampling (incl. an ASCII above/below-threshold
    `format: "map"`), plus `contourAt`/`slope` readouts. Every axis of the response size is budgeted.
  - `build_terrain` — compiles a compact spec into the exact V8 bytes plus a `.meta`, meta resolved
    first so an overwrite keeps its UUID and a corrupt meta aborts with nothing written.
  - `edit_terrain` — eight all-or-nothing ops over an existing `.terrain`: `set_info`, `set_layer`,
    `remove_layer`, `set_heights`, `adjust_heights`, `smooth_heights`, `paint_layer`,
    `set_block_layers`.
  - `create_asset_meta` — offline `.meta` generation, so assets created outside the editor are
    importable with a stable UUID.
- **`.terrain` binary support** (`src/utils/terrainBin.js`): V1–V8 reader with the engine's
  per-version field guards and the pre-V8 height migration, V8 writer with the pow-2 padding,
  round-trip verified byte-identical against the editor-saved 131 072-byte golden terrain (the only
  editor save with a payload) and against the editor's shipped 2 048-byte `default.terrain`, which
  covers the header and the empty-sentinel path only (`test/fixtures/golden/terrain/`).
- **Terrain analytics** (`src/utils/terrainContour.js`): iso-contour crossings, true
  point-to-segment signed distance (marching squares + bucket grid), slope in degrees with the
  adjacent-sample `maxStep`. Threshold ties are handled on both halves, so the read and write sides
  agree about whether a contour exists.
- **Height sources** (`src/utils/heightmap.js`): inline metre rows, headerless 16-bit LE `.raw`,
  and grayscale non-interlaced 8/16-bit PNG through a zero-dependency decoder.
- **Shared region mask for the terrain height/paint ops**: `region.shape` `rect`/`ellipse`/`band`
  (a band follows an iso-contour), `falloff` + `profile`, and `clamp` (`raise-only`/`lower-only`).
  The factor is 0 *at* the region border and 1 exactly `falloff` metres inside it; each write
  measures the residue left at the border and reports it as a step only when the ramp cannot
  explain it.
- **Scene-side terrain integration**: `cc.Terrain` and `cc.TerrainCollider` component templates,
  `terrain` → `cc.TerrainAsset` importer mapping, a `PROPERTY_ALIASES` entry so a bare `asset`
  reaches the `__asset` member, a terrain card in `get_asset_info`, an analytic (translation-only)
  terrain AABB in `Bounds`, `find_asset_references` attribution down to `terrain layer N .detailMap`
  inside the binary, a `Validator` terrain check and a `lint_assets` `terrain` check.
- **`apply_edits`: `insert_array_element` / `remove_array_element`** (13 → 15 ops) — changing the
  *set* of elements of a `CCClass[]` property, with `cc.TargetOverrideInfo` index remapping.
- **`find_scene_nodes {region}`** — world-XZ footprint filter (`{x, z, width, depth}` or
  `{center, radius}`); a `cc.Canvas` subtree is excluded and counted in a footer, since a Canvas
  lays out in pixels.
- **`get_node_bounds {perChild}`** — one world AABB per direct child; on a collapsed stub the
  children come from the source prefab, and mounted children are walked through the mount owner.
- **`get_project_info`** self-check of the *resolved* project root (`assets/`/`library/` present,
  assets indexed).
- **`list_assets` output shapes**: `summary` (counts per type and folder, no enumeration) and
  `grouped`, plus the opt-in `uuid` — see Breaking above.
- **Shared modules** replacing divergent copies: `src/core/componentIndices.js`,
  `src/core/valueTypes.js`, `src/utils/assetPaths.js`, `src/utils/fsAtomic.js`,
  `src/tools/terrainCard.js`.

### Changed

- The read pipeline now prints a node's `pos`/`scale`/`euler` wherever they are non-default, at
  every depth under `inspect_node`. A collapsed instance stub reads its placement from the source
  root's overrides instead of printing at its parent's origin. Read output is additive here; the
  read snapshots were regenerated deliberately and their diffs are added lines only.
- `.meta` and asset writes all go through an atomic temp+rename, and every writer under `assets/`
  shares one canonicalized containment check.

### Fixed

- An id-less `cc.Node` shell — an editor leftover reachable only from a dead
  `cc.TargetOverrideInfo` — no longer fails validation, so `apply_edits` stops refusing scenes that
  open and run fine in the editor.
- Cross-file test flake: the `find_asset_references` tests wrote into the shared
  `test/fixtures/mock-project` fixture while other test files copied it concurrently.
- Review fixes across the write, terrain and read layers: `Object.hasOwn` for every
  property/op membership test, override remapping and duplication on array splices, region clipping
  in `set_heights`, falloff on elongated ellipses, ancestor walks that ended at a mounted child's
  null parent, symlink containment for every writer under `assets/`, bounded PNG inflation, a
  `.terrain` whose stored geometry made it unrepairable, and response-size budgets on the terrain
  readouts.

## [1.1.0] - 2026-02-13

- Detailed mode, prefab support, `inspect_node`, trimmed-sprite indicators.

## [1.0.0] - 2025-12-29

- Initial release: scene graph extraction for AI coding assistants.

*No release was tagged between 1.1.0 and 2.0.0. The write layer (`apply_edits`,
`validate_document`), the prefab and animation-graph builders, prefab instances and mounted
components all landed on `main` with the version string left at 1.1.0; per-commit detail for that
period lives in git history.*
