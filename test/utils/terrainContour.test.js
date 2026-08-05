/**
 * terrainContour tests — contour crossings, signed distance, slope/crease analytics
 *
 * Expectations come from ANALYTIC terrains (plane, ramp, step, cone), where the contour position,
 * the distance to it and the slope angle all have closed forms.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
    contourCrossings,
    slopeStats,
    vertexSampleCount,
    ContourDistance,
    ContourError
} from '../../src/utils/terrainContour.js';
import { materialize, setVertexHeight, vertexCounts } from '../../src/utils/terrainBin.js';

/** A 1-block terrain (33x33 vertices at 1 m) whose heights come from `fn(x, z)` metres */
function terrainFrom(fn, { tileSize = 1, blockCount = [1, 1] } = {}) {
    const data = materialize({ blockCount, tileSize, weightMapSize: 4, lightMapSize: 4, layers: [] });
    const [vx, vz] = vertexCounts(blockCount);
    for (let j = 0; j < vz; j++) {
        for (let i = 0; i < vx; i++) setVertexHeight(data, i, j, fn(i * tileSize, j * tileSize), true);
    }
    return data;
}

const near = (actual, expected, tol, what) =>
    assert.ok(Math.abs(actual - expected) <= tol,
        `${what ?? 'value'}: ${actual} is not within ${tol} of ${expected}`);

describe('contourCrossings', () => {
    it('interpolates the crossing of a linear ramp exactly', () => {
        // h = x / 10, so the 1.05 m contour is the line x = 10.5
        const data = terrainFrom((x) => x / 10);
        const at = contourCrossings(data, 1.05);
        assert.strictEqual(at.samples[0], 33, 'defaults to the vertex resolution');
        assert.strictEqual(at.lines.length, 33);
        for (const line of at.lines) {
            assert.strictEqual(line.crossings.length, 1);
            near(line.crossings[0], 10.5, 0.06, `crossing at z=${line.coord}`);
        }
        assert.strictEqual(at.stats.uniform, true);
        assert.strictEqual(at.stats.monotone, true);
        near(at.stats.maxJump.value, 0, 1e-9, 'a straight contour never jumps');
    });

    it('measures a diagonal edge instead of assuming a straight one', () => {
        // The failure this prevents: an edge assumed straight actually runs at 2.5 m of x per m of z
        const data = terrainFrom((x, z) => (x - 2.5 * z) / 10);
        const at = contourCrossings(data, 0);
        const single = at.lines.filter((l) => l.crossings.length === 1);
        assert.ok(single.length >= 12, 'the contour crosses most rows exactly once');
        for (const line of single) {
            near(line.crossings[0], 2.5 * line.coord, 0.05, `crossing at z=${line.coord}`);
        }
        assert.strictEqual(at.stats.monotone, true);
        near(at.stats.maxJump.value, 2.5, 0.05, 'largest jump == the edge slope per row');
    });

    it('scans along z when asked, and reports a step as a jump', () => {
        // A contour that runs straight until z = 16 and then shifts 5 m
        const data = terrainFrom((x, z) => (x - (z < 16 ? 8 : 13)) / 10);
        const at = contourCrossings(data, 0);
        near(at.stats.maxJump.value, 5, 0.05, 'the step shows up as the largest jump');
        assert.strictEqual(at.stats.maxJump.fromCoord, 15);
        assert.strictEqual(at.stats.maxJump.toCoord, 16);

        const byZ = contourCrossings(data, 0, { axis: 'z' });
        assert.strictEqual(byZ.axis, 'z');
        // Along z the same field has one crossing only in the columns between the two offsets
        assert.ok(byZ.stats.crossings > 0);
    });

    it('reports no crossing when the threshold is outside the range', () => {
        const at = contourCrossings(terrainFrom(() => 1), 5);
        assert.strictEqual(at.stats.crossings, 0);
        assert.strictEqual(at.stats.monotone, null);
        assert.strictEqual(at.stats.maxJump, null);
    });

    it('reads a plateau exactly AT the threshold as one crossing: its rim', () => {
        // Heights are quantized to 1/128 m, so "sample == threshold" is the rule for a round
        // contour, not an edge case. Counting each such sample as a crossing turns the plateau
        // into one crossing per vertex and buries the rim, which is the whole answer.
        const data = terrainFrom((x) => Math.min(x / 4, 5));
        const at = contourCrossings(data, 5);
        assert.strictEqual(at.stats.crossings, 33, 'one per line');
        assert.strictEqual(at.stats.singleCrossingLines, 33);
        assert.strictEqual(at.stats.samplesOnContour, 13 * 33, 'x 20..32 sit exactly on 5 m');
        near(at.stats.min, 20, 1e-9, 'the rim');
        near(at.stats.max, 20, 1e-9, 'the rim');
    });

    it('reads a hill standing on a plain exactly AT the threshold as the hill foot', () => {
        // The mirror case of the plateau: here the PLAIN is the threshold, so the edge is where
        // the hill leaves it — two crossings per line across the hill, none on the others
        const data = terrainFrom((x, z) => (x >= 12 && x <= 20 && z >= 12 && z <= 20 ? 3 : 0));
        const at = contourCrossings(data, 0);
        assert.strictEqual(at.stats.multiCrossingLines, 9, 'the lines across the hill');
        assert.strictEqual(at.stats.crossings, 18);
        assert.strictEqual(at.stats.linesWithoutCrossing, 24, 'the lines that miss it');
        for (const line of at.lines.filter((l) => l.crossings.length)) {
            assert.deepStrictEqual(line.crossings, [11, 21], `foot on both sides at z=${line.coord}`);
        }
    });

    it('reports a level surface as having no edge at all', () => {
        const at = contourCrossings(terrainFrom(() => 2), 2);
        assert.strictEqual(at.stats.crossings, 0, 'nothing but the contour itself');
        assert.strictEqual(at.stats.samplesOnContour, 33 * 33);
        assert.strictEqual(at.stats.linesWithoutCrossing, 33);
    });

    it('counts lines with none and lines with several apart', () => {
        // A ridge h = 10 - (x - 16)^2 / 10 crosses the 5 m contour TWICE on every line
        const data = terrainFrom((x) => 10 - ((x - 16) ** 2) / 10);
        const at = contourCrossings(data, 5);
        assert.strictEqual(at.stats.multiCrossingLines, 33);
        assert.strictEqual(at.stats.crossings, 66);
        assert.strictEqual(at.stats.linesWithoutCrossing, 0, 'every line crosses it — twice');
        assert.strictEqual(at.stats.singleCrossingLines, 0);
    });

    it('rejects a bad threshold, axis, region and sampleCount', () => {
        const data = terrainFrom(() => 0);
        assert.throws(() => contourCrossings(data, 'high'), ContourError);
        assert.throws(() => contourCrossings(data, 0, { axis: 'y' }), /axis must be "x" or "z"/);
        assert.throws(() => contourCrossings(data, 0, { region: { width: 0 } }), /must be > 0 metres/);
        assert.throws(() => contourCrossings(data, 0, { sampleCount: 1 }), /must be an integer in 2\.\./);
    });
});

