/**
 * Heightmap decoding + resampling onto a terrain vertex grid.
 *
 * Three sources, exactly the set TERRAIN_PLAN §2.7 fixes:
 * 1. **inline rows** — a 2D JSON array of METRES, `rows[j][i]` with X fastest (the same
 *    row-major order the height grid uses and {@link exportHeights} dumps);
 * 2. **`.raw`** — headerless 16-bit little-endian samples (the World Machine / Unity
 *    interchange format) plus explicit `width`/`height`; 8-bit is accepted too;
 * 3. **`.png`** — grayscale, non-interlaced, 8 or 16 bit, decoded by the minimal
 *    zero-dependency decoder below (`node:zlib` inflate + PNG unfiltering). Anything else
 *    (truecolour, indexed, gray+alpha, interlaced, 1/2/4-bit) is REFUSED with a message
 *    naming what was found and pointing at `.raw` / inline rows. This is not an image
 *    library; a colour heightmap must be converted before it gets here.
 *
 * **Sampling.** `resampleToVertexGrid` is a port of `Terrain.importHeightField`
 * (terrain.ts:1616-1635) on top of `HeightField.getAt`/`getClamp` (height-field.ts) — the
 * same diagonal-split kernel `terrainBin.heightAt` uses, and the same source mapping:
 * `u = i / tileCount` then `x = u * field.w`. Note the source side is NOT
 * endpoint-inclusive: it is exact when the source dimensions equal the TILE count
 * (a 1024x1024 image on a 32-block terrain, i.e. 1025 vertices, maps 1:1 and the last
 * vertex re-uses the last texel through the clamp), and drifts by `w/(w-1)` otherwise.
 * That is the engine's own convention for importing a heightmap and it is ported verbatim.
 *
 * The one deliberate addition is {@link buildHeightGrid}'s exact-match shortcut: a source
 * whose dimensions equal the VERTEX grid is copied 1:1 instead of resampled, so
 * hand-authored inline rows (and an exported-then-reimported grid) survive a round trip
 * unchanged. Every other size goes through the engine port.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

/** Thrown for every bad heightmap input; builders wrap it in their own error type. */
export class HeightmapError extends Error {}

/** Refuse absurd images before allocating: per-axis cap */
export const MAX_HEIGHTMAP_AXIS = 16384;
/** Refuse absurd images before allocating: total sample cap (~64 MB as u16) */
export const MAX_HEIGHTMAP_SAMPLES = 32 * 1024 * 1024;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** PNG colour types (spec 11.2.2) — only 0 is supported */
const PNG_COLOUR_TYPES = {
    0: 'grayscale',
    2: 'truecolour (RGB)',
    3: 'indexed-colour (palette)',
    4: 'grayscale+alpha',
    6: 'truecolour+alpha (RGBA)',
};

/** `clamp` from cocos/core/math */
function clamp(v, min, max) {
    return Math.min(Math.max(v, min), max);
}

function checkDimensions(width, height, what) {
    for (const [name, v] of [['width', width], ['height', height]]) {
        if (!Number.isInteger(v) || v < 1 || v > MAX_HEIGHTMAP_AXIS) {
            throw new HeightmapError(
                `${what}: ${name} must be an integer in 1..${MAX_HEIGHTMAP_AXIS}, got ${v}`
            );
        }
    }
    if (width * height > MAX_HEIGHTMAP_SAMPLES) {
        throw new HeightmapError(
            `${what}: ${width}x${height} = ${width * height} samples exceeds ` +
            `${MAX_HEIGHTMAP_SAMPLES} — downsample the heightmap first`
        );
    }
}

// --- PNG --------------------------------------------------------------------

/**
 * Decode a grayscale, non-interlaced PNG into raw samples.
 *
 * Deliberately minimal: colour type 0 (grayscale) with bit depth 8 or 16, no interlacing.
 * Everything else throws a {@link HeightmapError} that names what was actually found.
 *
 * @param {Buffer|Uint8Array} buffer - Whole PNG file
 * @param {string} [what='heightmap'] - Label for error messages
 * @returns {{width: number, height: number, bitDepth: number, maxValue: number,
 *   data: Uint8Array|Uint16Array}} samples, row-major, X fastest
 * @throws {HeightmapError}
 */
