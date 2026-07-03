/**
 * Tool registry - exports all available tools
 */

import { BaseTool } from './BaseTool.js';
import { QuerySceneGraph } from './QuerySceneGraph.js';
import { ListSceneScripts } from './ListSceneScripts.js';
import { FindSceneNodes } from './FindSceneNodes.js';
import { QueryPrefabGraph } from './QueryPrefabGraph.js';
import { InspectNode } from './InspectNode.js';
import { GetProjectInfo } from './GetProjectInfo.js';
import { GetAssetInfo } from './GetAssetInfo.js';
import { ListAssets } from './ListAssets.js';
import { ApplyEdits } from './ApplyEdits.js';
import { ValidateDocument } from './ValidateDocument.js';
import { BuildPrefab } from './BuildPrefab.js';
import { GetNodeBounds } from './GetNodeBounds.js';
import { ComputeFitScale } from './ComputeFitScale.js';
import { LintAssets } from './LintAssets.js';

export {
    BaseTool, QuerySceneGraph, ListSceneScripts, FindSceneNodes, QueryPrefabGraph,
    InspectNode, GetProjectInfo, GetAssetInfo, ListAssets,
    ApplyEdits, ValidateDocument, BuildPrefab,
    GetNodeBounds, ComputeFitScale, LintAssets
};

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
        new InspectNode(),
        new GetProjectInfo(),
        new GetAssetInfo(),
        new ListAssets(),
        new ApplyEdits(),
        new ValidateDocument(),
        new BuildPrefab(),
        new GetNodeBounds(),
        new ComputeFitScale(),
        new LintAssets()
    ];
}