describe('ContourDistance', () => {
    it('signs the distance negative above the contour and positive below it', () => {
        // h = x / 10 → the 1 m contour is the line x = 10; distance is |x - 10|
        const data = terrainFrom((x) => x / 10);
        const cd = new ContourDistance(data, 1, { reach: 4 });
        assert.ok(cd.segmentCount > 0);

        const above = cd.signedDistanceAt(12, 5);
        near(above.signed, -2, 0.05, 'inland of the contour is negative');
        assert.strictEqual(above.high, true);

        const below = cd.signedDistanceAt(7, 5);
        near(below.signed, 3, 0.05, 'the low side is positive');
        assert.strictEqual(below.high, false);

        near(cd.signedDistanceAt(10, 20).distance, 0, 0.05, 'on the contour');
    });

    it('answers null beyond its reach and off the terrain', () => {
        const data = terrainFrom((x) => x / 10);
        const cd = new ContourDistance(data, 1, { reach: 2 });
        assert.strictEqual(cd.signedDistanceAt(20, 5), null, 'farther than reach');
        assert.strictEqual(cd.signedDistanceAt(-5, 5), null, 'off the terrain');
    });

    it('finds no segments when the threshold misses the height range', () => {
        const cd = new ContourDistance(terrainFrom(() => 0), 10, { reach: 2 });
        assert.strictEqual(cd.segmentCount, 0);
        assert.strictEqual(cd.signedDistanceAt(5, 5), null);
    });

    it('finds the foot of a hill standing on a plain exactly AT the threshold', () => {
        // What build_terrain leaves plus one adjust_heights: a flat 0 m plain, so the foot of the
        // hill IS the 0 m contour and every plain sample sits exactly on it. Reading the plain as
        // "not below" leaves no boundary and the band region has nothing to follow.
        const data = terrainFrom((x, z) => (Math.hypot(x - 16, z - 16) < 6 ? 3 : 0));
        const cd = new ContourDistance(data, 0, { reach: 3 });
        assert.ok(cd.segmentCount > 0, 'the hill foot is an edge');
        // The plain is exactly ON the threshold, so its own height cannot say which side it is:
        // geometrically it is BELOW the hill standing on it, and the band's `outer` reaches it
        const out = cd.signedDistanceAt(24, 16);
        assert.strictEqual(out.high, false, 'the plain is the low side of the hill foot');
        near(out.signed, 2, 0.6, '2 m out from the foot');
        assert.strictEqual(cd.signedDistanceAt(21, 16).high, true, 'the hill flank is the high side');
    });

    it('finds the rim of a plateau lying exactly AT the threshold', () => {
        // The mirror case: the high side is exactly ON the threshold, so reading it as "not above"
        // is what leaves no boundary
        const data = terrainFrom((x) => Math.min(x / 4, 5));
        const cd = new ContourDistance(data, 5, { reach: 3 });
        assert.ok(cd.segmentCount > 0, 'the plateau rim is an edge');
        near(cd.signedDistanceAt(22, 16).distance, 2, 0.05, '2 m inside the plateau');
        assert.strictEqual(cd.signedDistanceAt(22, 16).high, true);
        near(cd.signedDistanceAt(18, 16).distance, 2, 0.05, '2 m down the ramp');
        assert.strictEqual(cd.signedDistanceAt(18, 16).high, false);
    });

    it('measures the true distance to a curved contour, not a grid-quantized one', () => {
        // Cone h = 5 - r: the 2 m contour is the circle r = 3 around (16, 16)
        const data = terrainFrom((x, z) => 5 - Math.hypot(x - 16, z - 16));
        const cd = new ContourDistance(data, 2, { reach: 4 });
        // 1.5 m outside the circle along a diagonal, where no grid line passes
        const p = [16 + 4.5 / Math.SQRT2, 16 + 4.5 / Math.SQRT2];
        const sd = cd.signedDistanceAt(p[0], p[1]);
        near(sd.distance, 1.5, 0.1, 'diagonal distance to the circle');
        assert.strictEqual(sd.high, false, 'outside the cone is below the contour');
    });
});

