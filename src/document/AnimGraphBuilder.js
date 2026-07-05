/**
 * AnimGraphBuilder - compile a compact spec into a full .animgraph document
 *
 * Mirrors the PrefabBuilder pattern: a ~20-line spec expands into the exact
 * object shapes the 3.8.7 editor serializes (field sets and defaults verified
 * against project-example/zombie-miner Player.animgraph and the engine
 * sources — see AnimGraphReader.js for the enum mappings).
 *
 * Objects are appended in canonical depth-first first-visit order (head →
 * layer → state machine → states with their motions/bindings → transitions
 * with their conditions/bindings → variables), so renumber() is an identity —
 * verified by tests.
 *
 * Spec shape:
 * {
 *   variables?: { Speed: {type: "float"|"boolean"|"integer"|"trigger", value?} },
 *   states: [{ name, clip: "Models/X.glb@subId"|path|uuid, speed? }],
 *   transitions: [{
 *     from, to,                    // state names; "Entry"/"Any"/"Exit" reserved
 *     when?: "Speed > 0.1",        // BinaryCondition (ops: == != < <= > >=)
 *     trigger?: "Jump",            // TriggerCondition
 *     duration?: 0.3,              // blend duration (from Motion/Any only)
 *     exit?: boolean,              // exitConditionEnabled; defaults to true
 *                                  //   for a Motion-source transition with no
 *                                  //   conditions (editor behavior), else false
 *     exitTime?: 1                 // _exitCondition (normalized exit time)
 *   }]
 * }
 */

import { randomUUID } from 'crypto';
import { SceneDocument } from './SceneDocument.js';
import { BINARY_OPERATORS } from './AnimGraphReader.js';

export class AnimGraphBuildError extends Error {}

const VARIABLE_TYPE_IDS = { float: 0, boolean: 1, integer: 3 };

/** Editor-only node placement in the graph editor (cosmetic, grid layout) */
function editorExtras(centerX, centerY) {
    const extras = { name: '', id: randomUUID(), clone: null };
    if (centerX !== undefined) {
        extras.centerX = centerX;
        extras.centerY = centerY;
    }
    return extras;
}

function eventBinding() {
    return { __type__: 'cc.animation.AnimationGraphEventBinding', methodName: '' };
}

export class AnimGraphBuilder {
    #assetIndex;

    /**
     * @param {object|null} assetIndex - AssetIndex for clip resolution
     */
    constructor(assetIndex = null) {
        this.#assetIndex = assetIndex;
    }

