# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

MCP server that converts heavy Cocos Creator `.scene` files (~700KB JSON) into compact semantic scene graphs (~20KB) for AI coding assistants. Provides three MCP tools: `query_scene_graph`, `list_scene_scripts`, `find_scene_nodes`.

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

**SceneParser** reads the flat JSON array from a `.scene` file and indexes objects into nodes (`cc.Node`/`cc.Scene`) and components maps. **ScriptResolver** scans `assets/Scripts/**/*.ts.meta` files to map Cocos compressed UUIDs to human-readable script names (prefix-based 5-char matching). **NodeTreeBuilder** recursively builds a minified tree, using **TypeFilter** to skip noise types (transforms, UI renderers), **NodeFilter** to skip skeleton bones, and **PropertyExtractor** to pull meaningful props from custom script components. Formatters (Text/Json/Stats) render the final output.

**SceneMinifier** is the facade/orchestrator that wires all core classes together via constructor injection.

### MCP Tools

Each tool extends `BaseTool` (abstract with `name`, `description`, `inputSchema`, `execute`). Tools are registered in `src/tools/index.js:createTools()` and receive `projectRoot` from the server. The server (`McpServer`) uses `@modelcontextprotocol/sdk` with stdio transport.

### Key Convention: COCOS_PROJECT_ROOT

The MCP server resolves scene paths relative to `COCOS_PROJECT_ROOT` env var (falls back to `cwd()`). This is the root of the Cocos Creator project being analyzed, not this repo.

## Testing

Tests use Node.js built-in `node:test` and `node:assert`. Test fixtures live in `test/fixtures/` with a sample scene JSON and mock `.ts.meta` files. Test file structure mirrors `src/` (e.g., `test/core/SceneParser.test.js` tests `src/core/SceneParser.js`).

## Adding a New MCP Tool

1. Create `src/tools/NewTool.js` extending `BaseTool`
2. Implement `name`, `description`, `inputSchema` getters and `execute(args, projectRoot)`
3. Add to `createTools()` array in `src/tools/index.js`
4. Add test in `test/tools/NewTool.test.js`