export function decodePng(buffer, what = 'heightmap') {
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
        throw new HeightmapError(`${what}: not a PNG file (bad signature)`);
    }

    let ihdr = null;
    const idat = [];
    let off = 8;
    while (off + 8 <= buf.length) {
        const len = buf.readUInt32BE(off);
        const type = buf.toString('latin1', off + 4, off + 8);
        const dataStart = off + 8;
        if (len > buf.length - dataStart - 4) {
            throw new HeightmapError(
                `${what}: truncated PNG — chunk "${type}" at byte ${off} claims ${len} bytes, ` +
                `only ${Math.max(0, buf.length - dataStart - 4)} left`
            );
        }
        if (type === 'IHDR') {
            if (len !== 13) throw new HeightmapError(`${what}: malformed PNG IHDR (${len} bytes, expected 13)`);
            ihdr = {
                width: buf.readUInt32BE(dataStart),
                height: buf.readUInt32BE(dataStart + 4),
                bitDepth: buf[dataStart + 8],
                colourType: buf[dataStart + 9],
                compression: buf[dataStart + 10],
                filter: buf[dataStart + 11],
                interlace: buf[dataStart + 12],
            };
        } else if (type === 'IDAT') {
            idat.push(buf.subarray(dataStart, dataStart + len));
        } else if (type === 'IEND') {
            break;
        }
        off = dataStart + len + 4; // + CRC
    }

    if (!ihdr) throw new HeightmapError(`${what}: malformed PNG — no IHDR chunk`);
    const hint = 'convert it to 8- or 16-bit grayscale, or use a 16-bit .raw file / inline rows';
    if (ihdr.colourType !== 0) {
        throw new HeightmapError(
            `${what}: PNG colour type ${ihdr.colourType} ` +
            `(${PNG_COLOUR_TYPES[ihdr.colourType] ?? 'unknown'}) is not supported — ` +
            `only grayscale (colour type 0) is decoded here; ${hint}`
        );
    }
    if (ihdr.interlace !== 0) {
        throw new HeightmapError(
            `${what}: interlaced PNGs (Adam7) are not supported — re-save without interlacing`
        );
    }
    if (ihdr.bitDepth !== 8 && ihdr.bitDepth !== 16) {
        throw new HeightmapError(
            `${what}: PNG bit depth ${ihdr.bitDepth} is not supported — ` +
            `only 8 and 16 bit grayscale are decoded here; ${hint}`
        );
    }
    if (ihdr.compression !== 0 || ihdr.filter !== 0) {
        throw new HeightmapError(
            `${what}: unsupported PNG compression/filter method ` +
            `(${ihdr.compression}/${ihdr.filter}) — only the standard deflate method exists`
        );
    }
    checkDimensions(ihdr.width, ihdr.height, what);
    if (idat.length === 0) throw new HeightmapError(`${what}: malformed PNG — no IDAT data`);

    let raw;
    try {
        raw = zlib.inflateSync(Buffer.concat(idat));
    } catch (err) {
        throw new HeightmapError(`${what}: PNG IDAT data could not be inflated (${err.message})`);
    }

    const bpp = ihdr.bitDepth === 16 ? 2 : 1;
    const stride = ihdr.width * bpp;
    const expected = ihdr.height * (stride + 1);
    if (raw.length !== expected) {
        throw new HeightmapError(
            `${what}: PNG pixel data is ${raw.length} bytes, expected ${expected} ` +
            `(${ihdr.width}x${ihdr.height} at ${ihdr.bitDepth} bit + 1 filter byte per row)`
        );
    }

    const pixels = unfilter(raw, ihdr.height, stride, bpp, what);
    const count = ihdr.width * ihdr.height;
    if (ihdr.bitDepth === 8) {
        return { width: ihdr.width, height: ihdr.height, bitDepth: 8, maxValue: 255, data: pixels };
    }
    const data = new Uint16Array(count);
    for (let i = 0; i < count; i++) data[i] = (pixels[i * 2] << 8) | pixels[i * 2 + 1]; // PNG is big-endian
    return { width: ihdr.width, height: ihdr.height, bitDepth: 16, maxValue: 65535, data };
}

