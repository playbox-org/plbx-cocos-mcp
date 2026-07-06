/**
 * TypeFilter - Open/Closed Principle: Extensible type filtering
 *
 * SOLID: O - New noise types can be added without modifying core logic
 * SOLID: S - Only responsible for type classification
 */

// Inlined value types (primitives) - shared with SceneParser
export const VALUE_TYPES = new Set([
    'cc.Vec3', 'cc.Vec2', 'cc.Vec4', 'cc.Quat',
    'cc.Color', 'cc.Size', 'cc.Rect'
]);

// Noise types - data that doesn't help LLM understand scene structure
const NOISE_TYPES = new Set([
    ...VALUE_TYPES,

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
     * Check if type is a custom script
     */
    isCustomScript(type) {
        return !type.startsWith('cc.') && /^[a-zA-Z0-9+/]{15,}$/.test(type);
    }
}
