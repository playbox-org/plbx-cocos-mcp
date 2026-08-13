/**
 * fsAtomic tests
 *
 * The durability and exclusive-create guarantees are not observable from the outside (an fsync
 * leaves no trace, and no test can cut the power), so they are MEASURED as a call sequence in a
 * child process whose `fs` is patched by a `--require` preload: `import * as fs from 'fs'` binds
 * the CJS exports as they are at instantiation time, which is after the preload ran. An
 * in-process mock cannot do it — the namespace properties are not redefinable.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

import { writeFileAtomic, tempPathFor } from '../../src/utils/fsAtomic.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODULE = pathToFileURL(path.resolve(__dirname, '../../src/utils/fsAtomic.js')).href;

describe('writeFileAtomic', () => {
    let dir;

    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-')); });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('writes buffers and strings, replacing existing content', () => {
        const target = path.join(dir, 'a.bin');
        writeFileAtomic(target, Buffer.from([1, 2, 3]));
        assert.deepStrictEqual([...fs.readFileSync(target)], [1, 2, 3]);
        writeFileAtomic(target, 'text');
        assert.strictEqual(fs.readFileSync(target, 'utf-8'), 'text');
        assert.deepStrictEqual(fs.readdirSync(dir), ['a.bin']);
    });

    it('removes the temp file when the rename fails', () => {
        const target = path.join(dir, 'busy');
        fs.mkdirSync(target); // renaming a file onto a directory fails
        assert.throws(() => writeFileAtomic(target, Buffer.from([1])));
        assert.deepStrictEqual(fs.readdirSync(dir), ['busy']);
    });

    it('rejects bad arguments', () => {
        assert.throws(() => writeFileAtomic('', Buffer.alloc(1)), /non-empty string/);
        assert.throws(() => writeFileAtomic(path.join(dir, 'x'), { a: 1 }), /Buffer, a TypedArray or a string/);
    });

    // The old code wrote with a plain writeFileSync: the rename could become durable before the
    // data, so a power loss left the target existing and short — the one crash the temp+rename
    // idiom is sold as ruling out.
    it('fsyncs the contents before the rename', () => {
        const seen = inChildProcess(RECORD_CALLS, `
            writeFileAtomic(path.join(DIR, 'out.bin'), Buffer.from([7, 7, 7]));
            const calls = [...globalThis.__calls];
            report({ calls, bytes: [...fs.readFileSync(path.join(DIR, 'out.bin'))] });
        `);
        assert.deepStrictEqual(seen.calls,
            ['openSync:wx', 'writeFileSync', 'fsyncSync', 'closeSync', 'renameSync']);
        assert.deepStrictEqual(seen.bytes, [7, 7, 7]);
    });

    // Atomicity comes from the rename alone, so a filesystem without fsync (SMB, some FUSE and
    // overlay mounts) must lose DURABILITY, not the write — every .meta/.terrain goes through here.
    it('still writes when the filesystem has no fsync', () => {
        for (const code of ['EINVAL', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP']) {
            const seen = inChildProcess(failFsync(code), `
                writeFileAtomic(path.join(DIR, 'out.bin'), Buffer.from([9]));
                report({ tried: globalThis.__fsyncs, bytes: [...fs.readFileSync(path.join(DIR, 'out.bin'))],
                         dir: fs.readdirSync(DIR).sort() });
            `);
            assert.strictEqual(seen.tried, 1, `${code}: fsync is still attempted`);
            assert.deepStrictEqual(seen.bytes, [9], `${code}: the write must survive`);
            assert.deepStrictEqual(seen.dir, ['main.mjs', 'out.bin', 'preload.cjs'], `${code}: no temp left`);
        }
    });

    // ...while a real I/O error is data loss in progress: it must not be swallowed. EPERM is here
    // and not above on the evidence: no fsync(2) manual lists it, a seccomp/LSM denial does return
    // it — so a REFUSED fsync must fail the write, not pass as an fsync-less filesystem.
    it('fails loudly when fsync reports a real I/O error', () => {
        for (const code of ['ENOSPC', 'EIO', 'EBADF', 'EPERM']) {
            const seen = inChildProcess(failFsync(code), `
                let code = null;
                try { writeFileAtomic(path.join(DIR, 'out.bin'), Buffer.from([9])); }
                catch (err) { code = err.code; }
                report({ code, exists: fs.existsSync(path.join(DIR, 'out.bin')), dir: fs.readdirSync(DIR).sort() });
            `);
            assert.deepStrictEqual(seen,
                { code, exists: false, dir: ['main.mjs', 'preload.cjs'] }, `${code} must propagate`);
        }
    });

    // `.<base>.tmp-<pid>` plus an implicit `w` let any local same-user process pre-create the
    // name and have our write land in ITS file.
    it('creates the temp file exclusively and retries once on a collision', () => {
        const seen = inChildProcess(FAIL_FIRST_OPEN, `
            writeFileAtomic(path.join(DIR, 'out.bin'), 'ok');
            report({ attempts: globalThis.__attempts, dir: fs.readdirSync(DIR).sort(),
                     content: fs.readFileSync(path.join(DIR, 'out.bin'), 'utf-8') });
        `);
        assert.strictEqual(seen.attempts.length, 2, 'the EEXIST must be retried, not reported');
        assert.notStrictEqual(seen.attempts[0], seen.attempts[1], 'the retry needs a fresh tag');
        for (const p of seen.attempts) assert.match(p, /\.out\.bin\.tmp-\d+-[0-9a-f]{12}$/);
        assert.strictEqual(seen.content, 'ok');
        assert.deepStrictEqual(seen.dir, ['main.mjs', 'out.bin', 'preload.cjs']);
    });

    it('gives up after a second collision, leaving nothing behind', () => {
        const seen = inChildProcess(FAIL_EVERY_OPEN, `
            let code = null;
            try { writeFileAtomic(path.join(DIR, 'out.bin'), 'ok'); } catch (err) { code = err.code; }
            report({ code, attempts: globalThis.__attempts.length, exists: fs.existsSync(path.join(DIR, 'out.bin')) });
        `);
        assert.deepStrictEqual(seen, { code: 'EEXIST', attempts: 2, exists: false });
    });
});

describe('tempPathFor', () => {
    let dir;

    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-name-')); });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('is unguessable, keeps the pid, and stays inside the 255-BYTE limit', () => {
        const target = path.join(dir, 'Ground.terrain');
        const a = tempPathFor(target);
        const b = tempPathFor(target);
        assert.strictEqual(path.dirname(a), dir, 'rename(2) is only atomic within a filesystem');
        assert.notStrictEqual(a, b);
        assert.match(path.basename(a),
            new RegExp(`^\\.Ground\\.terrain\\.tmp-${process.pid}-[0-9a-f]{12}$`));

        // a target name already at the limit must not push the temp name over it
        const long = path.join(dir, `${'ü'.repeat(120)}.terrain`);
        const name = path.basename(tempPathFor(long));
        assert.strictEqual(Buffer.byteLength(path.basename(long)), 248);
        assert.ok(Buffer.byteLength(name) <= 255, `${Buffer.byteLength(name)} bytes`);
        assert.ok(name.includes('~'), 'over-long names are middle-truncated');
        assert.doesNotMatch(name, /�/, 'and never cut mid-sequence');
    });

    // The doc used to promise a name "never returned twice"; it is 48 bits of randomness, so pin
    // the WIDTH the ~1-in-2^48 claim rests on (the guarantee is writeFileAtomic's EEXIST retry).
    it('draws the random half from a full 48 bits', () => {
        const target = path.join(dir, 'Ground.terrain');
        const tags = new Set();
        let bits = 0n;
        for (let n = 0; n < 5000; n++) {
            const tag = /-([0-9a-f]+)$/.exec(tempPathFor(target))[1];
            assert.strictEqual(tag.length, 12, `${tag} is not 6 bytes of hex`);
            tags.add(tag);
            bits |= BigInt(`0x${tag}`);
        }
        assert.strictEqual(tags.size, 5000, 'no repeat in 5000 draws');
        assert.strictEqual(bits, (1n << 48n) - 1n, 'every one of the 48 bits varies');
    });
});

// --- helpers -----------------------------------------------------------------

/** Records every fs call fsAtomic makes, openSync with its flags */
const RECORD_CALLS = `
const fs = require('fs');
const calls = globalThis.__calls = [];
for (const [name, describe] of [['openSync', a => a[1]], ['writeFileSync'], ['fsyncSync'],
                                ['closeSync'], ['renameSync']]) {
    const real = fs[name];
    fs[name] = (...a) => { calls.push(describe ? \`\${name}:\${describe(a)}\` : name); return real(...a); };
}
`;

