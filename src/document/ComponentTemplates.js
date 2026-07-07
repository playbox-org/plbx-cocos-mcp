/**
 * ComponentTemplates - Full serialized component objects for Cocos Creator 3.8.x
 *
 * Field sets and ordering are copied from components serialized by the real
 * editor (project-example/zombie-miner, CC 3.8.7); values are engine defaults.
 * The engine tolerates missing fields, but templates are intentionally
 * complete so the editor re-saves our output without a diff.
 *
 * Each factory returns { component, extras } where extras are auxiliary
 * objects the component references via local `{__ref__: i}` placeholders
 * (index into extras). operations.js appends extras to the document and
 * rewrites placeholders into real `{__id__}` refs.
 */

function vec2(x = 0, y = 0) {
    return { __type__: 'cc.Vec2', x, y };
}
function vec3(x = 0, y = 0, z = 0) {
    return { __type__: 'cc.Vec3', x, y, z };
}
function color(r = 255, g = 255, b = 255, a = 255) {
    return { __type__: 'cc.Color', r, g, b, a };
}
function size(width = 100, height = 100) {
    return { __type__: 'cc.Size', width, height };
}

/** Common serialized head shared by every component */
function head(type) {
    return {
        __type__: type,
        _name: '',
        _objFlags: 0,
        __editorExtras__: {},
        node: null,       // wired by operations.js
        _enabled: true,
        __prefab: null    // wired by operations.js (CompPrefabInfo in prefab files)
    };
}

