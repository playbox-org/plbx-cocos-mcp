import { describe, it } from 'node:test';
import assert from 'node:assert';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { InspectNode } from '../../src/tools/InspectNode.js';
import { SceneDocument } from '../../src/document/SceneDocument.js';
import { mountedComponentEntries } from '../../src/document/instances.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, '../fixtures');
const GOLDEN = join(FIXTURES, 'golden', 'Main.scene_V2.scene');
const MOCK_PROJECT = join(FIXTURES, 'mock-project');

describe('InspectNode', () => {
    const tool = new InspectNode();

    describe('metadata', () => {
        it('should have correct name', () => {
            assert.strictEqual(tool.name, 'inspect_node');
        });

        it('should have valid input schema', () => {
            const schema = tool.inputSchema;

            assert.ok('filePath' in schema.properties);
            assert.ok('nodeId' in schema.properties);
            assert.ok('nodeName' in schema.properties);
            assert.ok(schema.required.includes('filePath'));
        });
    });

    describe('execute with nodeId', () => {
        it('should return subtree for valid nodeId (scene)', async () => {
            // Node id 4 = Player in sample-scene.json
            const result = await tool.execute(
                { filePath: 'sample-scene.json', nodeId: 4 },
                FIXTURES
            );

            assert.ok(!result.isError, 'should not be error');
            const text = result.content[0].text;
            assert.ok(text.includes('Player'), 'should include node name');
        });

        it('should return subtree for valid nodeId (prefab)', async () => {
            // Node id 1 = root node in Car.prefab
            const result = await tool.execute(
                { filePath: 'real-prefabs/Car.prefab', nodeId: 1 },
                FIXTURES
            );

            assert.ok(!result.isError, 'should not be error');
            const text = result.content[0].text;
            assert.ok(text.includes('Car'), 'should include prefab root name');
        });

        it('should return JSON format', async () => {
            const result = await tool.execute(
                { filePath: 'sample-scene.json', nodeId: 4, format: 'json' },
                FIXTURES
            );

            const text = result.content[0].text;
            const parsed = JSON.parse(text);
            assert.strictEqual(parsed.name, 'Player');
        });

        it('should return error for invalid nodeId', async () => {
            const result = await tool.execute(
                { filePath: 'sample-scene.json', nodeId: 9999 },
                FIXTURES
            );

            assert.ok(result.isError, 'should be error');
        });
    });

    describe('execute with nodeName', () => {
        it('should return subtree for unique name', async () => {
            const result = await tool.execute(
                { filePath: 'sample-scene.json', nodeName: 'Player' },
                FIXTURES
            );

            assert.ok(!result.isError, 'should not be error');
            const text = result.content[0].text;
            assert.ok(text.includes('Player'), 'should include node name');
        });

        it('should print the root-anchored path in the header', async () => {
            const result = await tool.execute(
                { filePath: 'sample-scene.json', nodeName: 'Player' },
                FIXTURES
            );

            assert.ok(!result.isError, 'should not be error');
            assert.match(result.content[0].text,
                /Path: "Level\/Player" — use as `node`/,
                'header carries the address reusable in other tools');
        });

        it('should include the path field in json format', async () => {
            const result = await tool.execute(
                { filePath: 'sample-scene.json', nodeName: 'Player', format: 'json' },
                FIXTURES
            );

            assert.ok(!result.isError, 'should not be error');
            const parsed = JSON.parse(result.content[0].text);
            assert.strictEqual(parsed.path, 'Level/Player');
            assert.strictEqual(parsed.name, 'Player');
        });

        it('should return disambiguation list for duplicate names', async () => {
            // roadside-c4 has 9 nodes named "root"
            const result = await tool.execute(
                { filePath: 'real-scenes/roadside-c4-main.scene', nodeName: 'root' },
                FIXTURES
            );

            assert.ok(!result.isError, 'should not be error');
            const text = result.content[0].text;
            assert.ok(text.includes('Multiple nodes'), 'should indicate multiple matches');
            assert.ok(text.includes('nodeId'), 'should suggest using nodeId');
        });

        it('should return error for non-existent name', async () => {
            const result = await tool.execute(
                { filePath: 'sample-scene.json', nodeName: 'NonExistentNode' },
                FIXTURES
            );

            assert.ok(result.isError, 'should be error');
        });
    });

    describe('execute with nodeName as a path', () => {
        it('should resolve a parent-path prefix (apply_edits style)', async () => {
            const result = await tool.execute(
                { filePath: 'sample-scene.json', nodeName: 'Level/Player' },
                FIXTURES
            );

            assert.ok(!result.isError, 'should not be error');
            assert.ok(result.content[0].text.includes('Player'));
        });

        it('should resolve a full path including the scene root name', async () => {
            const result = await tool.execute(
                { filePath: 'sample-scene.json', nodeName: 'TestScene/Level/Enemy/EnemyChild' },
                FIXTURES
            );

            assert.ok(!result.isError, 'should not be error');
            assert.ok(result.content[0].text.includes('EnemyChild'));
        });

        it('should list same-named candidates when the path is wrong', async () => {
            const result = await tool.execute(
                { filePath: 'sample-scene.json', nodeName: 'WrongParent/Player' },
                FIXTURES
            );

            assert.ok(result.isError, 'should be error');
            const text = result.content[0].text;
            assert.ok(text.includes('No node at path'), 'should mention the path');
            assert.ok(text.includes('Player#4'), 'should list existing candidates');
        });

        it('should accept node as an alias for nodeName via run()', async () => {
            const result = await tool.run(
                { filePath: 'sample-scene.json', node: 'Level/Player' },
                FIXTURES
            );

            assert.ok(!result.isError, 'should not be error');
            assert.ok(result.content[0].text.includes('Player'));
        });
    });

    describe('validation', () => {
        it('should error when neither nodeId nor nodeName provided', async () => {
            const result = await tool.execute(
                { filePath: 'sample-scene.json' },
                FIXTURES
            );

            assert.ok(result.isError, 'should be error');
        });

        it('should error for invalid file path', async () => {
            const result = await tool.execute(
                { filePath: 'nonexistent.scene', nodeId: 1 },
                FIXTURES
            );

            assert.ok(result.isError, 'should be error');
        });
    });

    // Blocker 2: a mounted component's refResolver classified components by the
    // `isRef(obj.node)` shape check, and PropertyExtractor consults it BEFORE
    // #isDataStruct. A user data struct with a `@property node: cc.Node` field
    // was therefore collapsed to a "→<path> ▸ Type" label instead of expanding
    // — in the very tool the array-element feature relies on. The resolver now
    // gates on _components MEMBERSHIP, so such a struct expands again.
    describe('mounted component data-struct expansion (review — blocker 2)', () => {
        it('expands a struct with a `node` field instead of collapsing it to a label', async () => {
            const doc = new SceneDocument(JSON.parse(fs.readFileSync(GOLDEN, 'utf-8')));
            const inst = doc.objects
                .filter(o => o.__type__ === 'cc.PrefabInstance')
                .find(i => mountedComponentEntries(doc, i).length > 0);
            assert.ok(inst, 'golden scene has a mounted-component instance');

            const comp = doc.getObject(mountedComponentEntries(doc, inst)[0].componentIndices[0]);
            const stubNodeIdx = comp.node.__id__;

            // A user data CCClass that declares `node: cc.Node` — the false-
            // positive shape. Reference it from the mounted component.
            const structIdx = doc.objects.length;
            doc.objects.push({
                __type__: 'CardEntry', node: { __id__: stubNodeIdx },
                cardId: 'ace', power: 9
            });
            comp.myEntry = { __id__: structIdx };

            const tmp = join(os.tmpdir(), `inspect-b2-${process.pid}.scene`);
            fs.writeFileSync(tmp, doc.serialize());
            try {
                const result = await tool.execute(
                    { filePath: tmp, nodeId: stubNodeIdx }, MOCK_PROJECT);
                assert.ok(!result.isError, result.content[0].text);
                const text = result.content[0].text;
                // Expanded struct: fields present (would be absent if collapsed
                // to a bare "→<path> ▸ CardEntry" label).
                assert.match(text, /"__struct__":"CardEntry"/);
                assert.match(text, /"cardId":"ace"/);
                assert.match(text, /"power":9/);
            } finally {
                fs.rmSync(tmp, { force: true });
            }
        });
    });
});
