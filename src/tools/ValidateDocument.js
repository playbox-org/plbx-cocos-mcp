/**
 * ValidateDocument - MCP tool: check a .scene/.prefab file's invariants
 *
 * Reference integrity, bidirectional parent/children and component/node
 * links, _id/fileId uniqueness, asset existence, wrapper convention.
 */

import * as fs from 'fs';
import * as path from 'path';
import { BaseTool } from './BaseTool.js';
import { SceneDocument } from '../document/SceneDocument.js';
import { Validator } from '../document/Validator.js';
import { AssetIndex } from '../core/AssetIndex.js';

export class ValidateDocument extends BaseTool {
    get name() {
        return 'validate_document';
    }

    get description() {
        return 'Validate a Cocos Creator .scene or .prefab file: reference integrity, ' +
               'parent/children and component/node bidirectional invariants, _id/fileId uniqueness, ' +
               'referenced asset existence, euler/quaternion sync, prefab wrapper convention. ' +
               'Run after external changes or before/after apply_edits batches. ' +
               'Args: {filePath (required)}.';
    }

    get inputSchema() {
        return {
            type: 'object',
            properties: {
                filePath: {
                    type: 'string',
                    description: 'Path to .scene or .prefab file relative to project root'
                }
            },
            required: ['filePath']
        };
    }

    async execute(args, projectRoot) {
        const filePath = path.resolve(projectRoot, args.filePath);
        if (!fs.existsSync(filePath)) {
            return this.error(`File not found: ${filePath}`);
        }

        let doc;
        try {
            doc = SceneDocument.load(filePath);
        } catch (err) {
            return this.error(`Cannot parse ${args.filePath}: ${err.message}`);
        }

        const assetIndex = new AssetIndex(projectRoot);
        const { errors, warnings } = new Validator(doc, assetIndex, { projectRoot }).validate();

        const lines = [`# Validation: ${args.filePath}`, ''];
        lines.push(`Objects: ${doc.objects.length} | Type: ${doc.isScene ? 'scene' : doc.isPrefab ? 'prefab' : 'unknown'}`);
        lines.push('');
        if (errors.length === 0 && warnings.length === 0) {
            lines.push('✅ Valid. No errors, no warnings.');
        } else {
            lines.push(errors.length === 0 ? '✅ No errors.' : `❌ ${errors.length} error(s):`);
            errors.forEach(e => lines.push(`- ${e}`));
            if (warnings.length) {
                lines.push('', `⚠️ ${warnings.length} warning(s):`);
                warnings.forEach(w => lines.push(`- ${w}`));
            }
        }
        return this.success(lines.join('\n'));
    }
}
