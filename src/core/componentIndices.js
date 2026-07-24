/**
 * Single source of truth for "which flat-array indices are COMPONENTS":
 * membership in some node's `_components` (or a `cc.MountedComponentsInfo`'s
 * `components`) — NOT the `node` back-ref heuristic, which false-positives on a
 * user data struct that declares `@property node: cc.Node`.
 *
 * Shared by the read side (PropertyExtractor, to decide what to expand as a
 * data struct) and the write side (operations.js, to decide ownership/GC), so
 * the membership rule can never drift between the two (CODE_REVIEW finding #8).
 *
 * `isNode` is injected so it works over both SceneParser and SceneDocument
 * object arrays (`(o) => o.__type__ === 'cc.Node' || o.__type__ === 'cc.Scene'`).
 */
/**
 * Engine serialization types that LOOK like data structs (typed, some even
 * carry a `node` back-ref) but are instance/prefab PLUMBING — never user
 * @property data. The read side must not recurse into them (PropertyExtractor)
 * and the write side must not treat them as owned value-objects
 * (operations.js `isValueObjectIdx`). Shared here so the two lists can never
 * drift apart (CODE_REVIEW finding #6).
 */
export const INTERNAL_STRUCT_TYPES = new Set([
    'cc.PrefabInfo', 'cc.PrefabInstance', 'cc.CompPrefabInfo',
    'cc.TargetInfo', 'cc.TargetOverrideInfo',
    'CCPropertyOverrideInfo', 'cc.MountedComponentsInfo', 'cc.MountedChildrenInfo'
]);

export function collectComponentIndices(objects, isNode) {
    const set = new Set();
    if (!Array.isArray(objects)) return set;
    for (const obj of objects) {
        if (!obj || typeof obj !== 'object') continue;
        const list = isNode(obj) ? obj._components
            : obj.__type__ === 'cc.MountedComponentsInfo' ? obj.components
            : null;
        if (!Array.isArray(list)) continue;
        for (const r of list) {
            if (r && typeof r === 'object' && r.__id__ !== undefined) set.add(r.__id__);
        }
    }
    return set;
}
