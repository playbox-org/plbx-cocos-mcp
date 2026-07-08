/**
 * ComputeRotation tests — quat↔euler(YZX), composition around world/local
 * axes (with parent-chain compensation), aiming a local axis.
 *
 * The math ports (eulerToQuat / quatToEulerYZX) are corpus-verified in
 * test/utils/math3d via the golden scene; these tests cover the tool
 * contract and the report's SM_Koleno case ("old rotation turned 180°
 * around world Y").
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { ComputeRotation } from '../../src/tools/ComputeRotation.js';
import {
    eulerToQuat, quatToEulerYZX, quatMultiply, quatConjugate, quatFromAxisAngle,
    quatApproxEquals, quatRotateVec3
} from '../../src/utils/math3d.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_SCENE = path.join(__dirname, '..', 'fixtures', 'golden', 'Main.scene_V2.scene');
const MOCK_PROJECT = path.join(__dirname, '..', 'fixtures', 'mock-project');

const tool = new ComputeRotation();
const run = (args) => tool.execute(args, MOCK_PROJECT);

/** Parse the "Apply with" op and the euler/quat lines out of the report */
function parse(result) {
    const text = result.content[0].text;
    assert.ok(!result.isError, text);
    const op = JSON.parse(text.match(/```json\n(.*)\n```/)[1]);
    const quat = text.match(/Quaternion: \{x: (.*), y: (.*), z: (.*), w: (.*)\}/);
    return {
        text,
        op,
        euler: op.value,
        quat: { x: Number(quat[1]), y: Number(quat[2]), z: Number(quat[3]), w: Number(quat[4]) }
    };
}

describe('convert mode', () => {
    test('euler → quat matches the verified fromEuler port', async () => {
        const { quat } = parse(await run({ mode: 'convert', euler: { x: 10, y: 90, z: -5 } }));
        assert.ok(quatApproxEquals(quat, eulerToQuat({ x: 10, y: 90, z: -5 }), 1e-6));
    });

    test('quat → euler round-trips through fromEuler', async () => {
        const q = eulerToQuat({ x: 33, y: -120, z: 71 });
        const { euler } = parse(await run({ mode: 'convert', quat: q }));
        assert.ok(quatApproxEquals(eulerToQuat(euler), q, 1e-6));
    });

    test('rejects a call without a base rotation', async () => {
        const result = await run({ mode: 'convert' });
        assert.ok(result.isError);
        assert.match(result.content[0].text, /euler.*quat.*filePath/s);
    });
});

describe('compose mode', () => {
    test('the SM_Koleno case: old rotation turned 180° around world Y', async () => {
        const oldEuler = { x: -8.53, y: 47.2, z: 3.1 };
        const { quat } = parse(await run({
            mode: 'compose', euler: oldEuler, axis: 'y', degrees: 180
        }));
        const expected = quatMultiply(quatFromAxisAngle({ x: 0, y: 1, z: 0 }, 180), eulerToQuat(oldEuler));
        assert.ok(quatApproxEquals(quat, expected, 1e-6));
    });

    test('local axis post-multiplies (differs from world on a rotated base)', async () => {
        const base = { x: 0, y: 90, z: 0 };
        const local = parse(await run({
            mode: 'compose', euler: base, axis: 'x', degrees: 45, space: 'local'
        }));
        const world = parse(await run({
            mode: 'compose', euler: base, axis: 'x', degrees: 45, space: 'world'
        }));
        const r = quatFromAxisAngle({ x: 1, y: 0, z: 0 }, 45);
        assert.ok(quatApproxEquals(local.quat, quatMultiply(eulerToQuat(base), r), 1e-6));
        assert.ok(quatApproxEquals(world.quat, quatMultiply(r, eulerToQuat(base)), 1e-6));
        assert.ok(!quatApproxEquals(local.quat, world.quat, 1e-3));
    });

    test('filePath+node reads the current rotation and compensates rotated parents', async () => {
        // Golden node under a rotated ancestor: find one via the file itself
        const { SceneDocument } = await import('../../src/document/SceneDocument.js');
        const doc = SceneDocument.load(GOLDEN_SCENE);
        let nodeIdx = null;
        let parentQ = null;
        outer:
        for (let i = 0; i < doc.objects.length; i++) {
            const o = doc.getObject(i);
            if (o?.__type__ !== 'cc.Node' || !o._lrot || !o._parent) continue;
            // parent chain must contain a really rotated regular node
            let p = o._parent.__id__;
            const chain = [];
            while (p !== undefined && p !== doc.root.idx) {
                const po = doc.getObject(p);
                if (!po?._lrot) break;
                chain.unshift(po._lrot);
                p = po._parent?.__id__;
            }
            if (p !== doc.root.idx) continue;
            if (chain.some(q => Math.abs(q.w) < 0.999)) {
                nodeIdx = i;
                parentQ = chain.reduce((acc, q) => quatMultiply(acc, q), { x: 0, y: 0, z: 0, w: 1 });
                break outer;
            }
        }
        assert.ok(nodeIdx !== null, 'golden scene has a node under rotated parents');

        const nodePath = doc.nodePath(nodeIdx);
        const { quat, op } = parse(await run({
            mode: 'compose', filePath: GOLDEN_SCENE, node: nodePath,
            axis: 'y', degrees: 90, space: 'world'
        }));

        const r = quatFromAxisAngle({ x: 0, y: 1, z: 0 }, 90);
        const q = doc.getObject(nodeIdx)._lrot;
        const expected = quatMultiply(quatConjugate(parentQ),
            quatMultiply(r, quatMultiply(parentQ, q)));
        assert.ok(quatApproxEquals(quat, expected, 1e-6));
        assert.strictEqual(op.op, 'set_node_property');
        assert.strictEqual(op.node, nodePath);
        assert.strictEqual(op.property, 'rotation');
    });

    test('instance stubs read the _lrot override and get a set_instance_property op', async () => {
        const { text, op } = await run({
            mode: 'compose', filePath: GOLDEN_SCENE, node: '[WORLD]/Zones/ButtonPurchaseZone',
            axis: 'y', degrees: 45, space: 'local'
        }).then(r => parse(r));
        assert.strictEqual(op.op, 'set_instance_property');
        assert.strictEqual(op.node, '[WORLD]/Zones/ButtonPurchaseZone');
        assert.match(text, /Base: current rotation/);
    });
});

