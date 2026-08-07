/**
 * terrainContour — iso-contour, signed-distance and slope analytics over a terrain height field
 *
 * An edit meeting existing geometry meets an ISO-CONTOUR: where it runs, how far a point is from
 * it, whether an edit creased it. Sampling is terrainBin's; only interpolation lives here.
 */

import { exportHeights, heightAt, terrainSize, vertexCounts } from './terrainBin.js';

/** Sampling caps: a contour scan is a grid dump plus O(1) per sample */
export const CONTOUR_MAX_AXIS = 2049;
export const CONTOUR_MAX_CELLS = 1_000_000;

/** Slope buckets in degrees — the "is this walkable" breakdown */
const SLOPE_BUCKETS = [15, 30, 45];

/** Floats per contour segment in `ContourDistance`: two endpoints + the uphill direction */
const SEG = 6;

/** Thrown for an unusable request (bad region/threshold) */
export class ContourError extends Error {
    name = 'ContourError';
}

// --- shared sampling --------------------------------------------------------

/**
 * Region + sample count → the grid every function here works on. The default resolution is the
 * region's VERTEX grid: a downsampled one blurs the very edge being measured.
 * @param {object} data - Terrain data object
 * @param {{region?: object, sampleCount?: number|number[]}} [options]
 * @returns {{region: object, cols: number, rows: number, dx: number, dz: number,
 *   rows2d: Array<Array<number|null>>, xAt: (i: number) => number, zAt: (j: number) => number}}
 */
export function sampleGrid(data, options = {}) {
    const [sw, sh] = terrainSize(data);
    const raw = options.region ?? null;
    const region = {
        x: raw?.x ?? 0,
        z: raw?.z ?? 0,
        width: raw?.width ?? Math.max(0, sw - (raw?.x ?? 0)),
        depth: raw?.depth ?? Math.max(0, sh - (raw?.z ?? 0)),
    };
    for (const key of ['x', 'z', 'width', 'depth']) {
        if (!Number.isFinite(region[key])) {
            throw new ContourError(`region.${key} must be a finite number of metres`);
        }
    }
    for (const key of ['width', 'depth']) {
        if (region[key] <= 0) {
            throw new ContourError(
                `region.${key} must be > 0 metres (it defaults to the distance from ` +
                `${key === 'width' ? 'x' : 'z'} to the far edge, which is ${region[key]} m here)`
            );
        }
    }

    let cols;
    let rows;
    if (options.sampleCount === undefined || options.sampleCount === null) {
        const ts = data.tileSize > 0 ? data.tileSize : 1;
        cols = clampAxis(Math.max(2, Math.round(region.width / ts) + 1));
        rows = clampAxis(Math.max(2, Math.round(region.depth / ts) + 1));
        // Scale both axes alike so a long thin strip does not lose its long axis first
        if (cols * rows > CONTOUR_MAX_CELLS) {
            const scale = Math.sqrt(CONTOUR_MAX_CELLS / (cols * rows));
            cols = Math.max(2, Math.floor(cols * scale));
            rows = Math.max(2, Math.min(Math.floor(rows * scale), Math.floor(CONTOUR_MAX_CELLS / cols)));
        }
    } else {
        const pair = Array.isArray(options.sampleCount)
            ? options.sampleCount
            : [options.sampleCount, options.sampleCount];
        if (pair.length !== 2) {
            throw new ContourError('sampleCount must be a number or a [cols, rows] pair');
        }
        for (const [name, n] of [['cols', pair[0]], ['rows', pair[1]]]) {
            if (!Number.isInteger(n) || n < 2 || n > CONTOUR_MAX_AXIS) {
                throw new ContourError(
                    `sampleCount ${name} must be an integer in 2..${CONTOUR_MAX_AXIS}, got ${show(n)}`
                );
            }
        }
        if (pair[0] * pair[1] > CONTOUR_MAX_CELLS) {
            throw new ContourError(
                `sampleCount ${pair[0]}x${pair[1]} = ${pair[0] * pair[1]} samples exceeds ` +
                `${CONTOUR_MAX_CELLS} — ask for a smaller region`
            );
        }
        [cols, rows] = pair;
    }

    const rows2d = exportHeights(data, region, [cols, rows]);
    const dx = region.width / (cols - 1);
    const dz = region.depth / (rows - 1);
    return {
        region,
        cols,
        rows,
        dx,
        dz,
        rows2d,
        xAt: (i) => region.x + i * dx,
        zAt: (j) => region.z + j * dz,
    };
}

