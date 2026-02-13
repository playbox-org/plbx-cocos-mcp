/**
 * Tool registry - exports all available tools
 */

import { BaseTool } from './BaseTool.js';
import { QuerySceneGraph } from './QuerySceneGraph.js';
import { ListSceneScripts } from './ListSceneScripts.js';
import { FindSceneNodes } from './FindSceneNodes.js';
import { QueryPrefabGraph } from './QueryPrefabGraph.js';
import { InspectNode } from './InspectNode.js';

export { BaseTool, QuerySceneGraph, ListSceneScripts, FindSceneNodes, QueryPrefabGraph, InspectNode };

/**
 * Create all tool instances
 * @returns {BaseTool[]}
 */
export function createTools() {
    return [
        new QuerySceneGraph(),
        new ListSceneScripts(),
        new FindSceneNodes(),
        new QueryPrefabGraph(),
        new InspectNode()
    ];
}
