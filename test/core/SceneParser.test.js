import { describe, it } from 'node:test';
import assert from 'node:assert';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { SceneParser } from '../../src/core/SceneParser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, '../fixtures');

describe('SceneParser', () => {
    const scenePath = join(FIXTURES, 'sample-scene.json');

    it('should parse scene JSON and index objects', () => {
        const parser = new SceneParser(scenePath);
        const objects = parser.objects;

        assert.ok(Array.isArray(objects), 'objects should be array');
        assert.strictEqual(objects.length, 11, 'should have 11 objects');
    });

    it('should find scene root', () => {
        const parser = new SceneParser(scenePath);
        const root = parser.findSceneRoot();

        assert.ok(root, 'should find scene root');
        assert.strictEqual(root.__type__, 'cc.Scene');
        assert.strictEqual(root._name, 'TestScene');
    });

    it('should get nodes by id', () => {
        const parser = new SceneParser(scenePath);

        const level = parser.getNode(2);
        assert.ok(level, 'should get node by id');
        assert.strictEqual(level._name, 'Level');

        const player = parser.getNode(4);
        assert.strictEqual(player._name, 'Player');
    });

    it('should return undefined for non-node id', () => {
        const parser = new SceneParser(scenePath);
        // getNode only returns nodes (cc.Node or cc.Scene), not components
        const nonNode = parser.getNode(5); // This is a RigidBody component
        assert.strictEqual(nonNode, undefined);
    });

    it('should get any object by id', () => {
        const parser = new SceneParser(scenePath);
        const component = parser.getObject(5);
        assert.strictEqual(component.__type__, 'cc.RigidBody');
    });

    it('should throw on invalid file', () => {
        assert.throws(
            () => new SceneParser('/nonexistent/path.scene'),
            /ENOENT|Cannot read/
        );
    });

    it('should throw on valid JSON that is not an array', () => {
        const dir = mkdtempSync(join(tmpdir(), 'scene-parser-'));
        const filePath = join(dir, 'not-a-scene.json');
        writeFileSync(filePath, '{"__type__": "cc.Scene"}');

        try {
            assert.throws(
                () => new SceneParser(filePath),
                /Not a Cocos scene\/prefab: expected a JSON array/
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('should find prefab root via cc.Prefab.data', () => {
        const parser = new SceneParser(join(FIXTURES, 'real-prefabs/Car.prefab'));
        const root = parser.findSceneRoot();

        assert.ok(root, 'should find prefab root');
        assert.strictEqual(root.__type__, 'cc.Node');
        assert.strictEqual(root._name, 'Car');
    });

    it('should index prefab nodes and components', () => {
        const parser = new SceneParser(join(FIXTURES, 'real-prefabs/Car.prefab'));

        assert.ok(parser.nodes.size > 0, 'should have nodes');
        assert.ok(parser.components.size > 0, 'should have components');
    });

    it('keeps instance overrides whose name collides with Object.prototype', () => {
        // The first-wins dedup asked `path[0] in overrides` on a plain object, so a
        // serialized override named "toString" looked already-present and was dropped,
        // and `__proto__` re-parented the accumulator instead of becoming a key.
        const override = (path, value, next) => [
            {
                __type__: 'CCPropertyOverrideInfo',
                targetInfo: { __id__: next }, propertyPath: [path], value
            },
            { __type__: 'cc.TargetInfo', localID: ['ROOT-FILE-ID'] }
        ];
        const scene = [
            { __type__: 'cc.Scene', _name: 'S', _children: [{ __id__: 1 }] },
            { __type__: 'cc.Node', _name: '', _id: 'stub', _prefab: { __id__: 2 } },
            {
                __type__: 'cc.PrefabInfo', fileId: 'ROOT-FILE-ID',
                asset: { __uuid__: 'aaaa1111-2222-4333-8444-555555555555' },
                instance: { __id__: 3 }
            },
            {
                __type__: 'cc.PrefabInstance',
                propertyOverrides: [{ __id__: 4 }, { __id__: 6 }, { __id__: 8 }]
            },
            ...override('toString', 'kept', 5),
            ...override('__proto__', { hijacked: true }, 7),
            ...override('_name', 'Renamed', 9)
        ];

        const dir = mkdtempSync(join(tmpdir(), 'scene-parser-overrides-'));
        const filePath = join(dir, 'proto.scene');
        writeFileSync(filePath, JSON.stringify(scene));
        try {
            const parser = new SceneParser(filePath);
            const info = parser.getInstanceInfo(parser.getObject(1));
            assert.strictEqual(info.overrides.toString, 'kept');
            assert.deepStrictEqual(info.overrides.__proto__, { hijacked: true });
            assert.strictEqual(Object.getPrototypeOf(info.overrides), null);
            assert.strictEqual(info.nameOverride, 'Renamed'); // consumers still read _name
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
