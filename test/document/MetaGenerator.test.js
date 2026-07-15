import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    createMetaObject, writeMetaFile, ensureParentDirMetas, serializeMeta,
    classifyAsset, prefabMeta, animGraphMeta, readImageSize, MetaGenerationError
} from '../../src/document/MetaGenerator.js';

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

    it('should create metas for the parent folder chain, excluding assets root', () => {
        const file = path.join(assets, 'Scripts', 'Core', 'Spin.ts');
        const created = ensureParentDirMetas(file, assets);
        const dirs = created.map(c => path.relative(assets, c.dir));
        assert.deepStrictEqual(dirs, ['Scripts', 'Scripts/Core']);
        assert.ok(fs.existsSync(path.join(assets, 'Scripts.meta')));
        assert.ok(fs.existsSync(path.join(assets, 'Scripts', 'Core.meta')));
        assert.ok(!fs.existsSync(`${assets}.meta`));
        assert.strictEqual(created[0].meta.importer, 'directory');
        // second run: nothing new
        assert.deepStrictEqual(ensureParentDirMetas(file, assets), []);
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

    it('should read PNG/JPEG sizes and return null otherwise', () => {
        assert.deepStrictEqual(readImageSize(PNG_1x1, '.png'), { width: 1, height: 1, hasAlpha: true });
        assert.deepStrictEqual(readImageSize(makeJpeg(), '.jpg'), { width: 32, height: 16, hasAlpha: false });
        assert.strictEqual(readImageSize(Buffer.from('junk'), '.tga'), null);
        assert.strictEqual(readImageSize(Buffer.from('junk'), '.png'), null);
    });
});