const TEMPLATES = {
    'cc.UITransform': () => ({
        component: {
            ...head('cc.UITransform'),
            _contentSize: size(100, 100),
            _anchorPoint: vec2(0.5, 0.5),
            _id: ''
        }
    }),

    'cc.Sprite': () => ({
        component: {
            ...head('cc.Sprite'),
            _customMaterial: null,
            _srcBlendFactor: 2,
            _dstBlendFactor: 4,
            _color: color(),
            _spriteFrame: null,
            _type: 0,
            _fillType: 0,
            _sizeMode: 1,
            _fillCenter: vec2(0, 0),
            _fillStart: 0,
            _fillRange: 0,
            _isTrimmedMode: true,
            _useGrayscale: false,
            _atlas: null,
            _id: ''
        }
    }),

    'cc.Label': () => ({
        component: {
            ...head('cc.Label'),
            _customMaterial: null,
            _srcBlendFactor: 2,
            _dstBlendFactor: 4,
            _color: color(),
            _string: 'Label',
            _horizontalAlign: 1,
            _verticalAlign: 1,
            _actualFontSize: 40,
            _fontSize: 40,
            _fontFamily: 'Arial',
            _lineHeight: 40,
            _overflow: 0,
            _enableWrapText: true,
            _font: null,
            _isSystemFontUsed: true,
            _spacingX: 0,
            _isItalic: false,
            _isBold: false,
            _isUnderline: false,
            _underlineHeight: 2,
            _cacheMode: 0,
            _enableOutline: false,
            _outlineColor: color(0, 0, 0),
            _outlineWidth: 2,
            _enableShadow: false,
            _shadowColor: color(0, 0, 0),
            _shadowOffset: vec2(2, 2),
            _shadowBlur: 2,
            _id: ''
        }
    }),

    'cc.UIOpacity': () => ({
        component: {
            ...head('cc.UIOpacity'),
            _opacity: 255,
            _id: ''
        }
    }),

    'cc.RenderRoot2D': () => ({
        component: {
            ...head('cc.RenderRoot2D'),
            _id: ''
        }
    }),

    'cc.Button': () => ({
        component: {
            ...head('cc.Button'),
            clickEvents: [],
            _interactable: true,
            _transition: 0,
            _normalColor: color(214, 214, 214),
            _hoverColor: color(211, 211, 211),
            _pressedColor: color(255, 255, 255),
            _disabledColor: color(124, 124, 124),
            _normalSprite: null,
            _hoverSprite: null,
            _pressedSprite: null,
            _disabledSprite: null,
            _duration: 0.1,
            _zoomScale: 1.2,
            _target: { __self_node__: true }, // editor points target at own node
            _id: ''
        }
    }),

    'cc.Widget': () => ({
        component: {
            ...head('cc.Widget'),
            _alignFlags: 0,
            _target: null,
            _left: 0,
            _right: 0,
            _top: 0,
            _bottom: 0,
            _horizontalCenter: 0,
            _verticalCenter: 0,
            _isAbsLeft: true,
            _isAbsRight: true,
            _isAbsTop: true,
            _isAbsBottom: true,
            _isAbsHorizontalCenter: true,
            _isAbsVerticalCenter: true,
            _originalWidth: 0,
            _originalHeight: 0,
            _alignMode: 2,
            _lockFlags: 0,
            _id: ''
        }
    }),

    'cc.MeshRenderer': () => ({
        component: {
            ...head('cc.MeshRenderer'),
            _materials: [],
            _visFlags: 0,
            bakeSettings: { __ref__: 0 },
            _mesh: null,
            _shadowCastingMode: 0,
            _shadowReceivingMode: 1,
            _shadowBias: 0,
            _shadowNormalBias: 0,
            _reflectionProbeId: -1,
            _reflectionProbeBlendId: -1,
            _reflectionProbeBlendWeight: 0,
            _enabledGlobalStandardSkinObject: false,
            _enableMorph: true,
            _id: ''
        },
        extras: [{
            __type__: 'cc.ModelBakeSettings',
            texture: null,
            uvParam: { __type__: 'cc.Vec4', x: 0, y: 0, z: 0, w: 0 },
            _bakeable: false,
            _castShadow: false,
            _receiveShadow: false,
            _recieveShadow: false,
            _lightmapSize: 64,
            _useLightProbe: false,
            _bakeToLightProbe: true,
            _reflectionProbeType: 0,
            _bakeToReflectionProbe: true
        }]
    }),

    // Same field set as cc.MeshRenderer plus _skeleton/_skinningRoot
    // (verified against editor-saved prefabs in project-example).
    // _skinningRoot is typically wired to the model's skeleton root node
    // via {"$node": ...} after adding.
    'cc.SkinnedMeshRenderer': () => ({
        component: {
            ...head('cc.SkinnedMeshRenderer'),
            _materials: [],
            _visFlags: 0,
            bakeSettings: { __ref__: 0 },
            _mesh: null,
            _shadowCastingMode: 0,
            _shadowReceivingMode: 1,
            _shadowBias: 0,
            _shadowNormalBias: 0,
            _reflectionProbeId: -1,
            _reflectionProbeBlendId: -1,
            _reflectionProbeBlendWeight: 0,
            _enabledGlobalStandardSkinObject: false,
            _enableMorph: true,
            _skeleton: null,
            _skinningRoot: null,
            _id: ''
        },
        extras: [{
            __type__: 'cc.ModelBakeSettings',
            texture: null,
            uvParam: { __type__: 'cc.Vec4', x: 0, y: 0, z: 0, w: 0 },
            _bakeable: false,
            _castShadow: false,
            _receiveShadow: false,
            _recieveShadow: false,
            _lightmapSize: 64,
            _useLightProbe: false,
            _bakeToLightProbe: true,
            _reflectionProbeType: 0,
            _bakeToReflectionProbe: true
        }]
    }),

    // Field set/order from an editor-saved sample (project-example
    // Rope.prefab); _width/_color are standalone cc.CurveRange /
    // cc.GradientRange objects referenced by id, exactly as the editor
    // serializes them. CurveRange in Constant mode serializes only
    // [mode, constant, multiplier] (engine _onBeforeSerialize). Width
    // defaults to 1 — the engine default 0 renders an invisible line.
    'cc.Line': () => ({
        component: {
            ...head('cc.Line'),
            _materials: [],
            _visFlags: 0,
            _texture: null,
            _material: null,
            _worldSpace: false,
            _positions: [],
            _width: { __ref__: 0 },
            _color: { __ref__: 1 },
            _tile: vec2(1, 1),
            _offset: vec2(0, 0),
            _id: ''
        },
        extras: [
            { __type__: 'cc.CurveRange', mode: 0, constant: 1, multiplier: 1 },
            { __type__: 'cc.GradientRange', _mode: 0, color: color() }
        ]
    }),

    'cc.BoxCollider': () => ({
        component: {
            ...head('cc.BoxCollider'),
            _material: null,
            _isTrigger: false,
            _center: vec3(0, 0, 0),
            _size: vec3(1, 1, 1),
            _id: ''
        }
    }),

    'cc.SphereCollider': () => ({
        component: {
            ...head('cc.SphereCollider'),
            _material: null,
            _isTrigger: false,
            _center: vec3(0, 0, 0),
            _radius: 0.5,
            _id: ''
        }
    }),

    // No sample in the game project — field set derived from the engine's
    // capsule-collider.ts. Verified: the 3.8.7 editor re-saves it unchanged.
    'cc.CapsuleCollider': () => ({
        component: {
            ...head('cc.CapsuleCollider'),
            _material: null,
            _isTrigger: false,
            _center: vec3(0, 0, 0),
            _radius: 0.5,
            _cylinderHeight: 1,
            _direction: 1,
            _id: ''
        }
    }),

    'cc.RigidBody': () => ({
        component: {
            ...head('cc.RigidBody'),
            _group: 1,
            _type: 2,
            _mass: 1,
            _allowSleep: true,
            _linearDamping: 0.1,
            _angularDamping: 0.1,
            _useGravity: true,
            _linearFactor: vec3(1, 1, 1),
            _angularFactor: vec3(1, 1, 1),
            _id: ''
        }
    }),

    'cc.Animation': () => ({
        component: {
            ...head('cc.Animation'),
            playOnLoad: false,
            _clips: [],
            _defaultClip: null,
            _id: ''
        }
    }),

    // Field order matches the editor-saved sample in the golden scene.
    // The graph reference serializes TWICE (_graph + graph getter/setter pair);
    // operations.js keeps the two in sync on every write.
    'cc.animation.AnimationController': () => ({
        component: {
            ...head('cc.animation.AnimationController'),
            _graph: null,
            graph: null,
            _id: ''
        }
    })
};

