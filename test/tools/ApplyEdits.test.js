/**
 * ApplyEdits / ValidateDocument tool tests
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

