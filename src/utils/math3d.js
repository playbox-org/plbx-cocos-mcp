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