/**
 * PNG unfiltering (spec 9.2): each scanline is prefixed by a filter-type byte and is
 * reconstructed from the already-reconstructed bytes to its left (`a`, `bpp` back), above
 * (`b`) and above-left (`c`).
 * @param {Buffer} raw - Inflated stream: `height * (stride + 1)` bytes
 * @param {number} height
 * @param {number} stride - Bytes per scanline, filter byte excluded
 * @param {number} bpp - Bytes per pixel (1 or 2 here)
 * @param {string} [what='heightmap'] - Label for error messages (which source failed)
 * @returns {Uint8Array} `height * stride` reconstructed bytes
 */
function unfilter(raw, height, stride, bpp, what = 'heightmap') {
    const out = new Uint8Array(height * stride);
    let p = 0;
    for (let y = 0; y < height; y++) {
        const filterType = raw[p++];
        const rowStart = y * stride;
        const prevStart = rowStart - stride;
        for (let i = 0; i < stride; i++) {
            const x = raw[p + i];
            const a = i >= bpp ? out[rowStart + i - bpp] : 0;
            const b = y > 0 ? out[prevStart + i] : 0;
            const c = y > 0 && i >= bpp ? out[prevStart + i - bpp] : 0;
            let value;
            switch (filterType) {
                case 0: value = x; break;                                  // None
                case 1: value = x + a; break;                              // Sub
                case 2: value = x + b; break;                              // Up
                case 3: value = x + ((a + b) >> 1); break;                 // Average
                case 4: value = x + paeth(a, b, c); break;                 // Paeth
                default:
                    throw new HeightmapError(
                        `${what}: unknown PNG filter type ${filterType} on row ${y}`
                    );
            }
            out[rowStart + i] = value & 0xff;
        }
        p += stride;
    }
    return out;
}

/** PaethPredictor (PNG spec 9.4) */
function paeth(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
}

// --- raw --------------------------------------------------------------------

/**
 * Decode a headerless raw heightmap: `width * height` samples, little-endian by default.
 * @param {Buffer|Uint8Array} buffer
 * @param {{width: number, height: number, bitDepth?: number, littleEndian?: boolean}} opts
 * @param {string} [what='heightmap']
 * @returns {{width: number, height: number, bitDepth: number, maxValue: number,
 *   data: Uint8Array|Uint16Array}}
 * @throws {HeightmapError}
 */
export function decodeRaw(buffer, opts, what = 'heightmap') {
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    const { width, height } = opts ?? {};
    const bitDepth = opts?.bitDepth ?? 16;
    const littleEndian = opts?.littleEndian ?? true;
    if (bitDepth !== 8 && bitDepth !== 16) {
        throw new HeightmapError(`${what}: raw bitDepth must be 8 or 16, got ${bitDepth}`);
    }
    if (width === undefined || height === undefined) {
        throw new HeightmapError(
            `${what}: a .raw heightmap is headerless — pass "width" and "height" ` +
            '(and "bitDepth": 8 if it is not 16-bit)'
        );
    }
    checkDimensions(width, height, what);

    const bytes = bitDepth === 16 ? 2 : 1;
    const expected = width * height * bytes;
    if (buf.length !== expected) {
        const perSample = buf.length / (width * height);
        const guess = Number.isInteger(perSample) && (perSample === 1 || perSample === 2)
            ? ` — the file matches ${width}x${height} at ${perSample * 8} bit, try "bitDepth": ${perSample * 8}`
            : '';
        throw new HeightmapError(
            `${what}: raw file is ${buf.length} bytes, expected ${expected} for ` +
            `${width}x${height} at ${bitDepth} bit${guess}`
        );
    }

    const count = width * height;
    if (bitDepth === 8) {
        return { width, height, bitDepth, maxValue: 255, data: Uint8Array.from(buf) };
    }
    const data = new Uint16Array(count);
    for (let i = 0; i < count; i++) {
        data[i] = littleEndian ? buf.readUInt16LE(i * 2) : buf.readUInt16BE(i * 2);
    }
    return { width, height, bitDepth, maxValue: 65535, data };
}

// --- height field -----------------------------------------------------------

