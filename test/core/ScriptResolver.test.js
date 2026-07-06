import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { ScriptResolver } from '../../src/core/ScriptResolver.js';
import { compressUuid } from '../../src/utils/uuid.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, '../fixtures');

// UUIDs from the .meta fixtures in test/fixtures/assets/
const PLAYER_UUID = '63d48abc-1234-5678-9abc-def012345678';   // assets/Scripts/PlayerController.ts
const ENEMY_UUID = 'a1b2c345-6789-abcd-ef01-234567890abc';    // assets/Scripts/EnemyController.ts
const SPAWNER_UUID = 'b2c3d456-789a-bcde-f012-3456789abcde';  // assets/Gameplay/WaveSpawner.ts
const AUDIO_UUID = 'c3d4e567-89ab-cdef-0123-456789abcdef';    // assets/Plugins/AudioShim.js

describe('ScriptResolver', () => {
    let resolver;

    before(() => {
        // ScriptResolver scans the whole assets/ tree of the project root
        resolver = new ScriptResolver(FIXTURES);
    });

    it('should resolve cc.* types by stripping prefix', () => {
        assert.strictEqual(resolver.resolve('cc.RigidBody'), 'RigidBody');
        assert.strictEqual(resolver.resolve('cc.BoxCollider'), 'BoxCollider');
        assert.strictEqual(resolver.resolve('cc.Camera'), 'Camera');
    });

    it('should resolve compressed UUIDs to script names exactly', () => {
        assert.strictEqual(resolver.resolve(compressUuid(PLAYER_UUID)), 'PlayerController');
        assert.strictEqual(resolver.resolve(compressUuid(ENEMY_UUID)), 'EnemyController');
    });

    it('should resolve scripts outside assets/Scripts', () => {
        assert.strictEqual(resolver.resolve(compressUuid(SPAWNER_UUID)), 'WaveSpawner');
    });

    it('should resolve .js scripts', () => {
        assert.strictEqual(resolver.resolve(compressUuid(AUDIO_UUID)), 'AudioShim');
    });

    it('should not resolve by UUID prefix alone', () => {
        // Same 8-char prefix as PlayerController's compressed UUID, different tail
        const almost = compressUuid(PLAYER_UUID).slice(0, 8) + 'XXXXXXXXXXXXXXX';
        const result = resolver.resolve(almost);
        assert.ok(result.startsWith('Script:'), 'prefix match must not resolve');
    });

    it('should return truncated type for unknown scripts', () => {
        const result = resolver.resolve('xyz99unknownvalue123');
        assert.ok(result.startsWith('Script:'), 'should prefix with Script:');
        assert.strictEqual(result, 'Script:xyz99unk');
    });

    it('should handle empty project root gracefully', () => {
        const emptyResolver = new ScriptResolver('/nonexistent/path');
        const result = emptyResolver.resolve('unknown123456789');
        assert.ok(result.startsWith('Script:'));
    });
});
