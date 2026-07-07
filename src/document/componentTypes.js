/**
 * Shared component-type lists — Validator, LintAssets and Bounds must agree
 * on what counts as a renderer.
 */

/** Renderers that must never sit on a prefab ROOT (Root → Visual convention) */
export const VISUAL_ROOT_TYPES = ['cc.MeshRenderer', 'cc.SkinnedMeshRenderer', 'cc.Sprite', 'cc.Line'];

/** Components whose `_mesh` contributes a mesh AABB / `_materials` slots */
export const MESH_RENDERERS = ['cc.MeshRenderer', 'cc.SkinnedMeshRenderer'];