function clampAxis(n) {
    return Math.min(Math.max(n, 2), CONTOUR_MAX_AXIS);
}

function show(v) {
    return typeof v === 'number' ? String(v) : (JSON.stringify(v) ?? String(v));
}

function requireThreshold(threshold) {
    if (typeof threshold !== 'number' || !Number.isFinite(threshold)) {
        throw new ContourError(`threshold must be a finite height in metres, got ${show(threshold)}`);
    }
    return threshold;
}

// --- contour crossings ------------------------------------------------------

/**
 * Where the iso-contour crosses each scan line, interpolated between the straddling sample pair
 * (`axis: "x"` = one line per z). A jump in the crossing list IS a step in the geometry.
 * @param {object} data - Terrain data object
 * @param {number} threshold - Contour height in metres
 * @param {{region?: object, sampleCount?: number|number[], axis?: string}} [options]
 * @returns {object} `{threshold, axis, region, samples, spacing, lines, stats}`
 */
export function contourCrossings(data, threshold, options = {}) {
    const T = requireThreshold(threshold);
    const axis = options.axis ?? 'x';
    if (axis !== 'x' && axis !== 'z') {
        throw new ContourError(`axis must be "x" or "z", got ${show(options.axis)}`);
    }
    const grid = sampleGrid(data, options);

    // One line per constant value of the OTHER axis; `along` walks the scanned axis.
    const lineCount = axis === 'x' ? grid.rows : grid.cols;
    const alongCount = axis === 'x' ? grid.cols : grid.rows;
    const step = axis === 'x' ? grid.dx : grid.dz;
    const lineCoord = axis === 'x' ? grid.zAt : grid.xAt;
    const alongCoord = axis === 'x' ? grid.xAt : grid.zAt;
    const heightAtIdx = axis === 'x'
        ? (line, along) => grid.rows2d[line][along]
        : (line, along) => grid.rows2d[along][line];

    const lines = [];
    let crossingsTotal = 0;
    let singleCrossingLines = 0;
    let emptyLines = 0;
    let multiCrossingLines = 0;
    let onContour = 0;
    let holes = 0;
    let min = Infinity;
    let max = -Infinity;
    for (let line = 0; line < lineCount; line++) {
        const crossings = [];
        let sawNull = false;
        // Three states per sample: below the contour, exactly ON it, above it. A crossing is a
        // TRANSITION — interpolated between a straddling pair, or at the end of a run of samples
        // sitting exactly on the threshold where something strictly signed adjoins it. Heights are
        // quantized to 1/128 m, so a sample landing exactly on a round contour is the rule, not the
        // edge case: counting each one as a crossing turns a plateau AT the threshold into one
        // crossing per vertex and hides the rim that is the actual answer.
        let prevSign = 0;   // sign of the last strictly-signed sample, 0 = none yet on this line
        let inRun = false;  // inside a run of exactly-on-threshold samples
        let lastOn = -1;
        for (let n = 0; n < alongCount; n++) {
            const h = heightAtIdx(line, n);
            if (h === null) {
                // A gap interpolates nothing and adjoins nothing: both runs end unreported
                sawNull = true;
                prevSign = 0;
                inRun = false;
                continue;
            }
            const s = h - T;
            if (s === 0) {
                onContour++;
                if (!inRun) {
                    inRun = true;
                    if (prevSign !== 0) push(crossings, alongCoord(n));
                }
                lastOn = n;
                continue;
            }
            const sign = s < 0 ? -1 : 1;
            if (inRun) {
                push(crossings, alongCoord(lastOn));
                inRun = false;
            } else if (prevSign !== 0 && prevSign !== sign) {
                const s0 = heightAtIdx(line, n - 1) - T;
                push(crossings, alongCoord(n - 1) + (s0 / (s0 - s)) * step);
            }
            prevSign = sign;
        }
        if (sawNull) holes++;
        crossingsTotal += crossings.length;
        if (crossings.length === 0) emptyLines++;
        else if (crossings.length === 1) {
            singleCrossingLines++;
            if (crossings[0] < min) min = crossings[0];
            if (crossings[0] > max) max = crossings[0];
        } else multiCrossingLines++;
        lines.push({ coord: lineCoord(line), crossings });
    }

    return {
        threshold: T,
        axis,
        region: grid.region,
        samples: [grid.cols, grid.rows],
        spacing: [grid.dx, grid.dz],
        lines,
        stats: contourStats(lines, {
            lineCount,
            crossingsTotal,
            singleCrossingLines,
            emptyLines,
            multiCrossingLines,
            onContour,
            holes,
            min: singleCrossingLines ? min : null,
            max: singleCrossingLines ? max : null,
        }),
    };
}

