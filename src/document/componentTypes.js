/**
 * Shared component-type lists — Validator, LintAssets and Bounds must agree
 * on what counts as a renderer.
 */

/**
 * Renderers that must never sit on a prefab ROOT (Root → Visual convention).
 * Every world-space visual renderer that has a template belongs here, so the
 * wrapper rule is enforced uniformly — each new renderer template must be
 * added (Validator.#checkWrapperRule and lint_assets both read this list).
 */
export const VISUAL_ROOT_TYPES = [
    'cc.MeshRenderer', 'cc.SkinnedMeshRenderer', 'cc.Sprite', 'cc.Line',
    'cc.SpriteRenderer', 'cc.Billboard', 'cc.ParticleSystem'
];

/** Components whose `_mesh` contributes a mesh AABB / `_materials` slots */
export const MESH_RENDERERS = ['cc.MeshRenderer', 'cc.SkinnedMeshRenderer'];
