/**
 * MetaGenerator - offline .meta generation for assets created outside the editor
 *
 * The editor's official model (docs 3.8, asset/meta): an asset file that
 * arrives WITH a .meta keeps its UUID — the editor imports it into library/
 * on the next open without touching the meta. So generating a correct meta
 * offline makes MCP-created assets (agent scripts, .mtl, .anim, images, …)
 * immediately addressable, and scene references stay valid after import.
 *
 * `ver` values are Importer versions for Cocos Creator 3.8.7, taken from
 * app.asar `engine-extends/package.json` (contributions.asset-db.asset-handler)
 * and cross-checked against real editor-saved metas (zombie-miner corpus).
 * Newer editors migrate older `ver` forward (Importer.migrations).
 *
 * Models (.fbx/.glb/.gltf) are deliberately NOT generated: their userData
 * (materials, assetFinder, imageMetas) derives from the model content, and
 * the MCP itself needs the library/ artifacts (mesh AABB, gltf-scene prefab)
 * that only a real editor import produces.
 *
 * library/ is never written — it is a derived cache the editor regenerates
 * from assets + meta, keeping our UUID.
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { nameToId } from '../utils/uuid.js';
import { writeFileAtomic } from '../utils/fsAtomic.js';

export class MetaGenerationError extends Error {
    /**
     * @param {string} message
     * @param {string} [assetPath] The refused asset — a caller reporting per-target failures
     *        cannot otherwise say WHICH path of a parent-folder chain was refused.
     */
    constructor(message, assetPath) {
        super(message);
        this.assetPath = assetPath;
    }
}

const AUDIO_EXTS = new Set(['.mp3', '.wav', '.ogg', '.aac', '.pcm', '.m4a']);
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.tga', '.hdr',
    '.bmp', '.psd', '.tif', '.tiff', '.exr']);
const MODEL_EXTS = new Set(['.fbx', '.glb', '.gltf']);

// Sub-asset ids are derived from the sub-asset NAME (nameToId, verified):
const TEXTURE_SUB_ID = nameToId('texture');          // "6c48a"
const SPRITE_FRAME_SUB_ID = nameToId('spriteFrame'); // "f9941"

/** Bare meta skeleton in the editor's stable key order */
function skeleton({ importer, ver, files = ['.json'], userData = {}, uuid = randomUUID() }) {
    return { ver, importer, imported: true, uuid, files, subMetas: {}, userData };
}

/** Meta for a .prefab written by build_prefab (root name known, no file read) */
export function prefabMeta(rootName) {
    return skeleton({ importer: 'prefab', ver: '1.1.50', userData: { syncNodeName: rootName } });
}

/** Meta for an .animgraph written by build_animgraph */
export function animGraphMeta() {
    return skeleton({ importer: 'animation-graph', ver: '1.2.0' });
}

/**
 * Meta for a .terrain written by build_terrain. Sourced from SIMPLE_TYPES so the
 * builder's meta and create_asset_meta's can never drift; `userData` stays `{}` —
 * the terrain importer has no userData config at all (verified against the
 * editor-saved golden meta).
 */
export function terrainMeta() {
    const { importer, ver, files } = SIMPLE_TYPES['.terrain'];
    return skeleton({ importer, ver, files: [...files] });
}

/** Editor byte-form: 2-space JSON + trailing newline */
export function serializeMeta(meta) {
    return JSON.stringify(meta, null, 2) + '\n';
}

/** `_name` of the head object of a flat-array asset (.prefab, .anim) */
function headName(absPath) {
    try {
        const arr = JSON.parse(fs.readFileSync(absPath, 'utf-8'));
        const head = Array.isArray(arr) ? arr[0] : arr;
        if (typeof head?._name === 'string' && head._name) return head._name;
        const rootIdx = head?.data?.__id__;
        if (rootIdx != null && typeof arr[rootIdx]?._name === 'string' && arr[rootIdx]._name) {
            return arr[rootIdx]._name;
        }
    } catch {
        // fall through to the filename-derived default
    }
    return null;
}

/**
 * Classify a path for meta generation.
 * @returns {'supported'|'model'|'unknown'}
 */