/** Avoid a duplicate crossing when a sample sits exactly on the threshold */
function push(crossings, value) {
    if (crossings.length && Math.abs(crossings[crossings.length - 1] - value) < 1e-9) return;
    crossings.push(value);
}

/**
 * Continuity/monotonicity of a crossing list, over consecutive SINGLE-crossing lines only —
 * a line with two crossings is a lagoon, not a step.
 */
function contourStats(lines, counts) {
    let maxJump = null;
    let increasing = true;
    let decreasing = true;
    let comparable = 0;
    for (let i = 0; i + 1 < lines.length; i++) {
        const a = lines[i].crossings;
        const b = lines[i + 1].crossings;
        if (a.length !== 1 || b.length !== 1) continue;
        comparable++;
        const jump = b[0] - a[0];
        if (jump < 0) increasing = false;
        if (jump > 0) decreasing = false;
        if (!maxJump || Math.abs(jump) > Math.abs(maxJump.value)) {
            maxJump = { value: jump, from: a[0], to: b[0], fromCoord: lines[i].coord, toCoord: lines[i + 1].coord };
        }
    }
    const uniform = counts.crossingsTotal > 0
        && counts.singleCrossingLines === counts.lineCount;
    return {
        lines: counts.lineCount,
        crossings: counts.crossingsTotal,
        singleCrossingLines: counts.singleCrossingLines,
        // Lines with NO crossing at all, and lines with several — the two halves of
        // `lines - singleCrossingLines`, which one number cannot tell apart
        linesWithoutCrossing: counts.emptyLines,
        multiCrossingLines: counts.multiCrossingLines,
        samplesOnContour: counts.onContour,
        linesWithGaps: counts.holes,
        uniform,
        monotone: comparable > 0 ? (increasing || decreasing) : null,
        maxJump,
        min: counts.min,
        max: counts.max,
    };
}

// --- signed distance to a contour -------------------------------------------

/**
 * Signed distance in metres to an iso-contour: marching-squares segments in a bucket grid walked
 * outward ring by ring, so a query is the TRUE distance (brute-force exact) at a cost set by the
 * contour NEAR the point rather than by its total length, bounded by `reach`. Negative on the HIGH
 * side (`-1..2` = inland..out).
 */
export class ContourDistance {
    #data;
    #threshold;
    // [x0, z0, x1, z1, ux, uz] flattened — `u` is the local UPHILL direction (unnormalized),
    // the only thing that can tell which side a point exactly ON the threshold lies on
    #segments = [];
    // Flat `j * bw + i` grid of segment-offset lists, holes where a cell holds no segment
    #buckets = [];
    #cell;
    #reach;
    #bx0 = 0;
    #bz0 = 0;
    #bw = 1;
    #bh = 1;
    #tests = 0;

