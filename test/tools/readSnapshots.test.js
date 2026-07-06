/**
 * Read-output snapshots — backward-compatibility lock for read tools
 *
 * Captures the exact text/JSON output of query_scene_graph, query_prefab_graph
 * and inspect_node over the golden corpus (with the mock project as root).
 * Write-layer work must keep these outputs additive-only: a failing diff here
 * means a read-format regression for main-branch MCP clients.
 *
 * Regenerate deliberately with: UPDATE_SNAPSHOTS=1 npm test
 * (review the diff — only added lines/fields are acceptable).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { QuerySceneGraph } from '../../src/tools/QuerySceneGraph.js';
import { QueryPrefabGraph } from '../../src/tools/QueryPrefabGraph.js';
import { InspectNode } from '../../src/tools/InspectNode.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = (f) => path.join(__dirname, '..', 'fixtures', 'golden', f);
const MOCK_PROJECT = path.join(__dirname, '..', 'fixtures', 'mock-project');
const SNAPSHOT_DIR = path.join(__dirname, '..', 'fixtures', 'snapshots');
const UPDATE = process.env.UPDATE_SNAPSHOTS === '1';

const SCENE = GOLDEN('Main.scene_V2.scene');
const PREFAB = GOLDEN('ZombieBuyer.prefab');

// Golden-scene object ids (stable: golden files are never edited):
// 1851 = [SERVICES] node (holds GameEntryPoint, source of 19 targetOverrides)
// 2069 = collapsed instance stub targeted by buyButtonZone-style overrides
const SERVICES_NODE_ID = 1851;
const STUB_NODE_ID = 2069;

/** name → async producer of the output text */
const SNAPSHOTS = {
    'scene.text.txt': () =>
        run(new QuerySceneGraph(), { scenePath: SCENE }),
    'scene.detailed.txt': () =>
        run(new QuerySceneGraph(), { scenePath: SCENE, detailed: true }),
    'scene.json.json': () =>
        run(new QuerySceneGraph(), { scenePath: SCENE, format: 'json' }),
    'prefab.text.txt': () =>
        run(new QueryPrefabGraph(), { prefabPath: PREFAB }),
    'prefab.detailed.json': () =>
        run(new QueryPrefabGraph(), { prefabPath: PREFAB, detailed: true, format: 'json' }),
    'inspect.services.txt': () =>
        run(new InspectNode(), { filePath: SCENE, nodeId: SERVICES_NODE_ID }),
    'inspect.services.json': () =>
        run(new InspectNode(), { filePath: SCENE, nodeId: SERVICES_NODE_ID, format: 'json' }),
    'inspect.stub.txt': () =>
        run(new InspectNode(), { filePath: SCENE, nodeId: STUB_NODE_ID })
};

async function run(tool, args) {
    const result = await tool.execute(args, MOCK_PROJECT);
    return result.content[0].text;
}

describe('read-tool output snapshots (main-branch compatibility)', () => {
    for (const [name, produce] of Object.entries(SNAPSHOTS)) {
        test(name, async () => {
            const actual = await produce();
            const file = path.join(SNAPSHOT_DIR, name);
            if (UPDATE || !fs.existsSync(file)) {
                fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
                fs.writeFileSync(file, actual, 'utf-8');
                return;
            }
            const expected = fs.readFileSync(file, 'utf-8');
            assert.strictEqual(actual, expected,
                `Snapshot "${name}" changed. If the change is intentional and additive-only, ` +
                'regenerate with UPDATE_SNAPSHOTS=1 and review the diff.');
        });
    }
});
