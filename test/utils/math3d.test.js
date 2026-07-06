/**
 * math3d tests - direct checks of the euler/quat and matrix helpers behind
 * the write layer (YZX euler order, column-major mat4, editor-verified).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
    eulerToQuat, mat4Identity, trsToMat4, mat4Multiply,
    mat4TransformPoint, transformAabb, mergeAabb
} from '../../src/utils/math3d.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !≈ ${b}`);
const nearVec = (v, expected, eps = 1e-9) => {
    for (const key of Object.keys(expected)) near(v[key], expected[key], eps);
};
const nearMat = (m, expected) => m.forEach((v, i) => near(v, expected[i]));

const NO_ROT = { x: 0, y: 0, z: 0, w: 1 };
const UNIT = { x: 1, y: 1, z: 1 };
const ZERO = { x: 0, y: 0, z: 0 };

describe('eulerToQuat', () => {
    test('zero euler is the identity quaternion', () => {
        nearVec(eulerToQuat({ x: 0, y: 0, z: 0 }), { x: 0, y: 0, z: 0, w: 1 });
    });

    test('single-axis 90° rotations', () => {
        nearVec(eulerToQuat({ x: 90, y: 0, z: 0 }), { x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 });
        nearVec(eulerToQuat({ x: 0, y: 90, z: 0 }), { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 });
        nearVec(eulerToQuat({ x: 0, y: 0, z: 90 }), { x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 });
    });

    test('matches an editor-computed value from the golden corpus', () => {
        // CashRegister in TableCash.prefab carries euler (0, -80, 0)
        const q = eulerToQuat({ x: 0, y: -80, z: 0 });
        near(q.y, -0.6427876096865393);
        near(q.w, 0.766044443118978);
    });

    test('missing components default to 0', () => {
        nearVec(eulerToQuat({ y: 180 }), { x: 0, y: 1, z: 0, w: 0 });
    });
});

describe('trsToMat4 / transformAabb', () => {
    test('translate + scale maps a unit box', () => {
        const m = trsToMat4({ x: 1, y: 2, z: 3 }, NO_ROT, { x: 2, y: 2, z: 2 });
        const box = transformAabb(
            { min: { x: -0.5, y: -0.5, z: -0.5 }, max: { x: 0.5, y: 0.5, z: 0.5 } }, m);
        nearVec(box.min, { x: 0, y: 1, z: 2 });
        nearVec(box.max, { x: 2, y: 3, z: 4 });
    });

    test('90° Y rotation swaps X and Z extents', () => {
        const m = trsToMat4(ZERO, eulerToQuat({ y: 90 }), UNIT);
        const box = transformAabb({ min: { x: -2, y: 0, z: -1 }, max: { x: 2, y: 1, z: 1 } }, m);
        near(box.max.x - box.min.x, 2);
        near(box.max.y - box.min.y, 1);
        near(box.max.z - box.min.z, 4);
    });

    test('mergeAabb unions boxes and tolerates null', () => {
        const a = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } };
        const b = { min: { x: -1, y: 0, z: 0 }, max: { x: 0.5, y: 2, z: 1 } };
        assert.strictEqual(mergeAabb(null, a), a);
        assert.strictEqual(mergeAabb(a, null), a);
        const merged = mergeAabb(a, b);
        nearVec(merged.min, { x: -1, y: 0, z: 0 });
        nearVec(merged.max, { x: 1, y: 2, z: 1 });
    });
});

describe('mat4Multiply', () => {
    test('identity is neutral on both sides', () => {
        const m = trsToMat4({ x: 1, y: 2, z: 3 }, eulerToQuat({ y: 45 }), { x: 2, y: 1, z: 1 });
        nearMat(mat4Multiply(mat4Identity(), m), m);
        nearMat(mat4Multiply(m, mat4Identity()), m);
    });

    test('composes right-to-left: a ∘ b applies b first', () => {
        const t = trsToMat4({ x: 10, y: 0, z: 0 }, NO_ROT, UNIT);
        const s = trsToMat4(ZERO, NO_ROT, { x: 2, y: 2, z: 2 });
        // translate ∘ scale: p is scaled first, then translated
        nearVec(mat4TransformPoint(mat4Multiply(t, s), { x: 1, y: 1, z: 1 }), { x: 12, y: 2, z: 2 });
        // scale ∘ translate: p is translated first, then scaled
        nearVec(mat4TransformPoint(mat4Multiply(s, t), { x: 1, y: 1, z: 1 }), { x: 22, y: 2, z: 2 });
    });
});
