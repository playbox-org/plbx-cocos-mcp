import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CreateAssetMeta } from '../../src/tools/CreateAssetMeta.js';

const PNG_1x1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64');

describe('CreateAssetMeta tool', () => {
    const tool = new CreateAssetMeta();
    let root;
    let assets;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'create-meta-'));
        assets = path.join(root, 'assets');
        fs.mkdirSync(path.join(assets, 'Scripts', 'Gen'), { recursive: true });
        fs.writeFileSync(path.join(assets, 'Scripts', 'Gen', 'Spin.ts'), 'export class Spin {}');
        fs.writeFileSync(path.join(assets, 'Scripts', 'Gen', 'Turn.ts'), 'export class Turn {}');
        fs.writeFileSync(path.join(assets, 'Scripts', 'Gen', 'icon.png'), PNG_1x1);
        fs.writeFileSync(path.join(assets, 'Scripts', 'Gen', 'Model.fbx'), 'binary');
        fs.writeFileSync(path.join(root, 'outside.ts'), 'export {}');
    });

    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    it('should have correct metadata', () => {
        assert.strictEqual(tool.name, 'create_asset_meta');
        assert.deepStrictEqual(tool.inputSchema.required, ['path']);
        assert.strictEqual(tool.aliases.assetPath, 'path');
    });

    it('should create a meta for a single file plus its folder chain', async () => {
        const result = await tool.execute({ path: 'assets/Scripts/Gen/Spin.ts' }, root);
        assert.ok(!result.isError, result.content[0].text);
        const text = result.content[0].text;
        assert.match(text, /3 created/);
        assert.ok(fs.existsSync(path.join(assets, 'Scripts.meta')));
        assert.ok(fs.existsSync(path.join(assets, 'Scripts', 'Gen.meta')));
        const meta = JSON.parse(fs.readFileSync(path.join(assets, 'Scripts', 'Gen', 'Spin.ts.meta'), 'utf-8'));
        assert.strictEqual(meta.importer, 'typescript');
        assert.ok(!fs.existsSync(`${assets}.meta`)); // assets root itself has no meta
    });

    it('should resolve paths given relative to assets/', async () => {
        const result = await tool.execute({ path: 'Scripts/Gen/Spin.ts' }, root);
        assert.ok(!result.isError);
        assert.ok(fs.existsSync(path.join(assets, 'Scripts', 'Gen', 'Spin.ts.meta')));
    });

    it('should walk folders recursively, skipping existing metas and refusing models', async () => {
        const first = await tool.execute({ path: 'assets/Scripts' }, root);
        assert.ok(!first.isError);
        const text = first.content[0].text;
        // Scripts, Gen, Spin.ts, Turn.ts, icon.png — model refused
        assert.match(text, /5 created/);
        assert.match(text, /1 refused/);
        assert.match(text, /Model\.fbx/);
        assert.ok(fs.existsSync(path.join(assets, 'Scripts', 'Gen', 'icon.png.meta')));
        assert.ok(!fs.existsSync(path.join(assets, 'Scripts', 'Gen', 'Model.fbx.meta')));

        const again = await tool.execute({ path: 'assets/Scripts' }, root);
        assert.match(again.content[0].text, /0 created, 5 skipped/);
    });

    it('should only meta the folder itself when recursive: false', async () => {
        const result = await tool.execute({ path: 'assets/Scripts/Gen', recursive: false }, root);
        assert.ok(!result.isError);
        assert.ok(fs.existsSync(path.join(assets, 'Scripts', 'Gen.meta')));
        assert.ok(!fs.existsSync(path.join(assets, 'Scripts', 'Gen', 'Spin.ts.meta')));
    });

    it('should honor imageType sprite-frame', async () => {
        const result = await tool.execute(
            { path: 'assets/Scripts/Gen/icon.png', imageType: 'sprite-frame' }, root);
        assert.ok(!result.isError);
        const meta = JSON.parse(fs.readFileSync(path.join(assets, 'Scripts', 'Gen', 'icon.png.meta'), 'utf-8'));
        assert.strictEqual(meta.userData.type, 'sprite-frame');
        assert.ok(meta.subMetas.f9941);
    });

    it('should error for a single model file', async () => {
        const result = await tool.execute({ path: 'assets/Scripts/Gen/Model.fbx' }, root);
        assert.ok(result.isError);
        assert.match(result.content[0].text, /editor/);
    });

    it('should reject paths outside assets/', async () => {
        const result = await tool.execute({ path: 'outside.ts' }, root);
        assert.ok(result.isError);
        assert.match(result.content[0].text, /assets\//);
    });

    it('should error on a missing path', async () => {
        const result = await tool.execute({ path: 'assets/Nope.ts' }, root);
        assert.ok(result.isError);
    });

    // Blocker 1: the containment check runs on the RESOLVED path and the walk
    // never follows a symlink — otherwise a link under assets/ pointing outside
    // the project let .meta files be written anywhere it led.
    describe('symlink containment (review — blocker 1)', () => {
        it('refuses a symlink whose target escapes the project, writing no .meta there', async () => {
            const victim = fs.mkdtempSync(path.join(os.tmpdir(), 'victim-'));
            try {
                fs.writeFileSync(path.join(victim, 'secret.ts'), 'export {}');
                fs.symlinkSync(victim, path.join(assets, 'escape'), 'dir');

                const result = await tool.execute({ path: 'assets/escape' }, root);
                assert.ok(result.isError, 'must reject the escaping symlink');
                assert.match(result.content[0].text, /assets\//);
                // Nothing written into the target directory
                assert.deepStrictEqual(fs.readdirSync(victim).sort(), ['secret.ts']);
            } finally {
                fs.rmSync(victim, { recursive: true, force: true });
            }
        });

        it('skips a symlink during a recursive walk (broken link does not abort the run)', async () => {
            const dir = path.join(assets, 'Sub');
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'ok.ts'), 'export {}');
            fs.symlinkSync(path.join(dir, 'nowhere.ts'), path.join(dir, 'dead.ts')); // broken

            const result = await tool.execute({ path: 'assets/Sub' }, root);
            assert.ok(!result.isError, result.content[0].text);
            assert.ok(fs.existsSync(path.join(dir, 'ok.ts.meta')));
            assert.ok(!fs.existsSync(path.join(dir, 'dead.ts.meta')));
        });

        it('does not follow a symlink to a file inside assets/ (no duplicate meta)', async () => {
            const dir = path.join(assets, 'Sub2');
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'real.ts'), 'export {}');
            fs.symlinkSync(path.join(dir, 'real.ts'), path.join(dir, 'alias.ts'));

            const result = await tool.execute({ path: 'assets/Sub2' }, root);
            assert.ok(!result.isError, result.content[0].text);
            assert.ok(fs.existsSync(path.join(dir, 'real.ts.meta')));
            assert.ok(!fs.existsSync(path.join(dir, 'alias.ts.meta')));
        });
    });
});