    /**
     * @param {object} data - Terrain data object
     * @param {number} threshold - Contour height in metres
     * @param {{region?: object, sampleCount?: number|number[], reach?: number}} [options]
     *   `reach` (metres, default 1 tile) bounds every query
     */
    constructor(data, threshold, options = {}) {
        this.#data = data;
        this.#threshold = requireThreshold(threshold);
        const ts = data.tileSize > 0 ? data.tileSize : 1;
        this.#reach = Number.isFinite(options.reach) && options.reach > 0 ? options.reach : ts;
        const grid = sampleGrid(data, options);
        // Cell size balances the two costs a query pays — `reach / cell` rings walked against
        // `cell / spacing` segments per bucket — at their geometric mean, and never goes below the
        // sample spacing (so there are never more buckets than samples, i.e. CONTOUR_MAX_CELLS of
        // them). Sizing it by `reach`, as this did, put every segment of a wide band in ONE bucket:
        // each query then scanned the whole contour, once per weight texel of a paint_layer.
        const spacing = Math.max(grid.dx, grid.dz);
        this.#cell = Math.max(spacing, Math.sqrt(this.#reach * spacing));
        this.#bx0 = grid.region.x;
        this.#bz0 = grid.region.z;
        this.#bw = Math.floor(grid.region.width / this.#cell) + 1;
        this.#bh = Math.floor(grid.region.depth / this.#cell) + 1;
        this.#buckets = new Array(this.#bw * this.#bh);
        this.#extract(grid);
    }

    /** Contour segments found (0 = the region is entirely above, entirely below, or entirely AT it) */
    get segmentCount() {
        return this.#segments.length / SEG;
    }