describe('slopeStats', () => {
    it('reports the exact angle of a constant-gradient plane', () => {
        // h = x → 45° everywhere, 1 m step between adjacent vertices
        const stats = slopeStats(terrainFrom((x) => x));
        near(stats.max.degrees, 45, 0.01, 'max slope');
        near(stats.mean, 45, 0.01, 'mean slope');
        near(stats.maxStep.metres, 1, 0.01, 'adjacent-vertex step');
        assert.strictEqual(stats.maxStep.axis, 'x');
        const overSteep = stats.buckets.find((b) => b.upTo === 45);
        assert.strictEqual(overSteep.count, stats.sampled, 'every sample lands in the <=45 bucket');
    });

    it('locates the crease of a step and stays flat elsewhere', () => {
        const data = terrainFrom((x) => (x < 16 ? 0 : 3));
        const stats = slopeStats(data);
        near(stats.maxStep.metres, 3, 0.01, 'the step height');
        assert.strictEqual(stats.maxStep.x, 15, 'the vertex before the jump owns the step');
        assert.ok(stats.max.degrees > 50, 'a 3 m rise over 1 m is steep');
        assert.ok(stats.mean < 6, 'the rest of the plane is flat');
    });

    it('honours a region and a coarser sampleCount', () => {
        const data = terrainFrom((x) => x / 10);
        const stats = slopeStats(data, { region: { x: 4, z: 4, width: 8, depth: 8 }, sampleCount: 5 });
        assert.deepStrictEqual(stats.samples, [5, 5]);
        assert.deepStrictEqual(stats.spacing, [2, 2]);
        near(stats.max.degrees, (Math.atan(0.1) * 180) / Math.PI, 0.5, 'the ramp slope');
    });
});

describe('vertexSampleCount', () => {
    it('is width/tileSize + 1, capped at the real vertex grid', () => {
        const data = materialize({
            blockCount: [1, 1], tileSize: 0.5, weightMapSize: 4, lightMapSize: 4, layers: []
        });
        assert.deepStrictEqual(vertexSampleCount(data, { x: 0, z: 0, width: 4, depth: 2 }), [9, 5]);
        // The whole terrain is 16 m at 0.5 m → 33 vertices, which is also the grid size
        assert.deepStrictEqual(vertexSampleCount(data), [33, 33]);
    });
});