/**
 * A sampled scalar grid — the port-side equivalent of the engine's `HeightField`.
 * `unit` records what the values mean: `'raw'` for image samples (0..`maxValue`, mapped to
 * metres by the caller's min/max) or `'metres'` for inline rows.
 * @typedef {{w: number, h: number, data: ArrayLike<number>, unit: 'raw'|'metres',
 *   maxValue: number|null, source: string}} HeightField
 */

/**
 * Wrap decoded image samples as a {@link HeightField}.
 * @param {{width: number, height: number, data: ArrayLike<number>, maxValue: number}} decoded
 * @param {string} source - Label for messages
 * @returns {HeightField}
 */
export function heightFieldFromSamples(decoded, source) {
    return {
        w: decoded.width,
        h: decoded.height,
        data: decoded.data,
        unit: 'raw',
        maxValue: decoded.maxValue,
        source,
    };
}

/**
 * Wrap a 2D array of METRES (`rows[j][i]`, X fastest) as a {@link HeightField}.
 * @param {Array<Array<number>>} rows
 * @param {string} [what='heightmap.rows']
 * @returns {HeightField}
 * @throws {HeightmapError} on a ragged / empty / non-numeric grid
 */
export function heightFieldFromRows(rows, what = 'heightmap.rows') {
    if (!Array.isArray(rows) || rows.length === 0) {
        throw new HeightmapError(`${what} must be a non-empty array of rows`);
    }
    if (!Array.isArray(rows[0]) || rows[0].length === 0) {
        throw new HeightmapError(`${what}[0] must be a non-empty array of numbers (metres)`);
    }
    const w = rows[0].length;
    const h = rows.length;
    checkDimensions(w, h, what);
    const data = new Float64Array(w * h);
    for (let j = 0; j < h; j++) {
        const row = rows[j];
        if (!Array.isArray(row) || row.length !== w) {
            throw new HeightmapError(
                `${what}[${j}] has ${Array.isArray(row) ? row.length : 'no'} value(s), ` +
                `expected ${w} — every row must be the same length`
            );
        }
        for (let i = 0; i < w; i++) {
            const v = row[i];
            if (typeof v !== 'number' || !Number.isFinite(v)) {
                throw new HeightmapError(
                    `${what}[${j}][${i}] must be a finite number of metres, got ${JSON.stringify(v) ?? String(v)}`
                );
            }
            data[j * w + i] = v;
        }
    }
    return { w, h, data, unit: 'metres', maxValue: null, source: what };
}

/**
 * `HeightField.getClamp` (height-field.ts): fetch with both indices clamped into the grid.
 * @param {HeightField} field
 * @param {number} i
 * @param {number} j
 * @returns {number}
 */
export function getClamp(field, i, j) {
    const x = clamp(i, 0, field.w - 1);
    const y = clamp(j, 0, field.h - 1);
    return field.data[y * field.w + x];
}

/**
 * `HeightField.getAt` (height-field.ts): the diagonal-split kernel — the quad is split by
 * `dx + dz <= 1` and the far corner extrapolated (`m = (b+c)/2; d = 2m - a`), exactly like
 * `terrainBin.heightAt`. Indices are clamped (getClamp), the fractions are computed BEFORE
 * the clamp, so sampling past an edge extrapolates flat rather than wrapping.
 * @param {HeightField} field
 * @param {number} x - Source-grid coordinate (in samples, not metres)
 * @param {number} y
 * @returns {number}
 */
export function sampleAt(field, x, y) {
    const ix0 = Math.floor(x);
    const iz0 = Math.floor(y);
    const dx = x - ix0;
    const dz = y - iz0;

    let a = getClamp(field, ix0, iz0);
    const b = getClamp(field, ix0 + 1, iz0);
    const c = getClamp(field, ix0, iz0 + 1);
    let d = getClamp(field, ix0 + 1, iz0 + 1);
    const m = (b + c) * 0.5;

    if (dx + dz <= 1.0) d = m + (m - a);
    else a = m + (m - d);

    const h1 = a * (1.0 - dx) + b * dx;
    const h2 = c * (1.0 - dx) + d * dx;
    return h1 * (1.0 - dz) + h2 * dz;
}