describe('orient mode', () => {
    test('local +Z aimed at world +X is a 90° yaw', async () => {
        const { quat, euler } = parse(await run({
            mode: 'orient', axis: 'z', direction: { x: 1, y: 0, z: 0 }
        }));
        assert.ok(quatApproxEquals(quat, eulerToQuat({ x: 0, y: 90, z: 0 }), 1e-6));
        assert.ok(Math.abs(euler.y - 90) < 1e-3);
    });

    test('aimed axis actually points along the direction (with up fixing the roll)', async () => {
        const direction = { x: 1, y: 2, z: -0.5 };
        const { quat } = parse(await run({
            mode: 'orient', axis: '-z', direction, up: { x: 0, y: 1, z: 0 }
        }));
        const aimed = quatRotateVec3(quat, { x: 0, y: 0, z: -1 });
        const len = Math.hypot(direction.x, direction.y, direction.z);
        assert.ok(Math.abs(aimed.x - direction.x / len) < 1e-6);
        assert.ok(Math.abs(aimed.y - direction.y / len) < 1e-6);
        assert.ok(Math.abs(aimed.z - direction.z / len) < 1e-6);
        // Roll fixed: the rotated local up equals world-up projected onto the
        // plane ⊥ direction (the closest attainable vector), normalized
        const upWorld = quatRotateVec3(quat, { x: 0, y: 1, z: 0 });
        const d = { x: direction.x / len, y: direction.y / len, z: direction.z / len };
        const k = d.y; // dot(worldUp, d)
        const proj = { x: -d.x * k, y: 1 - d.y * k, z: -d.z * k };
        const plen = Math.hypot(proj.x, proj.y, proj.z);
        assert.ok(Math.abs(upWorld.x - proj.x / plen) < 1e-6);
        assert.ok(Math.abs(upWorld.y - proj.y / plen) < 1e-6);
        assert.ok(Math.abs(upWorld.z - proj.z / plen) < 1e-6);
    });

    test('requires direction', async () => {
        const result = await run({ mode: 'orient', axis: 'z' });
        assert.ok(result.isError);
        assert.match(result.content[0].text, /"direction"/);
    });
});

describe('output contract', () => {
    test('warns about unrotated-parents assumption when no node is given', async () => {
        const { text } = parse(await run({
            mode: 'compose', euler: { y: 10 }, axis: 'y', degrees: 5
        }));
        assert.match(text, /assumes UNROTATED parents/);
    });

    test('euler in the op reproduces the quaternion through the engine conversion', async () => {
        const { euler, quat } = parse(await run({
            mode: 'compose', euler: { x: 12.3, y: -47, z: 88 }, axis: { x: 1, y: 1, z: 0 }, degrees: 30
        }));
        assert.ok(quatApproxEquals(eulerToQuat(euler), quat, 1e-4));
    });
});

describe('quatToEulerYZX corpus verification', () => {
    test('every golden-scene _lrot survives quat → euler → quat (412 nodes)', async () => {
        const { SceneDocument } = await import('../../src/document/SceneDocument.js');
        const doc = SceneDocument.load(GOLDEN_SCENE);
        let total = 0;
        for (const o of doc.objects) {
            if (o?.__type__ !== 'cc.Node' || !o._lrot) continue;
            total++;
            const rt = eulerToQuat(quatToEulerYZX(o._lrot));
            assert.ok(quatApproxEquals(rt, o._lrot, 1e-6),
                `roundtrip failed for "${o._name}"`);
        }
        assert.ok(total >= 400, `corpus too small: ${total}`);
    });
});
