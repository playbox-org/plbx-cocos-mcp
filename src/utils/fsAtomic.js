/**
 * Atomic file writes — the Buffer-capable counterpart of `SceneDocument.save`.
 *
 * `SceneDocument.save` (SceneDocument.js:469-474) writes a temp file next to the
 * target and `renameSync`s it into place, so a crash mid-write can never leave a
 * half-written scene behind. Binary assets need the same guarantee — a truncated
 * `.terrain` is unrecoverable and the editor would import it as a corrupt asset —
 * but `save()` is tied to a JSON document, so the idiom lives here as well.
 *
 * Same directory on purpose: `rename(2)` is only atomic within a filesystem, and a
 * temp file in `os.tmpdir()` can land on a different one.
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * Per-component filename limit on every filesystem we care about (APFS, HFS+, ext4, NTFS):
 * 255 BYTES, not characters. The temp name is longer than the target's, so a legal asset
 * name close to the limit would make an otherwise writable path unwritable.
 */
const MAX_TEMP_NAME_BYTES = 255;

/**
 * Temp basename for `base`: `.<base>.tmp-<pid>`, middle-truncated when that would exceed
 * {@link MAX_TEMP_NAME_BYTES}.
 *
 * The `.tmp-<pid>` suffix is never dropped (it is what keeps two processes apart) and the
 * elision keeps the head (recognizable) and the tail (extension) of the original name with a
 * `~` between them. Trimming is done in CHARACTERS and re-measured in BYTES, so a multi-byte
 * name cannot be cut mid-sequence. Two different over-long names in one directory can
 * collide on the same temp name; both are written-then-renamed immediately, and a rename
 * replaces atomically, so the worst case is a lost temp file, never a corrupt target.
 *
 * @param {string} base - `path.basename(filePath)`
 * @param {number|string} pid - Uniqueness suffix (the process id)
 * @returns {string}
 */
function tempBasename(base, pid) {
    const suffix = `.tmp-${pid}`;
    const plain = `.${base}${suffix}`;
    if (Buffer.byteLength(plain) <= MAX_TEMP_NAME_BYTES) return plain;

    let keep = MAX_TEMP_NAME_BYTES - Buffer.byteLength(`.~${suffix}`);
    for (;;) {
        const head = base.slice(0, Math.ceil(keep / 2));
        const tail = base.slice(base.length - Math.floor(keep / 2));
        const name = `.${head}~${tail}${suffix}`;
        if (keep <= 1 || Buffer.byteLength(name) <= MAX_TEMP_NAME_BYTES) return name;
        keep--;
    }
}

/**
 * Write `data` to `filePath` atomically (temp file in the same directory + rename).
 *
 * The temp name mirrors `SceneDocument.save`: `.<basename>.tmp-<pid>` — dot-prefixed
 * so an editor watching `assets/` ignores it (asset-db skips dotfiles), pid-suffixed
 * so two MCP processes writing the same asset do not clobber each other's temp file —
 * and is middle-truncated when the target's name is long enough that the decorated name
 * would break the 255-byte filename limit (see {@link tempBasename}).
 *
 * @param {string} filePath - Absolute path of the file to (over)write
 * @param {Buffer|Uint8Array|string} data - Binary payload, or a string written as UTF-8
 * @returns {string} `filePath`
 * @throws {Error} the underlying fs error, after removing the temp file
 */
export function writeFileAtomic(filePath, data) {
    if (typeof filePath !== 'string' || filePath === '') {
        throw new Error('writeFileAtomic: filePath must be a non-empty string');
    }
    if (typeof data !== 'string' && !Buffer.isBuffer(data) && !ArrayBuffer.isView(data)) {
        throw new Error('writeFileAtomic: data must be a Buffer, a TypedArray or a string');
    }
    const dir = path.dirname(filePath);
    const tmp = path.join(dir, tempBasename(path.basename(filePath), process.pid));
    try {
        if (typeof data === 'string') fs.writeFileSync(tmp, data, 'utf-8');
        else fs.writeFileSync(tmp, data);
        fs.renameSync(tmp, filePath);
    } catch (err) {
        // Never leave the temp file behind: it would show up in assets/ listings
        // (and in the editor's asset-db watcher) as a mystery dotfile.
        try { fs.unlinkSync(tmp); } catch { /* best effort */ }
        throw err;
    }
    return filePath;
}
