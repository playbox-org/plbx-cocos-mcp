/**
 * Public library entry point (package "main").
 *
 * The MCP server executable lives in src/index.js; importing this module
 * has no side effects.
 */

// Read pipeline
export { SceneMinifier } from './core/SceneMinifier.js';
export { SceneParser } from './core/SceneParser.js';
export { ScriptResolver } from './core/ScriptResolver.js';
export { NodeTreeBuilder } from './core/NodeTreeBuilder.js';
export { PropertyExtractor } from './core/PropertyExtractor.js';
export { TypeFilter } from './filters/TypeFilter.js';
export { NodeFilter } from './filters/NodeFilter.js';
export { Formatter } from './formatters/Formatter.js';
export { TextFormatter } from './formatters/TextFormatter.js';
export { JsonFormatter } from './formatters/JsonFormatter.js';
export { StatsFormatter } from './formatters/StatsFormatter.js';

// Asset / project introspection
export { AssetIndex } from './core/AssetIndex.js';
export { AssetInspector } from './core/AssetInspector.js';
export { ProjectInfoReader } from './core/ProjectInfoReader.js';

// Lossless write layer
export { SceneDocument } from './document/SceneDocument.js';
export { Validator } from './document/Validator.js';
export { PrefabBuilder } from './document/PrefabBuilder.js';

// MCP server building blocks
export { McpServer } from './server/McpServer.js';
export { BaseTool } from './tools/BaseTool.js';
export { createTools } from './tools/index.js';