export function classifyAsset(absPath) {
    if (fs.statSync(absPath).isDirectory()) return 'supported';
    const ext = path.extname(absPath).toLowerCase();
    if (MODEL_EXTS.has(ext)) return 'model';
    if (AUDIO_EXTS.has(ext) || IMAGE_EXTS.has(ext)) return 'supported';
    if (SIMPLE_TYPES[ext]) return 'supported';
    return 'unknown';
}

// ext → fixed parts; userData/files needing the file are handled in createMetaObject
// Exported so create_asset_meta's advertised type list can be drift-tested against it.
export const SIMPLE_TYPES = {
    '.ts': { importer: 'typescript', ver: '4.0.24', files: [] },
    '.js': { importer: 'javascript', ver: '4.0.24', files: [] },
    '.cjs': { importer: 'javascript', ver: '4.0.24', files: [] },
    '.mjs': { importer: 'javascript', ver: '4.0.24', files: [] },
    '.scene': { importer: 'scene', ver: '1.1.50' },
    '.prefab': { importer: 'prefab', ver: '1.1.50' },
    '.mtl': { importer: 'material', ver: '1.0.21' },
    '.pmtl': { importer: 'physics-material', ver: '1.0.1' },
    '.anim': { importer: 'animation-clip', ver: '2.0.4', files: ['.bin'] },
    '.animgraph': { importer: 'animation-graph', ver: '1.2.0' },
    // The importer copies the binary verbatim to library/<uuid>.bin and lifts the layer
    // table into <uuid>.json; it has no userData (verified on editor-saved metas).
    '.terrain': { importer: 'terrain', ver: '1.1.50', files: ['.bin', '.json'] },
    '.json': { importer: 'json', ver: '2.0.1' },
    '.effect': { importer: 'effect', ver: '1.7.1' },
    '.rt': { importer: 'render-texture', ver: '1.2.1' },
    '.ttf': { importer: 'ttf-font', ver: '1.0.1' }
};

/**
 * Build the meta object for a file or directory.
 * @param {string} absPath - Existing file/directory on disk
 * @param {object} [options]
 * @param {'texture'|'sprite-frame'} [options.imageType] - Image assets only (default "texture")
 * @returns {object} meta
 * @throws {MetaGenerationError} for models and unsupported types
 */
export function createMetaObject(absPath, options = {}) {
    const base = path.basename(absPath);

    if (fs.statSync(absPath).isDirectory()) {
        return skeleton({ importer: 'directory', ver: '1.2.0', files: [] });
    }

    const ext = path.extname(absPath).toLowerCase();
    const nameNoExt = base.slice(0, base.length - ext.length);

    if (MODEL_EXTS.has(ext)) {
        throw new MetaGenerationError(
            `${base}: model metas are not generated offline — their userData derives from the ` +
            'model content and the MCP itself needs the library/ artifacts only a real editor ' +
            'import produces. Open the project in Cocos Creator once.');
    }

    if (IMAGE_EXTS.has(ext)) {
        return imageMeta(absPath, ext, nameNoExt, options.imageType ?? 'texture');
    }

    if (AUDIO_EXTS.has(ext)) {
        return skeleton({
            importer: 'audio-clip', ver: '1.0.0',
            files: ['.json', ext], userData: { downloadMode: 0 }
        });
    }

    const entry = SIMPLE_TYPES[ext];
    if (!entry) {
        throw new MetaGenerationError(
            `${base}: no importer table entry for "${ext || base}" — generate this meta in the editor`);
    }

    const meta = skeleton(entry);
    if (ext === '.prefab') meta.userData = { syncNodeName: headName(absPath) ?? nameNoExt };
    if (ext === '.anim') meta.userData = { name: headName(absPath) ?? nameNoExt };
    if (ext === '.ttf') meta.files = ['.json', base];
    return meta;
}

