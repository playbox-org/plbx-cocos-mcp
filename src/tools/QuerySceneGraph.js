/**
 * QuerySceneGraph - MCP tool for scene graph extraction
 */

import { GraphQueryTool } from './GraphQueryTool.js';

export class QuerySceneGraph extends GraphQueryTool {
    get name() {
        return 'query_scene_graph';
    }

    get description() {
        return 'Get a minified, LLM-friendly scene graph from a Cocos Creator scene file. ' +
               'Converts ~700KB scene files to ~20KB semantic representations. ' +
               'Args: {scenePath (required), format?: "text"|"json", detailed?: boolean}.';
    }

    get pathParam() {
        return 'scenePath';
    }

    get kindLabel() {
        return 'Scene';
    }

    get pathDescription() {
        return "Path to scene file relative to project root (e.g., 'assets/Scenes/game.scene')";
    }
}
