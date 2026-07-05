# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

MCP server that converts heavy Cocos Creator `.scene` files (~700KB JSON) into compact semantic scene graphs (~20KB) for AI coding assistants, and edits scenes/prefabs through semantic operations. Sixteen MCP tools: scene reading (`query_scene_graph`, `query_prefab_graph`, `query_animgraph`, `list_scene_scripts`, `find_scene_nodes`, `inspect_node`), project/asset introspection (`get_project_info`, `get_asset_info`, `list_assets`), writing (`apply_edits`, `validate_document`, `build_prefab`, `build_animgraph`), and measurement/hygiene (`get_node_bounds`, `compute_fit_scale`, `lint_assets`).

Locked decisions (details and verified Cocos 3.x format notes live in [README.md](README.md)): LLMs never text-edit `.scene`/`.prefab` files — only semantic operations; nodes are addressed by path or stable `_id`, never by `__id__`; edit the source prefab, not the instance (instance internals exist only as overrides); wrapper convention — a model/sprite is never the prefab root (`Root` → `Visual` child). A companion Claude Code SKILL `cocos-scene-builder` (policy/recipes on top of these tools) is distributed outside this repo.

## Commands

```bash
npm start                # Run MCP server (stdio transport)
npm test                 # Run all tests (Node.js built-in test runner)
npm run test:watch       # Watch mode
npm run test:coverage    # With coverage (--experimental-test-coverage)
node --test test/core/SceneParser.test.js  # Run a single test file
npm run cli -- <scene-path> [--json] [-o file]  # CLI without MCP
```

## Architecture

ES modules (`"type": "module"`), plain JavaScript, Node >= 18, single dependency (`@modelcontextprotocol/sdk`).

### Data Flow

```
.scene JSON → SceneParser (index) → NodeTreeBuilder (tree) → Formatter (output)
                                       ↑           ↑
                                  TypeFilter    ScriptResolver
                                  NodeFilter    PropertyExtractor
```

**SceneParser** reads the flat JSON array from a `.scene` file and indexes objects into nodes (`cc.Node`/`cc.Scene`) and components maps. **ScriptResolver** scans `assets/**/*.{ts,js}.meta` files and maps compressed component UUIDs to script names by exact compression (`src/utils/uuid.js`). **NodeTreeBuilder** recursively builds a minified tree, using **TypeFilter** to skip noise types (transforms, UI renderers), **NodeFilter** to skip skeleton bones, and **PropertyExtractor** to pull meaningful props from custom script components (and built-in `cc.*` in detailed mode); asset references — including `_materials` arrays — resolve to names via `AssetIndex.label()`: sub-assets as `file@subId`, fbx-baked materials marked `(embedded)`. Formatters (Text/Json/Stats) render the final output.

**SceneMinifier** is the facade/orchestrator that wires all core classes together via constructor injection.

### Asset Layer

**AssetIndex** scans `assets/**/*.meta` and resolves any reference form — project-relative path, full UUID, compressed UUID, or `<uuid>@<subId>` sub-asset — plus filtered listing (type/folder/pattern). **AssetInspector** extracts per-type details: sprite rect/trim/9-slice from meta subMetas, mesh AABB from compiled `library/<xx>/<uuid>@<subId>.json` (fallback: glTF POSITION accessors for `.glb`), prefab summaries, material effect/defines. **ProjectInfoReader** reads engine version (`package.json` → `creator.version`), designResolution/layers/physics (`settings/v2/packages/`). `src/utils/uuid.js` implements the verified Cocos UUID compression algorithm (5 hex chars kept + 3-hex→2-base64 packing); `src/utils/glb.js` reads GLB JSON chunks.

### Write Layer

`src/document/` is the lossless counterpart to the lossy read pipeline. **SceneDocument** loads the flat JSON array, addresses nodes by path (`Canvas/Panel/BuyBtn`, `Name[i]` disambiguation) or scene `_id`, and saves atomically (temp+rename). Canonical form — verified byte-identical with editor output on the golden corpus — is depth-first first-visit numbering over the whole reference graph plus `JSON.stringify(arr, null, 2)` with no trailing newline; `renumber()` restores it and garbage-collects unreachable objects. **operations.js** implements the ten semantic ops (all-or-nothing batches). **ComponentTemplates.js** holds full 3.8.7 field sets taken from real files. **Validator.js** checks referential/bidirectional invariants (errors) and conventions (warnings). **PrefabBuilder.js** compiles a compact spec into a prefab by generating an ops batch over a skeleton document; the wrapper convention (`visual` → child node) is built in. **MiniTree.js** renders compact subtrees for `apply_edits` responses.

### Animation Graph Layer

