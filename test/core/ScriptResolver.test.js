import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { ScriptResolver } from '../../src/core/ScriptResolver.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, '../fixtures');

describe('ScriptResolver', () => {
    let resolver;

    before(() => {
        // ScriptResolver scans assets/Scripts directory
        // Our fixtures have scripts/ directly
        resolver = new ScriptResolver(join(FIXTURES, '..'));
    });

    it('should resolve cc.* types by stripping prefix', () => {
        assert.strictEqual(resolver.resolve('cc.RigidBody'), 'RigidBody');
        assert.strictEqual(resolver.resolve('cc.BoxCollider'), 'BoxCollider');
        assert.strictEqual(resolver.resolve('cc.Camera'), 'Camera');
    });

    it('should return truncated type for unknown scripts', () => {
        const result = resolver.resolve('xyz99unknownvalue123');
        assert.ok(result.startsWith('Script:'), 'should prefix with Script:');
        assert.strictEqual(result, 'Script:xyz99unk');
    });

    it('should identify custom scripts', () => {
        assert.strictEqual(resolver.isCustomScript('63d48abcdef123456'), true);
        assert.strictEqual(resolver.isCustomScript('cc.RigidBody'), false);
        assert.strictEqual(resolver.isCustomScript('Short'), false);
    });

    it('should handle empty project root gracefully', () => {
        const emptyResolver = new ScriptResolver('/nonexistent/path');
        const result = emptyResolver.resolve('unknown123456789');
        assert.ok(result.startsWith('Script:'));
    });
});