/**
 * Resample a field onto a terrain vertex grid — port of `Terrain.importHeightField`
 * (terrain.ts:1616-1627): `u = i / tileCount[0]`, `v = j / tileCount[1]`, sampled at
 * `(u * field.w, v * field.h)`.
 *
 * The source mapping is the engine's: exact when the source dimensions equal the TILE
 * count (the last vertex then re-uses the last texel through the clamp), scaled by
 * `w / (w - 1)` otherwise.
 *
 * @param {HeightField} field
 * @param {number[]} vertexCount - `[vx, vz]`
 * @param {number[]} tileCount - `[vx - 1, vz - 1]`
 * @returns {Float64Array} `vx * vz` samples in the field's own unit, row-major, X fastest
 */
export function resampleToVertexGrid(field, vertexCount, tileCount) {
    const [vx, vz] = vertexCount;
    const out = new Float64Array(vx * vz);
    let index = 0;
    for (let j = 0; j < vz; j++) {
        const v = j / tileCount[1];
        for (let i = 0; i < vx; i++) {
            const u = i / tileCount[0];
            out[index++] = sampleAt(field, u * field.w, v * field.h);
        }
    }
    return out;
}

// --- spec → metre grid ------------------------------------------------------

const HEIGHTMAP_KEYS = new Set([
    'source', 'rows', 'min', 'max', 'width', 'height', 'bitDepth', 'littleEndian',
]);

/**
 * Resolve a heightmap source path inside the project. Accepts a project-relative path or
 * one relative to `assets/`, and refuses anything that escapes the project (realpath-based,
 * so a symlink inside `assets/` cannot be used to read arbitrary files).
 * @param {string} source
 * @param {string} projectRoot
 * @returns {string} absolute path
 * @throws {HeightmapError}
 */
export function resolveHeightmapPath(source, projectRoot) {
    if (!projectRoot) {
        throw new HeightmapError(
            `heightmap.source "${source}": reading a heightmap file requires a project ` +
            '(projectRoot) — pass inline "rows" instead'
        );
    }
    const realRoot = realpathOrSelf(path.resolve(projectRoot));
    for (const rel of [source, path.join('assets', source)]) {
        const abs = path.resolve(projectRoot, rel);
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
        const real = realpathOrSelf(abs);
        if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
            throw new HeightmapError(
                `heightmap.source "${source}" resolves outside the project (${real}) — ` +
                'heightmaps must live inside the project directory'
            );
        }
        return real;
    }
    throw new HeightmapError(
        `heightmap.source not found: "${source}" (looked relative to the project root and to assets/)`
    );
}

function realpathOrSelf(p) {
    try { return fs.realpathSync(p); } catch { return p; }
}

/**
 * Decode a heightmap spec into a {@link HeightField} (no resampling yet).
 * @param {object} spec - `{source?, rows?, width?, height?, bitDepth?, littleEndian?}`
 * @param {{projectRoot?: string|null}} [options]
 * @returns {HeightField}
 * @throws {HeightmapError}
 */
export function loadHeightField(spec, options = {}) {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
        throw new HeightmapError('heightmap must be an object, e.g. {source: "Art/hills.png", max: 20}');
    }
    for (const key of Object.keys(spec)) {
        if (!HEIGHTMAP_KEYS.has(key)) {
            throw new HeightmapError(
                `heightmap: unknown key "${key}" — supported: ${[...HEIGHTMAP_KEYS].join(', ')}`
            );
        }
    }

    const inline = spec.source === undefined || spec.source === 'inline' || spec.source === null;
    if (inline) {
        if (spec.rows === undefined) {
            throw new HeightmapError(
                'heightmap needs either "source" (a .png/.raw path inside the project) or ' +
                'inline "rows" (a 2D array of metres)'
            );
        }
        // `label` names the ARGUMENT the caller actually used: set_heights takes the rows
        // either as its own `rows` key or nested in `heightmap.rows`, and an error that talks
        // about the wrong one sends the agent to look at an argument it never passed.
        return heightFieldFromRows(spec.rows, options.label === 'rows' ? 'rows' : 'heightmap.rows');
    }
    if (typeof spec.source !== 'string' || spec.source === '') {
        throw new HeightmapError('heightmap.source must be a non-empty string path, or "inline" with rows');
    }
    if (spec.rows !== undefined) {
        throw new HeightmapError(
            `heightmap: "source" ("${spec.source}") and inline "rows" are mutually exclusive — pass one`
        );
    }

    const abs = resolveHeightmapPath(spec.source, options.projectRoot ?? null);
    const ext = path.extname(abs).toLowerCase();
    const buf = fs.readFileSync(abs);
    const what = `heightmap.source "${spec.source}"`;

    if (ext === '.png') {
        return heightFieldFromSamples(decodePng(buf, what), spec.source);
    }
    if (ext === '.raw' || ext === '.r16' || ext === '.r8') {
        return heightFieldFromSamples(
            decodeRaw(buf, {
                width: spec.width,
                height: spec.height,
                bitDepth: spec.bitDepth ?? (ext === '.r8' ? 8 : 16),
                littleEndian: spec.littleEndian,
            }, what),
            spec.source
        );
    }
    throw new HeightmapError(
        `${what}: unsupported extension "${ext || '(none)'}" — use a grayscale .png, ` +
        'a headerless .raw (16-bit LE, with width/height), or inline rows'
    );
}

