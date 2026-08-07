/**
 * ComponentTemplates tests - template lookup over user-supplied type names
 *
 * The template table is a plain object literal and `type` is the add_component
 * argument, so the lookup must be an own-key test; asserted through
 * applyOperations, which is the only path a caller reaches it by.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { SceneDocument } from '../../src/document/SceneDocument.js';
import { applyOperations, OperationError } from '../../src/document/operations.js';
import {
    resolveTemplateType, createComponent, templateTypes
} from '../../src/document/ComponentTemplates.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = (f) => path.join(__dirname, '..', 'fixtures', 'golden', f);

const PROTO_NAMES = ['constructor', 'toString', 'valueOf', 'hasOwnProperty'];

describe('template lookup', () => {
    test('an Object.prototype name is not a template', () => {
        for (const type of PROTO_NAMES) {
            assert.strictEqual(resolveTemplateType(type), null, type);
            assert.throws(() => createComponent(type), /No component template for/, type);
        }
        assert.ok(!templateTypes().some(t => PROTO_NAMES.includes(t)));
    });

    test('add_component reports an unknown type instead of crashing on it', () => {
        // `TEMPLATES[type]` resolved "constructor" to Object and called it as a factory:
        // add_component {type:'constructor'} died with "Cannot set properties of
        // undefined (setting 'node')", valueOf/hasOwnProperty with "Cannot convert
        // undefined or null to object" — never the intended message.
        for (const type of PROTO_NAMES) {
            const doc = SceneDocument.load(GOLDEN('TableCash.prefab'));
            const before = doc.objects.length;
            assert.throws(
                () => applyOperations(doc, [{ op: 'add_component', node: 'Table', type }]),
                (err) => {
                    assert.ok(err instanceof OperationError, `${type}: ${err.name}`);
                    assert.match(err.message, new RegExp(`"${type}" not found in assets`));
                    assert.match(err.message, /Available cc\.\* templates/);
                    return true;
                },
                type
            );
            assert.strictEqual(doc.objects.length, before, type); // all-or-nothing
        }
    });

    test('a cc.-prefixed prototype name lists the templates', () => {
        for (const type of PROTO_NAMES) {
            const doc = SceneDocument.load(GOLDEN('TableCash.prefab'));
            assert.throws(
                () => applyOperations(doc, [{ op: 'add_component', node: 'Table', type: `cc.${type}` }]),
                /No template for "cc\..*". Available cc\.\* templates/,
                type
            );
        }
    });
});
