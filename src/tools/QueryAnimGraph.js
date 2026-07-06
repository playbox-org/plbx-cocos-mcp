/**
 * QueryAnimGraph - MCP tool: compact semantic view of a .animgraph asset
 *
 * Renders variables, per-layer states (clips resolved to names) and
 * transitions with human-readable conditions, so an animation graph is no
 * longer an opaque JSON blob. Read-only counterpart of build_animgraph.
 */

import * as fs from 'fs';
import * as path from 'path';
import { BaseTool } from './BaseTool.js';
import { AssetIndex } from '../core/AssetIndex.js';
import { parseAnimGraph, formatAnimGraphText } from '../document/AnimGraphReader.js';

export class QueryAnimGraph extends BaseTool {
    get name() {
        return 'query_animgraph';
    }

    get description() {
        return 'Read a Cocos Creator animation graph (.animgraph) as a compact semantic summary: ' +
               'variables, states per layer (clips resolved to asset names), transitions with ' +
               'conditions ("Speed > 0.1", "trigger Jump", "[exit]") and durations. ' +
               'Args: {graphPath (required; .animgraph path or UUID), format?: "text"|"json"}.';
    }

    get aliases() {
        return { filePath: 'graphPath', asset: 'graphPath', path: 'graphPath' };
    }

    get inputSchema() {
        return {
            type: 'object',
            properties: {
                graphPath: {
                    type: 'string',
                    description: 'Path to the .animgraph relative to project root (e.g. "assets/Art/Animations/Player.animgraph") or its UUID'
                },
                format: {
                    type: 'string',
                    enum: ['text', 'json'],
                    description: 'Output format',
                    default: 'text'
                }
            },
            required: ['graphPath']
        };
    }

    async execute(args, projectRoot) {
        try {
            const assetIndex = AssetIndex.shared(projectRoot);

            // Accept a UUID or any path form AssetIndex knows; fall back to a
            // plain file path for graphs outside the asset index (e.g. tests)
            let filePath;
            let title;
            const resolved = assetIndex.resolve(args.graphPath);
            if (resolved) {
                if (resolved.entry.importer !== 'animation-graph') {
                    return this.error(
                        `"${args.graphPath}" is a ${resolved.entry.importer} asset, not an animation graph`
                    );
                }
                filePath = path.resolve(projectRoot, resolved.entry.path);
                title = resolved.entry.name;
            } else {
                filePath = path.resolve(projectRoot, args.graphPath);
                title = path.basename(filePath);
            }

            if (!fs.existsSync(filePath)) {
                return this.error(
                    `Animation graph not found: ${args.graphPath}. ` +
                    'Use list_assets {type: "animation"} to browse animation assets.'
                );
            }

            const objects = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            const model = parseAnimGraph(objects, assetIndex);

            if (args.format === 'json') {
                return this.success(JSON.stringify({ name: title, ...model }, null, 2));
            }
            return this.success(formatAnimGraphText(title, model));
        } catch (err) {
            return this.error(err.message);
        }
    }
}