/**
 * Compile a heightmap spec into a grid of METRES over the terrain's vertices.
 *
 * Image sources are normalized to 0..1 and mapped onto `[min, max]` metres (`min` defaults
 * to 0, `max` is required — a 0..1 metre terrain is never what anybody means); inline rows
 * are already metres, so `min`/`max` are not used and their presence is reported as a note.
 *
 * @param {object} spec - The `heightmap` block of a terrain spec
 * @param {{vertexCount: number[], tileCount: number[], projectRoot?: string|null,
 *   label?: string}} options - `label` names the caller's argument in errors and notes:
 *   `'rows'` when the values came from a bare `rows` key, `'heightmap'` (default) otherwise
 * @returns {{heights: Float64Array, notes: string[], field: HeightField}} `heights` is
 *   `vx * vz` metres, row-major, X fastest
 * @throws {HeightmapError}
 */
export function buildHeightGrid(spec, options) {
    const { vertexCount, tileCount } = options;
    const what = options.label === 'rows' ? 'inline rows' : 'heightmap';
    const field = loadHeightField(spec, options);
    const notes = [];

    const [vx, vz] = vertexCount;
    let samples;
    if (field.w === vx && field.h === vz) {
        // Exact grid: copy 1:1 rather than resampling (the engine's importer would scale
        // the source by w/(w-1) and clamp the far edge, losing the authored values).
        // Reported like the resample branch: the divergence from the engine's own
        // importer is deliberate, but it must never be silent.
        samples = Float64Array.from(field.data);
        notes.push(
            `${what} ${field.w}x${field.h} matches the ${vx}x${vz} vertex grid exactly — copied 1:1 ` +
            '(the engine\'s own importer would resample it by w/(w-1) and clamp the far edge; pass a ' +
            `${tileCount[0]}x${tileCount[1]} source — one sample per tile — for an engine-identical import)`
        );
    } else {
        samples = resampleToVertexGrid(field, vertexCount, tileCount);
        notes.push(
            `${what} ${field.w}x${field.h} resampled onto the ${vx}x${vz} vertex grid ` +
            `(exact when the source is ${tileCount[0]}x${tileCount[1]} — one sample per tile — ` +
            `or ${vx}x${vz})`
        );
    }

    if (field.unit === 'metres') {
        if (spec.min !== undefined || spec.max !== undefined) {
            notes.push(`${options.label === 'rows' ? 'min/max are' : 'heightmap.min/max are'} ignored for inline rows — the values are already metres`);
        }
        return { heights: samples, notes, field };
    }

    const min = spec.min ?? 0;
    if (spec.max === undefined) {
        throw new HeightmapError(
            `heightmap "${field.source}": "max" (metres for a fully white sample) is required ` +
            'for image sources — with "min" (default 0) it defines the height range'
        );
    }
    for (const [name, v] of [['min', min], ['max', spec.max]]) {
        if (typeof v !== 'number' || !Number.isFinite(v)) {
            throw new HeightmapError(`heightmap.${name} must be a finite number of metres, got ${v}`);
        }
    }
    if (spec.max === min) {
        notes.push(`heightmap.min === heightmap.max (${min} m) — the result is a flat terrain`);
    }

    const range = spec.max - min;
    const heights = new Float64Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
        heights[i] = min + (samples[i] / field.maxValue) * range;
    }
    return { heights, notes, field };
}
