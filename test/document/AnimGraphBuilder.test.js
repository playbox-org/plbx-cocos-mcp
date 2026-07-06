/**
 * AnimGraph write-layer tests
 *
 * The round-trip suite proves the SceneDocument canon (DFS first-visit
 * numbering + stringify) extends to .animgraph files — including the
 * `_variables` object-map (name → ref), which scenes/prefabs never exercise.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { SceneDocument } from '../../src/document/SceneDocument.js';
import { AnimGraphBuilder, AnimGraphBuildError } from '../../src/document/AnimGraphBuilder.js';
import { parseAnimGraph, formatAnimGraphText } from '../../src/document/AnimGraphReader.js';
import { AssetIndex } from '../../src/core/AssetIndex.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_GRAPH = path.join(__dirname, '..', 'fixtures', 'golden', 'Player.animgraph');
const MOCK_PROJECT = path.join(__dirname, '..', 'fixtures', 'mock-project');

const COIN_UUID = '65522416-77c3-44a9-afb1-f22a7090b129';

const SPEC = {
    variables: {
        Speed: { type: 'float', value: 0 },
        Jump: { type: 'trigger' }
    },
    states: [
        { name: 'Idle', clip: 'assets/Models/Coin.fbx@c0001' },
        { name: 'Run', clip: `${COIN_UUID}@c0002`, speed: 1.7 }
    ],
    transitions: [
        { from: 'Entry', to: 'Idle' },
        { from: 'Idle', to: 'Run', when: 'Speed > 0.1', duration: 0.3 },
        { from: 'Run', to: 'Idle', when: 'Speed <= 0.1', duration: 0.3 },
        { from: 'Any', to: 'Idle', trigger: 'Jump', duration: 0.1 }
    ]
};

describe('AnimGraph round-trip (golden Player.animgraph)', () => {
    test('load + serialize is byte-identical', () => {
        const raw = fs.readFileSync(GOLDEN_GRAPH, 'utf-8');
        const doc = SceneDocument.load(GOLDEN_GRAPH);
        assert.strictEqual(doc.serialize(), raw);
    });

    test('load + renumber + serialize is byte-identical (map values walked)', () => {
        const raw = fs.readFileSync(GOLDEN_GRAPH, 'utf-8');
        const doc = SceneDocument.load(GOLDEN_GRAPH);
        const { dropped } = doc.renumber();
        assert.strictEqual(dropped, 0);
        assert.strictEqual(doc.serialize(), raw);
    });
});

describe('AnimGraphBuilder', () => {
    const index = new AssetIndex(MOCK_PROJECT);

    test('compiles the reference spec into editor-shaped objects', () => {
        const { doc, notes } = new AnimGraphBuilder(index).compile(SPEC);
        assert.deepStrictEqual(notes, []);
        const objs = doc.objects;

        // Head
        assert.strictEqual(objs[0].__type__, 'cc.animation.AnimationGraph');
        assert.deepStrictEqual(Object.keys(objs[0]._variables), ['Speed', 'Jump']);

        // Layer + state machine
        const layer = objs[objs[0]._layers[0].__id__];
        assert.strictEqual(layer.__type__, 'cc.animation.Layer');
        assert.strictEqual(layer.weight, 1);
        const sm = objs[layer._stateMachine.__id__];
        assert.strictEqual(sm.__type__, 'cc.animation.StateMachine');

        // Entry/Exit/Any always present, then the two motions
        const states = sm._states.map(r => objs[r.__id__]);
        assert.deepStrictEqual(states.map(s => s.name), ['Entry', 'Exit', 'Any', 'Idle', 'Run']);
        assert.strictEqual(objs[sm._entryState.__id__].name, 'Entry');
        assert.strictEqual(objs[sm._anyState.__id__].name, 'Any');

        // Motion shape: clip motion + in/out event bindings
        const idle = states[3];
        assert.strictEqual(idle.__type__, 'cc.animation.Motion');
        const clip = objs[idle.motion.__id__];
        assert.strictEqual(clip.__type__, 'cc.animation.ClipMotion');
        assert.deepStrictEqual(clip.clip, {
            __uuid__: `${COIN_UUID}@c0001`,
            __expectedType__: 'cc.AnimationClip'
        });
        assert.strictEqual(objs[idle.transitionInEventBinding.__id__].__type__,
            'cc.animation.AnimationGraphEventBinding');
        assert.strictEqual(objs[idle.transitionOutEventBinding.__id__].__type__,
            'cc.animation.AnimationGraphEventBinding');
        assert.strictEqual(states[4].speed, 1.7);

        // Transitions: Entry → bare Transition; Motion/Any → AnimationTransition
        const transitions = sm._transitions.map(r => objs[r.__id__]);
        assert.strictEqual(transitions[0].__type__, 'cc.animation.Transition');
        assert.deepStrictEqual(transitions[0].conditions, []);
        assert.strictEqual(transitions[1].__type__, 'cc.animation.AnimationTransition');
        assert.strictEqual(transitions[1].duration, 0.3);
        assert.strictEqual(transitions[1].exitConditionEnabled, false);
        assert.strictEqual(objs[transitions[1].startEventBinding.__id__].__type__,
            'cc.animation.AnimationGraphEventBinding');

        // BinaryCondition: "Speed > 0.1" → operator 4 (engine BinaryOperator)
        const gt = objs[transitions[1].conditions[0].__id__];
        assert.strictEqual(gt.__type__, 'cc.animation.BinaryCondition');
        assert.strictEqual(gt.operator, 4);
        assert.strictEqual(gt.rhs, 0.1);
        assert.deepStrictEqual(objs[gt.lhsBinding.__id__], {
            __type__: 'cc.animation.TCVariableBinding', type: 0, variableName: 'Speed'
        });
        const le = objs[transitions[2].conditions[0].__id__];
        assert.strictEqual(le.operator, 3); // <=

        // Trigger transition from Any
        const any = transitions[3];
        assert.strictEqual(any.__type__, 'cc.animation.AnimationTransition');
        assert.deepStrictEqual(objs[any.conditions[0].__id__], {
            __type__: 'cc.animation.TriggerCondition', trigger: 'Jump'
        });

        // Variables
        const speed = objs[objs[0]._variables.Speed.__id__];
        assert.deepStrictEqual(speed, { __type__: 'cc.animation.PlainVariable', _type: 0, _value: 0 });
        const jump = objs[objs[0]._variables.Jump.__id__];
        assert.deepStrictEqual(jump, { __type__: 'cc.animation.TriggerVariable', _flags: 2 });
    });

    test('construction order is already canonical (renumber is identity)', () => {
        const { doc } = new AnimGraphBuilder(index).compile(SPEC);
        const before = doc.serialize();
        const { dropped } = doc.renumber();
        assert.strictEqual(dropped, 0);
        assert.strictEqual(doc.serialize(), before);
    });

    test('structural parity with the golden graph (same type sequence)', () => {
        // Same graph topology as Player.animgraph minus its third state —
        // check that our types-in-file-order match the editor's for the
        // shared prefix pattern: head, layer, SM, 3 special states, motions...
        const { doc } = new AnimGraphBuilder(index).compile(SPEC);
        const golden = JSON.parse(fs.readFileSync(GOLDEN_GRAPH, 'utf-8'));
        const types = (arr) => arr.map(o => o.__type__);
        // Player: 3 motions, ours: 2 → compare through the second motion block
        assert.deepStrictEqual(types(doc.objects).slice(0, 14), types(golden).slice(0, 14));
        // Both end with the variables, trigger last
        assert.strictEqual(doc.objects.at(-1).__type__, 'cc.animation.TriggerVariable');
        assert.strictEqual(doc.objects.at(-2).__type__, 'cc.animation.PlainVariable');
    });

    test('motion transition without conditions defaults to exit-time', () => {
        const { doc } = new AnimGraphBuilder(index).compile({
            states: [
                { name: 'A', clip: `${COIN_UUID}@c0001` },
                { name: 'B', clip: `${COIN_UUID}@c0002` }
            ],
            transitions: [{ from: 'A', to: 'B', duration: 0.1 }]
        });
        const model = parseAnimGraph(doc.objects);
        assert.deepStrictEqual(model.layers[0].transitions, [
            { from: 'A', to: 'B', conditions: [], duration: 0.1, exit: true, exitCondition: 1 }
        ]);
    });

    test('boolean/integer variables and integer binding type', () => {
        const { doc } = new AnimGraphBuilder(index).compile({
            variables: {
                Dead: { type: 'boolean', value: true },
                Combo: { type: 'integer' }
            },
            states: [{ name: 'A', clip: `${COIN_UUID}@c0001` }],
            transitions: [{ from: 'A', to: 'A', when: 'Combo >= 3' }]
        });
        const objs = doc.objects;
        const dead = objs[objs[0]._variables.Dead.__id__];
        assert.deepStrictEqual(dead, { __type__: 'cc.animation.PlainVariable', _type: 1, _value: true });
        const combo = objs[objs[0]._variables.Combo.__id__];
        assert.deepStrictEqual(combo, { __type__: 'cc.animation.PlainVariable', _type: 3, _value: 0 });
        const binding = objs.find(o => o.__type__ === 'cc.animation.TCVariableBinding');
        assert.strictEqual(binding.type, 3); // TCBindingValueType.INTEGER
    });

    test('bare model path with several clips must pick one', () => {
        // Coin.fbx has two clips → error lists them
        assert.throws(
            () => new AnimGraphBuilder(index).compile({
                states: [{ name: 'A', clip: 'assets/Models/Coin.fbx' }]
            }),
            (err) => err instanceof AnimGraphBuildError &&
                /2 animation clips/.test(err.message) &&
                err.message.includes('@c0001') && err.message.includes('Idle.animation')
        );
    });

    test('rejects non-clip sub-assets with a clip listing', () => {
        assert.throws(
            () => new AnimGraphBuilder(index).compile({
                states: [{ name: 'A', clip: `${COIN_UUID}@2e1ee` }]
            }),
            /is a gltf-mesh.*Available clips:.*@c0001/s
        );
    });

    test('rejects unknown states, variables, reserved names and bad "when"', () => {
        const builder = new AnimGraphBuilder(index);
        const base = { states: [{ name: 'A', clip: `${COIN_UUID}@c0001` }] };
        assert.throws(
            () => builder.compile({ ...base, transitions: [{ from: 'Nope', to: 'A' }] }),
            /unknown state "Nope".*have: Entry, Exit, Any, A/
        );
        assert.throws(
            () => builder.compile({ ...base, transitions: [{ from: 'A', to: 'A', when: 'Speed > 1' }] }),
            /"Speed" is not declared/
        );
        assert.throws(
            () => builder.compile({ ...base, transitions: [{ from: 'A', to: 'A', trigger: 'Jump' }] }),
            /trigger variable "Jump" is not declared/
        );
        assert.throws(
            () => builder.compile({ states: [{ name: 'Any', clip: `${COIN_UUID}@c0001` }] }),
            /reserved/
        );
        assert.throws(
            () => builder.compile({
                ...base,
                variables: { Speed: { type: 'float' } },
                transitions: [{ from: 'A', to: 'A', when: 'Speed ~ 1' }]
            }),
            /cannot parse when/
        );
        assert.throws(
            () => builder.compile({
                ...base,
                variables: { Jump: { type: 'trigger' } },
                transitions: [{ from: 'A', to: 'A', when: 'Jump > 0' }]
            }),
            /is a trigger — use \{trigger:/
        );
        assert.throws(() => builder.compile({ states: [] }), /non-empty/);
    });

    test('notes unused variables and ignored Entry-transition duration', () => {
        const { notes } = new AnimGraphBuilder(index).compile({
            variables: { Speed: { type: 'float' } },
            states: [{ name: 'A', clip: `${COIN_UUID}@c0001` }],
            transitions: [{ from: 'Entry', to: 'A', duration: 0.5 }]
        });
        assert.strictEqual(notes.length, 2);
        assert.match(notes[0], /duration\/exit ignored/);
        assert.match(notes[1], /"Speed" is declared but not used/);
    });

    test('createMeta matches the editor meta shape', () => {
        const meta = AnimGraphBuilder.createMeta();
        assert.strictEqual(meta.ver, '1.2.0');
        assert.strictEqual(meta.importer, 'animation-graph');
        assert.deepStrictEqual(meta.files, ['.json']);
        assert.deepStrictEqual(meta.subMetas, {});
        assert.deepStrictEqual(meta.userData, {});
        assert.match(meta.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });
});

describe('AnimGraphReader on the golden graph', () => {
    const objects = JSON.parse(fs.readFileSync(GOLDEN_GRAPH, 'utf-8'));

    test('parses variables, states and transitions', () => {
        const model = parseAnimGraph(objects);
        assert.deepStrictEqual(model.variables, [
            { name: 'Speed', type: 'float', value: 0 },
            { name: 'Jump', type: 'trigger', value: false }
        ]);
        const layer = model.layers[0];
        assert.strictEqual(layer.weight, 1);
        assert.deepStrictEqual(
            layer.states.map(s => `${s.name}:${s.kind}`),
            ['Entry:entry', 'Exit:exit', 'Any:any', 'Idle:motion', 'Run:motion', 'Jump:motion']
        );
        assert.strictEqual(layer.states[4].speed, 1.7);
        assert.strictEqual(layer.states[3].clip, '00b30906-cb90-437f-9949-66a3498321e7@c2696');

        assert.deepStrictEqual(layer.transitions, [
            { from: 'Entry', to: 'Idle', conditions: [] },
            { from: 'Idle', to: 'Run', conditions: ['Speed > 0.1'], duration: 0.3 },
            { from: 'Run', to: 'Idle', conditions: ['Speed < 0.1'], duration: 0.3 },
            { from: 'Any', to: 'Jump', conditions: ['trigger Jump'], duration: 0.05 },
            { from: 'Jump', to: 'Idle', conditions: [], duration: 0.1, exit: true, exitCondition: 1 }
        ]);
    });

    test('text format is the compact per-layer summary', () => {
        const text = formatAnimGraphText('Player.animgraph', parseAnimGraph(objects));
        assert.match(text, /# AnimGraph: Player\.animgraph/);
        assert.match(text, /Variables: Speed: float = 0 \| Jump: trigger/);
        assert.match(text, /Layer 0 \(weight 1\):/);
        assert.match(text, /Idle → Run {2}\[Speed > 0\.1\] {2}dur 0\.3/);
        assert.match(text, /Any → Jump {2}\[trigger Jump\] {2}dur 0\.05/);
        assert.match(text, /Jump → Idle {2}\[exit\] {2}dur 0\.1/);
    });

    test('rejects non-animgraph heads', () => {
        assert.throws(() => parseAnimGraph([{ __type__: 'cc.Prefab' }]), /Not an animation graph/);
    });
});
