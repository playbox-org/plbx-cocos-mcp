import { describe, it } from 'node:test';
import assert from 'node:assert';
import { NodeFilter } from '../../src/filters/NodeFilter.js';

describe('NodeFilter', () => {
    describe('shouldFilter', () => {
        it('should filter nodes at max depth', () => {
            const filter = new NodeFilter();
            const node = { _name: 'DeepNode' };

            // Default maxDepth is 10
            assert.strictEqual(filter.shouldFilter(node, 5, false), false);
            assert.strictEqual(filter.shouldFilter(node, 10, false), false);
            assert.strictEqual(filter.shouldFilter(node, 11, false), true);
            assert.strictEqual(filter.shouldFilter(node, 20, false), true);
        });

        it('should filter bone nodes when parent is bone', () => {
            const filter = new NodeFilter();
            const boneNode = { _name: 'Spine' };
            const normalNode = { _name: 'Player' };

            // Non-bone nodes are not filtered
            assert.strictEqual(filter.shouldFilter(normalNode, 2, false), false);

            // Bone when parent is bone
            assert.strictEqual(filter.shouldFilter(boneNode, 2, true), true);
        });

        it('should filter deep bone nodes', () => {
            const filter = new NodeFilter();
            const boneNode = { _name: 'Head' };

            // Default boneMaxDepth is 3
            assert.strictEqual(filter.shouldFilter(boneNode, 3, false), false);
            assert.strictEqual(filter.shouldFilter(boneNode, 4, false), true);
        });

        it('should apply custom filters', () => {
            const filter = new NodeFilter();

            // Add filter for nodes starting with "_"
            filter.addFilter((node) => node._name?.startsWith('_'));

            const hiddenNode = { _name: '_HiddenNode' };
            const normalNode = { _name: 'VisibleNode' };

            assert.strictEqual(filter.shouldFilter(hiddenNode, 0, false), true);
            assert.strictEqual(filter.shouldFilter(normalNode, 0, false), false);
        });

        it('should chain multiple custom filters', () => {
            const filter = new NodeFilter();

            filter.addFilter((node) => node._name === 'FilterMe');
            filter.addFilter((node) => node._name?.includes('Debug'));

            assert.strictEqual(filter.shouldFilter({ _name: 'FilterMe' }, 0, false), true);
            assert.strictEqual(filter.shouldFilter({ _name: 'DebugNode' }, 0, false), true);
            assert.strictEqual(filter.shouldFilter({ _name: 'Normal' }, 0, false), false);
        });
    });

    describe('isBone', () => {
        it('should identify skeleton bones by name pattern', () => {
            const filter = new NodeFilter();

            // Keyword matches whole name, or continues with separator/digit
            assert.strictEqual(filter.isBone('Root'), true);
            assert.strictEqual(filter.isBone('Spine'), true);
            assert.strictEqual(filter.isBone('Spine1'), true);
            assert.strictEqual(filter.isBone('Head'), true);
            assert.strictEqual(filter.isBone('Head_L'), true);
            assert.strictEqual(filter.isBone('Shoulder_L'), true);
            assert.strictEqual(filter.isBone('Hand.R'), true);
            assert.strictEqual(filter.isBone('Hand_R'), true);
            assert.strictEqual(filter.isBone('Finger01'), true);
            assert.strictEqual(filter.isBone('Hip'), true);
            assert.strictEqual(filter.isBone('Leg_L'), true);
            assert.strictEqual(filter.isBone('mixamorig:Head'), true);
        });

        it('should identify bones with a bare L/R side suffix (no separator)', () => {
            const filter = new NodeFilter();

            assert.strictEqual(filter.isBone('EyeL'), true);
            assert.strictEqual(filter.isBone('EyeR'), true);
            assert.strictEqual(filter.isBone('HandR'), true);
            assert.strictEqual(filter.isBone('FootL'), true);
            assert.strictEqual(filter.isBone('ShoulderL'), true);
            // ...but a suffix continuing into a word is not a side marker
            assert.strictEqual(filter.isBone('EyeLid'), false);
            assert.strictEqual(filter.isBone('HandRig'), false);
        });

        it('should not identify regular nodes as bones', () => {
            const filter = new NodeFilter();

            assert.strictEqual(filter.isBone('Player'), false);
            assert.strictEqual(filter.isBone('Camera'), false);
            assert.strictEqual(filter.isBone('Level'), false);
            assert.strictEqual(filter.isBone('UI_Button'), false);
        });

        it('should not match bone keyword as plain prefix of a longer word', () => {
            const filter = new NodeFilter();

            assert.strictEqual(filter.isBone('Header'), false);
            assert.strictEqual(filter.isBone('Footer'), false);
            assert.strictEqual(filter.isBone('Armor'), false);
            assert.strictEqual(filter.isBone('Handle'), false);
            // Standard root of Cocos gltf prefabs must never be filtered
            assert.strictEqual(filter.isBone('RootNode'), false);
            assert.strictEqual(filter.isBone('Headquarters'), false);
            assert.strictEqual(filter.isBone('Legend'), false);
        });
    });

    describe('configure', () => {
        it('should allow changing maxDepth', () => {
            const filter = new NodeFilter();
            filter.configure({ maxDepth: 5 });

            const node = { _name: 'Test' };
            assert.strictEqual(filter.shouldFilter(node, 5, false), false);
            assert.strictEqual(filter.shouldFilter(node, 6, false), true);
        });

        it('should allow changing boneMaxDepth', () => {
            const filter = new NodeFilter();
            filter.configure({ boneMaxDepth: 1 });

            const boneNode = { _name: 'Head' };
            assert.strictEqual(filter.shouldFilter(boneNode, 1, false), false);
            assert.strictEqual(filter.shouldFilter(boneNode, 2, false), true);
        });

        it('should accept zero as maxDepth', () => {
            const filter = new NodeFilter();
            filter.configure({ maxDepth: 0 });

            const node = { _name: 'Test' };
            assert.strictEqual(filter.shouldFilter(node, 0, false), false);
            assert.strictEqual(filter.shouldFilter(node, 1, false), true);
        });

        it('should return this for chaining', () => {
            const filter = new NodeFilter();
            const result = filter.configure({ maxDepth: 5 });
            assert.strictEqual(result, filter);
        });
    });

    describe('addFilter', () => {
        it('should return this for chaining', () => {
            const filter = new NodeFilter();
            const result = filter.addFilter(() => false);
            assert.strictEqual(result, filter);
        });

        it('should support fluent API', () => {
            const filter = new NodeFilter()
                .addFilter((n) => n._name === 'A')
                .addFilter((n) => n._name === 'B');

            assert.strictEqual(filter.shouldFilter({ _name: 'A' }, 0, false), true);
            assert.strictEqual(filter.shouldFilter({ _name: 'B' }, 0, false), true);
        });
    });
});