/**
 * Idempotent write: creates `<absPath>.meta` unless one already exists.
 *
 * Shares {@link inspectMetaPath} with {@link resolveAssetMeta} — the two entry points must not
 * disagree about the same path, and `existsSync` here FOLLOWS a symlinked meta (a dangling one
 * read as "no meta at all", so the rename replaced the link and minted a fresh uuid).
 *
 * Only `'exists'` is a skip: an errno this call cannot classify is thrown, because reported as
 * "a meta is already there" it claimed a file that was never written.
 * @returns {{metaPath: string, meta: object|null, created: boolean}}
 * @throws {MetaGenerationError} when the path cannot hold a meta this call may write
 */
export function writeMetaFile(absPath, options = {}) {
    const metaPath = `${absPath}.meta`;
    const display = metaDisplayPath(absPath);
    const found = inspectMetaPath(metaPath, display);
    if (found.state === 'refuse') throw new MetaGenerationError(found.reason, absPath);
    if (found.state === 'unknown') {
        throw new MetaGenerationError(
            `Cannot tell whether ${display}.meta exists: ${found.message} — check that path and ` +
            'its folder\'s permissions by hand. No .meta was minted: one written blind would ' +
            'either fail again or replace a uuid existing references use.', absPath);
    }
    if (found.state === 'exists') return { metaPath, meta: null, created: false };
    const meta = createMetaObject(absPath, options);
    writeMeta(metaPath, meta);
    return { metaPath, meta, created: true };
}

/** `<folder>/<name>`: a bare basename never says WHICH folder of a chain walk is at fault */
function metaDisplayPath(absPath) {
    const parent = path.basename(path.dirname(absPath));
    const base = path.basename(absPath);
    return parent ? `${parent}/${base}` : base;
}

/** Codes that mean the path itself cannot hold a `.meta` — nothing exists there to read */
const UNUSABLE_PATH_CODES = new Set(['ENAMETOOLONG', 'ELOOP', 'ENOTDIR']);

/** Per-component filename limit: 255 BYTES, not characters (see utils/fsAtomic.js) */
const MAX_NAME_BYTES = 255;

/**
 * What is at `<asset>.meta`, as one decision for both entry points.
 *
 * `'none'` = mint, `'exists'` = keep what is there, `'refuse'` = the reason (the caller appends
 * its own "nothing was written" tail), `'unknown'` = neither answer can be read from this path
 * (EACCES on the parent, …), the errno carried along as `message` so both callers can NAME it:
 * {@link resolveAssetMeta} lets its own read reproduce it, {@link writeMetaFile} refuses. What
 * neither may do is call it "exists".
 * @returns {{state: 'none'|'exists'}|{state: 'unknown', message: string}
 *          |{state: 'refuse', reason: string}}
 */
function inspectMetaPath(metaPath, displayPath) {
    let link;
    try {
        link = fs.lstatSync(metaPath);
    } catch (err) {
        if (err.code === 'ENOENT') return { state: 'none' };
        if (UNUSABLE_PATH_CODES.has(err.code)) {
            return { state: 'refuse', reason: unusableMetaPath(metaPath, displayPath, err.code) };
        }
        return { state: 'unknown', message: err.message };
    }
    if (link.isSymbolicLink()) {
        return {
            state: 'refuse',
            reason: `${displayPath}.meta is a symlink, not a .meta file — replace it with a real one ` +
                '(or remove it) by hand. It is not deleted or replaced for you: writing over the ' +
                'link would swap it for a freshly minted uuid, orphaning every existing reference ' +
                'to this asset, and reading through it reports a uuid kept outside the project.'
        };
    }
    return { state: 'exists' };
}

/**
 * No meta exists AND none can be written here, so the path is the diagnosis — not "something is
 * at that path". The usual case is an asset name that fits while its `.meta` companion does not.
 */
function unusableMetaPath(metaPath, displayPath, code) {
    const over = Buffer.byteLength(path.basename(metaPath)) - MAX_NAME_BYTES;
    if (code === 'ENAMETOOLONG' && over > 0) {
        return `No .meta can exist next to ${displayPath}: its ".meta" companion name is ${over} ` +
            `byte(s) over the ${MAX_NAME_BYTES}-BYTE filename limit — shorten the asset name by ` +
            'that much. The asset name itself fits; the ".meta" the editor needs beside it does not.';
    }
    return `No .meta can exist next to ${displayPath}: that path cannot hold a file (${code}) — ` +
        'fix the path by hand.';
}

