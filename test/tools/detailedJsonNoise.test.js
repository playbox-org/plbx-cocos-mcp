/**
 * Detailed-JSON regression guard (review — size regression)
 *
 * Expanding engine plumbing (particle modules, curves, bake settings) as data
 * structs blew detailed JSON up by up to +178% on real files — and no test
 * caught it, because the snapshot fixtures are hand-written and none combined
 * such a field with the conditions that trigger it. This walks the REAL
 * fixtures end-to-end and asserts the detailed-JSON output never expands a
 * type the read pipeline classifies as noise/plumbing. It is intentionally
 * driven from the real corpus so a future negative-filter slip fails in CI.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { QuerySceneGraph } from '../../src/tools/QuerySceneGraph.js';
import { QueryPrefabGraph } from '../../src/tools/QueryPrefabGraph.js';
import { NOISE_TYPES } from '../../src/filters/TypeFilter.js';
import { INTERNAL_STRUCT_TYPES } from '../../src/core/componentIndices.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, '..', 'fixtures');
const SCENES = path.join(FIXTURES, 'real-scenes');
const PREFABS = path.join(FIXTURES, 'real-prefabs');

const BANNED = new Set([...NOISE_TYPES, ...INTERNAL_STRUCT_TYPES]);

/** Every `__struct__` type appearing anywhere in a parsed JSON tree */
function collectStructTypes(node, out = new Set()) {
    if (Array.isArray(node)) {
        for (const v of node) collectStructTypes(v, out);
    } else if (node && typeof node === 'object') {
        if (typeof node.__struct__ === 'string') out.add(node.__struct__);
        for (const v of Object.values(node)) collectStructTypes(v, out);
    }
    return out;
}

async function detailedStructTypes(tool, argKey, file, dir) {
    const result = await tool.execute(
        { [argKey]: path.join(dir, file), detailed: true, format: 'json' }, dir);
    assert.ok(!result.isError, result.content[0].text);
    const data = JSON.parse(result.content[0].text);
    return collectStructTypes(data);
}

describe('detailed JSON never expands engine plumbing (real fixtures)', () => {
    const scenes = fs.existsSync(SCENES) ? fs.readdirSync(SCENES).filter(f => f.endsWith('.scene')) : [];
    const prefabs = fs.existsSync(PREFABS) ? fs.readdirSync(PREFABS).filter(f => f.endsWith('.prefab')) : [];

    for (const file of scenes) {
        test(`scene: ${file}`, async () => {
            const types = await detailedStructTypes(new QuerySceneGraph(), 'scenePath', file, SCENES);
            const leaked = [...types].filter(t => BANNED.has(t));
            assert.deepStrictEqual(leaked, [], `expanded noise/plumbing types: ${leaked.join(', ')}`);
        });
    }

    for (const file of prefabs) {
        test(`prefab: ${file}`, async () => {
            const types = await detailedStructTypes(new QueryPrefabGraph(), 'prefabPath', file, PREFABS);
            const leaked = [...types].filter(t => BANNED.has(t));
            assert.deepStrictEqual(leaked, [], `expanded noise/plumbing types: ${leaked.join(', ')}`);
        });
    }

    test('the corpus is present (guards against silently testing nothing)', () => {
        assert.ok(scenes.length + prefabs.length > 0, 'no real fixtures found');
    });
});
