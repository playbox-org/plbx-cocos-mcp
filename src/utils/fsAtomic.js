/**
 * Atomic file writes — the Buffer-capable counterpart of `SceneDocument.save`.
 *
 * `SceneDocument.save` (SceneDocument.js:469-474) writes a temp file next to the target and
 * `renameSync`s it into place, so no reader ever sees a half-written file and a crashing
 * PROCESS cannot leave one behind. Binary assets need the same guarantee — a truncated
 * `.terrain` is unrecoverable and the editor would import it as a corrupt asset — but
 * `save()` is tied to a JSON document, so the idiom lives here as well.
 *
 * Surviving POWER LOSS takes more than the rename: the data must be on disk BEFORE the
 * directory entry points at it, or the entry can become durable first and the target reads
 * back as a hole. So the contents are `fsync`ed here while the temp file is still open.
 *
 * What is guaranteed: ATOMICITY, always — it comes from the rename alone, which is why an
 * `fsync` the filesystem does not implement ({@link FSYNC_UNSUPPORTED}) is skipped instead of
 * failing the write. DURABILITY of the contents only where that `fsync` works. Never the
 * DIRECTORY entry, which is not fsynced at all: a power loss just after the rename can lose
 * the rename itself — the target then keeps its previous bytes (or stays absent), which is a
 * lost write, never a torn file.
 *
 * Same directory on purpose: `rename(2)` is only atomic within a filesystem, and a temp file
 * in `os.tmpdir()` can land on a different one.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Per-component filename limit on every filesystem we care about (APFS, HFS+, ext4, NTFS):
 * 255 BYTES, not characters. The temp name is longer than the target's, so a legal asset
 * name close to the limit would make an otherwise writable path unwritable.
 */
const MAX_TEMP_NAME_BYTES = 255;

/**
 * "This filesystem/descriptor has no fsync" — network and virtual filesystems (SMB, some FUSE
 * and container overlay mounts) report one of these — EINVAL is fsync(2)'s own "this file type
 * does not support the operation". Durability is unreachable there, so the step is skipped; every
 * other code (ENOSPC, EIO, EBADF, …) is a real failure and propagates — EPERM included, since no
 * fsync(2) manual lists it while a seccomp filter or an LSM denying the call does, so tolerating
 * it would accept a REFUSED fsync as a durable one.
 */
const FSYNC_UNSUPPORTED = new Set(['EINVAL', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP']);

/** fsync `fd`, tolerating only a filesystem that does not implement it */
function fsyncBestEffort(fd) {
    try {
        fs.fsyncSync(fd);
    } catch (err) {
        if (!FSYNC_UNSUPPORTED.has(err.code)) throw err;
    }
}

/**
 * Uniqueness tag `<pid>-<random>`: the pid keeps two MCP processes apart, the random half
 * keeps the name unguessable, so no local same-user process can pre-create it.
 * @returns {string}
 */
function tempTag() {
    return `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
}

/**
 * Temp basename for `base`: `.<base>.tmp-<tag>`, middle-truncated when that would exceed
 * {@link MAX_TEMP_NAME_BYTES}.
 *
 * The `.tmp-<tag>` suffix is never dropped (it is what keeps two writers apart) and the
 * elision keeps the head (recognizable) and the tail (extension) of the original name with a
 * `~` between them. Trimming is done in CHARACTERS and re-measured in BYTES, so a multi-byte
 * name cannot be cut mid-sequence. Two different over-long names in one directory truncate to
 * the same head and tail, so only the tag separates them; the file is created exclusively, so
 * an unlucky collision is an EEXIST the caller retries (see {@link writeFileAtomic}) rather
 * than two writers sharing one temp file.
 *
 * @param {string} base - `path.basename(filePath)`
 * @param {string} tag - Uniqueness suffix (see {@link tempTag})
 * @returns {string}
 */
function tempBasename(base, tag) {
    const suffix = `.tmp-${tag}`;
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
 * A fresh temp path beside `filePath` — same directory, same naming as {@link writeFileAtomic}'s
 * own temp file, so a caller that must move a file ASIDE (build_terrain's overwrite rollback,
 * which renames it back when a later step fails) does not invent a second convention.
 *
 * Unguessable, not unique: the random half is 6 bytes, so a repeat for the same target is a
 * ~1-in-2^48 accident rather than an impossibility. The GUARANTEE is the exclusive create plus the
 * one EEXIST retry in {@link writeFileAtomic} — a caller that only renames onto this path has the
 * improbability alone, and owns creating and removing the file either way.
 *
 * @param {string} filePath - Absolute path of the file the temp belongs to
 * @returns {string}
 */
export function tempPathFor(filePath) {
    return path.join(path.dirname(filePath), tempBasename(path.basename(filePath), tempTag()));
}

/**
 * Write `data` to `filePath` atomically (temp file in the same directory + rename).
 *
 * The temp name mirrors `SceneDocument.save`: `.<basename>.tmp-<pid>-<random>` — dot-prefixed
 * so an editor watching `assets/` ignores it (asset-db skips dotfiles), pid-suffixed so two MCP
 * processes writing the same asset do not clobber each other's temp file, random-suffixed and
 * created with an EXCLUSIVE open so nothing local can hand us a file it already holds — and
 * middle-truncated when the target's name is long enough that the decorated name would break the
 * 255-byte filename limit (see {@link tempBasename}). Contents are fsynced before the rename
 * where the filesystem supports it; the directory entry never is (see the file header).
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
    let tmp = tempPathFor(filePath);
    let fd;
    try {
        fd = fs.openSync(tmp, 'wx');
    } catch (err) {
        // Something already holds our name: one fresh tag, then it is a real failure
        if (err.code !== 'EEXIST') throw err;
        tmp = tempPathFor(filePath);
        fd = fs.openSync(tmp, 'wx');
    }
    try {
        if (typeof data === 'string') fs.writeFileSync(fd, data, 'utf-8');
        else fs.writeFileSync(fd, data);
        // Durable BEFORE the rename, else the entry can outlive the data it points at
        fsyncBestEffort(fd);
        fs.closeSync(fd);
        fd = null;
        fs.renameSync(tmp, filePath);
    } catch (err) {
        // Never leave the temp file behind: it would show up in assets/ listings
        // (and in the editor's asset-db watcher) as a mystery dotfile.
        if (fd !== null) { try { fs.closeSync(fd); } catch { /* best effort */ } }
        try { fs.unlinkSync(tmp); } catch { /* best effort */ }
        throw err;
    }
    return filePath;
}
