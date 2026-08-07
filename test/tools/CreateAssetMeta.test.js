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

    // A meta path whose state cannot be read at all was counted under "skipped (meta exists)" —
    // the one thing the report must never claim, since nothing is there and nothing was written.
    it('should count an unreadable meta path as refused, never as "meta exists"', async (t) => {
        const dir = path.join(assets, 'Locked');
        fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, 't.ts'), 'export {}');
        fs.chmodSync(dir, 0o444); // readable, NOT searchable — readdir works, lstat gives EACCES
        let result;
        try {
            try {
                fs.lstatSync(path.join(dir, 't.ts.meta'));
                return t.skip('mode 444 is still searchable here'); // root, or a mode-blind fs
            } catch (err) {
                if (err.code !== 'EACCES') return t.skip(`unexpected ${err.code}`);
            }
            result = await tool.execute({ path: 'assets/Locked' }, root);
        } finally {
            fs.chmodSync(dir, 0o755);
        }
        const text = result.content[0].text;
        assert.match(text, /1 created, 0 skipped \(meta exists\), 1 refused/, text);
        assert.match(text, /## Refused\n- \S*assets\/Locked\/t\.ts: Cannot tell whether Locked\/t\.ts\.meta exists: EACCES/);
        assert.strictEqual(fs.existsSync(path.join(dir, 't.ts.meta')), false,
            'the refused target has no meta — reporting it as skipped claimed one');
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

    // The assets root is the one path that is "inside assets/" without being BELOW it:
    // it gets no meta of its own, but everything under it does.
    it('should accept the assets root itself as the target', async () => {
        const result = await tool.execute({ path: 'assets' }, root);
        assert.ok(!result.isError, result.content[0].text);
        assert.ok(fs.existsSync(path.join(assets, 'Scripts', 'Gen', 'Spin.ts.meta')));
        assert.ok(!fs.existsSync(`${assets}.meta`));
    });

    // A sibling directory sharing the assets/ prefix must not pass as contained.
    it('should reject a sibling directory whose name starts with "assets"', async () => {
        const backup = path.join(root, 'assets-backup');
        fs.mkdirSync(backup);
        fs.writeFileSync(path.join(backup, 'stray.ts'), 'export {}');
        const result = await tool.execute({ path: 'assets-backup/stray.ts' }, root);
        assert.ok(result.isError);
        assert.match(result.content[0].text, /must be inside the project's assets\/ directory/);
        assert.ok(!fs.existsSync(path.join(backup, 'stray.ts.meta')));
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

        // The link at the `<asset>.meta` path is the other half: `writeMetaFile` gated on
        // `existsSync`, which FOLLOWS it — a dangling one answered "2 created, 0 refused", minted
        // a fresh uuid and the rename swapped the link away. resolveAssetMeta already refused it.
        it('refuses a symlinked .meta path instead of minting over the link', async () => {
            const dir = path.join(assets, 'Sym');
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'a.prefab'), '[]');
            fs.writeFileSync(path.join(dir, 'b.prefab'), '[]');
            const gone = path.join(root, 'nope-target.meta');
            fs.symlinkSync(gone, path.join(dir, 'a.prefab.meta')); // dangling

            const single = await tool.execute({ path: 'assets/Sym/a.prefab' }, root);
            assert.strictEqual(single.isError, true, single.content[0].text);
            assert.match(single.content[0].text, /a\.prefab\.meta is a symlink/);
            assert.strictEqual(fs.existsSync(gone), false, 'no .meta written through the link');
            assert.strictEqual(fs.lstatSync(path.join(dir, 'a.prefab.meta')).isSymbolicLink(), true,
                'the link is left exactly as found');

            // in a folder run it is that one target's problem: counted refused, the rest still land
            const walk = await tool.execute({ path: 'assets/Sym' }, root);
            const text = walk.content[0].text;
            assert.match(text, /1 refused/);
            // the reason names the FOLDER too, so "which a.prefab" needs no second call
            assert.match(text, /## Refused\n- \S*assets\/Sym\/a\.prefab: Sym\/a\.prefab\.meta is a symlink/);
            assert.ok(fs.existsSync(path.join(dir, 'b.prefab.meta')));
            assert.strictEqual(fs.existsSync(gone), false);
        });

        // The parent-folder chain ran OUTSIDE the per-target try/catch, so a refused folder meta
        // escaped execute(): the server turned it into a bare error and the per-target list, the
        // ## Refused section and every remaining target were lost with it.
        it('keeps the batch when a parent folder meta is refused', async () => {
            const dir = path.join(assets, 'Sym', 'Deep');
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'd.ts'), 'export {}');
            fs.writeFileSync(path.join(dir, 'e.json'), '{}');
            const gone = path.join(root, 'nope-target.meta');
            fs.symlinkSync(gone, path.join(assets, 'Sym', 'Deep.meta')); // dangling FOLDER meta

            const result = await tool.execute({ path: 'assets/Sym/Deep/e.json' }, root);
            assert.ok(!result.isError, result.content[0].text);
            const text = result.content[0].text;
            // the refusal is the folder's own entry, named as such
            assert.match(text, /1 refused/);
            assert.match(text, /## Refused\n- \S*assets\/Sym\/Deep: Sym\/Deep\.meta is a symlink/);
            // …and the named target still got its meta, plus the folder metas that DID land
            assert.ok(fs.existsSync(path.join(dir, 'e.json.meta')), 'the named target was written');
            assert.ok(fs.existsSync(path.join(assets, 'Sym.meta')), 'the chain above the refusal');
            assert.match(text, /2 created/);
            assert.strictEqual(fs.existsSync(gone), false, 'nothing written through the link');

            // a folder run refuses the same folder and still walks everything under it
            const walk = await tool.execute({ path: 'assets/Sym' }, root);
            assert.ok(!walk.isError, walk.content[0].text);
            assert.match(walk.content[0].text, /1 refused/);
            assert.ok(fs.existsSync(path.join(dir, 'd.ts.meta')));
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
