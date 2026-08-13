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

/** Independent nearest-segment scan over flattened `[x0,z0,x1,z1,ux,uz]` rows: no buckets */
function bruteNearest(segments, x, z) {
    let best = Infinity;
    for (let s = 0; s < segments.length; s += 6) {
        const [ax, az, bx, bz] = segments.slice(s, s + 4);
        const vx = bx - ax;
        const vz = bz - az;
        const len2 = vx * vx + vz * vz;
        let t = len2 === 0 ? 0 : ((x - ax) * vx + (z - az) * vz) / len2;
        t = t < 0 ? 0 : (t > 1 ? 1 : t);
        const dx = x - (ax + vx * t);
        const dz = z - (az + vz * t);
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d < best) best = d;
    }
    return best;
}

/** mulberry32 — a seeded PRNG so a sweep over random points is reproducible */
function rng(seed) {
    let a = seed;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

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

    // The bucket grid is a spatial INDEX, not a bookkeeping detail: `paint_layer` issues one query
    // per weight texel of every touched block, so a query that scans the whole contour is tens of
    // millions of segment tests in a single edit. These two pin both halves — the answer is still
    // the true nearest segment, and getting it costs a fraction of the contour.
    it('answers exactly what a brute-force scan over the segments does', () => {
        // A saddle plus a plateau exactly AT the threshold: two contour branches that cross, ties on
        // both of them, and points equidistant from several segments near the centre
        const data = terrainFrom((x, z) => Math.min(((x - 16) ** 2 - (z - 16) ** 2) / 40, 3));
        const cd = new ContourDistance(data, 0, { reach: 12 });
        const segments = cd.segments;
        assert.ok(cd.segmentCount > 40, `expected a rich contour, got ${cd.segmentCount}`);
        const brute = (x, z) => bruteNearest(segments, x, z);

        let checked = 0;
        for (let z = 0; z <= 32; z += 0.5) {
            for (let x = 0; x <= 32; x += 0.5) {
                const sd = cd.signedDistanceAt(x, z);
                const expected = brute(x, z);
                if (expected > 12) {
                    assert.strictEqual(sd, null, `(${x},${z}) is ${expected} m out, past the reach`);
                    continue;
                }
                assert.ok(sd, `(${x},${z}) is ${expected} m from the contour but answered null`);
                // Bit-for-bit, not "close": the ring walk must not settle for a nearer bucket
                assert.strictEqual(sd.distance, expected, `distance at (${x},${z})`);
                checked++;
            }
        }
        assert.ok(checked > 500, `expected the reach to cover most of the grid, got ${checked}`);
    });

    // Same claim swept wide, because the ring walk's early-out is where an "almost nearest" answer
    // would hide: 4 fields (ties on two of them) x 4 reach values x 250 seeded random points.
    it('matches a brute-force scan across every field and reach', () => {
        const fields = [
            ['cone', terrainFrom((x, z) => 5 - Math.hypot(x - 16, z - 16)), 2, 32],
            ['saddle+plateau', terrainFrom((x, z) => Math.min(((x - 16) ** 2 - (z - 16) ** 2) / 40, 3)), 0, 32],
            ['flat-topped ramp', terrainFrom((x) => Math.min(x / 4, 5)), 5, 32],
            ['dunes', terrainFrom((x, z) => 4 * Math.sin(x / 3) * Math.cos(z / 3), { blockCount: [2, 2] }), 0, 64],
        ];
        let checked = 0;
        for (const [name, data, threshold, span] of fields) {
            for (const reach of [1, 4, 20, 60]) {
                const cd = new ContourDistance(data, threshold, { reach });
                const segments = cd.segments;
                const random = rng(0x5eed);
                for (let n = 0; n < 250; n++) {
                    const x = random() * span;
                    const z = random() * span;
                    const expected = bruteNearest(segments, x, z);
                    const sd = cd.signedDistanceAt(x, z);
                    if (expected > reach) {
                        assert.strictEqual(sd, null, `${name} reach ${reach}: (${x},${z}) is ${expected} m out`);
                        continue;
                    }
                    assert.ok(sd, `${name} reach ${reach}: (${x},${z}) is ${expected} m away, answered null`);
                    assert.strictEqual(sd.distance, expected, `${name} reach ${reach} at (${x},${z})`);
                    checked++;
                }
            }
        }
        assert.ok(checked > 2000, `expected most of the 4000 points inside a reach, got ${checked}`);
    });

    // The class doc quotes these two, since "a handful of segment tests" was measurably wrong.
    // The field is the RIPPLE below (1808 segments), not the dune field of the next test (922):
    // the doc named the dune one while quoting these numbers.
    it('costs a LOCAL number of segment tests, quoted by the doc', () => {
        const data = terrainFrom(
            (x, z) => 4 * Math.sin(x / 1.5) * Math.cos(z / 1.5), { blockCount: [2, 2] });
        const perQuery = (reach) => {
            const cd = new ContourDistance(data, 0, { reach });
            let queries = 0;
            for (let z = 0; z <= 64; z += 1) {
                for (let x = 0; x <= 64; x += 1) { cd.signedDistanceAt(x, z); queries++; }
            }
            return { segments: cd.segmentCount, per: cd.segmentTests / queries };
        };
        const tight = perQuery(1);
        const wide = perQuery(60);
        assert.strictEqual(tight.segments, 1808, 'the field the doc quotes');
        // 13.4 and 218.8 measured — a 60x wider reach costs 16x, never the whole contour
        assert.ok(tight.per > 8 && tight.per < 18, `1 m reach: ${tight.per.toFixed(1)} tests/query`);
        assert.ok(wide.per > 150 && wide.per < 260, `60 m reach: ${wide.per.toFixed(1)} tests/query`);
        assert.ok(wide.per / wide.segments < 0.15,
            `${wide.per.toFixed(1)} of ${wide.segments} segments at a whole-terrain reach`);
        // ...which is the doc's "1808/219 ≈ 8x" over reach-sized cells, where a 60 m reach put the
        // whole contour in the queried neighbourhood (8.3x measured)
        assert.ok(wide.segments / wide.per > 7,
            `${(wide.segments / wide.per).toFixed(1)}x, doc claims ~8x`);
    });

    it('tests a fraction of the contour per query even when the reach is wide', () => {
        // A dune field: 900+ segments over 4 blocks. Sizing the buckets by `reach` (the old rule)
        // dropped most of them into the queried 3x3 neighbourhood — 496 tests per query, 54% of the
        // whole contour, for every weight texel of a paint_layer.
        const data = terrainFrom((x, z) => 4 * Math.sin(x / 3) * Math.cos(z / 3), { blockCount: [2, 2] });
        const cd = new ContourDistance(data, 0, { reach: 20 });
        assert.ok(cd.segmentCount > 500, `expected a dense contour, got ${cd.segmentCount}`);

        let queries = 0;
        for (let z = 0; z <= 64; z += 1) {
            for (let x = 0; x <= 64; x += 1) {
                cd.signedDistanceAt(x, z);
                queries++;
            }
        }
        // Cost must follow the LOCAL contour density, not the contour's total length
        const perQuery = cd.segmentTests / queries;
        assert.ok(perQuery < cd.segmentCount / 10,
            `${perQuery.toFixed(1)} segment tests per query out of ${cd.segmentCount} segments`);
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
