/**
 * Heightmap decoding + resampling tests (Phase T3)
 *
 * The PNG decoder is validated against REAL PNGs produced by an independent encoder
 * (Pillow 12): `GRAY8_PNG` / `GRAY16_PNG` below are 37x23 grayscale images whose pixel
 * values follow a closed formula, and whose scanlines use adaptive filters — Sub/Up/Paeth
 * for the 8-bit one, Sub/Paeth for the 16-bit one — so the unfilter path is exercised for
 * real, not just filter type 0. Everything else (refusals, malformed streams) is built by
 * the tiny encoder in this file, which can emit shapes Pillow will not.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';

import {
    HeightmapError,
    decodePng,
    decodeRaw,
    heightFieldFromRows,
    heightFieldFromSamples,
    getClamp,
    sampleAt,
    resampleToVertexGrid,
    loadHeightField,
    buildHeightGrid,
    resolveHeightmapPath,
    MAX_HEIGHTMAP_AXIS,
} from '../../src/utils/heightmap.js';

// 37x23 8-bit grayscale, Pillow-encoded, filters 1/2/4
const GRAY8_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAACUAAAAXCAAAAACpR9l5AAABPklEQVR4nI3QR1ICYRCGYRp+yTnnHAYmMMOQBhCGJIOAOYeVS4/l1gVH8ADexqUb64cqxRW9fque+rpBB4YDk8XmcHl8gVAklkhlcoVSmeWrktxoKd3DwXA8nRGDnhhNZovVZnc4XW6P1+cPBEPhSDQWTyRT6Uw2ly8US/o9nSlXWI4nLmI0W+1Ot9cfDEfjifS2C7S3WY4XqqKkySTwb1WOrmLKPO0tUarJw0az1VZIbJdi0tl8kalUBbEmN2lXO92e1h+QzA7Fbw+s0wOVzYEDdTgbT1ak9EtJ8eSGUjhBrPWb7U5vrI4mM22+XMDHvl/NF6tT+PpbldyuolSdUn11NDnSjpcnZ8AhqHN4RVAXsEZQl/CNoK5giaCu4Q1B3YAOQd3CC4K6g08EdQ9dBPUAawT1CCyCeoJ3BPX8A8ehm3dAT8lHAAAAAElFTkSuQmCC',
    'base64');
// 37x23 16-bit grayscale, Pillow-encoded, filters 1/4
const GRAY16_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAACUAAAAXEAAAAAD51wU6AAAC0ElEQVR4nK2S0WpaSxSGY/2/0ctkWxpzHUNNoNALFU2vVZReR3HT6xr0BSL4AhZ8gQr7BQz4AhF8gQj2ARTa9DqBk+T2MLO3mubkcE6h+4dZa9Y/fKyZvWI7O/F7/Ybi/+rEduMyf0i7cb3W/nOxzVMvVvcjeU/qDnWkbCiiqKnLkzpQSplN/eKXUwml5XGorMpuH6EKKlFSSb0olvSoFSW9sijyqrja2rui5EAxh8pFzhpFVU3VqauukYtJHXD3BFV33sDFB11T17FieKorpzJ1fY5QFOSria+efHw9aoqvkxBFRr4qNNR23o3G+Eqz1K1DHSpHWb78LapKU126+qkRXR0w1wfd0XWoPBV11aarAV0luNKxlnRDFDl1dUbYFUfqU1Wfc/XpK6lL+prT1x2vNqgGbed+pa8r+loSdeXZC56pv0a5t+KneiQZ6oSpPrJao8hrSENDLjRkqDFDrrX0IhQW9W3bVQF7wYAegQICTQlCFCkF9tm5oa2AAYF3ypWuCdZdYd8q4D5CUdCER8414YQRE31ivkFlsBec7CW40IRTxg4VXZBDTfjBmSYbFFXNOKDHTDM+MWWuFbMQtZfngYZmHDNwvtUGRU4zzOaCPJKkyUILPjJi4bLFnuuKjBYkSNOO6mMb7TCwcKh7ylqQja1O+K7vPNN/V/SPE7Hbd/xlJbf+P+nFamznPX/o026c17z5VebpLvVi9U0kb1sPUUe8tTJu5S2XUW4f245ouGs/O2XYxzN2rtx+jSqYIkXOKVJ0WZG5KZIO/6DJU3nijF1mQTHjUSQXehHKFKhZGbuOTI0HEqxMzaJMhhoV51249Qf3XJsaWYdy025qbq4iVNU0adEzLW64NC3SHBs3V8ZNu2nQpmVafDUt25FZcrtGmTItWg5ljug41Lnp8MV0SDA1HU63KFOhY9p8Y2A6jE2HLEvTCVGpHB3OzOe/AYO3Sc9yEmsyAAAAAElFTkSuQmCC',
    'base64');

const GRAY_W = 37;
const GRAY_H = 23;
const gray8Expected = (i, j) => (i * i + j * j * 3 + i * j) % 256;
const gray16Expected = (i, j) => (i * 1013 + j * 4099 + i * j * 17) % 65536;

// --- minimal PNG encoder, for shapes Pillow will not produce -----------------

const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c;
    }
    return table;
})();

function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'latin1');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
}

/**
 * Encode a PNG with full control over IHDR. `rows` is an array of already-filtered
 * scanlines (filter byte included) — pass `samples` instead for plain filter-0 rows.
 */
