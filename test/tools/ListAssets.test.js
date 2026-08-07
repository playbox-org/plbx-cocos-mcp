import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { ListAssets } from '../../src/tools/ListAssets.js';
import { AssetIndex } from '../../src/core/AssetIndex.js';
import { compressUuid } from '../../src/utils/uuid.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT = join(__dirname, '../fixtures/mock-project');

/** Throwaway project: {relative asset path → importer}, one .meta per file */
function makeProject(assets) {
    const root = fs.mkdtempSync(join(os.tmpdir(), 'cocos-list-assets-'));
    let n = 0;
    for (const [rel, importer] of Object.entries(assets)) {
        const file = join(root, rel);
        fs.mkdirSync(dirname(file), { recursive: true });
        fs.writeFileSync(file, '{}');
        const uuid = `aaaaaaaa-0000-4000-8000-${String(++n).padStart(12, '0')}`;
        fs.writeFileSync(`${file}.meta`, JSON.stringify({ ver: '1.1.50', importer, uuid }));
    }
    return root;
}

describe('ListAssets tool', () => {
    const tool = new ListAssets();

    it('should have correct metadata', () => {
        assert.strictEqual(tool.name, 'list_assets');
        assert.ok(tool.description.includes('sprite'));
    });

    it('should list all assets without filters', async () => {
        const result = await tool.execute({}, PROJECT);
        assert.ok(!result.isError);
        const text = result.content[0].text;
        assert.ok(text.includes('Gold.prefab'));
        assert.ok(text.includes('Coin.fbx'));
        // uuid is opt-in now: paths resolve wherever a uuid does
        assert.ok(!text.includes('836478c3-ffde-4110-8347-cfda26288652'));
        assert.ok(text.includes('uuid omitted'));
    });

    it('should include the uuid in the requested form', async () => {
        const full = await tool.execute({ pattern: 'Gold*', uuid: 'full' }, PROJECT);
        assert.ok(full.content[0].text.includes('836478c3-ffde-4110-8347-cfda26288652'));

        const compressed = await tool.execute({ pattern: 'Gold*', uuid: 'compressed' }, PROJECT);
        const text = compressed.content[0].text;
        assert.ok(!text.includes('836478c3-ffde-4110-8347-cfda26288652'));
        assert.ok(text.includes(compressUuid('836478c3-ffde-4110-8347-cfda26288652')));
    });

    // 2.0 moved the DEFAULT, not the shape: this was the pre-2.0 default output, and the
    // assertion below is the one the default-shape change deleted, re-pointed at it.
    it('still serves the pre-2.0 row shape for format:"flat", uuid:"full"', async () => {
        const text = (await tool.execute({ format: 'flat', uuid: 'full' }, PROJECT)).content[0].text;
        const total = Number(text.match(/# Assets \((\d+)\)/)[1]);
        const rows = text.match(/^- .*$/gm) ?? [];
        assert.strictEqual(rows.length, total, 'one row per asset');
        const shape = /^- assets\/\S+ \[[\w-]+\] [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
        for (const row of rows) assert.match(row, shape);
        assert.ok(text.includes('- assets/Prefabs/Gold.prefab [prefab] 836478c3-ffde-4110-8347-cfda26288652'));
        assert.ok(!text.includes('uuid omitted'));
    });

    // The schema is published to the client, so a `default` it does not apply is a wrong answer
    // nobody can check against the code: the uuid default is per FORMAT, and the description is
    // the only place that can say so.
    it('applies exactly the per-format uuid default its schema publishes', async () => {
        const schema = tool.inputSchema.properties.uuid;
        assert.ok(!('default' in schema), 'one default cannot be true for every format');

        for (const format of ['grouped', 'flat', 'text']) {
            const declared = schema.description.match(new RegExp(`${format}='(none|compressed|full)'`))?.[1];
            assert.ok(declared, `the schema must state the default for format:"${format}"`);
            const implicit = (await tool.execute({ format }, PROJECT)).content[0].text;
            const spelledOut = (await tool.execute({ format, uuid: declared }, PROJECT)).content[0].text;
            assert.strictEqual(implicit, spelledOut, `format:"${format}" ignores its declared default`);
            // and the other two forms really do render differently, so the equality above bites
            for (const other of ['none', 'compressed', 'full'].filter(v => v !== declared)) {
                assert.notStrictEqual((await tool.execute({ format, uuid: other }, PROJECT)).content[0].text,
                    implicit, `format:"${format}" uuid:"${other}" must differ from the default`);
            }
        }
    });

    // The per-format table is keyed by a caller-supplied value, so it carries `__proto__: null`
    // like every other such table here; the enum is what keeps a prototype name from reaching it.
    it('rejects an Object.prototype name as a format', async () => {
        for (const format of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
            const result = await tool.run({ format }, PROJECT);
            assert.ok(result.isError, format);
            assert.match(result.content[0].text,
                /parameter "format" must be one of .*"grouped"/);
        }
    });

    // the 2.0 default, pinned: a caller passing no format gets grouped rows and no uuid
    it('defaults to the grouped, uuid-less shape and states the omission', async () => {
        const text = (await tool.execute({}, PROJECT)).content[0].text;
        const total = Number(text.match(/# Assets \((\d+)\)/)[1]);
        const rows = text.match(/^ {2}\S.*$/gm) ?? [];
        assert.strictEqual(rows.length, total, 'one indented row per asset under a folder header');
        assert.ok(rows.every(r => !r.includes('/')), 'a grouped row carries the leaf name, not the path');
        assert.doesNotMatch(text, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
        assert.match(text, /^uuid omitted — /m);
        // spelling the default out must be the same call
        const explicit = await tool.execute({ format: 'grouped', uuid: 'none' }, PROJECT);
        assert.strictEqual(explicit.content[0].text, text);
    });

    it('should filter by type and folder', async () => {
        const result = await tool.execute({ type: 'model', folder: 'Models' }, PROJECT);
        const text = result.content[0].text;
        assert.ok(text.includes('# Assets (3)'));
        assert.ok(text.includes('Rock.glb'));
        assert.ok(!text.includes('Gold.prefab'));
    });

    it('should report empty result gracefully', async () => {
        const result = await tool.execute({ pattern: 'zzz*' }, PROJECT);
        assert.ok(!result.isError);
        assert.ok(result.content[0].text.includes('No assets match'));
    });

    it('should explain which filter emptied the result', async () => {
        const result = await tool.execute({ type: 'prefab', pattern: 'zzz*' }, PROJECT);
        assert.ok(!result.isError);
        const text = result.content[0].text;
        assert.ok(text.includes('no filters:'));
        assert.match(text, /\+ type="prefab": [1-9]/);
        assert.ok(text.includes('+ pattern="zzz*": 0'));
        assert.ok(text.includes('file name'));
    });

    it('should find assets by bare substring pattern', async () => {
        const result = await tool.execute({ pattern: 'old' }, PROJECT);
        assert.ok(!result.isError);
        assert.ok(result.content[0].text.includes('Gold.prefab'));
    });

    it('should reject unknown asset types listing the valid ones', async () => {
        const result = await tool.execute({ type: 'bogusType' }, PROJECT);
        assert.strictEqual(result.isError, true);
        const text = result.content[0].text;
        assert.ok(text.includes('Known types:'));
        assert.ok(text.includes('sprite'));
        assert.ok(text.includes('Importers in this project:'));
    });

    it('should accept spriteFrame as a type alias', async () => {
        const result = await tool.execute({ type: 'spriteFrame' }, PROJECT);
        assert.ok(!result.isError);
        assert.ok(result.content[0].text.includes('panel.png'));
    });

    it('should render json format', async () => {
        const result = await tool.execute({ type: 'sprite', format: 'json' }, PROJECT);
        const parsed = JSON.parse(result.content[0].text);
        assert.ok(parsed.total >= 1);
        assert.ok(parsed.items.every(i => i.uuid && i.path));
    });

    it('should accept query as an alias for pattern via run()', async () => {
        const aliased = await tool.run({ query: 'Coin*' }, PROJECT);
        const canonical = await tool.execute({ pattern: 'Coin*' }, PROJECT);
        assert.ok(!aliased.isError);
        assert.strictEqual(aliased.content[0].text, canonical.content[0].text);
    });

    // Drift guard: the two enumerations in this file are hand-maintained, so a new
    // AssetIndex type is invisible to the LLM until they are updated. `terrain` was
    // added to TYPE_ALIASES (and query_terrain's not-found error points here) while
    // both lists still stopped at "animation"; effect/directory had drifted earlier.
    it('advertises every friendly AssetIndex type in both enumerations', () => {
        const typeDescription = tool.inputSchema.properties.type.description;
        // synonyms of a listed type (spriteframe/texture of sprite, mesh of model) do
        // not need their own mention; every other alias key does
        const synonyms = new Set(['spriteframe', 'texture', 'mesh']);
        const advertised = AssetIndex.knownTypes.filter(t => !synonyms.has(t));
        assert.ok(advertised.includes('terrain'), 'terrain is no longer a known type');
        for (const type of advertised) {
            assert.ok(tool.description.includes(type), `description omits type "${type}"`);
            assert.ok(typeDescription.includes(type), `type schema omits "${type}"`);
        }
    });

    it('should list terrain assets under the type that query_terrain points at', async () => {
        const result = await tool.execute({ type: 'terrain' }, PROJECT);
        assert.ok(!result.isError);
        const text = result.content[0].text;
        // grouped: folder hoisted into a header, type hoisted because it is uniform
        assert.match(text, /— all \[terrain\]/);
        assert.match(text, /^assets\/Maps\/$/m);
        assert.match(text, /^ {2}Terrain\.terrain$/m);
    });

    it('should keep the flat contract when the caller asks for it', async () => {
        const result = await tool.execute({ type: 'terrain', format: 'flat' }, PROJECT);
        // explicit flat implies the pre-grouped shape, uuid included
        assert.match(result.content[0].text, /- assets\/Maps\/Terrain\.terrain \[terrain\] [0-9a-f-]{36}/);
    });

    it('should answer the overview question with counts instead of rows', async () => {
        const all = await tool.execute({}, PROJECT);
        const summary = await tool.execute({ format: 'summary' }, PROJECT);
        assert.ok(!summary.isError);
        const text = summary.content[0].text;

        assert.match(text, /^by type: /m);
        assert.match(text, /^by folder: /m);
        // the whole point: no enumeration, so no asset name appears
        assert.ok(!text.includes('Gold.prefab'));
        assert.ok(text.length < all.content[0].text.length);

        // counts must agree with the enumerated listing
        const total = Number(text.match(/# Assets \((\d+)\)/)[1]);
        const perType = [...text.matchAll(/(?:^by type: |, )([\w-]+) (\d+)/gm)]
            .reduce((sum, m) => sum + Number(m[2]), 0);
        assert.strictEqual(perType, total);
    });

    it('should report the active filters in a summary', async () => {
        const result = await tool.execute({ type: 'prefab', format: 'summary' }, PROJECT);
        assert.match(result.content[0].text, /filters: type="prefab"/);
    });

    it('should group rows under one header per folder', async () => {
        const result = await tool.execute({}, PROJECT);
        const text = result.content[0].text;
        const headers = text.match(/^\S.*\/$/gm) ?? [];
        assert.ok(headers.length > 1, 'expected several folder headers');
        assert.strictEqual(new Set(headers).size, headers.length, 'a folder header repeats');
    });

    // AssetIndex scans depth-first without sorting, so a folder holding files both
    // before and after a subdirectory used to open two identical headers
    it('should keep a folder split by a subdirectory under one header', async () => {
        const root = makeProject({
            'assets/Art/alpha.prefab': 'prefab',
            'assets/Art/mid/inner.prefab': 'prefab',
            'assets/Art/mid.prefab': 'prefab',
            'assets/Art/zeta.prefab': 'prefab'
        });
        try {
            const text = (await tool.execute({}, root)).content[0].text;
            const headers = text.match(/^\S.*\/$/gm) ?? [];
            assert.deepStrictEqual(headers, ['assets/Art/', 'assets/Art/mid/']);
            const rows = (text.match(/^ {2}\S+$/gm) ?? []).map(r => r.trim());
            assert.deepStrictEqual(rows, ['alpha.prefab', 'mid.prefab', 'zeta.prefab', 'inner.prefab']);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('should order the flat and json shapes the same way', async () => {
        const root = makeProject({
            'assets/Art/zeta.prefab': 'prefab',
            'assets/Art/mid/inner.prefab': 'prefab',
            'assets/Art/alpha.prefab': 'prefab'
        });
        try {
            const expected = ['assets/Art/alpha.prefab', 'assets/Art/zeta.prefab', 'assets/Art/mid/inner.prefab'];
            const flat = (await tool.execute({ format: 'flat' }, root)).content[0].text;
            assert.deepStrictEqual([...flat.matchAll(/^- (\S+)/gm)].map(m => m[1]), expected);
            const json = JSON.parse((await tool.execute({ format: 'json' }, root)).content[0].text);
            assert.deepStrictEqual(json.items.map(i => i.path), expected);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    // the summary is sold as the complete inventory, so a capped rank must say how
    // many buckets it left out instead of quietly summing to less than the header
    it('should report the buckets a summary omits', async () => {
        const assets = {};
        for (let i = 1; i <= 26; i++) {
            const folder = `F${String(Math.min(i, 20)).padStart(2, '0')}`;
            assets[`assets/${folder}/a${i}.asset`] = `imp${String(i).padStart(2, '0')}`;
        }
        const root = makeProject(assets);
        try {
            const text = (await tool.execute({ format: 'summary' }, root)).content[0].text;
            assert.match(text, /# Assets \(26\)/);
            assert.match(text, /^by type: .*, \.\.\. 2 more$/m);   // 26 types, 24 shown
            assert.match(text, /^by folder: .*, \.\.\. 4 more$/m); // 20 buckets, 16 shown
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
