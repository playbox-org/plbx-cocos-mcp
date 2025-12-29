/**
 * Tool registry - exports all available tools
 */

import { BaseTool } from './BaseTool.js';
import { QuerySceneGraph } from './QuerySceneGraph.js';
import { ListSceneScripts } from './ListSceneScripts.js';
import { FindSceneNodes } from './FindSceneNodes.js';

export { BaseTool, QuerySceneGraph, ListSceneScripts, FindSceneNodes };

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