/** Short aliases accepted by add_component: "Sprite" → "cc.Sprite" */
const ALIASES = new Map(
    Object.keys(TEMPLATES).map(full => [full.slice(3).toLowerCase(), full])
);
// cc.animation.* strip to "animation.animationcontroller" above — also accept
// the bare class name
ALIASES.set('animationcontroller', 'cc.animation.AnimationController');

/**
 * Resolve a user-supplied component type to a template key, or null when
 * the type is unknown (candidate for custom-script resolution).
 * @param {string} type
 * @returns {string|null}
 */
export function resolveTemplateType(type) {
    if (TEMPLATES[type]) return type;
    const viaAlias = ALIASES.get(String(type).toLowerCase());
    if (viaAlias) return viaAlias;
    if (type.startsWith('cc.')) {
        const stripped = ALIASES.get(type.slice(3).toLowerCase());
        if (stripped) return stripped;
    }
    return null;
}

export function templateTypes() {
    return Object.keys(TEMPLATES);
}

/**
 * Instantiate a fresh component template.
 * @param {string} type - Exact template key (use resolveTemplateType first)
 * @returns {{component: object, extras: object[]}}
 */
export function createComponent(type) {
    const factory = TEMPLATES[type];
    if (!factory) throw new Error(`No component template for "${type}"`);
    const { component, extras = [] } = factory();
    return { component, extras };
}

/**
 * Create a serialized custom-script component. The engine fills any fields
 * the script declares but we omit (defaults), so only user-provided
 * properties are written.
 * @param {string} compressedUuid - Script class id (compressed asset UUID)
 * @returns {{component: object, extras: object[]}}
 */
export function createScriptComponent(compressedUuid) {
    return { component: { ...head(compressedUuid), _id: '' }, extras: [] };
}
