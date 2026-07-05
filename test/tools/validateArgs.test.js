import { describe, it } from 'node:test';
import assert from 'node:assert';
import { normalizeArgs } from '../../src/tools/validateArgs.js';
import { QuerySceneGraph } from '../../src/tools/QuerySceneGraph.js';
import { QueryPrefabGraph } from '../../src/tools/QueryPrefabGraph.js';
import { GetNodeBounds } from '../../src/tools/GetNodeBounds.js';
import { ListAssets } from '../../src/tools/ListAssets.js';
import { ApplyEdits } from '../../src/tools/ApplyEdits.js';

const SCHEMA = {
    type: 'object',
    properties: {
        scenePath: { type: 'string', description: 'Path to scene' },
        format: { type: 'string', enum: ['text', 'json'] },
        detailed: { type: 'boolean' }
    },
    required: ['scenePath']
};

describe('normalizeArgs', () => {
    it('passes valid args through unchanged', () => {
        const { args, error } = normalizeArgs(
            { scenePath: 'a.scene', format: 'json' }, SCHEMA
        );
        assert.strictEqual(error, null);
        assert.deepStrictEqual(args, { scenePath: 'a.scene', format: 'json' });
    });

    it('reports a missing required parameter by name', () => {
        const { error } = normalizeArgs({}, SCHEMA);
        assert.match(error, /missing required parameter "scenePath"/);
        assert.match(error, /Valid parameters:/);
        assert.match(error, /scenePath \(string, required\)/);
    });

    it('rejects unknown parameters with a suggestion', () => {
        const { error } = normalizeArgs({ scenPath: 'a.scene' }, SCHEMA);
        assert.match(error, /unknown parameter "scenPath"/);
        assert.match(error, /did you mean "scenePath"\?/);
    });

    it('suggests the path parameter for any path-like key', () => {
        const { error } = normalizeArgs(
            { prefab: 'a.prefab' },
            new QueryPrefabGraph().inputSchema
        );
        assert.match(error, /unknown parameter "prefab"/);
        assert.match(error, /did you mean "prefabPath"\?/);
    });

    it('maps an alias onto its canonical parameter', () => {
        const { args, error } = normalizeArgs(
            { filePath: 'a.scene' }, SCHEMA, { filePath: 'scenePath' }
        );
        assert.strictEqual(error, null);
        assert.deepStrictEqual(args, { scenePath: 'a.scene' });
    });

    it('lets the canonical parameter win over its alias', () => {
        const { args, error } = normalizeArgs(
            { filePath: 'alias.scene', scenePath: 'canon.scene' },
            SCHEMA, { filePath: 'scenePath' }
        );
        assert.strictEqual(error, null);
        assert.strictEqual(args.scenePath, 'canon.scene');
        assert.ok(!('filePath' in args));
    });

    it('checks types', () => {
        const { error } = normalizeArgs({ scenePath: 42 }, SCHEMA);
        assert.match(error, /parameter "scenePath" must be of type string, got number/);
    });

    it('checks enums', () => {
        const { error } = normalizeArgs(
            { scenePath: 'a.scene', format: 'yaml' }, SCHEMA
        );
        assert.match(error, /parameter "format" must be one of "text", "json"/);
    });

    it('checks array minItems and item types', () => {
        const schema = new ApplyEdits().inputSchema;
        const empty = normalizeArgs({ filePath: 'a.scene', ops: [] }, schema);
        assert.match(empty.error, /"ops" needs at least 1 item/);

        const badItem = normalizeArgs({ filePath: 'a.scene', ops: ['nope'] }, schema);
        assert.match(badItem.error, /"ops\[0\]" must be of type object/);
    });

    it('collects multiple problems in one error', () => {
        const { error } = normalizeArgs({ prefab: 'x', format: 'yaml' }, SCHEMA);
        assert.match(error, /unknown parameter "prefab"/);
        assert.match(error, /missing required parameter "scenePath"/);
        assert.match(error, /"format" must be one of/);
    });
});

describe('BaseTool.run', () => {
    it('returns a validation error instead of a paths[1] crash', async () => {
        const result = await new QuerySceneGraph().run({ path: 'x.scene' }, '/tmp');
        assert.ok(result.isError);
        assert.match(result.content[0].text, /unknown parameter "path"/);
        assert.match(result.content[0].text, /did you mean "scenePath"\?/);
        assert.doesNotMatch(result.content[0].text, /paths\[1\]/);
    });

    it('reports the missing path param for a bare call', async () => {
        const result = await new QuerySceneGraph().run({}, '/tmp');
        assert.ok(result.isError);
        assert.match(result.content[0].text, /missing required parameter "scenePath"/);
    });

    it('suggests filePath when get_node_bounds is called with scenePath', async () => {
        const result = await new GetNodeBounds().run(
            { scenePath: 'a.scene', node: '/' }, '/tmp'
        );
        assert.ok(result.isError);
        assert.match(result.content[0].text, /unknown parameter "scenePath"/);
        assert.match(result.content[0].text, /did you mean "filePath"\?/);
    });

    it('rejects the phantom list_assets keys instead of ignoring them', async () => {
        const result = await new ListAssets().run({ importer: 'fbx' }, '/tmp');
        assert.ok(result.isError);
        assert.match(result.content[0].text, /unknown parameter "importer"/);
    });
});
