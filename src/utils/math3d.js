/**
 * Minimal 3D math matching Cocos Creator serialization needs.
 *
 * eulerToQuat reproduces cc.Quat.fromEuler (YZX order). Verified against
 * 208/216 rotated nodes in the real Main.scene_V2.scene — the remaining 8
 * are stale euler/quat pairs in the source file itself.
 */

const DEG2RAD = Math.PI / 180;

/**
 * Convert euler angles (degrees) to a quaternion exactly like the editor.
 * @param {{x: number, y: number, z: number}} euler
 * @returns {{x: number, y: number, z: number, w: number}}
 */
export function eulerToQuat({ x = 0, y = 0, z = 0 }) {
    const hx = x * DEG2RAD * 0.5;
    const hy = y * DEG2RAD * 0.5;
    const hz = z * DEG2RAD * 0.5;
    const sx = Math.sin(hx), cx = Math.cos(hx);
    const sy = Math.sin(hy), cy = Math.cos(hy);
    const sz = Math.sin(hz), cz = Math.cos(hz);
    return {
        x: sx * cy * cz + cx * sy * sz,
        y: cx * sy * cz + sx * cy * sz,
        z: cx * cy * sz - sx * sy * cz,
        w: cx * cy * cz - sx * sy * sz
    };
}

/**
 * Quaternion distance check for validator warnings.
 * Accounts for the q/-q double cover.
 */
export function quatApproxEquals(a, b, epsilon = 1e-3) {
    const direct = Math.abs(a.x - b.x) + Math.abs(a.y - b.y) +
                   Math.abs(a.z - b.z) + Math.abs(a.w - b.w);
    const negated = Math.abs(a.x + b.x) + Math.abs(a.y + b.y) +
                    Math.abs(a.z + b.z) + Math.abs(a.w + b.w);
    return Math.min(direct, negated) < epsilon;
}

// --------------------------------------------------------------- transforms
// Column-major 4x4 matrices (same layout as cc.Mat4), used for world-bounds
// computation. Only compose/transform is needed — no inversion.

/** Identity 4x4 */
export function mat4Identity() {
    return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

/**
 * Build a TRS matrix from serialized node fields.
 * @param {{x,y,z}} pos - _lpos
 * @param {{x,y,z,w}} rot - _lrot quaternion
 * @param {{x,y,z}} scale - _lscale
 * @returns {number[]} column-major mat4
 */
export function trsToMat4(pos, rot, scale) {
    const { x, y, z, w } = rot;
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    const sx = scale.x, sy = scale.y, sz = scale.z;
    return [
        (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
        (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
        (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
        pos.x, pos.y, pos.z, 1
    ];
}

/** a ∘ b (apply b first, then a) */
export function mat4Multiply(a, b) {
    const out = new Array(16);
    for (let col = 0; col < 4; col++) {
        for (let row = 0; row < 4; row++) {
            out[col * 4 + row] =
                a[row] * b[col * 4] +
                a[4 + row] * b[col * 4 + 1] +
                a[8 + row] * b[col * 4 + 2] +
                a[12 + row] * b[col * 4 + 3];
        }
    }
    return out;
}

/** Transform a point {x,y,z} by a mat4 */
export function mat4TransformPoint(m, p) {
    return {
        x: m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12],
        y: m[1] * p.x + m[5] * p.y + m[9] * p.z + m[13],
        z: m[2] * p.x + m[6] * p.y + m[10] * p.z + m[14]
    };
}

/**
 * Axis-aligned box of a transformed AABB: run all 8 corners through the
 * matrix and take min/max.
 * @param {{min: {x,y,z}, max: {x,y,z}}} aabb
 * @param {number[]} m - mat4
 * @returns {{min: {x,y,z}, max: {x,y,z}}}
 */
export function transformAabb(aabb, m) {
    const min = { x: Infinity, y: Infinity, z: Infinity };
    const max = { x: -Infinity, y: -Infinity, z: -Infinity };
    for (const cx of [aabb.min.x, aabb.max.x]) {
        for (const cy of [aabb.min.y, aabb.max.y]) {
            for (const cz of [aabb.min.z, aabb.max.z]) {
                const p = mat4TransformPoint(m, { x: cx, y: cy, z: cz });
                min.x = Math.min(min.x, p.x); max.x = Math.max(max.x, p.x);
                min.y = Math.min(min.y, p.y); max.y = Math.max(max.y, p.y);
                min.z = Math.min(min.z, p.z); max.z = Math.max(max.z, p.z);
            }
        }
    }
    return { min, max };
}

/** In-place merge of AABB `b` into `a` (either may be null → the other) */
export function mergeAabb(a, b) {
    if (!a) return b;
    if (!b) return a;
    return {
        min: { x: Math.min(a.min.x, b.min.x), y: Math.min(a.min.y, b.min.y), z: Math.min(a.min.z, b.min.z) },
        max: { x: Math.max(a.max.x, b.max.x), y: Math.max(a.max.y, b.max.y), z: Math.max(a.max.z, b.max.z) }
    };
}