function makePng({ width, height, bitDepth = 8, colourType = 0, interlace = 0,
    samples = null, rows = null, idat = null }) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = bitDepth;
    ihdr[9] = colourType;
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = interlace;

    let raw;
    if (idat) {
        raw = idat;
    } else if (rows) {
        raw = Buffer.concat(rows);
    } else {
        const bpp = bitDepth === 16 ? 2 : 1;
        const stride = width * bpp;
        raw = Buffer.alloc(height * (stride + 1));
        for (let y = 0; y < height; y++) {
            const base = y * (stride + 1);
            raw[base] = 0; // filter: None
            for (let x = 0; x < width; x++) {
                const v = samples[y * width + x];
                if (bpp === 1) raw[base + 1 + x] = v & 0xff;
                else raw.writeUInt16BE(v & 0xffff, base + 1 + x * 2);
            }
        }
    }
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

describe('heightmap: PNG decoding', () => {
    it('decodes a real 8-bit grayscale PNG (adaptive filters) sample-exactly', () => {
        const png = decodePng(GRAY8_PNG);
        assert.strictEqual(png.width, GRAY_W);
        assert.strictEqual(png.height, GRAY_H);
        assert.strictEqual(png.bitDepth, 8);
        assert.strictEqual(png.maxValue, 255);
        assert.strictEqual(png.data.length, GRAY_W * GRAY_H);
        let mismatches = 0;
        for (let j = 0; j < GRAY_H; j++) {
            for (let i = 0; i < GRAY_W; i++) {
                if (png.data[j * GRAY_W + i] !== gray8Expected(i, j)) mismatches++;
            }
        }
        assert.strictEqual(mismatches, 0);
    });

    it('decodes a real 16-bit grayscale PNG (big-endian samples)', () => {
        const png = decodePng(GRAY16_PNG);
        assert.strictEqual(png.bitDepth, 16);
        assert.strictEqual(png.maxValue, 65535);
        let mismatches = 0;
        for (let j = 0; j < GRAY_H; j++) {
            for (let i = 0; i < GRAY_W; i++) {
                if (png.data[j * GRAY_W + i] !== gray16Expected(i, j)) mismatches++;
            }
        }
        assert.strictEqual(mismatches, 0);
    });

    it('reconstructs every filter type', () => {
        // One row per filter type over a 4x5 image, computed by hand from the spec:
        // the encoded bytes below must reconstruct to 10, 20, 30, 40 on every row.
        const target = [10, 20, 30, 40];
        const rows = [
            Buffer.from([0, 10, 20, 30, 40]),           // None
            Buffer.from([1, 10, 10, 10, 10]),           // Sub: x = value - left
            Buffer.from([2, 0, 0, 0, 0]),               // Up: x = value - above
            Buffer.from([3, 5, 5, 5, 5]),               // Average: value - floor((left+up)/2)
            Buffer.from([4, 0, 0, 0, 0]),               // Paeth: predictor = above here
        ];
        const png = decodePng(makePng({ width: 4, height: 5, rows }));
        for (let y = 0; y < 5; y++) {
            assert.deepStrictEqual([...png.data.slice(y * 4, y * 4 + 4)], target, `row ${y}`);
        }
    });

    it('refuses non-grayscale, interlaced and low-bit-depth PNGs by name', () => {
        const samples = new Uint8Array(4).fill(1);
        assert.throws(
            () => decodePng(makePng({ width: 2, height: 2, colourType: 6, samples })),
            (err) => err instanceof HeightmapError && /colour type 6 \(truecolour\+alpha \(RGBA\)\)/.test(err.message)
                && /\.raw/.test(err.message));
        assert.throws(
            () => decodePng(makePng({ width: 2, height: 2, colourType: 3, samples })),
            /indexed-colour \(palette\)/);
        assert.throws(
            () => decodePng(makePng({ width: 2, height: 2, colourType: 4, samples })),
            /grayscale\+alpha/);
        assert.throws(
            () => decodePng(makePng({ width: 2, height: 2, interlace: 1, samples })),
            /interlaced/);
        assert.throws(
            () => decodePng(makePng({ width: 2, height: 2, bitDepth: 4, samples })),
            /bit depth 4 is not supported/);
    });

    it('refuses non-PNG, truncated and malformed streams', () => {
        assert.throws(() => decodePng(Buffer.from('not a png at all')), /not a PNG file/);
        const good = makePng({ width: 2, height: 2, samples: new Uint8Array(4) });
        assert.throws(() => decodePng(good.subarray(0, good.length - 20)), /truncated PNG|no IDAT/);
        // IHDR promises more pixels than IDAT carries
        assert.throws(
            () => decodePng(makePng({ width: 8, height: 8, idat: Buffer.alloc(9) })),
            /pixel data is 9 bytes, expected 72/);
        assert.throws(
            () => decodePng(makePng({ width: 2, height: 1, rows: [Buffer.from([9, 1, 2])] })),
            /unknown PNG filter type 9/);
    });

    // Regression: the filter-type error used to hardcode "heightmap:" while every
    // sibling message interpolates `what`, so with several sources in one spec the
    // malformed file was unnameable.
    it('names the failing source in the unknown-filter error', () => {
        assert.throws(
            () => decodePng(makePng({ width: 2, height: 1, rows: [Buffer.from([9, 1, 2])] }),
                'heightmap.source "Art/hills.png"'),
            /heightmap\.source "Art\/hills\.png": unknown PNG filter type 9 on row 0/);
    });

    it('refuses absurd dimensions before allocating', () => {
        assert.throws(
            () => decodePng(makePng({ width: MAX_HEIGHTMAP_AXIS + 1, height: 1, idat: Buffer.alloc(0) })),
            new RegExp(`width must be an integer in 1\\.\\.${MAX_HEIGHTMAP_AXIS}`));
    });

    // Unbounded, the size check ran only AFTER the whole stream was materialized: a small file
    // whose IDAT expands to gigabytes spiked memory before being rejected. The IHDR is the bound.
    it('bounds the inflate by the size the header declares', () => {
        // 8x8 at 8 bit = 72 bytes expected; this IDAT inflates to 64 MiB
        const bomb = makePng({ width: 8, height: 8, idat: Buffer.alloc(64 * 1024 * 1024) });
        assert.ok(bomb.length < 100_000, `the file itself stays small (${bomb.length} bytes)`);

        const before = process.memoryUsage().arrayBuffers;
        assert.throws(
            () => decodePng(bomb, 'heightmap.source "Art/bomb.png"'),
            (err) => {
                assert.ok(err instanceof HeightmapError);
                assert.match(err.message, /heightmap\.source "Art\/bomb\.png"/);
                assert.match(err.message, /inflates to more than the 72 bytes its header declares/);
                assert.match(err.message, /8x8 at 8 bit/);
                return true;
            });
        // the 64 MiB was never allocated (the bound throws inside zlib instead)
        assert.ok(process.memoryUsage().arrayBuffers - before < 8 * 1024 * 1024,
            'no multi-megabyte buffer was materialized');
    });
});

