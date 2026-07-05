/**
 * Integration: references into collapsed instances, end-to-end (M6 B1)
 *
 * Full tool cycle on a disposable mock project: instantiate_prefab →
 * set a $node/$component reference inside the instance → validate →
 * save → reload → the read tools surface the reference.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { ApplyEdits } from '../../src/tools/ApplyEdits.js';
import { ValidateDocument } from '../../src/tools/ValidateDocument.js';
import { InspectNode } from '../../src/tools/InspectNode.js';
import { QuerySceneGraph } from '../../src/tools/QuerySceneGraph.js';
import { SceneDocument } from '../../src/document/SceneDocument.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_PROJECT = path.join(__dirname, '..', 'fixtures', 'mock-project');
const GOLDEN_DIR = path.join(__dirname, '..', 'fixtures', 'golden');

const SCENE = 'assets/Scenes/main.scene';

let projectRoot;

before(async () => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-target-overrides-'));
    fs.cpSync(MOCK_PROJECT, projectRoot, { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'assets', 'Scenes'), { recursive: true });
    fs.copyFileSync(
        path.join(GOLDEN_DIR, 'Main.scene_V2.scene'),
        path.join(projectRoot, SCENE)
    );

    const result = await new ApplyEdits().execute({
        filePath: SCENE,
        ops: [
            { op: 'instantiate_prefab', parent: '/', prefab: 'Prefabs/TableCash.prefab', name: 'Desk' },
            { op: 'add_node', parent: '/', name: 'Holder' },
            {
                op: 'add_component', node: 'Holder', type: 'PlayerController',
                properties: {
                    register: { $node: 'Desk/Table/CashRegister' },
                    tableView: { $component: { node: 'Desk', target: 'Table', type: 'cc.MeshRenderer' } }
                }
            }
        ]
    }, projectRoot);
    assert.ok(!result.isError, result.content[0].text);
});

after(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
});

describe('references into collapsed instances, end-to-end', () => {
    test('saved file holds null values + registry targetOverrides', () => {
        const doc = SceneDocument.load(path.join(projectRoot, SCENE));
        const holder = doc.resolveNode('Holder');
        const script = doc.getObject(doc.componentIndices(holder)[0]);
        assert.strictEqual(script.register, null);
        assert.strictEqual(script.tableView, null);

        const added = doc.objects.filter(o =>
            o.__type__ === 'cc.TargetOverrideInfo' &&
            o.source?.__id__ === doc.componentIndices(holder)[0]);
        assert.strictEqual(added.length, 2);
        assert.ok(added.every(o => o.sourceInfo === null &&
            o.target.__id__ === doc.resolveNode('Desk')));
    });

    test('validate_document reports zero errors', async () => {
        const result = await new ValidateDocument().execute({ filePath: SCENE }, projectRoot);
        const text = result.content[0].text;
        assert.ok(!result.isError, text);
        assert.doesNotMatch(text, /❌/);
    });

    test('inspect_node on the stub lists incoming scene references', async () => {
        const result = await new InspectNode().execute(
            { filePath: SCENE, nodeName: 'Desk' }, projectRoot);
        const text = result.content[0].text;
        assert.ok(!result.isError, text);
        assert.match(text, /## Incoming scene references \(2\)/);
        assert.match(text, /Holder ▸ PlayerController \.register → "Table\/CashRegister"/);
        assert.match(text, /Holder ▸ PlayerController \.tableView → "Table" ▸ cc\.MeshRenderer/);
    });

    test('inspect_node JSON exposes incomingRefs additively', async () => {
        const result = await new InspectNode().execute(
            { filePath: SCENE, nodeName: 'Desk', format: 'json' }, projectRoot);
        const parsed = JSON.parse(result.content[0].text);
        assert.strictEqual(parsed.incomingRefs.length, 2);
        assert.ok(Array.isArray(parsed.overrides), 'existing fields stay');
        const byProp = Object.fromEntries(parsed.incomingRefs.map(r => [r.property, r]));
        assert.strictEqual(byProp.register.target, 'Table/CashRegister');
        assert.strictEqual(byProp.tableView.component, 'cc.MeshRenderer');
    });

    test('query_scene_graph annotates the source component properties', async () => {
        const result = await new QuerySceneGraph().execute(
            { scenePath: SCENE, detailed: true }, projectRoot);
        const text = result.content[0].text;
        assert.match(text, /register__targetOverride=→Desk/);
    });

    test('inspect_node on the source node shows the sibling annotation', async () => {
        const result = await new InspectNode().execute(
            { filePath: SCENE, nodeName: 'Holder' }, projectRoot);
        const text = result.content[0].text;
        assert.match(text, /register__targetOverride=→Desk/);
        assert.match(text, /tableView__targetOverride=→Desk/);
    });
});

describe('in-instance sources and removedComponents, end-to-end (A2/B2)', () => {
    before(async () => {
        const result = await new ApplyEdits().execute({
            filePath: SCENE,
            ops: [
                {
                    op: 'set_instance_property', node: 'Desk', target: 'Table/CashRegister/Monitor',
                    component: 'cc.MeshRenderer', property: 'buddy', value: { $node: 'Desk/Table' }
                },
                {
                    op: 'remove_component', node: 'Desk', target: 'Table/CashRegister',
                    component: 'cc.MeshRenderer'
                }
            ]
        }, projectRoot);
        assert.ok(!result.isError, result.content[0].text);
    });

    test('saved file holds the sourceInfo override and the removedComponents entry', () => {
        const doc = SceneDocument.load(path.join(projectRoot, SCENE));
        const stubIdx = doc.resolveNode('Desk');

        const toi = doc.objects.find(o =>
            o.__type__ === 'cc.TargetOverrideInfo' && o.propertyPath?.[0] === 'buddy');
        assert.ok(toi, 'TargetOverrideInfo for "buddy" exists');
        assert.strictEqual(toi.source.__id__, stubIdx);
        assert.ok(toi.sourceInfo, 'sourceInfo is set (source lives inside the instance)');
        assert.strictEqual(toi.target.__id__, stubIdx);

        const instance = doc.instanceOf(stubIdx);
        assert.strictEqual(instance.removedComponents.length, 1);
        const entry = doc.getObject(instance.removedComponents[0].__id__);
        assert.strictEqual(entry.__type__, 'cc.TargetInfo');
    });

    test('validate_document still reports zero errors', async () => {
        const result = await new ValidateDocument().execute({ filePath: SCENE }, projectRoot);
        const text = result.content[0].text;
        assert.ok(!result.isError, text);
        assert.doesNotMatch(text, /❌/);
    });

    test('inspect_node shows the removed component and the in-instance source', async () => {
        const result = await new InspectNode().execute(
            { filePath: SCENE, nodeName: 'Desk' }, projectRoot);
        const text = result.content[0].text;
        assert.ok(!result.isError, text);
        assert.match(text, /## Removed components \(1\)/);
        assert.match(text, /"Table\/CashRegister" ▸ cc\.MeshRenderer \(removed on this instance/);
        assert.match(text,
            /Desk "Table\/CashRegister\/Monitor" ▸ cc\.MeshRenderer \(inside instance\) \.buddy → "Table"/);
    });

    test('inspect_node JSON exposes removedComponents additively', async () => {
        const result = await new InspectNode().execute(
            { filePath: SCENE, nodeName: 'Desk', format: 'json' }, projectRoot);
        const parsed = JSON.parse(result.content[0].text);
        assert.strictEqual(parsed.removedComponents.length, 1);
        assert.strictEqual(parsed.removedComponents[0].target, 'Table/CashRegister');
        assert.strictEqual(parsed.removedComponents[0].component, 'cc.MeshRenderer');
        assert.ok(Array.isArray(parsed.overrides), 'existing fields stay');
        assert.ok(Array.isArray(parsed.incomingRefs), 'existing fields stay');
    });

    test('restore_instance_component brings the component back', async () => {
        const result = await new ApplyEdits().execute({
            filePath: SCENE,
            ops: [{
                op: 'restore_instance_component', node: 'Desk', target: 'Table/CashRegister',
                component: 'cc.MeshRenderer'
            }]
        }, projectRoot);
        assert.ok(!result.isError, result.content[0].text);

        const doc = SceneDocument.load(path.join(projectRoot, SCENE));
        const instance = doc.instanceOf(doc.resolveNode('Desk'));
        assert.deepStrictEqual(instance.removedComponents, []);
    });
});