/**
 * The one way a `.meta` reaches disk: temp+rename. A half-written one is sticky (every later
 * build_* refuses that path), and a plain write follows a symlinked meta path out of the project.
 * @param {string} metaPath - `<asset>.meta`, absolute
 * @param {object} meta
 */
export function writeMeta(metaPath, meta) {
    writeFileAtomic(metaPath, serializeMeta(meta));
}

/**
 * The UUID an asset write must report and keep: the one an existing `.meta` already
 * carries, or a fresh meta's.
 *
 * Every builder resolves this BEFORE writing the asset bytes, so an unusable `.meta`
 * aborts the call with nothing on disk. Five refusals — a SYMLINK at the meta path, a path
 * that cannot hold a file at all (both from {@link inspectMetaPath}), unreadable, unparseable,
 * and parsing without a `uuid` — all leave the asset with a uuid other than the one this call
 * would report, orphaning every reference made against it.
 *
 * The symlink is checked with `lstat` before anything else, because `existsSync` FOLLOWS the
 * link: a dangling or self-referential `<asset>.meta` read as "no meta at all", so this minted
 * a fresh uuid and {@link writeMeta}'s rename replaced the link — the two things this module
 * promises never to do (never touch an existing meta, no UUID churn). A link that DOES resolve
 * is refused just the same: its target lives outside the path this module owns, so the uuid it
 * reports is not one the write can keep.
 *
 * The read and the parse failure are told APART on purpose: a read error names its own
 * errno (a directory or a chmod-000 file at that path is not a broken meta, and "delete
 * it" would be wrong and destructive advice), while a parse error never quotes the parser,
 * whose message carries a slice of the file — and `<asset>.meta` may be any file on disk.
 *
 * @param {string} metaPath - `<asset>.meta`, absolute
 * @param {string} displayPath - The asset path as the caller's argument spelled it, for messages
 * @param {() => object} mint - Fresh meta factory; called only when no meta exists
 * @returns {{uuid: string|null, newMeta: object|null, error: string|null}}
 *          `newMeta` non-null when it still has to be written next to the asset
 */
export function resolveAssetMeta(metaPath, displayPath, mint) {
    const found = inspectMetaPath(metaPath, displayPath);
    if (found.state === 'none') {
        const newMeta = mint();
        return { uuid: newMeta.uuid, newMeta, error: null };
    }
    if (found.state === 'refuse') {
        return { uuid: null, newMeta: null, error: `${found.reason}\n\nNothing was written.` };
    }
    let text;
    try {
        text = fs.readFileSync(metaPath, 'utf-8');
    } catch (err) {
        // The errno IS the diagnosis here (EISDIR/EACCES) and it quotes no content; codes meaning
        // "nothing is there" are refused above instead of reported as something being there.
        return {
            uuid: null, newMeta: null,
            error: `Cannot read existing ${displayPath}.meta: ${err.message} — check what is at ` +
                'that path and fix it by hand. It is not deleted or replaced for you: a real .meta ' +
                'there carries the uuid every existing reference to this asset uses.' +
                '\n\nNothing was written.'
        };
    }
    let meta;
    try {
        meta = JSON.parse(text);
    } catch {
        // Never the parser's message: it quotes the input, and `<asset>.meta` may be a symlink
        // to any file — the report would carry a slice of it.
        return {
            uuid: null, newMeta: null,
            error: `Cannot parse existing ${displayPath}.meta: it is not valid JSON — delete it and ` +
                're-run (a fresh .meta will be generated), or fix it by hand. An empty or ' +
                'truncated .meta is the usual cause; the editor will not import the asset while ' +
                'it stands either.\n\nNothing was written.'
        };
    }
    const uuid = meta?.uuid;
    if (typeof uuid !== 'string' || uuid === '') {
        return {
            uuid: null, newMeta: null,
            error: `${displayPath}.meta has no "uuid" — delete it and re-run (a fresh .meta ` +
                'will be generated), or fix it by hand.\n\nNothing was written.'
        };
    }
    return { uuid, newMeta: null, error: null };
}

