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
/** CurveRange in Constant mode — the only fields the engine serializes for it */
function curve(constant = 0) {
    return { __type__: 'cc.CurveRange', mode: 0, constant, multiplier: 1 };
}
/** GradientRange in Color mode — serializes only [_mode, color] */
function gradient() {
    return { __type__: 'cc.GradientRange', _mode: 0, color: color() };
}
/** StaticLightSettings — standalone object every light references by id */
function staticLightSettings() {
    return {
        __type__: 'cc.StaticLightSettings',
        _baked: false,
        _editorOnly: false,
        _castShadow: false
    };
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

    // _cameraComponent defaults to null: the engine does NOT self-wire it —
    // editor "Create → Canvas" wires it only because it also creates a Camera
    // child node. Wire via {"$component": ...} after adding.
    'cc.Canvas': () => ({
        component: {
            ...head('cc.Canvas'),
            _cameraComponent: null,
            _alignCanvasWithScreen: true,
            _id: ''
        }
    }),

    // @requireComponent(cc.Widget) — add a cc.Widget on the node first.
    'cc.SafeArea': () => ({
        component: {
            ...head('cc.SafeArea'),
            _symmetric: true,
            _id: ''
        }
    }),

    // Companion requirement (not extras): Mask serializes no _graphics ref —
    // at onLoad it addComponent's a cc.Graphics sibling (types 0-2 GRAPHICS_*)
    // or cc.Sprite (type 3 SPRITE_STENCIL), which the editor then saves on the
    // same node. Add a cc.Graphics sibling with _fillColor alpha 0 (the exact
    // values Mask._createGraphics sets) to match editor output.
    'cc.Mask': () => ({
        component: {
            ...head('cc.Mask'),
            _type: 0,
            _inverted: false,
            _segments: 64,
            _alphaThreshold: 0.1,
            _id: ''
        }
    }),

    // _lineJoin 2 = MITER, _lineCap 0 = BUTT. _fillColor is the engine default
    // (opaque white); as a Mask companion set _fillColor alpha to 0.
    'cc.Graphics': () => ({
        component: {
            ...head('cc.Graphics'),
            _customMaterial: null,
            _srcBlendFactor: 2,
            _dstBlendFactor: 4,
            _color: color(),
            _lineWidth: 1,
            _strokeColor: color(0, 0, 0),
            _lineJoin: 2,
            _lineCap: 0,
            _fillColor: color(),
            _miterLimit: 10,
            _id: ''
        }
    }),

    // _barSprite (the bar cc.Sprite, usually on a child node) is never
    // self-wired — wire via {"$component": ...} after adding.
    // _mode: 0 HORIZONTAL, 1 VERTICAL, 2 FILLED.
    'cc.ProgressBar': () => ({
        component: {
            ...head('cc.ProgressBar'),
            _barSprite: null,
            _mode: 0,
            _totalLength: 1,
            _progress: 0.1,
            _reverse: false,
            _id: ''
        }
    }),

    // _layoutType: 0 NONE, 1 HORIZONTAL, 2 VERTICAL, 3 GRID;
    // _resizeMode: 0 NONE, 1 CONTAINER, 2 CHILDREN.
    'cc.Layout': () => ({
        component: {
            ...head('cc.Layout'),
            _resizeMode: 0,
            _layoutType: 0,
            _cellSize: size(40, 40),
            _startAxis: 0,
            _paddingLeft: 0,
            _paddingRight: 0,
            _paddingTop: 0,
            _paddingBottom: 0,
            _spacingX: 0,
            _spacingY: 0,
            _verticalDirection: 1,
            _horizontalDirection: 0,
            _constraint: 0,
            _constraintNum: 2,
            _affectedByScale: false,
            _isAlign: false,
            _id: ''
        }
    }),

    // No serialized fields; blocks input over the node's UITransform rect.
    'cc.BlockInputEvents': () => ({
        component: {
            ...head('cc.BlockInputEvents'),
            _id: ''
        }
    }),

    // RichText defaults differ from cc.Label: align LEFT(0)/TOP(0), and
    // _string is the engine's demo markup.
    'cc.RichText': () => ({
        component: {
            ...head('cc.RichText'),
            _lineHeight: 40,
            _string: '<color=#00ff00>Rich</color><color=#0fffff>Text</color>',
            _horizontalAlign: 0,
            _verticalAlign: 0,
            _fontSize: 40,
            _fontColor: color(),
            _maxWidth: 0,
            _fontFamily: 'Arial',
            _font: null,
            _isSystemFontUsed: true,
            _userDefinedFont: null,
            _cacheMode: 0,
            _imageAtlas: null,
            _handleTouchEvent: true,
            _id: ''
        }
    }),

    // Deprecated since 3.8.2 — a pure delegate shell onto Label.outlineColor/
    // outlineWidth; nothing beyond the head is serialized. Prefer setting
    // _enableOutline/_outlineColor/_outlineWidth on cc.Label directly.
    // @requireComponent(cc.Label).
    'cc.LabelOutline': () => ({
        component: {
            ...head('cc.LabelOutline'),
            _id: ''
        }
    }),

    // _handle (a cc.Sprite on the handle child) is never self-wired — wire
    // via {"$component": ...}. _direction: 0 Horizontal, 1 Vertical.
    'cc.Slider': () => ({
        component: {
            ...head('cc.Slider'),
            slideEvents: [],
            _handle: null,
            _direction: 0,
            _progress: 0.1,
            _id: ''
        }
    }),

    // _type: 0 Static, 1 Kinematic, 2 Dynamic (default), 3 Animated.
    'cc.RigidBody2D': () => ({
        component: {
            ...head('cc.RigidBody2D'),
            enabledContactListener: false,
            bullet: false,
            awakeOnLoad: true,
            _group: 1,
            _type: 2,
            _allowSleep: true,
            _gravityScale: 1,
            _linearDamping: 0,
            _angularDamping: 0,
            _linearVelocity: vec2(0, 0),
            _angularVelocity: 0,
            _fixedRotation: false,
            _id: ''
        }
    }),

    // Collider2D base fields (tag.._offset) shared by all 2D colliders.
    // A RigidBody2D on the node is optional (static collider without one).
    'cc.BoxCollider2D': () => ({
        component: {
            ...head('cc.BoxCollider2D'),
            tag: 0,
            _group: 1,
            _density: 1,
            _sensor: false,
            _friction: 0.2,
            _restitution: 0,
            _offset: vec2(0, 0),
            _size: size(1, 1),
            _id: ''
        }
    }),

    'cc.CircleCollider2D': () => ({
        component: {
            ...head('cc.CircleCollider2D'),
            tag: 0,
            _group: 1,
            _density: 1,
            _sensor: false,
            _friction: 0.2,
            _restitution: 0,
            _offset: vec2(0, 0),
            _radius: 1,
            _id: ''
        }
    }),

    // Default points = the engine's unit quad (freshly added component), CCW.
    'cc.PolygonCollider2D': () => ({
        component: {
            ...head('cc.PolygonCollider2D'),
            tag: 0,
            _group: 1,
            _density: 1,
            _sensor: false,
            _friction: 0.2,
            _restitution: 0,
            _offset: vec2(0, 0),
            _points: [vec2(-1, -1), vec2(1, -1), vec2(1, 1), vec2(-1, 1)],
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

    // _direction: EAxisDirection Y_AXIS = 1
    'cc.CylinderCollider': () => ({
        component: {
            ...head('cc.CylinderCollider'),
            _material: null,
            _isTrigger: false,
            _center: vec3(0, 0, 0),
            _radius: 0.5,
            _height: 2,
            _direction: 1,
            _id: ''
        }
    }),

    // _mesh is usually wired to the rendered mesh after adding; _convex=false
    // means concave (static-only in most backends — needs convex=true or a
    // static rigid body to collide dynamically).
    'cc.MeshCollider': () => ({
        component: {
            ...head('cc.MeshCollider'),
            _material: null,
            _isTrigger: false,
            _center: vec3(0, 0, 0),
            _mesh: null,
            _convex: false,
            _id: ''
        }
    }),

    // Defaults from engine camera-component.ts initializers: ClearFlag
    // SOLID_COLOR=7, Aperture F16_0=19, Shutter D125=7, ISO100=0.
    // _visibility = CAMERA_DEFAULT_MASK (engine initializer; the editor's
    // create-node flow ships 1822425087 — same mask minus reserved bit 31).
    'cc.Camera': () => ({
        component: {
            ...head('cc.Camera'),
            _projection: 1,
            _priority: 0,
            _fov: 45,
            _fovAxis: 0,
            _orthoHeight: 10,
            _near: 1,
            _far: 1000,
            _color: color(51, 51, 51),
            _depth: 1,
            _stencil: 0,
            _clearFlags: 7,
            _rect: { __type__: 'cc.Rect', x: 0, y: 0, width: 1, height: 1 },
            _aperture: 19,
            _shutter: 7,
            _iso: 0,
            _screenScale: 1,
            _visibility: -325058561,
            _targetTexture: null,
            _postProcess: null,
            _usePostProcess: false,
            _cameraType: -1,
            _trackingType: 0,
            _id: ''
        }
    }),

    // _staticSettings is a standalone cc.StaticLightSettings referenced by id.
    // _illuminanceHDR/_illuminance is a formerlySerializedAs pair the editor
    // writes with equal values — kept in sync by PAIRED_FIELDS on writes.
    // _illuminanceLDR = 65000 * standardExposureValue (1/38400).
    'cc.DirectionalLight': () => ({
        component: {
            ...head('cc.DirectionalLight'),
            _color: color(),
            _useColorTemperature: false,
            _colorTemperature: 6550,
            _staticSettings: { __ref__: 0 },
            _visibility: -325058561,
            _illuminanceHDR: 65000,
            _illuminance: 65000,
            _illuminanceLDR: 1.6927083333333335,
            _shadowEnabled: false,
            _shadowPcf: 0,
            _shadowBias: 0.00001,
            _shadowNormalBias: 0,
            _shadowSaturation: 1,
            _shadowDistance: 50,
            _shadowInvisibleOcclusionRange: 200,
            _csmLevel: 4,
            _csmLayerLambda: 0.75,
            _csmOptimizationMode: 2,
            _csmAdvancedOptions: false,
            _csmLayersTransition: false,
            _csmTransitionRange: 0.05,
            _shadowFixedArea: false,
            _shadowNear: 0.1,
            _shadowFar: 10,
            _shadowOrthoSize: 5,
            _id: ''
        },
        extras: [staticLightSettings()]
    }),

    // _luminanceHDR = 1700 / nt2lm(0.15) = 1700 / (4π²·0.15²);
    // _luminanceLDR = luminanceHDR * (1/38400) * 10000. The HDR/plain pair
    // mirrors like DirectionalLight's illuminance (PAIRED_FIELDS).
    'cc.SphereLight': () => ({
        component: {
            ...head('cc.SphereLight'),
            _color: color(),
            _useColorTemperature: false,
            _colorTemperature: 6550,
            _staticSettings: { __ref__: 0 },
            _visibility: -325058561,
            _size: 0.15,
            _luminanceHDR: 1913.8445799108247,
            _luminance: 1913.8445799108247,
            _luminanceLDR: 498.3970260184439,
            _term: 0,
            _range: 1,
            _id: ''
        },
        extras: [staticLightSettings()]
    }),

    // Same base as SphereLight plus spot/shadow fields.
    'cc.SpotLight': () => ({
        component: {
            ...head('cc.SpotLight'),
            _color: color(),
            _useColorTemperature: false,
            _colorTemperature: 6550,
            _staticSettings: { __ref__: 0 },
            _visibility: -325058561,
            _size: 0.15,
            _luminanceHDR: 1913.8445799108247,
            _luminance: 1913.8445799108247,
            _luminanceLDR: 498.3970260184439,
            _term: 0,
            _range: 1,
            _spotAngle: 60,
            _angleAttenuationStrength: 0,
            _shadowEnabled: false,
            _shadowPcf: 0,
            _shadowBias: 0.00001,
            _shadowNormalBias: 0,
            _id: ''
        },
        extras: [staticLightSettings()]
    }),

    'cc.AudioSource': () => ({
        component: {
            ...head('cc.AudioSource'),
            _clip: null,
            _loop: false,
            _playOnAwake: true,
            _volume: 1,
            _id: ''
        }
    }),

    // _sortingLayer stores the layer id (SortingLayers default = 0)
    'cc.Sorting': () => ({
        component: {
            ...head('cc.Sorting'),
            _sortingLayer: 0,
            _sortingOrder: 0,
            _id: ''
        }
    }),

    // No serialized fields of its own — bridges a 3D ModelRenderer on the
    // same node into the UI render flow.
    'cc.UIMeshRenderer': () => ({
        component: {
            ...head('cc.UIMeshRenderer'),
            _id: ''
        }
    }),

    // The 3D sprite. The editor always assigns the builtin
    // default-sprite-renderer-material (stable builtin uuid, present in the
    // factory prefab and every editor-saved sample); an empty _materials
    // array renders nothing.
    'cc.SpriteRenderer': () => ({
        component: {
            ...head('cc.SpriteRenderer'),
            _materials: [{
                __uuid__: 'ade8a15a-dcca-4b3c-84c6-f6476ac875bb',
                __expectedType__: 'cc.Material'
            }],
            _visFlags: 0,
            _spriteFrame: null,
            _mode: 0,
            _color: color(),
            _flipX: false,
            _flipY: false,
            _size: vec2(0, 0),
            _id: ''
        }
    }),

    // Engine default width/height is 0 — an invisible billboard; 1 chosen
    // deliberately (same precedent as cc.Line width).
    'cc.Billboard': () => ({
        component: {
            ...head('cc.Billboard'),
            _texture: null,
            _height: 1,
            _width: 1,
            _rotation: 0,
            _techIndex: 0,
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

    // cc.Animation fields + _useBakedAnimation/_sockets. Socket entries are
    // standalone cc.SkeletalAnimation.Socket objects, but the default is [].
    'cc.SkeletalAnimation': () => ({
        component: {
            ...head('cc.SkeletalAnimation'),
            playOnLoad: false,
            _clips: [],
            _defaultClip: null,
            _useBakedAnimation: true,
            _sockets: [],
            _id: ''
        }
    }),

    // Field set/order from editor-saved 3.8 samples (two independent projects,
    // identical); values are engine 3.8.7 defaults. startSize aliases
    // startSizeX and startRotation aliases startRotationZ — the editor
    // serializes both keys pointing at the SAME CurveRange (same __ref__).
    // enableCulling is the deprecated serialized alias of _dataCulling
    // (PAIRED_FIELDS keeps them equal). renderer is NOT a component — a
    // referenced cc.ParticleSystemRenderer data object without head fields.
    // The editor assigns the builtin default-particle-material and
    // Default-Particle.png on a fresh component (uuids from editor/assets).
    'cc.ParticleSystem': () => ({
        component: {
            ...head('cc.ParticleSystem'),
            _materials: [
                { __uuid__: 'c0143906-9aed-447e-9436-2ae8512d1b6e', __expectedType__: 'cc.Material' }
            ],
            _visFlags: 0,
            startColor: { __ref__: 0 },
            scaleSpace: 1,
            startSize3D: false,
            startSizeX: { __ref__: 1 },
            startSize: { __ref__: 1 },
            startSizeY: { __ref__: 2 },
            startSizeZ: { __ref__: 3 },
            startSpeed: { __ref__: 4 },
            startRotation3D: false,
            startRotationX: { __ref__: 5 },
            startRotationY: { __ref__: 6 },
            startRotationZ: { __ref__: 7 },
            startRotation: { __ref__: 7 },
            startDelay: { __ref__: 8 },
            startLifetime: { __ref__: 9 },
            duration: 5,
            loop: true,
            simulationSpeed: 1,
            playOnAwake: true,
            gravityModifier: { __ref__: 10 },
            rateOverTime: { __ref__: 11 },
            rateOverDistance: { __ref__: 12 },
            bursts: [],
            _renderCulling: false,
            _cullingMode: 0,
            _aabbHalfX: 0,
            _aabbHalfY: 0,
            _aabbHalfZ: 0,
            _dataCulling: false,
            enableCulling: false,
            _colorOverLifetimeModule: { __ref__: 13 },
            _shapeModule: { __ref__: 15 },
            _sizeOvertimeModule: { __ref__: 17 },
            _velocityOvertimeModule: { __ref__: 22 },
            _forceOvertimeModule: { __ref__: 27 },
            _limitVelocityOvertimeModule: { __ref__: 31 },
            _rotationOvertimeModule: { __ref__: 36 },
            _textureAnimationModule: { __ref__: 40 },
            _noiseModule: { __ref__: 43 },
            _trailModule: { __ref__: 44 },
            renderer: { __ref__: 49 },
            _prewarm: false,
            _capacity: 100,
            _simulationSpace: 1,
            _id: ''
        },
        extras: [
            /* 0 */ gradient(),                                  // startColor
            /* 1 */ curve(1),                                    // startSizeX (+ startSize)
            /* 2 */ curve(0),                                    // startSizeY
            /* 3 */ curve(0),                                    // startSizeZ
            /* 4 */ curve(5),                                    // startSpeed
            /* 5 */ curve(0),                                    // startRotationX
            /* 6 */ curve(0),                                    // startRotationY
            /* 7 */ curve(0),                                    // startRotationZ (+ startRotation)
            /* 8 */ curve(0),                                    // startDelay
            /* 9 */ curve(5),                                    // startLifetime
            /* 10 */ curve(0),                                   // gravityModifier
            /* 11 */ curve(10),                                  // rateOverTime
            /* 12 */ curve(0),                                   // rateOverDistance
            /* 13 */ {
                __type__: 'cc.ColorOvertimeModule',
                _enable: false,
                color: { __ref__: 14 }
            },
            /* 14 */ gradient(),
            /* 15 */ {
                __type__: 'cc.ShapeModule',
                _enable: false,
                _shapeType: 2,                                   // Cone
                shapeType: 2,                                    // getter pair, kept equal
                emitFrom: 3,                                     // Volume
                alignToDirection: false,
                randomDirectionAmount: 0,
                sphericalDirectionAmount: 0,
                randomPositionAmount: 0,
                radius: 1,
                radiusThickness: 1,
                arcMode: 0,
                arcSpread: 0,
                arcSpeed: { __ref__: 16 },
                length: 5,
                boxThickness: vec3(0, 0, 0),
                _position: vec3(0, 0, 0),
                _rotation: vec3(0, 0, 0),
                _scale: vec3(1, 1, 1),
                _arc: 6.283185307179586,                         // toRadian(360)
                _angle: 0.4363323129985824                       // toRadian(25)
            },
            /* 16 */ curve(0),
            /* 17 */ {
                __type__: 'cc.SizeOvertimeModule',
                _enable: false,
                separateAxes: false,
                size: { __ref__: 18 },
                x: { __ref__: 19 },
                y: { __ref__: 20 },
                z: { __ref__: 21 }
            },
            /* 18 */ curve(0),
            /* 19 */ curve(0),
            /* 20 */ curve(0),
            /* 21 */ curve(0),
            /* 22 */ {
                __type__: 'cc.VelocityOvertimeModule',
                _enable: false,
                x: { __ref__: 23 },
                y: { __ref__: 24 },
                z: { __ref__: 25 },
                speedModifier: { __ref__: 26 },
                space: 1
            },
            /* 23 */ curve(0),
            /* 24 */ curve(0),
            /* 25 */ curve(0),
            /* 26 */ curve(1),
            /* 27 */ {
                __type__: 'cc.ForceOvertimeModule',
                _enable: false,
                x: { __ref__: 28 },
                y: { __ref__: 29 },
                z: { __ref__: 30 },
                space: 1
            },
            /* 28 */ curve(0),
            /* 29 */ curve(0),
            /* 30 */ curve(0),
            /* 31 */ {
                __type__: 'cc.LimitVelocityOvertimeModule',
                _enable: false,
                limitX: { __ref__: 32 },
                limitY: { __ref__: 33 },
                limitZ: { __ref__: 34 },
                limit: { __ref__: 35 },
                dampen: 3,
                separateAxes: false,
                space: 1
            },
            /* 32 */ curve(0),
            /* 33 */ curve(0),
            /* 34 */ curve(0),
            /* 35 */ curve(0),
            /* 36 */ {
                __type__: 'cc.RotationOvertimeModule',
                _enable: false,
                _separateAxes: false,
                x: { __ref__: 37 },
                y: { __ref__: 38 },
                z: { __ref__: 39 }
            },
            /* 37 */ curve(0),
            /* 38 */ curve(0),
            /* 39 */ curve(0),
            /* 40 */ {
                __type__: 'cc.TextureAnimationModule',
                _enable: false,
                _numTilesX: 0,
                numTilesX: 0,                                    // getter pair, kept equal
                _numTilesY: 0,
                numTilesY: 0,                                    // getter pair, kept equal
                _mode: 0,
                animation: 0,
                frameOverTime: { __ref__: 41 },
                startFrame: { __ref__: 42 },
                cycleCount: 0,
                _flipU: 0,
                _flipV: 0,
                _uvChannelMask: -1,
                randomRow: false,
                rowIndex: 0
            },
            /* 41 */ curve(0),
            /* 42 */ curve(0),
            /* 43 */ {
                __type__: 'cc.NoiseModule',
                _enable: false,
                _strengthX: 10,
                _strengthY: 10,
                _strengthZ: 10,
                _noiseSpeedX: 0,
                _noiseSpeedY: 0,
                _noiseSpeedZ: 0,
                _noiseFrequency: 1,
                _remapX: 0,
                _remapY: 0,
                _remapZ: 0,
                _octaves: 1,
                _octaveMultiplier: 0.5,
                _octaveScale: 2
            },
            /* 44 */ {
                __type__: 'cc.TrailModule',
                _enable: false,
                mode: 0,
                // engine class default is 0, but every untouched editor-saved
                // trail module serializes constant 1 — editor value chosen
                lifeTime: { __ref__: 45 },
                _minParticleDistance: 0.1,
                existWithParticles: true,
                textureMode: 0,
                widthFromParticle: true,
                widthRatio: { __ref__: 46 },
                colorFromParticle: false,
                colorOverTrail: { __ref__: 47 },
                colorOvertime: { __ref__: 48 },
                _space: 0,
                _particleSystem: { __self_component__: true }    // back-ref to THIS component
            },
            /* 45 */ curve(1),
            /* 46 */ curve(0),
            /* 47 */ gradient(),
            /* 48 */ gradient(),
            /* 49 */ {                                           // renderer — data object, NO head fields
                __type__: 'cc.ParticleSystemRenderer',
                _renderMode: 0,                                  // Billboard
                _velocityScale: 1,
                _lengthScale: 1,
                _mesh: null,
                _cpuMaterial: null,
                _gpuMaterial: null,
                _mainTexture: { __uuid__: 'b5b27ab1-e740-4398-b407-848fc2b2c897@6c48a', __expectedType__: 'cc.Texture2D' },
                _useGPU: false,
                _alignSpace: 2                                   // View
            }
        ]
    }),

    // UIRenderer subclass: head is followed by the four UIRenderer fields
    // (_customMaterial/_srcBlendFactor/_dstBlendFactor/_color); verified
    // against 3 editor-saved samples. _preview/preview is a getter pair
    // (PAIRED_FIELDS). Renders nothing until a .plist _file is set or
    // _custom=true with a _spriteFrame. @requireComponent(cc.UITransform).
    'cc.ParticleSystem2D': () => ({
        component: {
            ...head('cc.ParticleSystem2D'),
            _customMaterial: null,
            _srcBlendFactor: 2,
            _dstBlendFactor: 4,
            _color: color(),
            duration: -1,
            emissionRate: 10,
            life: 1,
            lifeVar: 0,
            angle: 90,
            angleVar: 20,
            startSize: 50,
            startSizeVar: 0,
            endSize: 0,
            endSizeVar: 0,
            startSpin: 0,
            startSpinVar: 0,
            endSpin: 0,
            endSpinVar: 0,
            sourcePos: vec2(0, 0),
            posVar: vec2(0, 0),
            emitterMode: 0,
            gravity: vec2(0, 0),
            speed: 180,
            speedVar: 50,
            tangentialAccel: 80,
            tangentialAccelVar: 0,
            radialAccel: 0,
            radialAccelVar: 0,
            rotationIsDir: false,
            startRadius: 0,
            startRadiusVar: 0,
            endRadius: 0,
            endRadiusVar: 0,
            rotatePerS: 0,
            rotatePerSVar: 0,
            playOnLoad: true,
            autoRemoveOnFinish: false,
            _preview: true,
            preview: true,
            _custom: false,
            _file: null,
            _spriteFrame: null,
            _totalParticles: 150,
            _startColor: color(255, 255, 255, 255),
            _startColorVar: color(0, 0, 0, 0),
            _endColor: color(255, 255, 255, 0),
            _endColorVar: color(0, 0, 0, 0),
            _positionType: 0,
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