    /**
     * Compile a spec into an in-memory SceneDocument (canonical order, unsaved).
     * @param {object} spec
     * @returns {{doc: SceneDocument, notes: string[]}}
     */
    compile(spec) {
        if (!spec || typeof spec !== 'object') {
            throw new AnimGraphBuildError('spec must be an object');
        }
        const states = spec.states ?? [];
        if (!Array.isArray(states) || states.length === 0) {
            throw new AnimGraphBuildError('spec.states must be a non-empty array');
        }
        const variables = spec.variables ?? {};
        const notes = [];

        const objects = [];
        const push = (obj) => objects.push(obj) - 1;

        // --- skeleton: head → layer → state machine → Entry/Exit/Any
        const head = {
            __type__: 'cc.animation.AnimationGraph',
            _name: '',
            _objFlags: 0,
            __editorExtras__: {},
            _native: '',
            _layers: [{ __id__: 1 }],
            _variables: {}
        };
        push(head);
        push({
            __type__: 'cc.animation.Layer',
            _stateMachine: { __id__: 2 },
            name: '',
            weight: 1,
            mask: null,
            additive: false,
            _stashes: {}
        });
        const sm = {
            __type__: 'cc.animation.StateMachine',
            __editorExtras__: editorExtras(),
            _states: [],
            _transitions: [],
            _entryState: null,
            _exitState: null,
            _anyState: null
        };
        push(sm);

        const special = { Entry: [-125, 0], Exit: [125, 0], Any: [125, 0] };
        const stateIdx = new Map(); // name → {idx, isMotion}
        for (const [name, [x, y]] of Object.entries(special)) {
            const idx = push({
                __type__: 'cc.animation.State',
                __editorExtras__: editorExtras(x, y),
                name
            });
            stateIdx.set(name, { idx, isMotion: false });
        }
        sm._entryState = { __id__: stateIdx.get('Entry').idx };
        sm._exitState = { __id__: stateIdx.get('Exit').idx };
        sm._anyState = { __id__: stateIdx.get('Any').idx };

        // --- motion states (grid layout, purely cosmetic)
        states.forEach((s, i) => {
            if (!s?.name) throw new AnimGraphBuildError(`states[${i}] needs a "name"`);
            if (Object.hasOwn(special, s.name)) {
                throw new AnimGraphBuildError(`state name "${s.name}" is reserved (Entry/Exit/Any)`);
            }
            if (stateIdx.has(s.name)) {
                throw new AnimGraphBuildError(`duplicate state name "${s.name}"`);
            }
            if (!s.clip) throw new AnimGraphBuildError(`state "${s.name}" needs a "clip"`);

            const clipUuid = this.#resolveClip(s.clip, s.name);
            const motion = {
                __type__: 'cc.animation.Motion',
                __editorExtras__: editorExtras(-50 + (i % 4) * 150, 100 + Math.floor(i / 4) * 100),
                name: s.name,
                _components: [],
                motion: null,
                speed: s.speed ?? 1,
                speedMultiplier: '',
                speedMultiplierEnabled: false,
                transitionInEventBinding: null,
                transitionOutEventBinding: null
            };
            const idx = push(motion);
            motion.motion = { __id__: push({
                __type__: 'cc.animation.ClipMotion',
                __editorExtras__: editorExtras(),
                clip: { __uuid__: clipUuid, __expectedType__: 'cc.AnimationClip' }
            }) };
            motion.transitionInEventBinding = { __id__: push(eventBinding()) };
            motion.transitionOutEventBinding = { __id__: push(eventBinding()) };
            stateIdx.set(s.name, { idx, isMotion: true });
        });
        sm._states = [...stateIdx.values()].map(s => ({ __id__: s.idx }));

        // --- transitions
        for (const [i, t] of (spec.transitions ?? []).entries()) {
            const from = this.#endpoint(stateIdx, t.from, `transitions[${i}].from`);
            const to = this.#endpoint(stateIdx, t.to, `transitions[${i}].to`);
            if (t.from === 'Exit') throw new AnimGraphBuildError(`transitions[${i}]: cannot leave Exit`);
            if (t.to === 'Entry' || t.to === 'Any') {
                throw new AnimGraphBuildError(`transitions[${i}]: cannot target ${t.to}`);
            }

            // Entry (and plain states) get a bare Transition; Motion/Any
            // sources blend, so the editor serializes AnimationTransition
            // (verified: Player Entry→Idle vs Any→Jump)
            const blending = from.isMotion || t.from === 'Any';
            const transition = {
                __type__: blending ? 'cc.animation.AnimationTransition' : 'cc.animation.Transition',
                __editorExtras__: null,
                from: { __id__: from.idx },
                to: { __id__: to.idx },
                conditions: []
            };
            const idx = push(transition);
            sm._transitions.push({ __id__: idx });

            if (t.when !== undefined) {
                transition.conditions.push({ __id__: this.#pushBinaryCondition(push, variables, t.when, i) });
            }
            if (t.trigger !== undefined) {
                if (variables[t.trigger] === undefined) {
                    throw new AnimGraphBuildError(
                        `transitions[${i}]: trigger variable "${t.trigger}" is not declared in spec.variables`
                    );
                }
                transition.conditions.push({ __id__: push({
                    __type__: 'cc.animation.TriggerCondition',
                    trigger: t.trigger
                }) });
            }

            if (blending) {
                transition.destinationStart = 0;
                transition.relativeDestinationStart = false;
                transition.startEventBinding = { __id__: push(eventBinding()) };
                transition.endEventBinding = { __id__: push(eventBinding()) };
                transition.duration = t.duration ?? 0.3;
                transition.relativeDuration = false;
                transition.exitConditionEnabled =
                    t.exit ?? (from.isMotion && transition.conditions.length === 0);
                transition._exitCondition = t.exitTime ?? 1;
            } else if (t.duration !== undefined || t.exit !== undefined || t.exitTime !== undefined) {
                notes.push(
                    `transitions[${i}] (${t.from} → ${t.to}): duration/exit ignored — ` +
                    'transitions out of Entry are instant'
                );
            }
        }

        // --- variables (numbered last, matching editor order)
        for (const [name, def] of Object.entries(variables)) {
            head._variables[name] = { __id__: push(this.#buildVariable(name, def)) };
        }

        // Unused-variable hygiene note
        const used = new Set();
        for (const obj of objects) {
            if (obj.__type__ === 'cc.animation.TCVariableBinding') used.add(obj.variableName);
            if (obj.__type__ === 'cc.animation.TriggerCondition') used.add(obj.trigger);
        }
        for (const name of Object.keys(variables)) {
            if (!used.has(name)) notes.push(`variable "${name}" is declared but not used by any transition`);
        }

        const doc = new SceneDocument(objects);
        doc.renumber(); // construction order is already canonical — safety net
        return { doc, notes };
    }

    #endpoint(stateIdx, name, what) {
        if (typeof name !== 'string' || name === '') {
            throw new AnimGraphBuildError(`${what} (state name) is required`);
        }
        const found = stateIdx.get(name);
        if (!found) {
            const names = [...stateIdx.keys()].join(', ');
            throw new AnimGraphBuildError(`${what}: unknown state "${name}" (have: ${names})`);
        }
        return { ...found, name };
    }

    /** "Speed > 0.1" → BinaryCondition + TCVariableBinding (returns condition idx) */
    #pushBinaryCondition(push, variables, when, i) {
        const m = String(when).match(/^\s*([A-Za-z_]\w*)\s*(==|!=|<=|>=|<|>)\s*(-?\d+(?:\.\d+)?)\s*$/);
        if (!m) {
            throw new AnimGraphBuildError(
                `transitions[${i}]: cannot parse when "${when}" — expected "<variable> <op> <number>" ` +
                `with op one of ${BINARY_OPERATORS.join(' ')}`
            );
        }
        const [, varName, opSym, rhs] = m;
        const varDef = variables[varName];
        if (varDef === undefined) {
            throw new AnimGraphBuildError(
                `transitions[${i}]: variable "${varName}" is not declared in spec.variables`
            );
        }
        const varType = typeof varDef === 'string' ? varDef : varDef?.type;
        if (varType === 'trigger') {
            throw new AnimGraphBuildError(
                `transitions[${i}]: "${varName}" is a trigger — use {trigger: "${varName}"} instead of "when"`
            );
        }
        const condition = {
            __type__: 'cc.animation.BinaryCondition',
            operator: BINARY_OPERATORS.indexOf(opSym),
            lhs: 0,
            lhsBinding: null,
            rhs: Number(rhs)
        };
        const condIdx = push(condition);
        // TCBindingValueType: FLOAT=0, INTEGER=3 (mirrors VariableType)
        condition.lhsBinding = { __id__: push({
            __type__: 'cc.animation.TCVariableBinding',
            type: varType === 'integer' ? 3 : 0,
            variableName: varName
        }) };
        return condIdx;
    }

    #buildVariable(name, def) {
        const type = typeof def === 'string' ? def : def?.type;
        const value = typeof def === 'object' && def !== null ? def.value : undefined;
        if (type === 'trigger') {
            // _flags 2 = value false, resetMode NEXT_FRAME_OR_AFTER_CONSUMED —
            // what the 3.8.7 editor writes for a fresh trigger (Player.animgraph)
            return { __type__: 'cc.animation.TriggerVariable', _flags: value === true ? 3 : 2 };
        }
        const typeId = VARIABLE_TYPE_IDS[type];
        if (typeId === undefined) {
            throw new AnimGraphBuildError(
                `variable "${name}": unknown type "${type}" — use float, boolean, integer or trigger`
            );
        }
        const defaults = { float: 0, boolean: false, integer: 0 };
        return { __type__: 'cc.animation.PlainVariable', _type: typeId, _value: value ?? defaults[type] };
    }

    /** Resolve a clip reference into "<uuid>[@subId]" (must be an animation clip) */
    #resolveClip(ref, stateName) {
        if (!this.#assetIndex) {
            throw new AnimGraphBuildError('clip resolution requires a project (assetIndex)');
        }
        const resolved = this.#assetIndex.resolve(ref);
        if (!resolved) {
            throw new AnimGraphBuildError(`state "${stateName}": clip asset not found: "${ref}"`);
        }
        const { entry, subAsset } = resolved;

        if (subAsset) {
            if (subAsset.importer !== 'gltf-animation') {
                throw new AnimGraphBuildError(
                    `state "${stateName}": "${ref}" is a ${subAsset.importer}, not an animation clip. ` +
                    this.#clipHint(entry)
                );
            }
            return `${entry.uuid}@${subAsset.id}`;
        }
        if (entry.importer === 'animation-clip') {
            return entry.uuid;
        }
        const clips = entry.subAssets.filter(s => s.importer === 'gltf-animation');
        if (clips.length === 1) return `${entry.uuid}@${clips[0].id}`;
        if (clips.length > 1) {
            throw new AnimGraphBuildError(
                `state "${stateName}": "${ref}" has ${clips.length} animation clips — pick one: ` +
                clips.map(c => `${entry.path}@${c.id} (${c.name || c.displayName})`).join(', ')
            );
        }
        throw new AnimGraphBuildError(
            `state "${stateName}": "${ref}" (${entry.importer}) has no animation clips. ` + this.#clipHint(entry)
        );
    }

    #clipHint(entry) {
        const clips = entry.subAssets.filter(s => s.importer === 'gltf-animation');
        return clips.length
            ? `Available clips: ${clips.map(c => `${entry.path}@${c.id} (${c.name || c.displayName})`).join(', ')}`
            : 'Use get_asset_info on a model to list its gltf-animation sub-assets.';
    }

    /**
     * Standard .animgraph.meta content (shape verified on Player.animgraph.meta).
     */
    static createMeta() {
        return {
            ver: '1.2.0',
            importer: 'animation-graph',
            imported: true,
            uuid: randomUUID(),
            files: ['.json'],
            subMetas: {},
            userData: {}
        };
    }
}
