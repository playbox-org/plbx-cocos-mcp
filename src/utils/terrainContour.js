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
    let holes = 0;
    let min = Infinity;
    let max = -Infinity;
    for (let line = 0; line < lineCount; line++) {
        const crossings = [];
        let sawNull = false;
        for (let n = 0; n + 1 < alongCount; n++) {
            const h0 = heightAtIdx(line, n);
            const h1 = heightAtIdx(line, n + 1);
            if (h0 === null || h1 === null) { sawNull = true; continue; }
            const s0 = h0 - T;
            const s1 = h1 - T;
            if (s0 === 0) {
                push(crossings, alongCoord(n));
                continue;
            }
            if ((s0 < 0) === (s1 < 0)) continue;
            // Linear interpolation between the straddling pair
            push(crossings, alongCoord(n) + (s0 / (s0 - s1)) * step);
        }
        // The far end can sit exactly on the threshold without a following pair to catch it
        const last = heightAtIdx(line, alongCount - 1);
        if (last !== null && last - T === 0) push(crossings, alongCoord(alongCount - 1));
        if (sawNull) holes++;
        crossingsTotal += crossings.length;
        if (crossings.length === 1) {
            singleCrossingLines++;
            if (crossings[0] < min) min = crossings[0];
            if (crossings[0] > max) max = crossings[0];
        }
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
        linesWithoutCrossing: counts.lineCount - counts.singleCrossingLines,
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
 * Signed distance in metres to an iso-contour: marching-squares segments in a bucket grid, so a
 * query is the TRUE distance, bounded by `reach`. Negative on the HIGH side (`-1..2` = inland..out).
 */
export class ContourDistance {
    #data;
    #threshold;
    #segments = []; // [x0, z0, x1, z1] flattened
    #buckets = new Map();
    #cell;
    #reach;

    /**
     * @param {object} data - Terrain data object
     * @param {number} threshold - Contour height in metres
     * @param {{region?: object, sampleCount?: number|number[], reach?: number}} [options]
     *   `reach` (metres, default 1 tile) bounds every query and sizes the lookup buckets
     */
    constructor(data, threshold, options = {}) {
        this.#data = data;
        this.#threshold = requireThreshold(threshold);
        const ts = data.tileSize > 0 ? data.tileSize : 1;
        this.#reach = Number.isFinite(options.reach) && options.reach > 0 ? options.reach : ts;
        this.#cell = Math.max(this.#reach, ts);
        const grid = sampleGrid(data, options);
        this.#extract(grid);
    }

    /** Number of contour segments found (0 = the threshold is above or below the whole region) */
    get segmentCount() {
        return this.#segments.length / 4;
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
        const high = h >= this.#threshold;
        const d = this.#nearest(x, z);
        if (d === null) return null;
        return { signed: high ? -d : d, distance: d, high };
    }

    /** Nearest segment distance within `reach`, or null */
    #nearest(x, z) {
        const bi = Math.floor(x / this.#cell);
        const bj = Math.floor(z / this.#cell);
        let best = Infinity;
        for (let j = bj - 1; j <= bj + 1; j++) {
            for (let i = bi - 1; i <= bi + 1; i++) {
                const list = this.#buckets.get(`${i},${j}`);
                if (!list) continue;
                for (const s of list) {
                    const d = pointSegmentDistance(x, z, this.#segments[s], this.#segments[s + 1],
                        this.#segments[s + 2], this.#segments[s + 3]);
                    if (d < best) best = d;
                }
            }
        }
        return best <= this.#reach ? best : null;
    }

    /** Marching squares over the sampled grid; every cell contributes 0, 1 or 2 segments */
    #extract(grid) {
        const T = this.#threshold;
        const at = (i, j) => grid.rows2d[j][i];
        for (let j = 0; j + 1 < grid.rows; j++) {
            for (let i = 0; i + 1 < grid.cols; i++) {
                const h = [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)];
                if (h.some((v) => v === null)) continue;
                const x0 = grid.xAt(i);
                const x1 = grid.xAt(i + 1);
                const z0 = grid.zAt(j);
                const z1 = grid.zAt(j + 1);
                const corners = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
                // Crossings on the four edges, in cell order — 0, 2 or 4 of them
                const pts = [];
                for (let e = 0; e < 4; e++) {
                    const a = h[e] - T;
                    const b = h[(e + 1) % 4] - T;
                    if (a === 0 && b === 0) continue; // a whole edge on the contour: its ends carry it
                    if ((a < 0) === (b < 0)) continue;
                    const t = a / (a - b);
                    const [ax, az] = corners[e];
                    const [bx, bz] = corners[(e + 1) % 4];
                    pts.push([ax + (bx - ax) * t, az + (bz - az) * t]);
                }
                if (pts.length === 2) {
                    this.#addSegment(pts[0], pts[1]);
                } else if (pts.length === 4) {
                    // Saddle: the pairing is ambiguous, and edge order keeps both branches —
                    // the alternative gives the same distance field to within a cell
                    this.#addSegment(pts[0], pts[1]);
                    this.#addSegment(pts[2], pts[3]);
                }
            }
        }
    }

    #addSegment(a, b) {
        const s = this.#segments.length;
        this.#segments.push(a[0], a[1], b[0], b[1]);
        const i0 = Math.floor(Math.min(a[0], b[0]) / this.#cell);
        const i1 = Math.floor(Math.max(a[0], b[0]) / this.#cell);
        const j0 = Math.floor(Math.min(a[1], b[1]) / this.#cell);
        const j1 = Math.floor(Math.max(a[1], b[1]) / this.#cell);
        for (let j = j0; j <= j1; j++) {
            for (let i = i0; i <= i1; i++) {
                const key = `${i},${j}`;
                const list = this.#buckets.get(key);
                if (list) list.push(s);
                else this.#buckets.set(key, [s]);
            }
        }
    }
}

function pointSegmentDistance(px, pz, ax, az, bx, bz) {
    const vx = bx - ax;
    const vz = bz - az;
    const len2 = vx * vx + vz * vz;
    let t = len2 === 0 ? 0 : ((px - ax) * vx + (pz - az) * vz) / len2;
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
    const dx = px - (ax + vx * t);
    const dz = pz - (az + vz * t);
    return Math.sqrt(dx * dx + dz * dz);
}

// --- slope + crease ---------------------------------------------------------

/**
 * Gradient magnitude in degrees (central differences, one-sided at the border) plus `maxStep`, the
 * largest ADJACENT-sample difference — the crease metric, read against its pre-edit value.
 * @param {object} data - Terrain data object
 * @param {{region?: object, sampleCount?: number|number[]}} [options]
 * @returns {object} `{region, samples, spacing, max, mean, maxStep, buckets, sampled, skipped}`
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
    const buckets = SLOPE_BUCKETS.map((upTo) => ({ upTo, count: 0 }));
    buckets.push({ upTo: null, count: 0 });

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
