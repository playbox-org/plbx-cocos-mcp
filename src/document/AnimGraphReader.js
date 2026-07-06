/**
 * AnimGraphReader - semantic model + text rendering for .animgraph files
 *
 * An .animgraph is the same flat JSON array as .scene/.prefab (verified on
 * project-example/zombie-miner, CC 3.8.7), but its head object is
 * cc.animation.AnimationGraph — SceneDocument's node addressing does not
 * apply, so this module walks the reference graph directly:
 * head → _layers → _stateMachine → _states/_transitions.
 *
 * Enum mappings are verified against the 3.8.7 engine sources
 * (cocos/animation/marionette/):
 * - BinaryOperator: EQUAL_TO, NOT_EQUAL_TO, LESS_THAN, LESS_THAN_OR_EQUAL_TO,
 *   GREATER_THAN, GREATER_THAN_OR_EQUAL_TO (binary-condition.ts)
 * - VariableType: FLOAT=0, BOOLEAN=1, TRIGGER=2, INTEGER=3 (variable/basic.ts)
 * - UnaryOperator: TRUTHY=0, FALSY=1 (unary-condition.ts)
 */

import { isRef } from './SceneDocument.js';

/** BinaryCondition.operator index → comparison symbol */
export const BINARY_OPERATORS = ['==', '!=', '<', '<=', '>', '>='];

/** PlainVariable._type → friendly name (2 is TriggerVariable, kept for symmetry) */
export const VARIABLE_TYPES = { 0: 'float', 1: 'boolean', 2: 'trigger', 3: 'integer' };

export function isAnimGraphDocument(objects) {
    return Array.isArray(objects) && objects[0]?.__type__ === 'cc.animation.AnimationGraph';
}

/**
 * Parse a flat .animgraph object array into a semantic model.
 * @param {object[]} objects - Parsed flat JSON array (head = AnimationGraph)
 * @param {object|null} [assetIndex] - Resolves clip UUIDs to names when given
 * @returns {{variables: object[], layers: object[]}}
 */
export function parseAnimGraph(objects, assetIndex = null) {
    if (!isAnimGraphDocument(objects)) {
        throw new Error(
            `Not an animation graph: head object is "${objects?.[0]?.__type__}" ` +
            '(want cc.animation.AnimationGraph)'
        );
    }
    const deref = (ref) => (isRef(ref) ? objects[ref.__id__] : null);
    const head = objects[0];

    const variables = Object.entries(head._variables ?? {}).map(([name, ref]) => {
        const v = deref(ref) ?? {};
        if (v.__type__ === 'cc.animation.TriggerVariable') {
            return { name, type: 'trigger', value: Boolean((v._flags ?? 0) & 1) };
        }
        return {
            name,
            type: VARIABLE_TYPES[v._type] ?? `type ${v._type}`,
            value: v._value ?? null
        };
    });

    const layers = (head._layers ?? []).map((layerRef, i) => {
        const layer = deref(layerRef) ?? {};
        const sm = deref(layer._stateMachine) ?? {};
        return {
            index: i,
            name: layer.name ?? '',
            weight: layer.weight ?? 1,
            additive: layer.additive ?? false,
            mask: layer.mask ?? null,
            ...parseStateMachine(sm, deref, assetIndex)
        };
    });

    return { variables, layers };
}

function parseStateMachine(sm, deref, assetIndex) {
    const special = new Map([
        [deref(sm._entryState), 'entry'],
        [deref(sm._exitState), 'exit'],
        [deref(sm._anyState), 'any']
    ]);

    const stateName = (obj) =>
        obj?.name || special.get(obj)?.replace(/^./, c => c.toUpperCase()) || '<unnamed>';

    const states = (sm._states ?? []).map(ref => {
        const s = deref(ref);
        if (!s) return null;
        const kind = special.get(s) ?? kindOf(s.__type__);
        const state = { name: stateName(s), kind };
        if (s.__type__ === 'cc.animation.Motion') {
            Object.assign(state, parseMotion(deref(s.motion), deref, assetIndex));
            if (s.speed !== undefined && s.speed !== 1) state.speed = s.speed;
            if (s.speedMultiplierEnabled && s.speedMultiplier) {
                state.speedMultiplier = s.speedMultiplier;
            }
        }
        return state;
    }).filter(Boolean);

    const transitions = (sm._transitions ?? []).map(ref => {
        const t = deref(ref);
        if (!t) return null;
        const out = {
            from: stateName(deref(t.from)),
            to: stateName(deref(t.to)),
            conditions: (t.conditions ?? []).map(c => describeCondition(deref(c), deref))
        };
        if (t.__type__ === 'cc.animation.AnimationTransition') {
            out.duration = t.duration ?? 0;
            if (t.exitConditionEnabled) {
                out.exit = true;
                out.exitCondition = t._exitCondition;
            }
        }
        return out;
    }).filter(Boolean);

    return { states, transitions };
}

