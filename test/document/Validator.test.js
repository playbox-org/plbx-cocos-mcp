/**
 * Validator tests - invariants on golden files and hand-broken documents
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { SceneDocument } from '../../src/document/SceneDocument.js';
import { Validator } from '../../src/document/Validator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = path.join(__dirname, '..', 'fixtures', 'golden');

const load = (f) => SceneDocument.load(path.join(GOLDEN_DIR, f));

describe('Validator on editor-authored files', () => {
    for (const file of fs.readdirSync(GOLDEN_DIR).filter(f => /\.(scene|prefab)$/.test(f))) {
        test(`${file} has zero errors`, () => {
            const { errors } = new Validator(load(file)).validate();
            assert.deepStrictEqual(errors, []);
        });
    }
});

describe('Validator catches corruption', () => {
    test('dangling __id__', () => {
        const doc = load('TableCash.prefab');
        doc.getObject(doc.resolveNode('Table'))._components.push({ __id__: 9999 });
        const { errors } = new Validator(doc).validate();
        assert.ok(errors.some(e => /dangling __id__ 9999/.test(e)));
    });

    test('broken parent/children symmetry', () => {
        const doc = load('TableCash.prefab');
        const monitorIdx = doc.resolveNode('Table/CashRegister/Monitor');
        doc.getObject(monitorIdx)._parent = { __id__: doc.root.idx };
        const { errors } = new Validator(doc).validate();
        assert.ok(errors.some(e => /missing from parent's _children/.test(e)));
    });

    test('component .node backref mismatch', () => {
        const doc = load('TableCash.prefab');
        const monitorIdx = doc.resolveNode('Table/CashRegister/Monitor');
        const compIdx = doc.componentIndices(monitorIdx)[0];
        doc.getObject(compIdx).node = { __id__: doc.root.idx };
        const { errors } = new Validator(doc).validate();
        assert.ok(errors.some(e => /does not point back via \.node/.test(e)));
    });

    test('duplicate definition fileId', () => {
        const doc = load('TableCash.prefab');
        const infos = doc.objects.filter(o =>
            o.__type__ === 'cc.PrefabInfo' && o.asset?.__id__ === 0);
        infos[1].fileId = infos[0].fileId;
        const { errors } = new Validator(doc).validate();
        assert.ok(errors.some(e => /duplicate definition fileId/.test(e)));
    });

    test('duplicate node _id in scene', () => {
        const doc = load('Main.scene_V2.scene');
        const nodes = doc.objects.filter(o => o.__type__ === 'cc.Node' && o._id);
        nodes[1]._id = nodes[0]._id;
        const { errors } = new Validator(doc).validate();
        assert.ok(errors.some(e => /duplicate _id/.test(e)));
    });

    test('wrapper rule warning for renderer on prefab root', () => {
        const doc = load('TableCash.prefab');
        // Move the Table MeshRenderer ref onto the root (contrived but structural)
        const tableIdx = doc.resolveNode('Table');
        const compIdx = doc.componentIndices(tableIdx)[0];
        doc.getObject(tableIdx)._components = [];
        doc.root.node._components.push({ __id__: compIdx });
        doc.getObject(compIdx).node = { __id__: doc.root.idx };
        const { warnings } = new Validator(doc).validate();
        assert.ok(warnings.some(w => /wrapper rule/.test(w)));
    });

    test('unreachable objects produce a warning', () => {
        const doc = load('TableCash.prefab');
        doc.addObject({ __type__: 'cc.ModelBakeSettings', texture: null });
        const { errors, warnings } = new Validator(doc).validate();
        assert.ok(warnings.some(w => /unreachable objects/.test(w)));
        assert.deepStrictEqual(errors, []);
    });
});