describe('heightmap: raw decoding', () => {
    it('reads 16-bit little-endian samples', () => {
        const buf = Buffer.alloc(6);
        buf.writeUInt16LE(0, 0);
        buf.writeUInt16LE(32768, 2);
        buf.writeUInt16LE(65535, 4);
        const raw = decodeRaw(buf, { width: 3, height: 1 });
        assert.deepStrictEqual([...raw.data], [0, 32768, 65535]);
        assert.strictEqual(raw.maxValue, 65535);
    });

    it('reads big-endian and 8-bit variants', () => {
        const be = decodeRaw(Buffer.from([0x12, 0x34]), { width: 1, height: 1, littleEndian: false });
        assert.strictEqual(be.data[0], 0x1234);
        const eight = decodeRaw(Buffer.from([1, 2, 3, 4]), { width: 2, height: 2, bitDepth: 8 });
        assert.deepStrictEqual([...eight.data], [1, 2, 3, 4]);
        assert.strictEqual(eight.maxValue, 255);
    });

    it('requires dimensions and checks the file size, guessing the bit depth', () => {
        assert.throws(() => decodeRaw(Buffer.alloc(8), {}), /headerless — pass "width" and "height"/);
        assert.throws(
            () => decodeRaw(Buffer.alloc(4), { width: 2, height: 2 }),
            /is 4 bytes, expected 8 .* try "bitDepth": 8/);
        assert.throws(() => decodeRaw(Buffer.alloc(4), { width: 2, height: 2, bitDepth: 12 }), /bitDepth must be 8 or 16/);
    });
});

