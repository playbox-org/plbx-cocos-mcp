/**
 * GetNodeBounds report rendering — the part that is the tool's own rather than Bounds' math:
 * `## Per child` must never present an incomplete list as a complete one.
 *
 * Fixture: the golden scene saved into a copy of the mock project. Its instance stubs point at
 * source prefabs that are not in this project, which is exactly the unreadable-source case.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

import { GetNodeBounds } from '../../src/tools/GetNodeBounds.js';
import { SceneDocument } from '../../src/document/SceneDocument.js';
import { applyOperations } from '../../src/document/operations.js';
import { AssetIndex } from '../../src/core/AssetIndex.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = (f) => path.join(__dirname, '..', 'fixtures', 'golden', f);
const MOCK_PROJECT = path.join(__dirname, '..', 'fixtures', 'mock-project');
const SCENE_REL = 'assets/Scenes/Bounds.scene';
const MOUNT_STUB = '[WORLD]/Zones/GoldStackZone';   // stub with a mounted child
const BARE_STUB = '[WORLD]/Environment/Cliffs/Scal'; // stub with nothing knowable at all

/** The `## Per child` section only — the reason must live there, not in a section further down */
function perChildSection(report) {
    const start = report.indexOf('## Per child');
    assert.ok(start >= 0, `no Per child section in:\n${report}`);
    const rest = report.slice(start);
    const end = rest.indexOf('\n## ', 1);
    return end < 0 ? rest : rest.slice(0, end);
}

describe('get_node_bounds report', () => {
    const tool = new GetNodeBounds();
    let project;

    const text = async (args) => {
        const result = await tool.run({ filePath: SCENE_REL, ...args }, project);
        assert.ok(!result.isError, result.content[0].text);
        return result.content[0].text;
    };

    before(() => {
        project = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-bounds-tool-'));
        fs.cpSync(MOCK_PROJECT, project, { recursive: true });
        // The fixture ships Crate.prefab and Sprites/panel.png under the SAME uuid; a stub is
        // resolved BY uuid, so give the sprite its own in this copy
        const panelMeta = path.join(project, 'assets/Sprites/panel.png.meta');
        fs.writeFileSync(panelMeta, fs.readFileSync(panelMeta, 'utf-8')
            .replaceAll('11112222-3333-4444-8555-666677778888', '99998888-7777-6666-8555-444433332222'));
        AssetIndex.invalidate(project);
        const doc = SceneDocument.load(GOLDEN('Main.scene_V2.scene'));
        applyOperations(doc, [{
            op: 'instantiate_prefab', parent: '/', prefab: 'Prefabs/Crate.prefab', name: 'Box'
        }], { assetIndex: new AssetIndex(project), projectRoot: project });
        fs.mkdirSync(path.join(project, 'assets/Scenes'), { recursive: true });
        doc.save(path.join(project, SCENE_REL));
    });

    after(() => {
        AssetIndex.invalidate(project);
        fs.rmSync(project, { recursive: true, force: true });
    });

    it('never prints "Per child (0)" without saying why', async () => {
        const section = perChildSection(await text({ node: BARE_STUB, perChild: true }));
        assert.match(section, /## Per child \(0\)/);
        assert.match(
            section,
            new RegExp(`- ! ${BARE_STUB.replace(/[[\]/]/g, '\\$&')}: children NOT listed — ` +
                       'source prefab unavailable: [^\\n]+lower bound')
        );
    });

    it('states the unreadable half beside the children it did list', async () => {
        const report = await text({ node: MOUNT_STUB, perChild: true });
        const section = perChildSection(report);
        assert.match(section, /## Per child \(1\)/);
        assert.match(section, /● icon \(mounted\)/, 'the knowable half is still listed');
        assert.match(section, /children NOT listed — source prefab unavailable: /);
        // the row cap slices the rows: the reason must not be attached to that array
        assert.strictEqual((report.match(/children NOT listed/g) ?? []).length, 1);
    });

    it('says nothing when every child was enumerated', async () => {
        for (const node of ['Box', '/']) {
            const section = perChildSection(await text({ node, perChild: true }));
            assert.doesNotMatch(section, /NOT listed/, `false alarm on "${node}"`);
        }
        // 'Box' is a readable stub, so its source children ARE the list
        assert.match(perChildSection(await text({ node: 'Box', perChild: true })), /● Visual: /);
    });
});
