/**
 * TypeFilter - Open/Closed Principle: Extensible type filtering
 *
 * SOLID: O - New noise types can be added without modifying core logic
 * SOLID: S - Only responsible for type classification
 */

// Noise types - data that doesn't help LLM understand scene structure
const NOISE_TYPES = new Set([
    // Primitives
    'cc.Vec3', 'cc.Vec2', 'cc.Vec4', 'cc.Quat',
    'cc.Color', 'cc.Size', 'cc.Rect',

    // Animation curves
    'cc.CurveRange', 'cc.GradientRange', 'cc.Gradient',
    'cc.ColorKey', 'cc.AlphaKey',
    'cc.RealCurve', 'cc.RealKeyframeValue',

    // Particle modules
    'cc.VelocityOvertimeModule', 'cc.TrailModule',
    'cc.TextureAnimationModule', 'cc.SizeOvertimeModule',
    'cc.ShapeModule', 'cc.RotationOvertimeModule',
    'cc.ParticleSystemRenderer', 'cc.NoiseModule',
    'cc.LimitVelocityOvertimeModule', 'cc.ForceOvertimeModule',
    'cc.ColorOvertimeModule', 'cc.Burst',

    // Editor/Build
    'cc.ModelBakeSettings', 'cc.StaticLightSettings',
    'cc.TargetInfo', 'CCPropertyOverrideInfo'
]);

// Important components worth keeping
const IMPORTANT_COMPONENTS = new Set([
    'cc.Camera', 'cc.DirectionalLight', 'cc.PointLight', 'cc.SpotLight',
    'cc.MeshRenderer', 'cc.SkinnedMeshRenderer',
    'cc.Sprite', 'cc.Label', 'cc.Button', 'cc.Widget',
    'cc.RigidBody', 'cc.BoxCollider', 'cc.SphereCollider', 'cc.CapsuleCollider',
    'cc.ParticleSystem', 'cc.Animation', 'cc.AudioSource',
    'cc.UITransform', 'cc.RenderRoot2D', 'cc.Canvas', 'cc.UIOpacity'
]);

export class TypeFilter {
    #customNoiseTypes = new Set();

    /**
     * Add custom noise types (Open for extension)
     * @param {string[]} types
     */
    addNoiseTypes(types) {
        types.forEach(t => this.#customNoiseTypes.add(t));
    }

    /**
     * Check if type is noise (should be filtered out)
     */
    isNoise(type) {
        return NOISE_TYPES.has(type) || this.#customNoiseTypes.has(type);
    }

    /**
     * Check if type is an important built-in component
     */
    isImportant(type) {
        return IMPORTANT_COMPONENTS.has(type);
    }

    /**
     * Check if type is a custom script
     */
    isCustomScript(type) {
        return !type.startsWith('cc.') && /^[a-zA-Z0-9+/]{15,}$/.test(type);
    }

    /**
     * Get all noise types (for debugging/stats)
     */
    static get noiseTypes() {
        return [...NOISE_TYPES];
    }

    /**
     * Get all important types
     */
    static get importantTypes() {
        return [...IMPORTANT_COMPONENTS];
    }
}
