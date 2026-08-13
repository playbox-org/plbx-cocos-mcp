import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    createMetaObject, writeMetaFile, ensureParentDirMetas, serializeMeta,
    classifyAsset, prefabMeta, animGraphMeta, terrainMeta, readImageSize, MetaGenerationError,
    resolveAssetMeta, SIMPLE_TYPES
} from '../../src/document/MetaGenerator.js';
import { CreateAssetMeta } from '../../src/tools/CreateAssetMeta.js';

// 1x1 RGBA (colorType 6) transparent PNG
const PNG_1x1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64');

/** Minimal JPEG: SOI + SOF0 (height 16, width 32) + EOI */
function makeJpeg() {
    return Buffer.from([
        0xff, 0xd8,
        0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x20,
        0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
        0xff, 0xd9
    ]);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('MetaGenerator', () => {
    let root;
    let assets;

    before(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-gen-'));
        assets = path.join(root, 'assets');
        fs.mkdirSync(path.join(assets, 'Scripts', 'Core'), { recursive: true });
        fs.writeFileSync(path.join(assets, 'Scripts', 'Core', 'Spin.ts'), 'export class Spin {}');
        fs.writeFileSync(path.join(assets, 'Scripts', 'legacy.js'), 'module.exports = {};');
        fs.writeFileSync(path.join(assets, 'Mat.mtl'), '{}');
        fs.writeFileSync(path.join(assets, 'clip.anim'),
            JSON.stringify([{ __type__: 'cc.AnimationClip', _name: 'run-cycle' }]));
        fs.writeFileSync(path.join(assets, 'Thing.prefab'), JSON.stringify([
            { __type__: 'cc.Prefab', _name: 'Thing', data: { __id__: 1 } },
            { __type__: 'cc.Node', _name: 'Thing' }
        ]));
        fs.writeFileSync(path.join(assets, 'boom.mp3'), Buffer.from([0xff, 0xfb, 0x00, 0x00]));
        fs.writeFileSync(path.join(assets, 'Peace.ttf'), Buffer.from([0x00, 0x01, 0x00, 0x00]));
        fs.writeFileSync(path.join(assets, 'icon.png'), PNG_1x1);
        fs.writeFileSync(path.join(assets, 'photo.jpg'), makeJpeg());
        fs.writeFileSync(path.join(assets, 'Model.fbx'), 'not-a-real-fbx');
        fs.writeFileSync(path.join(assets, 'notes.xyz'), 'mystery');
    });

    after(() => fs.rmSync(root, { recursive: true, force: true }));

    it('should build a bare typescript meta (skeleton, files: [])', () => {
        const meta = createMetaObject(path.join(assets, 'Scripts', 'Core', 'Spin.ts'));
        assert.strictEqual(meta.importer, 'typescript');
        assert.strictEqual(meta.ver, '4.0.24');
        assert.strictEqual(meta.imported, true);
        assert.deepStrictEqual(meta.files, []);
        assert.deepStrictEqual(meta.subMetas, {});
        assert.deepStrictEqual(meta.userData, {});
        assert.match(meta.uuid, UUID_RE);
        assert.deepStrictEqual(Object.keys(meta),
            ['ver', 'importer', 'imported', 'uuid', 'files', 'subMetas', 'userData']);
    });

    it('should map .js to the javascript importer', () => {
        const meta = createMetaObject(path.join(assets, 'Scripts', 'legacy.js'));
        assert.strictEqual(meta.importer, 'javascript');
        assert.strictEqual(meta.ver, '4.0.24');
    });

    it('should build directory metas (files: [], ver 1.2.0)', () => {
        const meta = createMetaObject(path.join(assets, 'Scripts'));
        assert.strictEqual(meta.importer, 'directory');
        assert.strictEqual(meta.ver, '1.2.0');
        assert.deepStrictEqual(meta.files, []);
    });

    it('should read the clip name for .anim userData', () => {
        const meta = createMetaObject(path.join(assets, 'clip.anim'));
        assert.strictEqual(meta.importer, 'animation-clip');
        assert.deepStrictEqual(meta.files, ['.bin']);
        assert.deepStrictEqual(meta.userData, { name: 'run-cycle' });
    });

    it('should read the root name for .prefab syncNodeName', () => {
        const meta = createMetaObject(path.join(assets, 'Thing.prefab'));
        assert.strictEqual(meta.importer, 'prefab');
        assert.deepStrictEqual(meta.userData, { syncNodeName: 'Thing' });
    });

    it('should build audio metas with downloadMode', () => {
        const meta = createMetaObject(path.join(assets, 'boom.mp3'));
        assert.strictEqual(meta.importer, 'audio-clip');
        assert.deepStrictEqual(meta.files, ['.json', '.mp3']);
        assert.deepStrictEqual(meta.userData, { downloadMode: 0 });
    });

    it('should list the full basename in ttf files (editor form)', () => {
        const meta = createMetaObject(path.join(assets, 'Peace.ttf'));
        assert.strictEqual(meta.importer, 'ttf-font');
        assert.deepStrictEqual(meta.files, ['.json', 'Peace.ttf']);
    });

    it('should build a texture-type image meta with the 6c48a sub-meta', () => {
        const meta = createMetaObject(path.join(assets, 'icon.png'));
        assert.strictEqual(meta.importer, 'image');
        assert.strictEqual(meta.ver, '1.0.27');
        assert.deepStrictEqual(meta.files, ['.json', '.png']);
        assert.strictEqual(meta.userData.type, 'texture');
        assert.strictEqual(meta.userData.hasAlpha, true); // colorType 6
        assert.strictEqual(meta.userData.redirect, `${meta.uuid}@6c48a`);
        assert.deepStrictEqual(Object.keys(meta.subMetas), ['6c48a']);
        const tex = meta.subMetas['6c48a'];
        assert.strictEqual(tex.importer, 'texture');
        assert.strictEqual(tex.uuid, `${meta.uuid}@6c48a`);
        assert.strictEqual(tex.name, 'texture');
        assert.strictEqual(tex.displayName, 'icon');
        assert.strictEqual(tex.userData.wrapModeS, 'repeat');
        assert.strictEqual(tex.userData.imageUuidOrDatabaseUri, meta.uuid);
    });

    it('should build a sprite-frame image meta with full-image f9941 placeholders', () => {
        const meta = createMetaObject(path.join(assets, 'icon.png'), { imageType: 'sprite-frame' });
        assert.strictEqual(meta.userData.type, 'sprite-frame');
        assert.deepStrictEqual(Object.keys(meta.subMetas), ['6c48a', 'f9941']);
        assert.strictEqual(meta.subMetas['6c48a'].userData.wrapModeS, 'clamp-to-edge');
        const sf = meta.subMetas.f9941.userData;
        assert.strictEqual(sf.rawWidth, 1);
        assert.strictEqual(sf.rawHeight, 1);
        assert.strictEqual(sf.width, 1);
        assert.strictEqual(sf.trimX, 0);
        assert.strictEqual(sf.trimType, 'auto'); // importer recomputes real trim on import
        assert.deepStrictEqual(sf.vertices.rawPosition, [-0.5, -0.5, 0, 0.5, -0.5, 0, -0.5, 0.5, 0, 0.5, 0.5, 0]);
        assert.deepStrictEqual(sf.vertices.uv, [0, 1, 1, 1, 0, 0, 1, 0]);
        assert.deepStrictEqual(sf.vertices.nuv, [0, 0, 1, 0, 0, 1, 1, 1]);
        assert.strictEqual(sf.imageUuidOrDatabaseUri, `${meta.uuid}@6c48a`);
        assert.strictEqual(meta.subMetas.f9941.uuid, `${meta.uuid}@f9941`);
    });

    it('should parse JPEG dimensions', () => {
        const meta = createMetaObject(path.join(assets, 'photo.jpg'), { imageType: 'sprite-frame' });
        const sf = meta.subMetas.f9941.userData;
        assert.strictEqual(sf.rawWidth, 32);
        assert.strictEqual(sf.rawHeight, 16);
        assert.strictEqual(meta.userData.hasAlpha, false);
    });

    it('should refuse models with an explanation', () => {
        assert.throws(() => createMetaObject(path.join(assets, 'Model.fbx')),
            MetaGenerationError);
        assert.throws(() => createMetaObject(path.join(assets, 'Model.fbx')),
            /library/);
    });

    it('should refuse unknown extensions', () => {
        assert.throws(() => createMetaObject(path.join(assets, 'notes.xyz')),
            MetaGenerationError);
    });

    it('should classify paths', () => {
        assert.strictEqual(classifyAsset(path.join(assets, 'Scripts')), 'supported');
        assert.strictEqual(classifyAsset(path.join(assets, 'icon.png')), 'supported');
        assert.strictEqual(classifyAsset(path.join(assets, 'Model.fbx')), 'model');
        assert.strictEqual(classifyAsset(path.join(assets, 'notes.xyz')), 'unknown');
    });

    it('should write idempotently: never touch an existing .meta', () => {
        const target = path.join(assets, 'Mat.mtl');
        const first = writeMetaFile(target);
        assert.strictEqual(first.created, true);
        assert.strictEqual(first.meta.importer, 'material');
        const onDisk = fs.readFileSync(first.metaPath, 'utf-8');
        assert.strictEqual(onDisk, serializeMeta(first.meta));
        assert.ok(onDisk.endsWith('}\n')); // editor byte-form: trailing newline

        const second = writeMetaFile(target);
        assert.strictEqual(second.created, false);
        assert.strictEqual(fs.readFileSync(first.metaPath, 'utf-8'), onDisk);
    });

    // Both entry points must agree about one path. writeMetaFile gated on `existsSync`, which
    // FOLLOWS the link: a dangling `<asset>.meta` read as "no meta at all", so a fresh uuid was
    // minted and writeMeta's rename replaced the link — while resolveAssetMeta refused it.
    it('should refuse a symlinked meta path, exactly as resolveAssetMeta does', () => {
        const target = path.join(assets, 'Linked.mtl');
        fs.writeFileSync(target, '{}');
        const metaPath = `${target}.meta`;
        const gone = path.join(assets, 'link-target.meta');
        fs.symlinkSync(gone, metaPath); // dangling

        assert.throws(() => writeMetaFile(target), (err) => {
            assert.ok(err instanceof MetaGenerationError, err.constructor.name);
            // folder-qualified: a bare "Linked.mtl.meta" never says which folder to look in
            assert.match(err.message, /^assets\/Linked\.mtl\.meta is a symlink/);
            assert.strictEqual(err.assetPath, target); // which path of a chain walk was refused
            return true;
        });
        assert.ok(fs.lstatSync(metaPath).isSymbolicLink(), 'the link is left exactly as found');
        assert.strictEqual(fs.existsSync(gone), false, 'no meta written through the link');

        // …and the builders' entry point refuses the same path with the same reason
        const out = resolveAssetMeta(metaPath, 'assets/Linked.mtl', () => {
            throw new Error('the factory must not run for a link at the meta path');
        });
        assert.match(out.error, /^assets\/Linked\.mtl\.meta is a symlink/);
        assert.strictEqual(out.uuid, null);
    });

    // The lstat gate answers three ways, and only 'exists' may be a skip: an unclassifiable
    // errno reported as `created: false` claimed a meta that was never written (before the gate,
    // `existsSync` returned false on EACCES and the write failed loudly).
    it('should refuse an unreadable meta path instead of calling it "meta exists"', (t) => {
        const dir = path.join(assets, 'Locked');
        fs.mkdirSync(dir, { recursive: true });
        const target = path.join(dir, 'x.mtl');
        fs.writeFileSync(target, '{}');
        fs.chmodSync(dir, 0o444); // readable, NOT searchable — lstat inside gives EACCES
        try {
            try {
                fs.lstatSync(`${target}.meta`);
                return t.skip('mode 444 is still searchable here'); // root, or a mode-blind fs
            } catch (err) {
                if (err.code !== 'EACCES') return t.skip(`unexpected ${err.code}`);
            }
            assert.throws(() => writeMetaFile(target), (err) => {
                assert.ok(err instanceof MetaGenerationError, err.constructor.name);
                assert.match(err.message, /^Cannot tell whether Locked\/x\.mtl\.meta exists: EACCES/);
                assert.match(err.message, /No \.meta was minted/);
                assert.strictEqual(err.assetPath, target);
                return true;
            });
        } finally {
            fs.chmodSync(dir, 0o755);
        }
        assert.strictEqual(fs.existsSync(`${target}.meta`), false, 'no meta was written');
    });

    it('should create metas for the parent folder chain, excluding assets root', () => {
        const file = path.join(assets, 'Scripts', 'Core', 'Spin.ts');
        const created = ensureParentDirMetas(file, assets);
        const dirs = created.map(c => path.relative(assets, c.dir));
        assert.deepStrictEqual(dirs, ['Scripts', 'Scripts/Core']);
        assert.ok(fs.existsSync(path.join(assets, 'Scripts.meta')));
        assert.ok(fs.existsSync(path.join(assets, 'Scripts', 'Core.meta')));
        assert.ok(!fs.existsSync(`${assets}.meta`));
        assert.strictEqual(created[0].meta.importer, 'directory');
        assert.strictEqual(created[0].metaPath, path.join(assets, 'Scripts.meta'));
        // second run: nothing new
        assert.deepStrictEqual(ensureParentDirMetas(file, assets), []);
    });

    // A caller unwinding a failed write cannot use the return value: it only materializes once
    // the whole chain succeeded, so a throw half-way up would orphan the metas already written.
    it('should report each folder meta through onCreated as it lands', () => {
        const file = path.join(assets, 'A', 'B', 'C', 'Spin.ts');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const seen = [];
        assert.throws(() => ensureParentDirMetas(file, assets, {
            onCreated: ({ dir, metaPath }) => {
                seen.push(path.relative(assets, dir));
                // the meta is on disk BEFORE the callback runs, so the caller can register a
                // rollback that actually works
                assert.ok(fs.existsSync(metaPath));
                if (seen.length === 2) throw new Error('boom');
            },
        }), /boom/);
        assert.deepStrictEqual(seen, ['A', 'A/B']);
        // both are on disk, and the caller was told about both — nothing is orphaned silently
        assert.ok(fs.existsSync(path.join(assets, 'A.meta')));
        assert.ok(fs.existsSync(path.join(assets, 'A', 'B.meta')));
        assert.ok(!fs.existsSync(path.join(assets, 'A', 'B', 'C.meta')));
    });

    it('should keep prefabMeta/animGraphMeta shapes used by the builders', () => {
        const p = prefabMeta('Crate');
        assert.strictEqual(p.importer, 'prefab');
        assert.strictEqual(p.ver, '1.1.50');
        assert.deepStrictEqual(p.files, ['.json']);
        assert.deepStrictEqual(p.userData, { syncNodeName: 'Crate' });
        const g = animGraphMeta();
        assert.strictEqual(g.importer, 'animation-graph');
        assert.strictEqual(g.ver, '1.2.0');
        assert.deepStrictEqual(g.userData, {});
    });

    it('should generate a .terrain meta byte-identical to the editor-saved golden', () => {
        const goldenPath = path.resolve(
            import.meta.dirname, '../fixtures/golden/terrain/terrain.terrain.meta');
        const golden = fs.readFileSync(goldenPath, 'utf-8');
        const goldenMeta = JSON.parse(golden);

        const file = path.join(assets, 'Ground.terrain');
        fs.writeFileSync(file, Buffer.alloc(2048)); // content is irrelevant to the meta
        const meta = createMetaObject(file);
        assert.strictEqual(meta.importer, 'terrain');
        assert.strictEqual(meta.ver, '1.1.50');
        assert.deepStrictEqual(meta.files, ['.bin', '.json']);
        assert.deepStrictEqual(meta.userData, {}); // the terrain importer has no userData
        assert.match(meta.uuid, UUID_RE);
        // byte-for-byte the editor's own meta, modulo the UUID
        assert.strictEqual(
            serializeMeta(meta).replace(meta.uuid, goldenMeta.uuid),
            golden);
        assert.strictEqual(classifyAsset(file), 'supported');

        // terrainMeta() (used by build_terrain) is the same object, sourced from SIMPLE_TYPES
        const built = terrainMeta();
        assert.deepStrictEqual({ ...built, uuid: 'x' }, { ...meta, uuid: 'x' });
        // …and does not alias the SIMPLE_TYPES arrays between calls
        const other = terrainMeta();
        assert.notStrictEqual(built.files, other.files);
        assert.notStrictEqual(built.uuid, other.uuid);
    });

    it('should advertise every SIMPLE_TYPES extension in create_asset_meta\'s description', () => {
        const description = new CreateAssetMeta().description;
        const missing = Object.keys(SIMPLE_TYPES).filter(ext => !description.includes(ext));
        assert.deepStrictEqual(missing, [],
            `create_asset_meta's hand-kept "Supported:" list is out of date: ${missing.join(', ')}`);
    });

    it('should read PNG/JPEG sizes and return null otherwise', () => {
        assert.deepStrictEqual(readImageSize(PNG_1x1, '.png'), { width: 1, height: 1, hasAlpha: true });
        assert.deepStrictEqual(readImageSize(makeJpeg(), '.jpg'), { width: 32, height: 16, hasAlpha: false });
        assert.strictEqual(readImageSize(Buffer.from('junk'), '.tga'), null);
        assert.strictEqual(readImageSize(Buffer.from('junk'), '.png'), null);
    });

    it('should skip JPEG 0xFF fill bytes before markers (review #7)', () => {
        // SOI + APP0 + a run of fill bytes (legal per ITU T.81 B.1.1.2) + SOF0
        const jpeg = Buffer.from([
            0xff, 0xd8,
            0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
            0xff, 0xff, 0xff, // fill bytes
            0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x20,
            0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
            0xff, 0xd9
        ]);
        assert.deepStrictEqual(readImageSize(jpeg, '.jpg'),
            { width: 32, height: 16, hasAlpha: false });
    });

    it('should return null for a JPEG with no frame header (EOI reached)', () => {
        assert.strictEqual(readImageSize(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), '.jpg'), null);
    });

    it('should not read tRNS out of compressed IDAT bytes (opaque PNG)', () => {
        // Opaque RGB PNG (colorType 2) whose IDAT payload happens to contain
        // the ASCII bytes "tRNS" — a whole-buffer scan would false-positive.
        const opaque = makePng(2, [
            pngChunk('IDAT', Buffer.from('xxtRNSxx', 'latin1')),
            pngChunk('IEND', Buffer.alloc(0))
        ]);
        assert.deepStrictEqual(readImageSize(opaque, '.png'),
            { width: 2, height: 3, hasAlpha: false });

        // A real tRNS chunk before IDAT still counts
        const trans = makePng(2, [
            pngChunk('tRNS', Buffer.from([0, 0, 0, 0, 0, 0])),
            pngChunk('IDAT', Buffer.alloc(4)),
            pngChunk('IEND', Buffer.alloc(0))
        ]);
        assert.deepStrictEqual(readImageSize(trans, '.png'),
            { width: 2, height: 3, hasAlpha: true });
    });

    // The uuid the builders REPORT is the one the agent references the asset by. Every
    // form that would make the editor mint a different one on import must abort the build.
    describe('resolveAssetMeta (shared by build_prefab/build_animgraph/build_terrain)', () => {
        let dir;

        before(() => {
            dir = path.join(root, 'resolve-meta');
            fs.mkdirSync(dir, { recursive: true });
        });

        const mint = () => ({ ver: '1.1.50', importer: 'prefab', uuid: 'fresh-uuid' });

        it('mints through the caller factory when no meta exists', () => {
            const out = resolveAssetMeta(path.join(dir, 'none.prefab.meta'), 'assets/none.prefab', mint);
            assert.strictEqual(out.error, null);
            assert.strictEqual(out.uuid, 'fresh-uuid');
            assert.strictEqual(out.newMeta.importer, 'prefab');
        });

        it('reuses the uuid of an existing meta and mints nothing', () => {
            const metaPath = path.join(dir, 'kept.prefab.meta');
            fs.writeFileSync(metaPath, JSON.stringify({ uuid: 'kept-uuid' }));
            const out = resolveAssetMeta(metaPath, 'assets/kept.prefab', () => {
                throw new Error('the factory must not run when a meta exists');
            });
            assert.deepStrictEqual(out, { uuid: 'kept-uuid', newMeta: null, error: null });
        });

        it('refuses an unparseable meta', () => {
            const metaPath = path.join(dir, 'broken.prefab.meta');
            fs.writeFileSync(metaPath, '{ not json');
            const out = resolveAssetMeta(metaPath, 'assets/broken.prefab', mint);
            assert.strictEqual(out.uuid, null);
            assert.strictEqual(out.newMeta, null);
            assert.match(out.error, /^Cannot parse existing assets\/broken\.prefab\.meta: /);
            assert.match(out.error, /Nothing was written\.$/);
        });

        // JSON.parse quotes the input it choked on, and `<asset>.meta` may be a symlink to any
        // file — so the error names the meta and never carries a slice of its content.
        it('does not echo the meta\'s content into the error', () => {
            const metaPath = path.join(dir, 'secret.prefab.meta');
            // the parser quotes the first ~10 bytes, so that is where the probe sits
            fs.writeFileSync(metaPath, 'TOPSECRET-' + 'private-key-material\n'.repeat(4));
            const out = resolveAssetMeta(metaPath, 'assets/secret.prefab', mint);
            assert.strictEqual(out.uuid, null);
            assert.strictEqual(out.newMeta, null);
            assert.ok(!out.error.includes('TOPSECRET'), `content leaked: ${out.error}`);
            // still actionable: which meta, and what to do about it
            assert.match(out.error,
                /^Cannot parse existing assets\/secret\.prefab\.meta: it is not valid JSON/);
            assert.match(out.error, /delete it and re-run|fix it by hand/);
            assert.match(out.error, /Nothing was written\.$/);
        });

        // Hiding the PARSER's message (it quotes content) must not swallow the READ error too:
        // "it is not valid JSON — delete it" is both wrong and destructive for an EISDIR/EACCES
        // path, and it hides the only thing that explains the failure.
        it('names the real read error instead of blaming JSON (EISDIR)', () => {
            const metaPath = path.join(dir, 'dirmeta.prefab.meta');
            fs.mkdirSync(metaPath, { recursive: true });
            const out = resolveAssetMeta(metaPath, 'assets/dirmeta.prefab', () => {
                throw new Error('the factory must not run when something exists at the meta path');
            });
            assert.strictEqual(out.uuid, null);
            assert.strictEqual(out.newMeta, null);
            assert.match(out.error, /^Cannot read existing assets\/dirmeta\.prefab\.meta: EISDIR/);
            assert.doesNotMatch(out.error, /valid JSON/);
            assert.doesNotMatch(out.error, /delete it/); // destructive advice for a directory
            assert.match(out.error, /Nothing was written\.$/);
            assert.ok(fs.statSync(metaPath).isDirectory()); // untouched
        });

        it('names the real read error instead of blaming JSON (EACCES)', (t) => {
            const metaPath = path.join(dir, 'locked.prefab.meta');
            fs.writeFileSync(metaPath, JSON.stringify({ uuid: 'TOPSECRET-uuid' }));
            fs.chmodSync(metaPath, 0);
            try {
                fs.readFileSync(metaPath, 'utf-8');
                // running as root (or a filesystem ignoring the mode): nothing to observe
                return t.skip('mode 000 is still readable here');
            } catch { /* expected: EACCES */ }
            try {
                const out = resolveAssetMeta(metaPath, 'assets/locked.prefab', mint);
                assert.strictEqual(out.uuid, null);
                assert.strictEqual(out.newMeta, null);
                assert.match(out.error, /^Cannot read existing assets\/locked\.prefab\.meta: EACCES/);
                assert.doesNotMatch(out.error, /valid JSON/);
                assert.doesNotMatch(out.error, /delete it/);
                assert.ok(!out.error.includes('TOPSECRET'), `content leaked: ${out.error}`);
                assert.match(out.error, /Nothing was written\.$/);
            } finally {
                fs.chmodSync(metaPath, 0o600);
            }
        });

        // A meta that parses but has no usable uuid used to yield `uuid === undefined`,
        // printed as "UUID: undefined" while the asset landed on disk.
        it('refuses a parsed meta with no usable uuid', () => {
            for (const [name, body] of [
                ['empty', {}],
                ['blank', { uuid: '' }],
                ['typed', { uuid: 42 }],
                ['nulled', { uuid: null }]
            ]) {
                const metaPath = path.join(dir, `${name}.prefab.meta`);
                fs.writeFileSync(metaPath, JSON.stringify(body));
                const out = resolveAssetMeta(metaPath, `assets/${name}.prefab`, mint);
                assert.strictEqual(out.uuid, null, name);
                assert.strictEqual(out.newMeta, null, name);
                assert.match(out.error, new RegExp(`^assets/${name}\\.prefab\\.meta has no "uuid"`));
                assert.match(out.error, /Nothing was written\.$/);
            }
        });

        // existsSync FOLLOWS the link, so a dangling or looping `<asset>.meta` read as "no meta":
        // a fresh uuid was minted (verified: both returned `{uuid: 'fresh-uuid', error: null}`) and
        // writeMeta's rename then replaced the link — UUID churn on an existing meta path.
        it('refuses a symlinked meta path instead of minting over it', () => {
            const cases = [
                ['dangling', (p) => fs.symlinkSync(path.join(dir, 'gone.json'), p)],
                ['looping', (p) => fs.symlinkSync(p, p)],
                ['resolvable', (p) => {
                    fs.writeFileSync(path.join(dir, 'outside.json'), JSON.stringify({ uuid: 'outside-uuid' }));
                    fs.symlinkSync(path.join(dir, 'outside.json'), p);
                }]
            ];
            for (const [name, link] of cases) {
                const metaPath = path.join(dir, `${name}.prefab.meta`);
                link(metaPath);
                const out = resolveAssetMeta(metaPath, `assets/${name}.prefab`, () => {
                    throw new Error('the factory must not run for a link at the meta path');
                });
                assert.strictEqual(out.uuid, null, name);
                assert.strictEqual(out.newMeta, null, name);
                assert.match(out.error, new RegExp(`^assets/${name}\\.prefab\\.meta is a symlink`), name);
                assert.match(out.error, /Nothing was written\.$/, name);
                assert.ok(fs.lstatSync(metaPath).isSymbolicLink(), `${name}: the link is left alone`);
            }
            // and the resolvable one never leaks the uuid it could have read through the link
            const out = resolveAssetMeta(path.join(dir, 'resolvable.prefab.meta'),
                'assets/resolvable.prefab', mint);
            assert.ok(!out.error.includes('outside-uuid'), out.error);
        });

        // ENAMETOOLONG/ELOOP/ENOTDIR mean NOTHING is at that path, so "check what is at that path
        // — a real .meta there carries the uuid every existing reference uses" was fiction. The
        // actionable fact is the 255-BYTE filename limit the ".meta" companion blows.
        it('names the filename limit when no meta can exist at the path', () => {
            const base = `${'x'.repeat(246)}.terrain`; // 254 bytes; "<base>.meta" needs 259
            const out = resolveAssetMeta(path.join(dir, `${base}.meta`), `assets/${base}`, () => {
                throw new Error('the factory must not run for a path that cannot hold a meta');
            });
            assert.strictEqual(out.uuid, null);
            assert.strictEqual(out.newMeta, null);
            assert.match(out.error, /^No \.meta can exist next to assets\/x{20}/);
            assert.match(out.error, /4 byte\(s\) over the 255-BYTE filename limit/);
            assert.match(out.error, /shorten the asset name/);
            assert.doesNotMatch(out.error, /Cannot read existing/);
            assert.doesNotMatch(out.error, /check what is at that path|carries the uuid/);
            assert.match(out.error, /Nothing was written\.$/);

            // same class, same answer: a path component that is a file, not a directory
            fs.writeFileSync(path.join(dir, 'notadir'), 'x');
            const nested = resolveAssetMeta(path.join(dir, 'notadir', 'x.prefab.meta'),
                'assets/notadir/x.prefab', mint);
            assert.strictEqual(nested.uuid, null);
            assert.match(nested.error,
                /^No \.meta can exist next to assets\/notadir\/x\.prefab: that path cannot hold a file \(ENOTDIR\)/);
        });

        it('leaves the offending meta on disk for the user to fix', () => {
            const metaPath = path.join(dir, 'untouched.prefab.meta');
            fs.writeFileSync(metaPath, '{}');
            resolveAssetMeta(metaPath, 'assets/untouched.prefab', mint);
            assert.strictEqual(fs.readFileSync(metaPath, 'utf-8'), '{}');
        });
    });

    it('should not treat sibling "assets-backup" dirs as inside assets root', () => {
        const backup = path.join(root, 'assets-backup');
        fs.mkdirSync(backup, { recursive: true });
        const file = path.join(backup, 'stray.ts');
        fs.writeFileSync(file, 'export {}');
        assert.deepStrictEqual(ensureParentDirMetas(file, assets), []);
        assert.ok(!fs.existsSync(`${backup}.meta`));
    });
});

/** length(4) + type(4) + data + crc(4, fake — the parser never checks it) */
function pngChunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
}

/** Minimal PNG: signature + IHDR (2×3, given colorType) + given chunks */
function makePng(colorType, chunks) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(2, 0); // width
    ihdr.writeUInt32BE(3, 4); // height
    ihdr[8] = 8;              // bit depth
    ihdr[9] = colorType;
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    return Buffer.concat([sig, pngChunk('IHDR', ihdr), ...chunks]);
}
