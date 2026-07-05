/**
 * ApplyEdits / ValidateDocument / BuildPrefab tool tests
 *
 * Runs against a disposable copy of the mock project with a golden prefab
 * inside, so writes never touch fixtures.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { ApplyEdits } from '../../src/tools/ApplyEdits.js';
import { ValidateDocument } from '../../src/tools/ValidateDocument.js';
import { BuildPrefab } from '../../src/tools/BuildPrefab.js';
import { SceneDocument } from '../../src/document/SceneDocument.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_PROJECT = path.join(__dirname, '..', 'fixtures', 'mock-project');
const GOLDEN_DIR = path.join(__dirname, '..', 'fixtures', 'golden');

let projectRoot;

before(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-tools-'));
    fs.cpSync(MOCK_PROJECT, projectRoot, { recursive: true });
    fs.copyFileSync(
        path.join(GOLDEN_DIR, 'TableCash.prefab'),
        path.join(projectRoot, 'assets', 'Prefabs', 'TableCash.prefab')
    );
});

after(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
});

const text = (result) => result.content[0].text;

describe('apply_edits tool — prefab instances (Phase 2)', () => {
    test('instantiate_prefab + set_instance_property end-to-end', async () => {
        const result = await new ApplyEdits().execute({
            filePath: 'assets/Prefabs/TableCash.prefab',
            ops: [
                {
                    op: 'instantiate_prefab', parent: 'Table',
                    prefab: 'Prefabs/Gold.prefab', name: 'Reward', position: { y: 1 }
                },
                {
                    op: 'set_instance_property', node: 'Table/Reward',
                    property: 'scale', value: { x: 0.5, y: 0.5, z: 0.5 }
                }
            ]
        }, projectRoot);

        assert.ok(!result.isError, text(result));
        assert.match(text(result), /instantiated assets\/Prefabs\/Gold\.prefab/);
        assert.match(text(result), /Reward \[prefab instance\]/); // MiniTree stub rendering

        // Written file: stub + overrides present, valid, resolvable by name
        const doc = SceneDocument.load(path.join(projectRoot, 'assets/Prefabs/TableCash.prefab'));
        const stubIdx = doc.resolveNode('Table/Reward');
        assert.ok(doc.isInstanceStub(stubIdx));

        const validation = await new ValidateDocument().execute({
            filePath: 'assets/Prefabs/TableCash.prefab'
        }, projectRoot);
        assert.match(text(validation), /No errors/i);
    });
});

describe('apply_edits tool', () => {
    test('dryRun previews without writing', async () => {
        const target = path.join(projectRoot, 'assets/Prefabs/TableCash.prefab');
        const before = fs.readFileSync(target, 'utf-8');

        const result = await new ApplyEdits().execute({
            filePath: 'assets/Prefabs/TableCash.prefab',
            ops: [{ op: 'add_node', parent: '/', name: 'Preview' }],
            dryRun: true
        }, projectRoot);

        assert.ok(!result.isError, text(result));
        assert.match(text(result), /DRY RUN/);
        assert.match(text(result), /created node "Preview"/);
        assert.strictEqual(fs.readFileSync(target, 'utf-8'), before);
    });

    test('writes edits and reports the result subtree', async () => {
        const result = await new ApplyEdits().execute({
            filePath: 'assets/Prefabs/TableCash.prefab',
            ops: [
                { op: 'add_node', parent: '/', name: 'Lamp', position: { y: 2 } },
                { op: 'add_component', node: 'Lamp', type: 'SphereCollider' }
            ]
        }, projectRoot);

        assert.ok(!result.isError, text(result));
        assert.match(text(result), /Applied 2 op\(s\)/);
        assert.match(text(result), /Lamp pos\(0,2,0\) \[SphereCollider\]/);

        // The written file must be valid and canonical
        const doc = SceneDocument.load(path.join(projectRoot, 'assets/Prefabs/TableCash.prefab'));
        const idx = doc.resolveNode('Lamp');
        assert.strictEqual(doc.getObject(idx)._lpos.y, 2);
        const raw = doc.serialize();
        doc.renumber();
        assert.strictEqual(doc.serialize(), raw);
    });

    test('add_component tells an unimported script apart from a typo', async () => {
        fs.writeFileSync(
            path.join(projectRoot, 'assets/Scripts/NotImported.ts'),
            'export class NotImported {}\n'
        );

        const unimported = await new ApplyEdits().execute({
            filePath: 'assets/Prefabs/TableCash.prefab',
            ops: [{ op: 'add_component', node: 'Table', type: 'NotImported' }],
            dryRun: true
        }, projectRoot);

        assert.ok(unimported.isError);
        assert.match(text(unimported), /exists on disk \(assets\/Scripts\/NotImported\.ts\)/);
        assert.match(text(unimported), /has no \.meta/);
        assert.match(text(unimported), /open the project in Cocos Creator/);

        const typo = await new ApplyEdits().execute({
            filePath: 'assets/Prefabs/TableCash.prefab',
            ops: [{ op: 'add_component', node: 'Table', type: 'NoSuchView' }],
            dryRun: true
        }, projectRoot);

        assert.ok(typo.isError);
        assert.match(text(typo), /not found in assets/);
    });

    test('failed op writes nothing', async () => {
        const target = path.join(projectRoot, 'assets/Prefabs/TableCash.prefab');
        const before = fs.readFileSync(target, 'utf-8');

        const result = await new ApplyEdits().execute({
            filePath: 'assets/Prefabs/TableCash.prefab',
            ops: [
                { op: 'add_node', parent: '/', name: 'Orphan' },
                { op: 'add_component', node: 'Nowhere', type: 'Sprite' }
            ]
        }, projectRoot);

        assert.ok(result.isError);
        assert.match(text(result), /op\[1\]/);
        assert.strictEqual(fs.readFileSync(target, 'utf-8'), before);
    });

    test('missing file errors cleanly', async () => {
        const result = await new ApplyEdits().execute({
            filePath: 'assets/Nope.scene',
            ops: [{ op: 'add_node', parent: '/', name: 'X' }]
        }, projectRoot);
        assert.ok(result.isError);
        assert.match(text(result), /File not found/);
    });
});

describe('validate_document tool', () => {
    test('golden prefab validates clean', async () => {
        const result = await new ValidateDocument().execute({
            filePath: 'assets/Prefabs/Gold.prefab'
        }, projectRoot);
        assert.ok(!result.isError, text(result));
        assert.match(text(result), /No errors|Valid\./);
    });
});

describe('build_prefab tool', () => {
    test('builds prefab + meta from a spec with a mesh visual', async () => {
        const result = await new BuildPrefab().execute({
            outputPath: 'assets/Prefabs/RockProp.prefab',
            spec: {
                visual: { mesh: 'assets/Models/Rock.glb', scale: 2 },
                root: { components: [{ type: 'BoxCollider' }] }
            }
        }, projectRoot);

        assert.ok(!result.isError, text(result));
        assert.match(text(result), /UUID: [0-9a-f-]{36}/);
        assert.match(text(result), /Visual scale\(2,2,2\) \[MeshRenderer\]/);

        const prefabPath = path.join(projectRoot, 'assets/Prefabs/RockProp.prefab');
        assert.ok(fs.existsSync(prefabPath));
        assert.ok(fs.existsSync(`${prefabPath}.meta`));

        const doc = SceneDocument.load(prefabPath);
        assert.strictEqual(doc.getObject(0)._name, 'RockProp');
    });

    test('refuses to overwrite without the flag, keeps UUID with it', async () => {
        const denied = await new BuildPrefab().execute({
            outputPath: 'assets/Prefabs/RockProp.prefab',
            spec: {}
        }, projectRoot);
        assert.ok(denied.isError);
        assert.match(text(denied), /already exists/);

        const metaBefore = JSON.parse(
            fs.readFileSync(path.join(projectRoot, 'assets/Prefabs/RockProp.prefab.meta'), 'utf-8'));
        const replaced = await new BuildPrefab().execute({
            outputPath: 'assets/Prefabs/RockProp.prefab',
            spec: {},
            overwrite: true
        }, projectRoot);
        assert.ok(!replaced.isError, text(replaced));
        assert.match(text(replaced), new RegExp(metaBefore.uuid));
    });

    test('rejects paths outside assets/', async () => {
        const result = await new BuildPrefab().execute({
            outputPath: 'settings/Evil.prefab',
            spec: {}
        }, projectRoot);
        assert.ok(result.isError);
        assert.match(text(result), /assets\//);
    });
});