A `.animgraph` is the same flat JSON array with head `cc.animation.AnimationGraph` — `SceneDocument` serves as its plain array container (load/renumber/serialize/save apply; `root`/`resolveNode` don't), round-trip verified byte-identical on the golden Player.animgraph including the `_variables` object-map. **AnimGraphReader.js** parses the array into a semantic model (variables, per-layer states/transitions, conditions as strings) and renders the compact text summary; enum mappings (BinaryOperator `== != < <= > >=` = 0–5; VariableType float 0 / boolean 1 / trigger 2 / integer 3) are verified against the 3.8.7 engine sources. **AnimGraphBuilder.js** compiles a compact spec (`when: "Speed > 0.1"` strings, `trigger` keys) into editor-shaped objects — Entry/Exit/Any and the event-binding pairs (Motion in/out, AnimationTransition start/end) are always generated, objects are appended in canonical DFS order so `renumber()` is an identity, plus a `.meta` (`importer: "animation-graph"`). Tools: `query_animgraph` (path or UUID) and `build_animgraph`. The `cc.animation.AnimationController` template works with the `PAIRED_FIELDS` rule in operations.js: the graph reference serializes twice (`_graph` + `graph`), and every write via `set_asset_ref`/`set_component_property` mirrors both fields (deep-copied, never aliased). The controller belongs on the skeleton root inside a model — it cannot land on a collapsed instance (unpacking the model in the editor stays manual).

### Instance & Measurement Layer

**instances.js** implements collapsed prefab instances exactly as the editor serializes them: `instantiate_prefab` creates a stub node + `cc.PrefabInfo` (fileId = source prefab root's fileId) + `cc.PrefabInstance`, registers it in the document's instance registry, and accepts `.prefab` assets or model files (gltf-scene prefab read from `library/`); `set_instance_property`/`remove_instance_override` manage `CCPropertyOverrideInfo` objects, resolving `target` paths inside the source prefab into `TargetInfo.localID` fileIds (node PrefabInfo / component CompPrefabInfo). Instance internals are never editable directly — only via overrides; multi-hop targets (inside nested instances) are not implemented yet. Reading them is supported: `inspect_node` on a stub expands the source prefab internals (read-only tree with `target` paths + the override list resolved from fileIds), and the `materials` check of `lint_assets` walks instances the same way to flag embedded-vs-project material mismatches per mesh. **Bounds.js** computes subtree AABBs (mesh AABBs via AssetInspector, UITransform rects, instance stubs through their source prefab with overrides applied) in two frames: `local` (node's own frame — BoxCollider center/size) and `world`; matrix math lives in `src/utils/math3d.js`.

Never edit `.scene`/`.prefab`/`.animgraph` files with text edits — always go through `apply_edits`/`build_prefab`/`build_animgraph`.

### MCP Tools

Each tool extends `BaseTool` (abstract with `name`, `description`, `inputSchema`, `execute`; optional `aliases` maps courtesy argument keys onto canonical ones, e.g. `filePath`→`scenePath`). The server calls `BaseTool.run()`, which normalizes aliases and validates args against `inputSchema` (`src/tools/validateArgs.js`: unknown-key rejection with a did-you-mean hint, required/type/enum checks) before delegating to `execute()` — a bad call gets a self-explanatory error, never an internal crash like `paths[1] ... undefined`. Tools are registered in `src/tools/index.js:createTools()` and receive `projectRoot` from the server. The server (`McpServer`) uses `@modelcontextprotocol/sdk` with stdio transport.

### Key Convention: COCOS_PROJECT_ROOT

The MCP server resolves scene paths relative to `COCOS_PROJECT_ROOT` env var (falls back to `cwd()`). This is the root of the Cocos Creator project being analyzed, not this repo.

## Testing

Tests use Node.js built-in `node:test` and `node:assert`. Test fixtures live in `test/fixtures/` with a sample scene JSON, mock script `.meta` files (`test/fixtures/assets/`), and `mock-project/` — a miniature Cocos project (settings, asset metas copied from a real project, `library/` mesh + compiled gltf-scene prefab cache, generated `.glb`, prefabs for instance/bounds tests, deliberately bad-named assets for lint tests) used by asset/write-layer tests. `test/fixtures/golden/` holds unmodified editor-saved files from the real game (1.2MB scene + 4 prefabs + Player.animgraph): the write layer's round-trip tests must reproduce them byte-for-byte, so never reformat or hand-edit them. Test file structure mirrors `src/` (e.g., `test/core/SceneParser.test.js` tests `src/core/SceneParser.js`).

A real production Cocos Creator 3.8.7 3D project lives in `project-example/zombie-miner` (gitignored) — use it for manual verification of new tools against real data.

## Adding a New MCP Tool

1. Create `src/tools/NewTool.js` extending `BaseTool`
2. Implement `name`, `description`, `inputSchema` getters and `execute(args, projectRoot)`
3. Add to `createTools()` array in `src/tools/index.js`
4. Add test in `test/tools/NewTool.test.js`