/** Turns the Nth exclusive open into an EEXIST, as a colliding temp name would */
const failOpen = (until) => `
const fs = require('fs');
const attempts = globalThis.__attempts = [];
const real = fs.openSync;
fs.openSync = (p, flags, ...rest) => {
    if (flags === 'wx') {
        attempts.push(p);
        if (attempts.length <= ${until}) { const e = new Error('EEXIST'); e.code = 'EEXIST'; throw e; }
    }
    return real(p, flags, ...rest);
};
`;
const FAIL_FIRST_OPEN = failOpen(1);
const FAIL_EVERY_OPEN = failOpen(99);

/** Makes fsyncSync fail with `code`, counting the attempts, as an fsync-less filesystem does */
const failFsync = (code) => `
const fs = require('fs');
globalThis.__fsyncs = 0;
fs.fsyncSync = () => {
    globalThis.__fsyncs++;
    const e = new Error(${JSON.stringify(code)});
    e.code = ${JSON.stringify(code)};
    throw e;
};
`;

/**
 * Run `body` against the real fsAtomic in a child process whose `fs` the `preload` patched.
 * `body` gets `fs`, `path`, `DIR` (its own temp dir), `writeFileAtomic` and `report(obj)`.
 * @returns {object} whatever `body` reported
 */
function inChildProcess(preload, body) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-child-'));
    try {
        fs.writeFileSync(path.join(dir, 'preload.cjs'), preload);
        fs.writeFileSync(path.join(dir, 'main.mjs'), [
            "import * as fs from 'fs';",
            "import * as path from 'path';",
            `import { writeFileAtomic } from ${JSON.stringify(MODULE)};`,
            `const DIR = ${JSON.stringify(dir)};`,
            'const report = (o) => console.log(JSON.stringify(o));',
            body,
        ].join('\n'));
        const out = execFileSync(
            process.execPath, ['--require', path.join(dir, 'preload.cjs'), path.join(dir, 'main.mjs')],
            { encoding: 'utf-8' });
        return JSON.parse(out);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}