/** Short kind tag for non-special states */
function kindOf(type) {
    switch (type) {
        case 'cc.animation.Motion': return 'motion';
        case 'cc.animation.SubStateMachine': return 'sub-state-machine';
        case 'cc.animation.ProceduralPoseState': return 'pose-graph';
        default: return type?.replace(/^cc\.animation\./, '') ?? 'unknown';
    }
}

/** Motion payload: single clip, or a blend tree summarized by its clips */
function parseMotion(motion, deref, assetIndex) {
    if (!motion) return { clip: null };
    if (motion.__type__ === 'cc.animation.ClipMotion') {
        const uuid = motion.clip?.__uuid__ ?? null;
        return { clip: uuid, clipLabel: uuid ? (assetIndex?.label(uuid) ?? uuid) : null };
    }
    // Blend trees reference child ClipMotions via items[].motion / _items etc. —
    // collect every nested ClipMotion without depending on the exact shape
    const clips = [];
    const seen = new Set();
    const walk = (value) => {
        if (value === null || typeof value !== 'object' || seen.has(value)) return;
        seen.add(value);
        if (isRef(value)) { walk(deref(value)); return; }
        if (value.__type__ === 'cc.animation.ClipMotion') {
            const uuid = value.clip?.__uuid__;
            if (uuid) clips.push(assetIndex?.label(uuid) ?? uuid);
            return;
        }
        for (const v of Array.isArray(value) ? value : Object.values(value)) walk(v);
    };
    walk(motion);
    return {
        blend: motion.__type__.replace(/^cc\.animation\./, ''),
        clips
    };
}

function describeCondition(cond, deref) {
    if (!cond) return '<missing condition>';
    switch (cond.__type__) {
        case 'cc.animation.BinaryCondition': {
            const op = BINARY_OPERATORS[cond.operator] ?? `op${cond.operator}`;
            const lhs = bindingName(deref(cond.lhsBinding)) ?? cond.lhs ?? '?';
            return `${lhs} ${op} ${cond.rhs}`;
        }
        case 'cc.animation.TriggerCondition':
            return `trigger ${cond.trigger}`;
        case 'cc.animation.UnaryCondition': {
            const operand = cond.operand?.variableName ??
                bindingName(deref(cond.operand)) ?? '?';
            return `${cond.operator === 1 ? 'falsy' : 'truthy'}(${operand})`;
        }
        default:
            return cond.__type__?.replace(/^cc\.animation\./, '') ?? 'unknown';
    }
}

function bindingName(binding) {
    return typeof binding?.variableName === 'string' ? binding.variableName : null;
}

/**
 * Compact text rendering of a parsed graph (see query_animgraph).
 * @param {string} title - Usually the file name
 * @param {{variables: object[], layers: object[]}} model
 * @returns {string}
 */
export function formatAnimGraphText(title, model) {
    const lines = [`# AnimGraph: ${title}`, ''];

    const vars = model.variables.map(v =>
        v.type === 'trigger' ? `${v.name}: trigger` : `${v.name}: ${v.type} = ${JSON.stringify(v.value)}`
    );
    lines.push(`Variables: ${vars.length ? vars.join(' | ') : '(none)'}`);

    for (const layer of model.layers) {
        const meta = [`weight ${layer.weight}`];
        if (layer.additive) meta.push('additive');
        if (layer.mask) meta.push('masked');
        lines.push('', `Layer ${layer.index}${layer.name ? ` "${layer.name}"` : ''} (${meta.join(', ')}):`);

        const named = layer.states.filter(s => !['entry', 'exit', 'any'].includes(s.kind));
        lines.push(`  states: ${named.length ? named.map(describeState).join(', ') : '(none)'}`);

        for (const t of layer.transitions) {
            const conds = [...t.conditions];
            if (t.exit) conds.push('exit');
            const cond = conds.length ? `  [${conds.join(' && ')}]` : '';
            const dur = t.duration !== undefined ? `  dur ${t.duration}` : '';
            lines.push(`  ${t.from} → ${t.to}${cond}${dur}`);
        }
        if (layer.transitions.length === 0) lines.push('  (no transitions)');
    }

    return lines.join('\n');
}

function describeState(s) {
    const details = [];
    if (s.clipLabel ?? s.clip) details.push(`clip ${s.clipLabel ?? s.clip}`);
    if (s.blend) details.push(`${s.blend}: ${s.clips.join(', ') || 'no clips'}`);
    if (s.kind !== 'motion' && !s.blend) details.push(s.kind);
    if (s.speed !== undefined) details.push(`speed ${s.speed}`);
    if (s.speedMultiplier) details.push(`×${s.speedMultiplier}`);
    return details.length ? `${s.name} (${details.join(', ')})` : s.name;
}
