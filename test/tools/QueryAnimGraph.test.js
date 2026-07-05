/**
 * query_animgraph tool tests — path/UUID resolution and both output formats
 * run against a graph built into a temp copy of the mock project (clip names
 * resolve through the same AssetIndex the tool uses).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { QueryAnimGraph } from '../../src/tools/QueryAnimGraph.js';
import { BuildAnimGraph } from '../../src/tools/BuildAnimGraph.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_PROJECT = join(__dirname, '..', 'fixtures', 'mock-project');
const GOLDEN_GRAPH = join(__dirname, '..', 'fixtures', 'golden', 'Player.animgraph');

const SPEC = {
    variables: { Speed: { type: 'float' }, Flip: { type: 'trigger' } },
    states: [
        { name: 'Idle', clip: 'assets/Models/Coin.fbx@c0001' },
        { name: 'Spin', clip: 'assets/Models/Coin.fbx@c0002', speed: 1.5 }
    ],
    transitions: [
        { from: 'Entry', to: 'Idle' },
        { from: 'Idle', to: 'Spin', when: 'Speed > 0.5', duration: 0.25 },
        { from: 'Any', to: 'Idle', trigger: 'Flip', duration: 0.1 }
    ]
};

describe('QueryAnimGraph + BuildAnimGraph tools', () => {
    let project;

    before(async () => {
        project = fs.mkdtempSync(join(os.tmpdir(), 'cocos-animgraph-'));
        fs.cpSync(MOCK_PROJECT, project, { recursive: true });
        const result = await new BuildAnimGraph().run(
            { outputPath: 'assets/Anims/Coin.animgraph', spec: SPEC }, project
        );
        assert.ok(!result.isError, result.content[0].text);
    });

    after(() => {
        fs.rmSync(project, { recursive: true, force: true });
    });

    it('build_animgraph writes graph + meta and reports the summary', async () => {
        assert.ok(fs.existsSync(join(project, 'assets/Anims/Coin.animgraph')));
        const meta = JSON.parse(fs.readFileSync(join(project, 'assets/Anims/Coin.animgraph.meta'), 'utf-8'));
        assert.strictEqual(meta.importer, 'animation-graph');
    });

    it('build_animgraph refuses to overwrite without overwrite: true, keeps UUID with it', async () => {
        const tool = new BuildAnimGraph();
        const refused = await tool.run({ outputPath: 'assets/Anims/Coin.animgraph', spec: SPEC }, project);
        assert.strictEqual(refused.isError, true);
        assert.match(refused.content[0].text, /overwrite: true/);

        const before = JSON.parse(fs.readFileSync(join(project, 'assets/Anims/Coin.animgraph.meta'), 'utf-8')).uuid;
        const ok = await tool.run(
            { outputPath: 'assets/Anims/Coin.animgraph', spec: SPEC, overwrite: true }, project
        );
        assert.ok(!ok.isError);
        assert.match(ok.content[0].text, /existing \.meta kept/);
        const after = JSON.parse(fs.readFileSync(join(project, 'assets/Anims/Coin.animgraph.meta'), 'utf-8')).uuid;
        assert.strictEqual(after, before);
    });

    it('build_animgraph validates path and spec errors without writing', async () => {
        const tool = new BuildAnimGraph();
        const badExt = await tool.run({ outputPath: 'assets/Anims/x.prefab', spec: SPEC }, project);
        assert.match(badExt.content[0].text, /must end with \.animgraph/);

        const outside = await tool.run({ outputPath: 'settings/x.animgraph', spec: SPEC }, project);
        assert.match(outside.content[0].text, /inside the project's assets\//);

        const badSpec = await tool.run({
            outputPath: 'assets/Anims/bad.animgraph',
            spec: { states: [{ name: 'A', clip: 'assets/Nope.fbx' }] }
        }, project);
        assert.strictEqual(badSpec.isError, true);
        assert.match(badSpec.content[0].text, /clip asset not found.*Nothing was written/s);
        assert.ok(!fs.existsSync(join(project, 'assets/Anims/bad.animgraph')));
    });

    it('query_animgraph resolves by path and renders clips as names', async () => {
        const result = await new QueryAnimGraph().run(
            { graphPath: 'assets/Anims/Coin.animgraph' }, project
        );
        assert.ok(!result.isError, result.content[0].text);
        const text = result.content[0].text;
        assert.match(text, /# AnimGraph: Coin\.animgraph/);
        assert.match(text, /Speed: float = 0 \| Flip: trigger/);
        assert.match(text, /Idle \(clip Coin\.fbx@c0001\)/);
        assert.match(text, /Spin \(clip Coin\.fbx@c0002, speed 1\.5\)/);
        assert.match(text, /Entry → Idle/);
        assert.match(text, /Idle → Spin {2}\[Speed > 0\.5\] {2}dur 0\.25/);
        assert.match(text, /Any → Idle {2}\[trigger Flip\] {2}dur 0\.1/);
    });

    it('query_animgraph resolves by UUID and returns structured json', async () => {
        const uuid = JSON.parse(
            fs.readFileSync(join(project, 'assets/Anims/Coin.animgraph.meta'), 'utf-8')
        ).uuid;
        const result = await new QueryAnimGraph().run({ graphPath: uuid, format: 'json' }, project);
        assert.ok(!result.isError, result.content[0].text);
        const parsed = JSON.parse(result.content[0].text);
        assert.strictEqual(parsed.name, 'Coin.animgraph');
        assert.deepStrictEqual(parsed.variables.map(v => v.name), ['Speed', 'Flip']);
        assert.strictEqual(parsed.layers[0].states.length, 5); // Entry/Exit/Any + 2 motions
        assert.strictEqual(parsed.layers[0].transitions.length, 3);
    });

    it('query_animgraph accepts the filePath alias and reads files outside the index', async () => {
        const result = await new QueryAnimGraph().run({ filePath: GOLDEN_GRAPH }, MOCK_PROJECT);
        assert.ok(!result.isError, result.content[0].text);
        assert.match(result.content[0].text, /Jump → Idle {2}\[exit\]/);
    });

    it('query_animgraph errors helpfully on wrong asset kinds and misses', async () => {
        const notGraph = await new QueryAnimGraph().run(
            { graphPath: 'assets/Models/Coin.fbx' }, project
        );
        assert.strictEqual(notGraph.isError, true);
        assert.match(notGraph.content[0].text, /is a fbx asset, not an animation graph/);

        const missing = await new QueryAnimGraph().run({ graphPath: 'assets/Nope.animgraph' }, project);
        assert.strictEqual(missing.isError, true);
        assert.match(missing.content[0].text, /list_assets/);
    });
});
