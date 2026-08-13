import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { GetAssetInfo } from '../../src/tools/GetAssetInfo.js';
import {
    defaultSentinel, materialize, writeTerrain, setBlockLayers
} from '../../src/utils/terrainBin.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT = join(__dirname, '../fixtures/mock-project');

/**
 * Disposable project holding a single `assets/Maps/Terrain.terrain` with the
 * mock project's meta (so path/uuid resolution works) and the given payload.
 * Deliberately NOT a copy of the shared mock project: other suites create and
 * delete files under it, which makes a recursive copy racy.
 */
function terrainOnlyProject(prefix, payload) {
    const root = fs.mkdtempSync(join(os.tmpdir(), prefix));
    fs.mkdirSync(join(root, 'assets', 'Maps'), { recursive: true });
    fs.copyFileSync(
        join(PROJECT, 'assets/Maps/Terrain.terrain.meta'),
        join(root, 'assets/Maps/Terrain.terrain.meta')
    );
    fs.writeFileSync(join(root, 'assets/Maps/Terrain.terrain'), payload);
    return root;
}

describe('GetAssetInfo tool', () => {
    const tool = new GetAssetInfo();

    it('should have correct metadata', () => {
        assert.strictEqual(tool.name, 'get_asset_info');
        assert.deepStrictEqual(tool.inputSchema.required, ['asset']);
    });

    it('should render sprite info as text', async () => {
        const result = await tool.execute({ asset: 'assets/Sprites/panel.png' }, PROJECT);
        assert.ok(!result.isError);
        const text = result.content[0].text;
        assert.ok(text.includes('SpriteFrame'));
        assert.ok(text.includes('128x128'));
        assert.ok(text.includes('SLICED'));
    });

    it('should render model info with mesh AABB', async () => {
        const result = await tool.execute({ asset: 'assets/Models/Rock.glb' }, PROJECT);
        const text = result.content[0].text;
        assert.ok(text.includes('Meshes (1)'));
        assert.ok(text.includes('1 x 2 x 1'));
        assert.ok(text.includes('[glb]'));
    });

    it('should render prefab summary', async () => {
        const result = await tool.execute({ asset: 'assets/Prefabs/Gold.prefab' }, PROJECT);
        const text = result.content[0].text;
        assert.ok(text.includes('Root: Gold'));
        assert.ok(text.includes('Nodes: 2'));
    });

    it('should accept UUID input and json format', async () => {
        const result = await tool.execute(
            { asset: '836478c3-ffde-4110-8347-cfda26288652', format: 'json' },
            PROJECT
        );
        const parsed = JSON.parse(result.content[0].text);
        assert.strictEqual(parsed.rootName, 'Gold');
    });

    it('should error for unknown assets', async () => {
        const result = await tool.execute({ asset: 'assets/Nope.png' }, PROJECT);
        assert.strictEqual(result.isError, true);
        assert.ok(result.content[0].text.includes('list_assets'));
    });

    it('should render the terrain card with resolved layer textures', async () => {
        const result = await tool.execute({ asset: 'assets/Maps/Terrain.terrain' }, PROJECT);
        assert.ok(!result.isError);
        const text = result.content[0].text;
        assert.ok(text.includes('## Terrain'));
        assert.ok(text.includes('Size: 32 x 32 m'));
        // a block is 32x32 tiles, not 32; weightMapSize is a per-SIDE texel count and is
        // spelled the same way query_terrain spells it; the mean carries its unit
        assert.ok(text.includes('Blocks: 1 x 1 of 32x32 tiles, tileSize 1 m'), text);
        assert.ok(text.includes('Vertex grid: 33 x 33'));
        assert.ok(text.includes('Weight map: 32 x 32 per block (32 x 32 texels total)'), text);
        assert.ok(text.includes('Height range: 0 .. 3 m (mean 0.9394 m)'), text);
        assert.ok(text.includes('## Terrain layers (2)'));
        assert.ok(text.includes('slot 0: coin_bar.png@6c48a'), text);
        assert.ok(/coverage 80\.8%/.test(text), text);
    });

    it('should render the terrain error line the generic formatter never prints', async () => {
        const tmp = terrainOnlyProject('cocos-asset-info-terrain-', 'garbage, not a terrain');
        try {
            const result = await tool.execute({ asset: 'assets/Maps/Terrain.terrain' }, tmp);
            assert.ok(!result.isError, 'an unreadable payload is still a valid asset card');
            const text = result.content[0].text;
            assert.ok(text.includes('## Terrain'));
            assert.match(text, /Error: Not a Cocos \.terrain binary/);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    it('should note an empty default (sentinel) terrain', async () => {
        const tmp = terrainOnlyProject('cocos-asset-info-sentinel-', defaultSentinel());
        try {
            const text = (await tool.execute({ asset: 'assets/Maps/Terrain.terrain' }, tmp))
                .content[0].text;
            assert.ok(text.includes('Note: empty default terrain'), text);
            assert.ok(text.includes('Height range: no height data'), text);
            assert.ok(text.includes('## Terrain layers (0)'), text);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    it('should keep the terrain block machine-readable in json format', async () => {
        const result = await tool.execute(
            { asset: 'assets/Maps/Terrain.terrain', format: 'json' }, PROJECT);
        const parsed = JSON.parse(result.content[0].text);
        assert.strictEqual(parsed.importer, 'terrain');
        assert.deepStrictEqual(parsed.terrain.blockCount, [1, 1]);
        assert.strictEqual(parsed.terrain.layers[1].detailMapName, 'panel.png@6c48a');
    });

    // This card printed one warning line per (layer, field) in its own wording: 32 lines here
    // against query_terrain's one aggregated line for the same file, and `warningEntries` — the
    // data view a consumer reads — held none of them.
    it('should aggregate unresolvable layer textures the way query_terrain does', async () => {
        const layers = Array.from({ length: 16 }, (_, i) => ({
            slot: i, tileSize: 1, roughness: 1, metallic: 0,
            detailMapId: `dead${String(i).padStart(4, '0')}-0000-4000-8000-000000000000@6c48a`,
            normalMapId: `beef${String(i).padStart(4, '0')}-0000-4000-8000-000000000000@6c48a`
        }));
        const bytes = writeTerrain(materialize({
            blockCount: [1, 1], tileSize: 1, weightMapSize: 4, lightMapSize: 4, layers
        }));
        const tmp = terrainOnlyProject('cocos-asset-info-dead-textures-', bytes);
        try {
            const text = (await tool.execute({ asset: 'assets/Maps/Terrain.terrain' }, tmp))
                .content[0].text;
            const section = text.slice(text.indexOf('## Terrain warnings'));
            const bullets = section.split('\n').filter(l => l.startsWith('- '));
            const unresolved = bullets.filter(l => /does not resolve to a project asset/.test(l));
            assert.strictEqual(unresolved.length, 1, section);
            assert.match(unresolved[0], /… and 31 more occurrences \(32 total\)$/);
            // The header counts what it prints — 32 unaggregated lines was ~6 KB of card
            assert.match(section, new RegExp(`^## Terrain warnings \\(${bullets.length}\\)$`, 'm'));
            assert.ok(section.length < 1500, `warnings section is ${section.length} chars`);

            const parsed = JSON.parse((await tool.execute(
                { asset: 'assets/Maps/Terrain.terrain', format: 'json' }, tmp)).content[0].text);
            const entry = parsed.terrain.warningEntries.find(e => e.kind === 'unresolvedTexture');
            assert.strictEqual(entry.count, 32);
            assert.deepStrictEqual(parsed.terrain.warnings,
                parsed.terrain.warningEntries.map(e => e.text));
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    // The line cap bounds the TEXT card; `format:"json"` serializes the card verbatim, and the
    // per-occurrence data behind an aggregated line is what the entry count does not bound: this
    // terrain's warning entries were 2052 subjects / ~270 KB of the response, the text 1371 chars.
    it('should bound the terrain warning data json carries, with exact counts', async () => {
        const data = materialize({
            blockCount: [32, 32], tileSize: 1, weightMapSize: 4, lightMapSize: 4,
            layers: [
                { slot: 0, tileSize: 1, roughness: 1, metallic: 0, detailMapId: 'abc@6c48a' },
                { slot: 1, tileSize: 1, roughness: 1, metallic: 0, detailMapId: 'def@6c48a' }
            ]
        });
        // a hole in channels 0 and 2 of every one of the 1024 blocks: 2048 occurrences, 1 family
        for (let by = 0; by < 32; by++) {
            for (let bx = 0; bx < 32; bx++) setBlockLayers(data, bx, by, [-1, 0, -1, 1]);
        }
        const tmp = terrainOnlyProject('cocos-asset-info-warning-data-', writeTerrain(data));
        try {
            const parsed = JSON.parse((await tool.execute(
                { asset: 'assets/Maps/Terrain.terrain', format: 'json' }, tmp)).content[0].text);
            const entry = parsed.terrain.warningEntries.find(e => e.kind === 'emptyChannel');
            assert.strictEqual(entry.count, 2048, 'the count stays exact');
            assert.ok(entry.subjects.length <= 16, `${entry.subjects.length} subjects retained`);
            assert.match(entry.text, /… and 2047 more occurrences \(2048 total\)$/);
            const size = JSON.stringify(parsed.terrain.warningEntries, null, 2).length;
            assert.ok(size < 8000, `${size} characters of warning data`);
            // the tool's own cross-file finding rides the same cap, in the same list
            assert.ok(parsed.terrain.warningEntries.some(e => e.kind === 'unresolvedTexture'));
            assert.deepStrictEqual(parsed.terrain.warnings,
                parsed.terrain.warningEntries.map(e => e.text));
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    // Nine distinct problems, so the shared cap bites: eight bullets, the ninth a continuation
    // line in the shared spelling, and the header still counting real problems.
    it('should cap the printed terrain warnings at eight and elide the rest', async () => {
        const dead = (n) => `dead${n}-0000-4000-8000-000000000000@6c48a`;
        const data = materialize({
            blockCount: [1, 1], tileSize: 1, weightMapSize: 4, lightMapSize: 4,
            layers: [
                { slot: 0, tileSize: 1, roughness: 1, metallic: 0, detailMapId: dead('0000'), normalMapId: dead('0001') },
                { slot: 1, tileSize: 1, roughness: 1, metallic: 0, detailMapId: '', normalMapId: '' },
                { slot: 2, tileSize: 1, roughness: 1, metallic: 0, detailMapId: '35b97cf8-601e-4835-8a3e-0d29568af652@6c48a', normalMapId: '' },
                { slot: 3, tileSize: 1, roughness: 1, metallic: 0, detailMapId: dead('0002'), normalMapId: dead('0003') }
            ]
        });
        // A hole below a used channel, plus a palette slot no layer backs
        setBlockLayers(data, 0, 0, [0, -1, 2, 5]);
        const bytes = Buffer.from(writeTerrain(data));
        bytes.writeDoubleLE(1.234, 4); // a tileSize the loader's snap changes
        for (const n of ['0002', '0003']) bytes[bytes.indexOf(dead(n))] = 0x80; // unreadable ids
        const tmp = terrainOnlyProject('cocos-asset-info-many-warnings-', bytes);
        try {
            const text = (await tool.execute({ asset: 'assets/Maps/Terrain.terrain' }, tmp))
                .content[0].text;
            const section = text.slice(text.indexOf('## Terrain warnings'));
            assert.match(section, /^## Terrain warnings \(9\)$/m);
            assert.strictEqual(section.split('\n').filter(l => l.startsWith('- ')).length, 8);
            assert.match(section, /^… and 1 more warning \(9 total\)$/m);

            // The elided one is data, not a lost finding
            const parsed = JSON.parse((await tool.execute(
                { asset: 'assets/Maps/Terrain.terrain', format: 'json' }, tmp)).content[0].text);
            assert.strictEqual(parsed.terrain.warnings.length, 9);
            assert.match(parsed.terrain.warnings[8], /does not resolve to a project asset/);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    it('should flag files on disk the editor has not imported', async () => {
        const tmp = fs.mkdtempSync(join(os.tmpdir(), 'cocos-asset-info-'));
        try {
            fs.cpSync(PROJECT, tmp, { recursive: true });
            fs.writeFileSync(join(tmp, 'assets/Scripts/NotImported.ts'), 'export {}\n');

            const result = await tool.execute({ asset: 'assets/Scripts/NotImported.ts' }, tmp);
            assert.strictEqual(result.isError, true);
            const text = result.content[0].text;
            assert.ok(text.includes('no .meta'));
            assert.ok(text.includes('create_asset_meta'));
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });
});
