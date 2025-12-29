/**
 * Tool registry - exports all available tools
 */

export { BaseTool } from './BaseTool.js';
export { QuerySceneGraph } from './QuerySceneGraph.js';
export { ListSceneScripts } from './ListSceneScripts.js';
export { FindSceneNodes } from './FindSceneNodes.js';

/**
 * Create all tool instances
 * @returns {BaseTool[]}
 */
export function createTools() {
    return [
        new QuerySceneGraph(),
        new ListSceneScripts(),
        new FindSceneNodes()
    ];
}