    /**
     * TEST SEAM, no src/ caller: the flattened `[x0, z0, x1, z1, ux, uz]` rows, so a query can be
     * checked against a brute-force scan over all of them — the only thing that shows `#nearest`'s
     * ring-walk early-out still answers the TRUE nearest.
     */
    get segments() {
        return [...this.#segments];
    }

    /** TEST SEAM, no src/ caller: segment-distance tests so far — the cost the bucket grid bounds */
    get segmentTests() {
        return this.#tests;
    }

    get threshold() {
        return this.#threshold;
    }

    get reach() {
        return this.#reach;
    }

    /**
     * @param {number} x - Local X in metres
     * @param {number} z - Local Z in metres
     * @param {number|null} [height] - Height at (x, z) when the caller already has it
     * @returns {{signed: number, distance: number, high: boolean}|null} null when the point is
     *   off the terrain, or farther from the contour than `reach`
     */
    signedDistanceAt(x, z, height = undefined) {
        const h = height === undefined ? heightAt(this.#data, x, z) : height;
        if (h === null || h === undefined) return null;
        const near = this.#nearest(x, z);
        if (near === null) return null;
        // A point sitting exactly ON the threshold is on the contour itself, and its own height
        // then says nothing about which side it is on: a plain AT the contour height is BELOW the
        // hill standing on it, a plateau AT that height is ABOVE the ramp leading up to it. Both
        // are ordinary (heights are quantized to 1/128 m), so ask the geometry — the nearest
        // segment carries the direction the ground rises in.
        const s = near.s;
        const high = h === this.#threshold
            ? (x - near.px) * this.#segments[s + 4] + (z - near.pz) * this.#segments[s + 5] > 0
            : h > this.#threshold;
        return { signed: high ? -near.distance : near.distance, distance: near.distance, high };
    }

    /**
     * Nearest segment within `reach`: its base offset, its distance and the point on it that is
     * closest — the foot of the perpendicular the sign of a tie is measured from.
     *
     * Buckets are walked outward ring by ring. Every bucket of ring `r` lies at least
     * `(r - 1) * cell` from the query point, so once that floor exceeds the best distance found the
     * remaining rings cannot improve on it and the walk stops — which is what keeps the answer the
     * TRUE nearest, bit-identical to a brute-force scan.
     *
     * It is not a handful of tests, it is a LOCAL number: measured on the tests' 1808-segment
     * ripple field (`4·sin(x/1.5)·cos(z/1.5)` over 2x2 blocks, contour 0), 13 tests per query at a
     * 1 m reach and 219 at 60 m. Reach-sized buckets put that whole contour in the queried
     * neighbourhood, so the win is the WIDE reach (1808/219 ≈ 8x), not the narrow one, where that
     * rule already sized a cell at the sample spacing. A wide reach over a SHORT contour can even
     * exceed the segment count: a segment sits in every bucket it touches.
     * @returns {{s: number, distance: number, px: number, pz: number}|null}
     */
    #nearest(x, z) {
        const ci = Math.floor((x - this.#bx0) / this.#cell);
        const cj = Math.floor((z - this.#bz0) / this.#cell);
        // Neither past the reach nor past the far side of the grid: a reach far larger than the
        // terrain would otherwise walk ring after ring of out-of-range buckets
        const maxRing = Math.min(
            Math.ceil(this.#reach / this.#cell) + 1,
            Math.max(ci, this.#bw - 1 - ci, cj, this.#bh - 1 - cj)
        );
        let best = Infinity;
        let found = null;
        for (let r = 0; r <= maxRing; r++) {
            if ((r - 1) * this.#cell > Math.min(best, this.#reach)) break;
            for (let j = cj - r; j <= cj + r; j++) {
                if (j < 0 || j >= this.#bh) continue;
                // Only the ring's perimeter: the interior came out of an earlier r
                const step = (j === cj - r || j === cj + r) ? 1 : 2 * r;
                for (let i = ci - r; i <= ci + r; i += step) {
                    if (i < 0 || i >= this.#bw) continue;
                    const list = this.#buckets[j * this.#bw + i];
                    if (!list) continue;
                    for (const s of list) {
                        this.#tests++;
                        const p = closestPointOnSegment(x, z, this.#segments[s], this.#segments[s + 1],
                            this.#segments[s + 2], this.#segments[s + 3]);
                        if (p.distance < best) {
                            best = p.distance;
                            found = { s, distance: p.distance, px: p.x, pz: p.z };
                        }
                    }
                }
            }
        }
        return best <= this.#reach ? found : null;
    }

    /**
     * A sample sitting EXACTLY on the threshold belongs to two different edges: `{h > T}` and
     * `{h >= T}` have different boundaries, and either can be the one the caller means — a plateau
     * exactly at T has a rim (only `>=` sees it), a plain exactly at T has none but a hill standing
     * on it does (only `>` sees that). Heights are quantized to 1/128 m, so both cases are ordinary.
     * March twice and keep the union; with no exact tie the two passes are identical, so the second
     * one only visits the cells that have one.
     */
    #extract(grid) {
        if (this.#march(grid, false)) this.#march(grid, true);
    }

    /**
     * Marching squares over the sampled grid; every cell contributes 0, 1 or 2 segments.
     * @param {object} grid
     * @param {boolean} inclusive - Count a sample exactly on the threshold as HIGH; when set, only
     *   cells that actually have such a sample are visited (the rest came out of the first pass)
     * @returns {boolean} whether any sample sat exactly on the threshold
     */
    #march(grid, inclusive) {
        const T = this.#threshold;
        const at = (i, j) => grid.rows2d[j][i];
        const high = (s) => (inclusive ? s >= 0 : s > 0);
        let sawTie = false;
        for (let j = 0; j + 1 < grid.rows; j++) {
            for (let i = 0; i + 1 < grid.cols; i++) {
                const h = [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)];
                if (h.some((v) => v === null)) continue;
                const tie = h.some((v) => v - T === 0);
                if (tie) sawTie = true;
                if (inclusive && !tie) continue;
                const x0 = grid.xAt(i);
                const x1 = grid.xAt(i + 1);
                const z0 = grid.zAt(j);
                const z1 = grid.zAt(j + 1);
                const corners = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
                // Crossings on the four edges, in cell order — 0, 2 or 4 of them (the corner
                // states change an even number of times around a closed loop of four)
                const pts = [];
                for (let e = 0; e < 4; e++) {
                    const a = h[e] - T;
                    const b = h[(e + 1) % 4] - T;
                    if (high(a) === high(b)) continue;
                    const t = a / (a - b); // a !== b here, so never 0/0
                    const [ax, az] = corners[e];
                    const [bx, bz] = corners[(e + 1) % 4];
                    pts.push([ax + (bx - ax) * t, az + (bz - az) * t]);
                }
                if (pts.length === 0) continue;
                const cell = [x0, x1, z0, z1];
                if (pts.length === 2) {
                    this.#addSegment(pts[0], pts[1], uphillAt(h, cell, pts[0], pts[1]));
                } else if (pts.length === 4) {
                    // Saddle: the pairing is ambiguous, and edge order keeps both branches —
                    // the alternative gives the same distance field to within a cell
                    this.#addSegment(pts[0], pts[1], uphillAt(h, cell, pts[0], pts[1]));
                    this.#addSegment(pts[2], pts[3], uphillAt(h, cell, pts[2], pts[3]));
                }
            }
        }
        return sawTie;
    }

    #addSegment(a, b, uphill) {
        const s = this.#segments.length;
        this.#segments.push(a[0], a[1], b[0], b[1], uphill[0], uphill[1]);
        // Registered in every bucket its AABB overlaps, clamped: a segment sits inside the sampled
        // region by construction, but rounding can put an endpoint a hair outside it
        const i0 = this.#bucket(a[0], b[0], this.#bx0, this.#bw, Math.min);
        const i1 = this.#bucket(a[0], b[0], this.#bx0, this.#bw, Math.max);
        const j0 = this.#bucket(a[1], b[1], this.#bz0, this.#bh, Math.min);
        const j1 = this.#bucket(a[1], b[1], this.#bz0, this.#bh, Math.max);
        for (let j = j0; j <= j1; j++) {
            for (let i = i0; i <= i1; i++) {
                const key = j * this.#bw + i;
                const list = this.#buckets[key];
                if (list) list.push(s);
                else this.#buckets[key] = [s];
            }
        }
    }

    /** Bucket index of `pick(u, v)` along one axis, clamped into the bucket grid */
    #bucket(u, v, origin, count, pick) {
        const n = Math.floor((pick(u, v) - origin) / this.#cell);
        return n < 0 ? 0 : (n >= count ? count - 1 : n);
    }
}

/**
 * Uphill direction at a segment's midpoint: the gradient of the cell's bilinear field, per SEGMENT
 * so a saddle's two branches get their own. Unnormalized — only its sign against a point offset is
 * ever read.
 * @param {number[]} h - Corner heights in cell order: (i,j), (i+1,j), (i+1,j+1), (i,j+1)
 * @param {number[]} cell - `[x0, x1, z0, z1]` of the cell in metres
 * @param {number[]} a - Segment endpoint `[x, z]`
 * @param {number[]} b - The other endpoint
 * @returns {number[]} `[ux, uz]`
 */
function uphillAt(h, cell, a, b) {
    const [x0, x1, z0, z1] = cell;
    const dx = x1 - x0;
    const dz = z1 - z0;
    const u = dx === 0 ? 0 : ((a[0] + b[0]) / 2 - x0) / dx;
    const v = dz === 0 ? 0 : ((a[1] + b[1]) / 2 - z0) / dz;
    return [
        ((1 - v) * (h[1] - h[0]) + v * (h[2] - h[3])) / (dx || 1),
        ((1 - u) * (h[3] - h[0]) + u * (h[2] - h[1])) / (dz || 1),
    ];
}

/** Closest point of a segment to (px, pz), with its distance */
function closestPointOnSegment(px, pz, ax, az, bx, bz) {
    const vx = bx - ax;
    const vz = bz - az;
    const len2 = vx * vx + vz * vz;
    let t = len2 === 0 ? 0 : ((px - ax) * vx + (pz - az) * vz) / len2;
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
    const x = ax + vx * t;
    const z = az + vz * t;
    const dx = px - x;
    const dz = pz - z;
    return { x, z, distance: Math.sqrt(dx * dx + dz * dz) };
}

// --- slope + crease ---------------------------------------------------------

/**
 * Gradient magnitude in degrees (central differences, one-sided at the border) plus `maxStep`, the
 * largest ADJACENT-sample difference — the crease metric, read against its pre-edit value.
 * @param {object} data - Terrain data object
 * @param {{region?: object, sampleCount?: number|number[]}} [options]
 * @returns {object} `{region, samples, spacing, max, mean, maxStep, buckets, sampled, skipped}` —
 *   `buckets` are DISJOINT bands `(from, upTo]`, each with the `label` it is counted under
 */
export function slopeStats(data, options = {}) {
    const grid = sampleGrid(data, options);
    const { rows2d, cols, rows, dx, dz } = grid;

    let maxDeg = -1;
    let maxAt = null;
    let sum = 0;
    let sampled = 0;
    let skipped = 0;
    let maxStep = null;
    // DISJOINT bands, each carrying the label it is counted under: a `<=N°` reading of a band
    // count is off by every gentler band, and "how much is walkable" is the question being asked
    const buckets = [];
    for (const upTo of SLOPE_BUCKETS) {
        const from = buckets.length ? buckets[buckets.length - 1].upTo : 0;
        buckets.push({ from, upTo, label: `${from}-${upTo}°`, count: 0 });
    }
    const last = buckets[buckets.length - 1].upTo;
    buckets.push({ from: last, upTo: null, label: `>${last}°`, count: 0 });

    const finite = (v) => v !== null && v !== undefined;
    for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
            const h = rows2d[j][i];
            if (!finite(h)) { skipped++; continue; }
            // Forward neighbours only, so each pair is measured once
            for (const [ni, nj, axis] of [[i + 1, j, 'x'], [i, j + 1, 'z']]) {
                if (ni >= cols || nj >= rows) continue;
                const hn = rows2d[nj][ni];
                if (!finite(hn)) continue;
                const step = Math.abs(hn - h);
                if (!maxStep || step > maxStep.metres) {
                    maxStep = { metres: step, x: grid.xAt(i), z: grid.zAt(j), axis };
                }
            }

            const gx = difference(rows2d, i, j, cols, 'x', dx);
            const gz = difference(rows2d, i, j, rows, 'z', dz);
            if (gx === null || gz === null) { skipped++; continue; }
            const deg = (Math.atan(Math.sqrt(gx * gx + gz * gz)) * 180) / Math.PI;
            sampled++;
            sum += deg;
            if (deg > maxDeg) {
                maxDeg = deg;
                maxAt = { x: grid.xAt(i), z: grid.zAt(j) };
            }
            const bucket = buckets.find((b) => b.upTo !== null && deg <= b.upTo) ?? buckets[buckets.length - 1];
            bucket.count++;
        }
    }

    return {
        region: grid.region,
        samples: [cols, rows],
        spacing: [dx, dz],
        max: maxAt ? { degrees: maxDeg, ...maxAt } : null,
        mean: sampled ? sum / sampled : null,
        maxStep,
        buckets,
        sampled,
        skipped,
    };
}

/** Central difference where both neighbours exist, one-sided at a border, null when neither does */
function difference(rows2d, i, j, count, axis, spacing) {
    const at = (n) => (axis === 'x' ? rows2d[j][n] : rows2d[n][i]);
    const n = axis === 'x' ? i : j;
    const prev = n > 0 ? at(n - 1) : null;
    const next = n + 1 < count ? at(n + 1) : null;
    const here = at(n);
    if (prev !== null && next !== null) return (next - prev) / (2 * spacing);
    if (next !== null) return (next - here) / spacing;
    if (prev !== null) return (here - prev) / spacing;
    return null;
}

// --- vertex grid helper -----------------------------------------------------

/**
 * The sampleCount that dumps a region at exactly its VERTEX resolution (`width / tileSize + 1`) —
 * what a contour derivation needs, and hand-computed otherwise.
 * @param {object} data - Terrain data object
 * @param {{x?: number, z?: number, width?: number, depth?: number}} [region]
 * @returns {number[]} `[cols, rows]`
 */
export function vertexSampleCount(data, region = null) {
    const [sw, sh] = terrainSize(data);
    const ts = data.tileSize > 0 ? data.tileSize : 1;
    const width = region?.width ?? Math.max(0, sw - (region?.x ?? 0));
    const depth = region?.depth ?? Math.max(0, sh - (region?.z ?? 0));
    const [vx, vz] = vertexCounts(data.blockCount);
    return [
        Math.min(clampAxis(Math.max(2, Math.round(width / ts) + 1)), vx),
        Math.min(clampAxis(Math.max(2, Math.round(depth / ts) + 1)), vz),
    ];
}
