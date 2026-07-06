/**
 * QueryPrefabGraph - MCP tool for prefab graph extraction
 */

import { GraphQueryTool } from './GraphQueryTool.js';

export class QueryPrefabGraph extends GraphQueryTool {
    get name() {
        return 'query_prefab_graph';
    }

    get description() {
        return 'Get a minified, LLM-friendly node graph from a Cocos Creator prefab file. ' +
               'Same compression as query_scene_graph but for .prefab files. ' +
               'Args: {prefabPath (required), format?: "text"|"json", detailed?: boolean}.';
    }

    get pathParam() {
        return 'prefabPath';
    }

    get kindLabel() {
        return 'Prefab';
    }

    get pathDescription() {
        return "Path to prefab file relative to project root (e.g., 'assets/Prefabs/Player.prefab')";
    }
}
