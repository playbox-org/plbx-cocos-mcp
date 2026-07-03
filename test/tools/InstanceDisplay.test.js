/**
 * Read-pipeline display of collapsed prefab instances
 *
 * Instance stubs keep _name empty in the file (the editor stores the visible
 * name as a _name propertyOverride on the source root). The read tools must
 * show the actual name plus the source asset: `Reward [P→Gold.prefab]`.
 *
 * Runs against a disposable copy of the mock project so writes never touch
 * fixtures.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { ApplyEdits } from '../../src/tools/ApplyEdits.js';
import { QueryPrefabGraph } from '../../src/tools/QueryPrefabGraph.js';
import { FindSceneNodes } from '../../src/tools/FindSceneNodes.js';
import { InspectNode } from '../../src/tools/InspectNode.js';
import { SceneParser } from '../../src/core/SceneParser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_PROJECT = path.join(__dirname, '..', 'fixtures', 'mock-project');
const GOLDEN_DIR = path.join(__dirname, '..', 'fixtures', 'golden');

const PREFAB = 'assets/Prefabs/TableCash.prefab';

let projectRoot;
let prefabAbs;

before(async () => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-instance-display-'));
    fs.cpSync(MOCK_PROJECT, projectRoot, { recursive: true });
    fs.copyFileSync(
        path.join(GOLDEN_DIR, 'TableCash.prefab'),
        path.join(projectRoot, PREFAB)
    );
    prefabAbs = path.join(projectRoot, PREFAB);

    const result = await new ApplyEdits().execute({
        filePath: PREFAB,
        ops: [
            { op: 'instantiate_prefab', parent: 'Table', prefab: 'Prefabs/Gold.prefab', name: 'Reward' },
            // deep chain: stubs must survive the empty-node trim at depth > 3
            { op: 'add_node', parent: 'Table', name: 'L1' },
            { op: 'add_node', parent: 'Table/L1', name: 'L2' },
            { op: 'add_node', parent: 'Table/L1/L2', name: 'L3' },
            { op: 'add_node', parent: 'Table/L1/L2/L3', name: 'L4' },
            { op: 'instantiate_prefab', parent: 'Table/L1/L2/L3/L4', prefab: 'Prefabs/Gold.prefab', name: 'DeepReward' }
        ]
    }, projectRoot);
    assert.ok(!result.isError, result.content[0].text);
});

after(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
});

const text = (result) => result.content[0].text;

describe('collapsed instance display in read pipeline', () => {
    test('SceneParser.getInstanceInfo resolves _name override and asset uuid', () => {
        const parser = new SceneParser(prefabAbs);
        const stubs = [...parser.nodes.values()]
            .map(n => ({ node: n, info: parser.getInstanceInfo(n) }))
            .filter(x => x.info);

        assert.strictEqual(stubs.length, 2);
        const names = stubs.map(s => s.info.nameOverride).sort();
        assert.deepStrictEqual(names, ['DeepReward', 'Reward']);
        for (const s of stubs) {
            assert.ok(s.info.assetUuid, 'stub must expose the source asset uuid');
            assert.strictEqual(parser.getInstanceInfo({ _name: 'plain' }), null);
        }
    });

    test('query_prefab_graph shows instance name and source prefab', async () => {
        const result = await new QueryPrefabGraph().execute({ prefabPath: PREFAB }, projectRoot);

        assert.ok(!result.isError, text(result));
        assert.match(text(result), /● Reward \[P→Gold\.prefab\]/);
        assert.ok(!text(result).includes('unnamed'), 'no stub may render as unnamed');
    });

    test('deeply nested stub is not trimmed as an empty node', async () => {
        const result = await new QueryPrefabGraph().execute({ prefabPath: PREFAB }, projectRoot);

        assert.match(text(result), /● DeepReward \[P→Gold\.prefab\]/);
    });

    test('json format carries prefab + prefabSource', async () => {
        const result = await new QueryPrefabGraph().execute(
            { prefabPath: PREFAB, format: 'json' }, projectRoot);

        const graph = JSON.parse(text(result));
        const table = graph.children.find(c => c.name === 'Table');
        const reward = table.children.find(c => c.name === 'Reward');
        assert.strictEqual(reward.prefab, true);
        assert.strictEqual(reward.prefabSource, 'Gold.prefab');
    });

    test('instance name falls back to source asset name without a _name override', async () => {
        // Editor files may carry unrenamed instances with no _name override
        const arr = JSON.parse(fs.readFileSync(prefabAbs, 'utf-8'));
        const stripped = arr.map(obj => {
            if (obj?.__type__ !== 'cc.PrefabInstance') return obj;
            const overrides = obj.propertyOverrides.filter(ref => {
                const ov = arr[ref.__id__];
                return !(ov?.propertyPath?.length === 1 && ov.propertyPath[0] === '_name'
                    && arr[ref.__id__].value === 'Reward');
            });
            return { ...obj, propertyOverrides: overrides };
        });
        const noOverridePath = path.join(projectRoot, 'assets/Prefabs/TableCashNoName.prefab');
        fs.writeFileSync(noOverridePath, JSON.stringify(stripped, null, 2));
        fs.copyFileSync(`${prefabAbs}.meta`, `${noOverridePath}.meta`);

        const result = await new QueryPrefabGraph().execute(
            { prefabPath: 'assets/Prefabs/TableCashNoName.prefab' }, projectRoot);

        assert.ok(!result.isError, text(result));
        assert.match(text(result), /● Gold \[P→Gold\.prefab\]/);
    });

    test('find_scene_nodes matches the instance display name', async () => {
        const result = await new FindSceneNodes().execute(
            { scenePath: PREFAB, pattern: '^Reward$' }, projectRoot);

        assert.ok(!result.isError, text(result));
        assert.match(text(result), /Found: 1/);
        assert.match(text(result), /● Reward/);
    });

    test('inspect_node resolves an instance stub by display name', async () => {
        const result = await new InspectNode().execute(
            { filePath: PREFAB, nodeName: 'Reward' }, projectRoot);

        assert.ok(!result.isError, text(result));
        assert.match(text(result), /● Reward \[P→Gold\.prefab\]/);
    });
});
