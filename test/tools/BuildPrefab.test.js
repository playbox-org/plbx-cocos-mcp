/**
 * build_prefab tool tests — path containment and .meta/UUID resolution
 *
 * The spec-compilation side is covered by `test/document/PrefabBuilder.test.js` and the
 * end-to-end build by `test/tools/ApplyEdits.test.js`; what lives here is the write
 * layer's two safety rails, both of which build_terrain grew first:
 * a symlink under assets/ must not carry the write out of the project, and the reported
 * UUID must be one the editor will actually honour on import.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

import { BuildPrefab } from '../../src/tools/BuildPrefab.js';
import { AssetIndex } from '../../src/core/AssetIndex.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_PROJECT = path.resolve(__dirname, '../fixtures/mock-project');

describe('BuildPrefab tool', () => {
    const tool = new BuildPrefab();
    let root;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'build-prefab-'));
        // `test/tools/FindAssetReferences.test.js` writes and deletes a transient scene
        // inside this SHARED fixture while node:test runs the files in parallel — a
        // recursive copy that enumerates and then lstats it fails with ENOENT.
        fs.cpSync(MOCK_PROJECT, root, {
            recursive: true,
            filter: (src) => !path.basename(src).startsWith('__refs_test'),
        });
        AssetIndex.invalidate(root);
    });

    afterEach(() => {
        AssetIndex.invalidate(root);
        fs.rmSync(root, { recursive: true, force: true });
    });

    const build = (args) => tool.run(args, root);
    const text = (result) => result.content[0].text;

    it('writes a .prefab plus a .meta and reports the fresh UUID', async () => {
        const result = await build({ outputPath: 'assets/Prefabs/Box.prefab', spec: {} });
        assert.ok(!result.isError, text(result));

        const file = path.join(root, 'assets/Prefabs/Box.prefab');
        const meta = JSON.parse(fs.readFileSync(`${file}.meta`, 'utf-8'));
        assert.strictEqual(meta.importer, 'prefab');
        assert.match(text(result), new RegExp(`UUID: ${meta.uuid} \\(new \\.meta written\\)`));
    });

    it('rejects a bad output path', async () => {
        for (const [outputPath, re] of [
            ['assets/Prefabs/Box.json', /must end with \.prefab/],
            ['settings/Evil.prefab', /inside the project's assets\/ directory/],
        ]) {
            const result = await build({ outputPath, spec: {} });
            assert.ok(result.isError, outputPath);
            assert.match(text(result), re);
        }
    });

    // --- review regressions ------------------------------------------------

    // The containment check used to test the UNRESOLVED path, so `assets/ext -> /outside`
    // let the prefab (and the parent-folder metas) land outside the project entirely.
    it('refuses a symlink under assets/ that escapes the project', async () => {
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
        try {
            fs.symlinkSync(outside, path.join(root, 'assets', 'Linked'));
            const result = await build({ outputPath: 'assets/Linked/Evil.prefab', spec: {} });
            assert.strictEqual(result.isError, true);
            assert.match(text(result), /inside the project's assets\/ directory/);
            assert.deepStrictEqual(fs.readdirSync(outside), []);
        } finally {
            fs.rmSync(outside, { recursive: true, force: true });
        }
    });

    // Canonicalizing before the extension check let the LINK TARGET's name answer a
    // question about the caller's path: a symlink to an extensionless file was refused
    // as "must end with .prefab" instead of for escaping assets/.
    it('names the escape, not the extension, when the link target has none', async () => {
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
        try {
            fs.writeFileSync(path.join(outside, 'payload'), '');
            fs.symlinkSync(path.join(outside, 'payload'), path.join(root, 'assets', 'Linked.prefab'));
            const result = await build({ outputPath: 'assets/Linked.prefab', spec: {}, overwrite: true });
            assert.strictEqual(result.isError, true);
            assert.match(text(result), /inside the project's assets\/ directory/);
            assert.strictEqual(fs.readFileSync(path.join(outside, 'payload'), 'utf-8'), '');
        } finally {
            fs.rmSync(outside, { recursive: true, force: true });
        }
    });

    // Both sides of the containment test must be canonicalized the SAME way: `assets/` fell back to
    // the unresolved spelling when absent, so a symlinked root (macOS /tmp) refused a legal path.
    it('accepts a legal path in a symlinked project that has no assets/ yet', async () => {
        const real = fs.mkdtempSync(path.join(os.tmpdir(), 'real-project-'));
        const linkHome = fs.mkdtempSync(path.join(os.tmpdir(), 'link-home-'));
        const linked = path.join(linkHome, 'project');
        try {
            fs.symlinkSync(real, linked);
            assert.strictEqual(fs.existsSync(path.join(linked, 'assets')), false);

            const result = await tool.run({ outputPath: 'assets/UI/Btn.prefab', spec: {} }, linked);
            assert.ok(!result.isError, text(result));
            assert.strictEqual(fs.existsSync(path.join(real, 'assets/UI/Btn.prefab')), true);
            assert.strictEqual(fs.existsSync(path.join(real, 'assets/UI/Btn.prefab.meta')), true);
            // the folder metas the write creates land inside assets/ too
            assert.strictEqual(fs.existsSync(path.join(real, 'assets/UI.meta')), true);
        } finally {
            AssetIndex.invalidate(linked);
            fs.rmSync(linkHome, { recursive: true, force: true });
            fs.rmSync(real, { recursive: true, force: true });
        }
    });

    // An existing .meta that parses but carries no "uuid" used to print
    // "UUID: undefined (existing .meta kept)" and write the prefab anyway — the editor
    // mints its own uuid on import and every reference made against the printed one dies.
    it('refuses an existing .meta with no uuid, writing nothing', async () => {
        const metaPath = path.join(root, 'assets/Prefabs/NoUuid.prefab.meta');
        fs.writeFileSync(metaPath, JSON.stringify({ ver: '1.1.50', importer: 'prefab' }));

        const result = await build({
            outputPath: 'assets/Prefabs/NoUuid.prefab', spec: {}, overwrite: true,
        });
        assert.strictEqual(result.isError, true);
        assert.match(text(result), /has no "uuid"/);
        assert.match(text(result), /Nothing was written\./);
        assert.ok(!text(result).includes('undefined'));
        assert.strictEqual(fs.existsSync(path.join(root, 'assets/Prefabs/NoUuid.prefab')), false);
        // the unusable meta is left exactly as found, for the user to delete or fix
        assert.strictEqual(fs.readFileSync(metaPath, 'utf-8'),
            JSON.stringify({ ver: '1.1.50', importer: 'prefab' }));
    });

    it('aborts with nothing written when the existing meta is corrupt', async () => {
        const metaPath = path.join(root, 'assets/Prefabs/Broken.prefab.meta');
        fs.writeFileSync(metaPath, '{ this is not json');

        const result = await build({
            outputPath: 'assets/Prefabs/Broken.prefab', spec: {}, overwrite: true,
        });
        assert.strictEqual(result.isError, true);
        assert.match(text(result), /Cannot parse existing assets\/Prefabs\/Broken\.prefab\.meta/);
        assert.match(text(result), /Nothing was written\.$/);
        assert.strictEqual(fs.existsSync(path.join(root, 'assets/Prefabs/Broken.prefab')), false);
    });
});