/**
 * Every folder under assets/ needs its own meta. Walk from `absPath`'s parent
 * up to (excluding) `assetsRoot` — the assets root itself has no meta — and
 * create the missing ones.
 *
 * `onCreated` fires immediately after each meta lands on disk, BEFORE the next one
 * is attempted. A caller unwinding a failed write needs that: the return value only
 * materializes once the whole chain succeeded, so a throw half-way up would otherwise
 * leave the metas already written with nothing registered to remove them.
 *
 * @param {string} absPath
 * @param {string} assetsRoot
 * @param {{onCreated?: (entry: {dir: string, metaPath: string, meta: object}) => void}} [options]
 * @returns {Array<{dir: string, metaPath: string, meta: object}>} newly created directory metas
 */
export function ensureParentDirMetas(absPath, assetsRoot, options = {}) {
    const created = [];
    const root = path.resolve(assetsRoot);
    let dir = path.dirname(path.resolve(absPath));
    const chain = [];
    // Separator-suffixed prefix check: "<proj>/assets-backup" must not pass
    // as being under "<proj>/assets".
    while (dir.startsWith(root + path.sep)) {
        chain.unshift(dir);
        dir = path.dirname(dir);
    }
    for (const d of chain) {
        const { metaPath, meta, created: isNew } = writeMetaFile(d);
        if (!isNew) continue;
        const entry = { dir: d, metaPath, meta };
        created.push(entry);
        options.onCreated?.(entry);
    }
    return created;
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

/**
 * Image meta with the same shape the editor saves: texture sub-meta always,
 * spriteFrame sub-meta for type "sprite-frame". Derived fields we cannot
 * compute without decoding pixels (alpha trim) get full-image placeholders
 * with trimType "auto" — the importer recomputes them on the next import
 * without touching the UUID.
 */
function imageMeta(absPath, ext, displayName, imageType) {
    if (imageType !== 'texture' && imageType !== 'sprite-frame') {
        throw new MetaGenerationError(`imageType must be "texture" or "sprite-frame", got "${imageType}"`);
    }
    const uuid = randomUUID();
    const buf = fs.readFileSync(absPath);
    const dims = readImageSize(buf, ext); // null when the header is not parseable

    // Editor defaults differ by type (verified on real metas)
    const wrap = imageType === 'sprite-frame' ? 'clamp-to-edge' : 'repeat';
    const subMetas = {
        [TEXTURE_SUB_ID]: {
            importer: 'texture',
            uuid: `${uuid}@${TEXTURE_SUB_ID}`,
            displayName,
            id: TEXTURE_SUB_ID,
            name: 'texture',
            userData: {
                wrapModeS: wrap, wrapModeT: wrap,
                minfilter: 'linear', magfilter: 'linear', mipfilter: 'none',
                anisotropy: 0,
                isUuid: true,
                imageUuidOrDatabaseUri: uuid,
                visible: false
            },
            ver: '1.0.22',
            imported: true,
            files: ['.json'],
            subMetas: {}
        }
    };

    if (imageType === 'sprite-frame') {
        if (!dims) {
            throw new MetaGenerationError(
                `${path.basename(absPath)}: cannot read image dimensions from a ${ext} header — ` +
                'a sprite-frame meta needs them. Use imageType "texture" or import via the editor.');
        }
        subMetas[SPRITE_FRAME_SUB_ID] = spriteFrameSubMeta(uuid, displayName, dims);
    }

    const meta = skeleton({ importer: 'image', ver: '1.0.27', files: ['.json', ext], uuid });
    meta.subMetas = subMetas;
    meta.userData = {
        type: imageType,
        hasAlpha: dims ? dims.hasAlpha : false,
        fixAlphaTransparencyArtifacts: false,
        redirect: `${uuid}@${TEXTURE_SUB_ID}`
    };
    return meta;
}

/** Full-image (no-trim) spriteFrame sub-meta, exact shape of editor output */
function spriteFrameSubMeta(uuid, displayName, { width: w, height: h }) {
    return {
        importer: 'sprite-frame',
        uuid: `${uuid}@${SPRITE_FRAME_SUB_ID}`,
        displayName,
        id: SPRITE_FRAME_SUB_ID,
        name: 'spriteFrame',
        userData: {
            trimThreshold: 1,
            rotated: false,
            offsetX: 0, offsetY: 0,
            trimX: 0, trimY: 0,
            width: w, height: h,
            rawWidth: w, rawHeight: h,
            borderTop: 0, borderBottom: 0, borderLeft: 0, borderRight: 0,
            packable: true,
            pixelsToUnit: 100,
            pivotX: 0.5, pivotY: 0.5,
            meshType: 0,
            vertices: {
                rawPosition: [-w / 2, -h / 2, 0, w / 2, -h / 2, 0, -w / 2, h / 2, 0, w / 2, h / 2, 0],
                indexes: [0, 1, 2, 2, 1, 3],
                uv: [0, h, w, h, 0, 0, w, 0],
                nuv: [0, 0, 1, 0, 0, 1, 1, 1],
                minPos: [-w / 2, -h / 2, 0],
                maxPos: [w / 2, h / 2, 0]
            },
            isUuid: true,
            imageUuidOrDatabaseUri: `${uuid}@${TEXTURE_SUB_ID}`,
            atlasUuid: '',
            trimType: 'auto'
        },
        ver: '1.0.12',
        imported: true,
        files: ['.json'],
        subMetas: {}
    };
}

/**
 * Width/height (+hasAlpha) from PNG/JPEG headers; null for other formats —
 * enough for the meta, no pixel decoding.
 * @returns {{width: number, height: number, hasAlpha: boolean}|null}
 */
export function readImageSize(buf, ext) {
    if (ext === '.png') return readPngSize(buf);
    if (ext === '.jpg' || ext === '.jpeg') return readJpegSize(buf);
    return null;
}

function readPngSize(buf) {
    // signature (8) + IHDR chunk: len(4) "IHDR"(4) width(4) height(4) depth(1) colorType(1)
    if (buf.length < 26 || buf.readUInt32BE(0) !== 0x89504e47) return null;
    if (buf.toString('latin1', 12, 16) !== 'IHDR') return null;
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    const colorType = buf[25];
    // 4 = gray+alpha, 6 = RGBA; indexed/opaque PNGs can still carry a tRNS
    // chunk. Walk the chunk HEADERS up to IDAT (tRNS precedes IDAT per spec)
    // — a byte scan over the whole file could false-positive on the "tRNS"
    // byte sequence inside compressed IDAT data.
    let hasAlpha = colorType === 4 || colorType === 6;
    let off = 8;
    while (!hasAlpha && off + 8 <= buf.length) {
        const len = buf.readUInt32BE(off);
        const type = buf.toString('latin1', off + 4, off + 8);
        if (type === 'tRNS') hasAlpha = true;
        if (type === 'IDAT' || type === 'IEND') break;
        off += 12 + len; // length(4) + type(4) + data(len) + crc(4)
    }
    return { width, height, hasAlpha };
}

function readJpegSize(buf) {
    if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
    let off = 2;
    while (off < buf.length) {
        if (buf[off] !== 0xff) { off++; continue; }
        // Any run of 0xFF fill bytes before the marker type is legal
        // (ITU T.81 B.1.1.2) — skip the run, then read the real marker.
        let m = off + 1;
        while (m < buf.length && buf[m] === 0xff) m++;
        if (m >= buf.length) return null;
        const marker = buf[m];
        // Standalone markers without a length: SOI, TEM, RST0-7;
        // 0x00 is a stuffed data byte, not a marker.
        if (marker === 0xd8 || marker === 0x01 || marker === 0x00 ||
            (marker >= 0xd0 && marker <= 0xd7)) {
            off = m + 1;
            continue;
        }
        if (marker === 0xd9) return null; // EOI — no frame header in the stream
        if (m + 3 > buf.length) return null;
        const len = buf.readUInt16BE(m + 1);
        // SOF0..SOF15 minus DHT(C4)/JPG(C8)/DAC(CC) carry the frame size
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            if (m + 8 > buf.length) return null;
            return {
                height: buf.readUInt16BE(m + 4),
                width: buf.readUInt16BE(m + 6),
                hasAlpha: false
            };
        }
        off = m + 1 + len;
    }
    return null;
}
