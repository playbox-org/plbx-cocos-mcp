/**
 * Tool registry sanity tests: every tool the server exposes has a unique
 * name, a valid schema and a description — keeps docs and code in sync.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createTools } from '../../src/tools/index.js';

const EXPECTED_NAMES = [
    'query_scene_graph', 'query_prefab_graph', 'query_animgraph', 'list_scene_scripts',
    'find_scene_nodes', 'inspect_node',
    'get_project_info', 'get_asset_info', 'list_assets',
    'apply_edits', 'validate_document', 'build_prefab', 'build_animgraph',
    'get_node_bounds', 'compute_fit_scale', 'compute_rotation', 'find_asset_references', 'lint_assets'
];

describe('createTools registry', () => {
    const tools = createTools();

    it('exposes exactly the documented tool set', () => {
        const names = tools.map(t => t.name).sort();
        assert.deepStrictEqual(names, [...EXPECTED_NAMES].sort());
    });

    it('has unique names', () => {
        const names = tools.map(t => t.name);
        assert.strictEqual(new Set(names).size, names.length);
    });

    it('every tool has a description, an object schema and execute()', () => {
        for (const tool of tools) {
            assert.ok(tool.description.length > 0, `${tool.name}: empty description`);
            assert.strictEqual(tool.inputSchema.type, 'object', `${tool.name}: schema.type`);
            assert.ok(tool.inputSchema.properties, `${tool.name}: schema.properties`);
            assert.strictEqual(typeof tool.execute, 'function', `${tool.name}: execute`);
        }
    });

    it('required schema fields are declared properties', () => {
        for (const tool of tools) {
            for (const req of tool.inputSchema.required ?? []) {
                assert.ok(
                    tool.inputSchema.properties[req],
                    `${tool.name}: required "${req}" is not a declared property`
                );
            }
        }
    });
});
