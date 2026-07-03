/**
 * GraphQueryTool - shared base for query_scene_graph / query_prefab_graph
 *
 * Both tools run the same minify pipeline; subclasses only differ in the
 * path parameter name and the human-facing label.
 */

import * as fs from 'fs';
import * as path from 'path';
import { BaseTool } from './BaseTool.js';
import { SceneMinifier } from '../core/SceneMinifier.js';

export class GraphQueryTool extends BaseTool {
    /** Name of the file-path argument ('scenePath' / 'prefabPath') */
    get pathParam() {
        throw new Error('Subclass must implement pathParam getter');
    }

    /** Human label used in headers and errors ('Scene' / 'Prefab') */
    get kindLabel() {
        throw new Error('Subclass must implement kindLabel getter');
    }

    /** Description of the file-path argument */
    get pathDescription() {
        throw new Error('Subclass must implement pathDescription getter');
    }

    get inputSchema() {
        return {
            type: 'object',
            properties: {
                [this.pathParam]: {
                    type: 'string',
                    description: this.pathDescription
                },
                format: {
                    type: 'string',
                    enum: ['text', 'json'],
                    description: "Output format: 'text' for readable hierarchy, 'json' for structured data",
                    default: 'text'
                },
                detailed: {
                    type: 'boolean',
                    description: 'When true, expands reference arrays to show individual names and extracts properties from built-in cc.* components',
                    default: false
                }
            },
            required: [this.pathParam]
        };
    }

    async execute(args, projectRoot) {
        const filePath = path.resolve(projectRoot, args[this.pathParam]);

        if (!fs.existsSync(filePath)) {
            return this.error(`${this.kindLabel} file not found: ${filePath}`);
        }

        try {
            const minifier = new SceneMinifier(filePath, projectRoot, {
                detailed: args.detailed
            });
            const graph = minifier.minify();

            if (!graph) {
                return this.error(`Could not parse ${this.kindLabel.toLowerCase()}`);
            }

            const format = args.format || 'text';
            const output = format === 'json'
                ? minifier.toJson(graph)
                : `# ${this.kindLabel}: ${path.basename(args[this.pathParam])}\n\n${minifier.toText(graph)}`;

            return this.success(output);
        } catch (err) {
            return this.error(err.message);
        }
    }
}
