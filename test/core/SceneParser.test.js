import { describe, it } from 'node:test';
import assert from 'node:assert';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
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
});
