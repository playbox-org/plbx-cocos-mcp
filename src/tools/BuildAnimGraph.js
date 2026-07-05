/**
 * BuildAnimGraph - MCP tool: compile a compact spec into a .animgraph asset
 *
 * Counterpart of build_prefab for animation graphs: states/transitions/
 * variables expand into the exact editor-serialized object shapes (Entry/
 * Exit/Any and event bindings included), plus a .meta with a fresh UUID so
 * the graph is immediately referencable from an AnimationController.
 */

import * as fs from 'fs';
import * as path from 'path';
import { BaseTool } from './BaseTool.js';
import { AnimGraphBuilder, AnimGraphBuildError } from '../document/AnimGraphBuilder.js';
import { parseAnimGraph, formatAnimGraphText } from '../document/AnimGraphReader.js';
import { AssetIndex } from '../core/AssetIndex.js';

export class BuildAnimGraph extends BaseTool {
    get name() {
        return 'build_animgraph';
    }

    get description() {
        return 'Create a new Cocos Creator animation graph (.animgraph plus .meta with a fresh UUID) ' +
               'from a compact spec. Entry/Exit/Any states and event bindings are generated automatically. ' +
               'Args: {outputPath (required), spec (required object), overwrite?: boolean}. ' +
               'Spec: {variables?: {Name: {type: "float"|"boolean"|"integer"|"trigger", value?}}, ' +
               'states: [{name, clip: "Models/X.glb[@subId]"|"clip.anim"|uuid, speed?}], ' +
               'transitions: [{from, to, when?: "Speed > 0.1", trigger?: "Jump", duration?, exit?, exitTime?}]}. ' +
               '"Entry"/"Any" are valid from-states; a Motion-source transition with no conditions defaults ' +
               'to exit-time behavior ([exit]). Use get_asset_info on a model to list its animation clips, ' +
               'then reference the graph via add_component AnimationController + set_asset_ref graph.';
    }

    get inputSchema() {
        return {
            type: 'object',
            properties: {
                outputPath: {
                    type: 'string',
                    description: 'Target .animgraph path relative to project root, e.g. "assets/Art/Animations/Zombie.animgraph"'
                },
                spec: {
                    type: 'object',
                    description: 'Animation graph spec (see tool description)'
                },
                overwrite: {
                    type: 'boolean',
                    description: 'Allow replacing an existing .animgraph (its .meta/UUID is preserved)',
                    default: false
                }
            },
            required: ['outputPath', 'spec']
        };
    }

    async execute(args, projectRoot) {
        const outputPath = path.resolve(projectRoot, args.outputPath);
        if (!outputPath.endsWith('.animgraph')) {
            return this.error('outputPath must end with .animgraph');
        }
        if (!outputPath.startsWith(path.resolve(projectRoot, 'assets') + path.sep)) {
            return this.error('outputPath must be inside the project\'s assets/ directory');
        }
        if (fs.existsSync(outputPath) && !args.overwrite) {
            return this.error(`${args.outputPath} already exists — pass overwrite: true to replace it`);
        }

        const assetIndex = new AssetIndex(projectRoot);
        let doc;
        let notes;
        try {
            ({ doc, notes } = new AnimGraphBuilder(assetIndex).compile(args.spec));
        } catch (err) {
            if (err instanceof AnimGraphBuildError) {
                return this.error(`${err.message}\n\nNothing was written.`);
            }
            throw err;
        }

        // Meta: reuse an existing one so overwrites keep the UUID; resolve it
        // BEFORE writing the graph so a corrupt .meta aborts with nothing written
        const metaPath = `${outputPath}.meta`;
        let uuid;
        let newMeta = null;
        if (fs.existsSync(metaPath)) {
            try {
                uuid = JSON.parse(fs.readFileSync(metaPath, 'utf-8')).uuid;
            } catch (err) {
                return this.error(`Cannot parse existing ${args.outputPath}.meta: ${err.message}\n\nNothing was written.`);
            }
        } else {
            newMeta = AnimGraphBuilder.createMeta();
            uuid = newMeta.uuid;
        }

        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        doc.save(outputPath);
        if (newMeta) {
            fs.writeFileSync(metaPath, JSON.stringify(newMeta, null, 2), 'utf-8');
        }

        const model = parseAnimGraph(doc.objects, assetIndex);
        const lines = [
            `# Built ${args.outputPath}`,
            '',
            `UUID: ${uuid}${newMeta ? ' (new .meta written)' : ' (existing .meta kept)'}`,
            `Objects: ${doc.objects.length}`,
            '',
            formatAnimGraphText(path.basename(outputPath), model)
        ];
        if (notes.length) {
            lines.push('', '## Warnings');
            notes.forEach(n => lines.push(`- ${n}`));
        }
        lines.push(
            '',
            'Attach it with: apply_edits {op: "add_component", type: "AnimationController"} on the ' +
            'skeleton root, then {op: "set_asset_ref", property: "graph", asset: "<this path>"}. ' +
            'Open the project in Cocos Creator (or its asset-db refresh) to import the new asset.'
        );
        return this.success(lines.join('\n'));
    }
}