describe('heightmap: inline rows', () => {
    it('accepts a rectangular grid of metres', () => {
        const field = heightFieldFromRows([[0, 1, 2], [3, 4, 5]]);
        assert.strictEqual(field.w, 3);
        assert.strictEqual(field.h, 2);
        assert.strictEqual(field.unit, 'metres');
        assert.strictEqual(field.maxValue, null);
        assert.deepStrictEqual([...field.data], [0, 1, 2, 3, 4, 5]);
    });

    it('rejects empty, ragged and non-numeric grids', () => {
        assert.throws(() => heightFieldFromRows([]), /non-empty array of rows/);
        assert.throws(() => heightFieldFromRows([[]]), /\[0\] must be a non-empty array/);
        assert.throws(() => heightFieldFromRows([[1, 2], [3]]), /\[1\] has 1 value\(s\), expected 2/);
        assert.throws(() => heightFieldFromRows([[1, 2], [3, null]]), /\[1\]\[1\] must be a finite number/);
        assert.throws(() => heightFieldFromRows([[1, NaN]]), /\[0\]\[1\] must be a finite number/);
    });
});

describe('heightmap: sampling (engine port)', () => {
    const field = heightFieldFromRows([
        [0, 10, 20],
        [1, 11, 21],
        [2, 12, 22],
    ]);

    it('getClamp clamps both axes', () => {
        assert.strictEqual(getClamp(field, 1, 1), 11);
        assert.strictEqual(getClamp(field, -5, 0), 0);
        assert.strictEqual(getClamp(field, 99, 99), 22);
    });

    it('sampleAt returns the exact value at integer coordinates', () => {
        for (let j = 0; j < 3; j++) {
            for (let i = 0; i < 3; i++) {
                assert.strictEqual(sampleAt(field, i, j), field.data[j * 3 + i], `(${i},${j})`);
            }
        }
    });

    it('sampleAt uses the diagonal-split kernel, not plain bilinear', () => {
        // A planar field cannot tell the two apart — this one has a corner spike.
        const bent = heightFieldFromRows([
            [0, 10, 20],
            [1, 11, 21],
            [2, 12, 100],
        ]);
        // cell (1,1): a=11 b=21 c=12 d=100, dx=dz=0.75 → dx+dz > 1, so a = m + (m - d),
        // m = (b+c)/2 = 16.5 → a = -67
        const a = 16.5 + (16.5 - 100);
        const h1 = a * 0.25 + 21 * 0.75;
        const h2 = 12 * 0.25 + 100 * 0.75;
        assert.strictEqual(sampleAt(bent, 1.75, 1.75), h1 * 0.25 + h2 * 0.75);
        // plain bilinear would give 63.125
        assert.strictEqual(Math.round(sampleAt(bent, 1.75, 1.75) * 1000) / 1000, 58.25);
    });

    it('resamples 1:1 when the source matches the TILE count (the engine mapping)', () => {
        // 4x4 source onto a 5x5 vertex grid (tileCount 4): u = i/4, x = u*4 = i
        const src = heightFieldFromRows([
            [1, 2, 3, 4],
            [5, 6, 7, 8],
            [9, 10, 11, 12],
            [13, 14, 15, 16],
        ]);
        const out = resampleToVertexGrid(src, [5, 5], [4, 4]);
        for (let j = 0; j < 4; j++) {
            for (let i = 0; i < 4; i++) {
                assert.strictEqual(out[j * 5 + i], src.data[j * 4 + i], `(${i},${j})`);
            }
        }
        // the far edge re-uses the last texel through the clamp
        assert.strictEqual(out[4], 4);
        assert.strictEqual(out[5 * 4 + 4], 16);
    });
});

