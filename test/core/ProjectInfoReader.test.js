import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { ProjectInfoReader, BUILTIN_LAYERS } from '../../src/core/ProjectInfoReader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT = join(__dirname, '../fixtures/mock-project');

describe('ProjectInfoReader', () => {
    let info;

    before(() => {
        info = new ProjectInfoReader(PROJECT).read();
    });

    it('should detect engine version from package.json', () => {
        assert.strictEqual(info.engineVersion, '3.8.7');
        assert.strictEqual(new ProjectInfoReader(PROJECT).detectEngineVersion(), '3.8.7');
    });

    it('should read project name and uuid', () => {
        assert.strictEqual(info.projectName, 'mock-game');
        assert.strictEqual(info.projectUuid, '98c2634d-797f-43d4-b160-e38a937e6849');
    });

    it('should read design resolution', () => {
        assert.deepStrictEqual(info.designResolution, {
            height: 1280, width: 720, fitHeight: true, fitWidth: false
        });
    });

    it('should read custom layers and expose builtin ones', () => {
        assert.deepStrictEqual(info.layers.custom, [
            { name: 'GROUND', value: 1 },
            { name: 'ENEMY', value: 2 }
        ]);
        assert.strictEqual(info.layers.builtin.DEFAULT, 1 << 30);
        assert.strictEqual(BUILTIN_LAYERS.UI_2D, 1 << 25);
    });

    it('should read physics config with implicit DEFAULT group', () => {
        assert.strictEqual(info.physics.engine3d, 'physics-ammo');
        assert.strictEqual(info.physics.engine2d, null);
        assert.deepStrictEqual(info.physics.gravity, { x: 0, y: -10, z: 0 });
        assert.deepStrictEqual(info.physics.collisionGroups, [
            { index: 0, name: 'DEFAULT' },
            { index: 1, name: 'PLAYER' },
            { index: 2, name: 'BULLET' }
        ]);
        assert.deepStrictEqual(info.physics.collisionMatrix, { 0: 7, 1: 5, 2: 1 });
    });

    it('should read enabled engine modules', () => {
        assert.strictEqual(info.modules.has3d, true);
        assert.strictEqual(info.modules.has2d, true);
        assert.ok(info.modules.enabled.includes('physics'));
        assert.ok(!info.modules.enabled.includes('particle'));
    });

    it('should degrade gracefully for a missing project', () => {
        const empty = new ProjectInfoReader('/nonexistent/path').read();
        assert.strictEqual(empty.engineVersion, null);
        assert.strictEqual(empty.designResolution, null);
        assert.deepStrictEqual(empty.layers.custom, []);
        assert.deepStrictEqual(empty.physics.collisionGroups, [{ index: 0, name: 'DEFAULT' }]);
        assert.strictEqual(empty.modules, null);
    });
});
