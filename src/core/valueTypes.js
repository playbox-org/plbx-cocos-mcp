/**
 * Single registry of cc value-types serialized INLINE (no {__id__}
 * indirection), with their serialized field order (matches the editor/API
 * constructors). Shared by the read side (PropertyExtractor renders them as
 * compact ordered arrays) and the write side (operations.js derives inline
 * membership from the keys) so the two lists can never drift apart
 * (CODE_REVIEW finding #8: cc.Mat4 was writable but invisible on read).
 */
export const VALUE_TYPE_FIELDS = {
    'cc.Vec2': ['x', 'y'],
    'cc.Vec3': ['x', 'y', 'z'],
    'cc.Vec4': ['x', 'y', 'z', 'w'],
    'cc.Quat': ['x', 'y', 'z', 'w'],
    'cc.Color': ['r', 'g', 'b', 'a'],
    'cc.Size': ['width', 'height'],
    'cc.Rect': ['x', 'y', 'width', 'height'],
    'cc.Mat3': ['m00', 'm01', 'm02', 'm03', 'm04', 'm05', 'm06', 'm07', 'm08'],
    'cc.Mat4': [
        'm00', 'm01', 'm02', 'm03', 'm04', 'm05', 'm06', 'm07',
        'm08', 'm09', 'm10', 'm11', 'm12', 'm13', 'm14', 'm15'
    ]
};