describe('heightmap: buildHeightGrid', () => {
    const gridOpts = { vertexCount: [3, 3], tileCount: [2, 2] };

    it('uses an exactly-sized inline grid verbatim', () => {
        const rows = [[0, 1, 2], [3, 4, 5], [6, 7, 8]];
        const { heights, notes } = buildHeightGrid({ rows }, gridOpts);
        assert.deepStrictEqual([...heights], [0, 1, 2, 3, 4, 5, 6, 7, 8]);
        assert.doesNotMatch(notes.join('\n'), /resampled onto/);
    });

    // Regression: the 1:1 shortcut diverges from the engine's own importHeightField
    // (which scales the source by w/(w-1)); the resample branch always explained
    // itself, so the copy branch must too — a silent divergence is invisible.
    it('notes the 1:1 copy on an exact vertex-grid match', () => {
        const rows = [[0, 1, 2], [3, 4, 5], [6, 7, 8]];
        const { notes } = buildHeightGrid({ rows }, gridOpts);
        assert.match(notes.join('\n'), /3x3 matches the 3x3 vertex grid exactly — copied 1:1/);
        assert.match(notes.join('\n'), /pass a 2x2 source/);
    });

    it('notes a resample when the source has another size', () => {
        const { heights, notes } = buildHeightGrid({ rows: [[0, 4], [0, 4]] }, gridOpts);
        assert.strictEqual(heights.length, 9);
        assert.match(notes.join('\n'), /2x2 resampled onto the 3x3 vertex grid/);
    });

    it('maps image samples onto [min, max] metres', () => {
        const field = { width: 3, height: 3, maxValue: 255, data: Uint8Array.from([0, 128, 255, 0, 128, 255, 0, 128, 255]) };
        // go through the public entry point via inline rows equivalence check first
        const wrapped = heightFieldFromSamples(field, 'test');
        assert.strictEqual(wrapped.unit, 'raw');

        const png = makePng({ width: 3, height: 3, samples: field.data });
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-'));
        try {
            fs.mkdirSync(path.join(dir, 'assets'));
            fs.writeFileSync(path.join(dir, 'assets', 'h.png'), png);
            const { heights, notes } = buildHeightGrid(
                { source: 'h.png', min: 10, max: 20 }, { ...gridOpts, projectRoot: dir });
            assert.strictEqual(heights[0], 10);
            assert.ok(Math.abs(heights[1] - (10 + (128 / 255) * 10)) < 1e-12);
            assert.strictEqual(heights[2], 20);
            // 3x3 matches the vertex grid exactly: copied 1:1, and it says so
            assert.doesNotMatch(notes.join('\n'), /resampled onto/);
            assert.match(notes.join('\n'), /copied 1:1/);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('requires max for image sources and ignores min/max for inline rows', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-'));
        try {
            fs.writeFileSync(path.join(dir, 'h.png'),
                makePng({ width: 3, height: 3, samples: new Uint8Array(9) }));
            assert.throws(
                () => buildHeightGrid({ source: 'h.png' }, { ...gridOpts, projectRoot: dir }),
                /"max" \(metres for a fully white sample\) is required/);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
        const { notes } = buildHeightGrid(
            { rows: [[0, 1, 2], [3, 4, 5], [6, 7, 8]], min: 0, max: 10 }, gridOpts);
        assert.match(notes.join('\n'), /min\/max are ignored for inline rows/);
    });

    it('rejects unknown keys, missing sources and source+rows together', () => {
        assert.throws(() => buildHeightGrid({ rows: [[1]], scale: 2 }, gridOpts), /unknown key "scale"/);
        assert.throws(() => buildHeightGrid({}, gridOpts), /needs either "source" .* or inline "rows"/s);
        assert.throws(
            () => buildHeightGrid({ source: 'a.png', rows: [[1]] }, gridOpts),
            /mutually exclusive/);
        assert.throws(() => buildHeightGrid('nope', gridOpts), /heightmap must be an object/);
    });

    it('refuses unsupported extensions and files outside the project', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-'));
        try {
            fs.writeFileSync(path.join(dir, 'h.tga'), Buffer.alloc(4));
            assert.throws(
                () => buildHeightGrid({ source: 'h.tga', max: 1 }, { ...gridOpts, projectRoot: dir }),
                /unsupported extension "\.tga"/);
            assert.throws(
                () => buildHeightGrid({ source: 'missing.png', max: 1 }, { ...gridOpts, projectRoot: dir }),
                /heightmap.source not found/);
            assert.throws(
                () => buildHeightGrid({ source: 'h.png', max: 1 }, gridOpts),
                /requires a project \(projectRoot\)/);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('resolveHeightmapPath refuses a symlink escaping the project', () => {
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-out-'));
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-'));
        try {
            fs.writeFileSync(path.join(outside, 'secret.raw'), Buffer.alloc(2));
            fs.mkdirSync(path.join(dir, 'assets'));
            fs.symlinkSync(path.join(outside, 'secret.raw'), path.join(dir, 'assets', 'link.raw'));
            assert.throws(
                () => resolveHeightmapPath('assets/link.raw', dir),
                /resolves outside the project/);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
            fs.rmSync(outside, { recursive: true, force: true });
        }
    });

    it('reads a .raw source with explicit dimensions', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-'));
        try {
            const buf = Buffer.alloc(18);
            for (let i = 0; i < 9; i++) buf.writeUInt16LE(i * 8000, i * 2);
            fs.writeFileSync(path.join(dir, 'h.raw'), buf);
            const field = loadHeightField(
                { source: 'h.raw', width: 3, height: 3 }, { projectRoot: dir });
            assert.strictEqual(field.w, 3);
            assert.strictEqual(field.maxValue, 65535);
            assert.strictEqual(field.data[8], 64000);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
