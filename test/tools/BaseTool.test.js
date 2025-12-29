import { describe, it } from 'node:test';
import assert from 'node:assert';
import { BaseTool } from '../../src/tools/BaseTool.js';

describe('BaseTool', () => {
    it('should throw when name is not implemented', () => {
        const tool = new BaseTool();
        assert.throws(() => tool.name, /Subclass must implement/);
    });

    it('should throw when description is not implemented', () => {
        const tool = new BaseTool();
        assert.throws(() => tool.description, /Subclass must implement/);
    });

    it('should throw when inputSchema is not implemented', () => {
        const tool = new BaseTool();
        assert.throws(() => tool.inputSchema, /Subclass must implement/);
    });

    it('should throw when execute is not implemented', async () => {
        const tool = new BaseTool();
        await assert.rejects(() => tool.execute({}), /Subclass must implement/);
    });

    it('should allow subclass to implement all methods', () => {
        class TestTool extends BaseTool {
            get name() { return 'test_tool'; }
            get description() { return 'Test tool'; }
            get inputSchema() { return { type: 'object' }; }
            async execute() { return 'result'; }
        }

        const tool = new TestTool();
        assert.strictEqual(tool.name, 'test_tool');
        assert.strictEqual(tool.description, 'Test tool');
    });
});
