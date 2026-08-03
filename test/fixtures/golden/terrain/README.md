# Golden terrain fixtures

Unmodified, editor-produced files. They are the byte-exactness bar for the `.terrain` binary layer
(`src/utils/terrainBin.js`): read → write must reproduce them **byte-for-byte**, padding included.

**Never hand-edit, reformat, re-save or "clean up" anything in this directory.** No trailing-newline
fixes, no re-indent, no re-export through the editor. If a file here ever needs to change, replace it
with a fresh capture from a real editor save and say so in the commit message. Same rule as the rest
of `test/fixtures/golden/`.

| File | Provenance |
|---|---|
| `terrain.terrain` | `project-example/guligames-legendale-c7/assets/Art/terrain.terrain` — copied verbatim (`cmp`-verified). Cocos Creator 3.8.8 editor save; format V8 (`0x01010008`), 131 072 bytes, 67 922 bytes of payload + zero padding, `blockCount [1,1]`, `weightMapSize`/`lightMapSize` 128, 1089 heights, 0 normals, 65 536 weight bytes, 2 palette layers. |
| `terrain.terrain.meta` | Sibling meta of the above. `importer: "terrain"`, `ver: "1.1.50"`, `files: [".bin", ".json"]`, empty `userData` — uuid `665a0471-f644-43e9-95c8-3415f2590ef5`. |
| `terrain.library.json` | The importer artifact `library/66/665a0471-…json` of that same asset. Reference for the importer's output shape only (`cc.TerrainAsset` + `cc.TerrainLayerInfo` mirror of the binary layer table). Renamed from the uuid filename; contents verbatim. |
| `default.terrain` | The empty-terrain sentinel shipped with the editor (`…/CocosCreator.app/…/editor/assets/default_file_content/terrain/default.terrain`), copied verbatim. 2048 bytes: the `0x01010111` DEFAULT version word followed by 2044 zero bytes. What "Create → Terrain" drops into a project before the first sculpt. |

Deliberately **not** copied:

- `library/66/665a0471-….bin` — the importer copies the source verbatim, so it is a byte-identical
  duplicate of `terrain.terrain` (`cmp`-verified). Nothing to learn from a second copy of 131 KB.
- The layer textures (`TropMayaGround.png`, `TropMayaSand.png`) — only their uuids appear in the
  binary, and the tests never need the pixels.

A byte-level map of every section of `terrain.terrain` (offsets, lengths, decoded values, height
min/max in metres, weight statistics) lives in the terrain notes referenced from `TERRAIN_PLAN.md`.
