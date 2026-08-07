/**
 * build_animgraph tool tests — path containment and .meta/UUID resolution
 *
 * The compilation side is covered by `test/document/AnimGraphBuilder.test.js` and the
 * end-to-end build/read round trip by `test/tools/QueryAnimGraph.test.js`; what lives here
 * is the write layer's two safety rails, both of which build_terrain grew first:
 * a symlink under assets/ must not carry the write out of the project, and the reported
 * UUID must be one the editor will actually honour on import.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

import { BuildAnimGraph } from '../../src/tools/BuildAnimGraph.js';
import { AssetIndex } from '../../src/core/AssetIndex.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_PROJECT = path.resolve(__dirname, '../fixtures/mock-project');

const SPEC = {
    variables: { Speed: { type: 'float', value: 0 } },
    states: [{ name: 'Idle', clip: 'assets/Models/Coin.fbx@c0001' }],
    transitions: [{ from: 'Entry', to: 'Idle' }],
};

describe('BuildAnimGraph tool', () => {
    const tool = new BuildAnimGraph();
    let root;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'build-animgraph-'));
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

    it('writes a .animgraph plus a .meta and reports the fresh UUID', async () => {
        const result = await build({ outputPath: 'assets/Anims/Walk.animgraph', spec: SPEC });
        assert.ok(!result.isError, text(result));

        const file = path.join(root, 'assets/Anims/Walk.animgraph');
        const meta = JSON.parse(fs.readFileSync(`${file}.meta`, 'utf-8'));
        assert.strictEqual(meta.importer, 'animation-graph');
        assert.match(text(result), new RegExp(`UUID: ${meta.uuid} \\(new \\.meta written\\)`));
    });

    // --- review regressions ------------------------------------------------

    // The containment check used to test the UNRESOLVED path, so `assets/ext -> /outside`
    // let the graph (and the parent-folder metas) land outside the project entirely.
    it('refuses a symlink under assets/ that escapes the project', async () => {
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
        try {
            fs.symlinkSync(outside, path.join(root, 'assets', 'Linked'));
            const result = await build({ outputPath: 'assets/Linked/Evil.animgraph', spec: SPEC });
            assert.strictEqual(result.isError, true);
            assert.match(text(result), /inside the project's assets\/ directory/);
            assert.deepStrictEqual(fs.readdirSync(outside), []);
        } finally {
            fs.rmSync(outside, { recursive: true, force: true });
        }
    });

    // An existing .meta that parses but carries no "uuid" used to print
    // "UUID: undefined (existing .meta kept)" and write the graph anyway — the editor
    // mints its own uuid on import and every reference made against the printed one dies.
    it('refuses an existing .meta with no uuid, writing nothing', async () => {
        const metaPath = path.join(root, 'assets/Anims/NoUuid.animgraph.meta');
        fs.writeFileSync(metaPath, JSON.stringify({ ver: '1.2.0', importer: 'animation-graph' }));

        const result = await build({
            outputPath: 'assets/Anims/NoUuid.animgraph', spec: SPEC, overwrite: true,
        });
        assert.strictEqual(result.isError, true);
        assert.match(text(result), /has no "uuid"/);
        assert.match(text(result), /Nothing was written\./);
        assert.ok(!text(result).includes('undefined'));
        assert.strictEqual(fs.existsSync(path.join(root, 'assets/Anims/NoUuid.animgraph')), false);
        // the unusable meta is left exactly as found, for the user to delete or fix
        assert.strictEqual(fs.readFileSync(metaPath, 'utf-8'),
            JSON.stringify({ ver: '1.2.0', importer: 'animation-graph' }));
    });

    // `ensureParentDirMetas` refuses a symlinked FOLDER meta, and it ran AFTER doc.save() and
    // OUTSIDE any try: the tool answered "Error: New.meta is a symlink…" while the graph AND its
    // .meta were already on disk with no UUID reported. build_terrain's rollback is the reference.
    it('rolls the graph back when a parent folder meta is refused', async () => {
        const gone = path.join(root, 'nope-target.meta');
        fs.symlinkSync(gone, path.join(root, 'assets', 'New.meta')); // dangling folder meta

        const result = await build({ outputPath: 'assets/New/G.animgraph', spec: SPEC });
        assert.strictEqual(result.isError, true);
        // the refusal names the FOLDER, not a bare "New.meta"
        assert.match(text(result), /assets\/New\.meta is a symlink/);
        assert.match(text(result), /Nothing was written\.$/);
        assert.strictEqual(fs.existsSync(path.join(root, 'assets/New/G.animgraph')), false);
        assert.strictEqual(fs.existsSync(path.join(root, 'assets/New/G.animgraph.meta')), false);
        assert.strictEqual(fs.existsSync(path.join(root, 'assets/New')), false,
            'the directory this call created must go with it');
        assert.strictEqual(fs.existsSync(gone), false, 'nothing written through the link');
        assert.strictEqual(fs.lstatSync(path.join(root, 'assets', 'New.meta')).isSymbolicLink(), true,
            'the link is left exactly as found');
    });

    // An overwrite cannot be rolled back by unlinking, so the previous file is moved ASIDE first.
    it('restores the previous graph when a later step fails', async () => {
        const victim = path.join(root, 'assets/Anims/Keep.animgraph');
        await build({ outputPath: 'assets/Anims/Keep.animgraph', spec: SPEC });
        const before = fs.readFileSync(victim, 'utf-8');
        // remove the folder meta and make assets/ read-only: writing assets/Anims.meta now fails
        fs.rmSync(path.join(root, 'assets/Anims.meta'));
        fs.chmodSync(path.join(root, 'assets'), 0o555);
        let result;
        try {
            result = await build({
                outputPath: 'assets/Anims/Keep.animgraph',
                spec: { ...SPEC, states: [{ name: 'Run', clip: 'assets/Models/Coin.fbx@c0001' }],
                    transitions: [{ from: 'Entry', to: 'Run' }] },
                overwrite: true,
            });
        } finally {
            fs.chmodSync(path.join(root, 'assets'), 0o755);
        }
        assert.strictEqual(result.isError, true);
        assert.match(text(result), /Nothing was written\.$/);
        assert.strictEqual(fs.readFileSync(victim, 'utf-8'), before,
            'the previous graph must be back in place, byte for byte');
        assert.deepStrictEqual(
            fs.readdirSync(path.join(root, 'assets/Anims')).filter(f => f.includes('.tmp-')), [],
            'no aside copy left behind');
    });

    it('aborts with nothing written when the existing meta is corrupt', async () => {
        const metaPath = path.join(root, 'assets/Anims/Broken.animgraph.meta');
        fs.writeFileSync(metaPath, '{ this is not json');

        const result = await build({
            outputPath: 'assets/Anims/Broken.animgraph', spec: SPEC, overwrite: true,
        });
        assert.strictEqual(result.isError, true);
        assert.match(text(result), /Cannot parse existing assets\/Anims\/Broken\.animgraph\.meta/);
        assert.match(text(result), /Nothing was written\.$/);
        assert.strictEqual(fs.existsSync(path.join(root, 'assets/Anims/Broken.animgraph')), false);
    });
});
