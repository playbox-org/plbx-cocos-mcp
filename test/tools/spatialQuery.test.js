/**
 * Spatial scene queries: find_scene_nodes {region}, get_node_bounds {perChild}, the transforms the
 * read pipeline now surfaces, and the project-root self-check.
 *
 * Fixtures are built at runtime: Crate.prefab instances at known world positions in a copy of the
 * golden scene.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

import { FindSceneNodes } from '../../src/tools/FindSceneNodes.js';
import { GetNodeBounds } from '../../src/tools/GetNodeBounds.js';
import { InspectNode } from '../../src/tools/InspectNode.js';
import { GetProjectInfo } from '../../src/tools/GetProjectInfo.js';
import { SceneDocument } from '../../src/document/SceneDocument.js';
import { applyOperations } from '../../src/document/operations.js';
import { AssetIndex } from '../../src/core/AssetIndex.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = (f) => path.join(__dirname, '..', 'fixtures', 'golden', f);
const MOCK_PROJECT = path.join(__dirname, '..', 'fixtures', 'mock-project');
const SCENE_REL = 'assets/Scenes/Spatial.scene';

const text = async (tool, args, root) => {
    const result = await tool.run(args, root);
    assert.ok(!result.isError, result.content[0].text);
    return result.content[0].text;
};

const fails = async (tool, args, root) => {
    const result = await tool.run(args, root);
    assert.strictEqual(result.isError, true, `expected an error, got:\n${result.content[0].text}`);
    return result.content[0].text;
};

describe('spatial scene queries', () => {
    let project;

    before(() => {
        project = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-spatial-'));
        fs.cpSync(MOCK_PROJECT, project, { recursive: true });
        // The fixture ships Crate.prefab and Sprites/panel.png under the SAME uuid; these tests
        // resolve the crate BY uuid, so give the sprite its own in this copy
        const panelMeta = path.join(project, 'assets/Sprites/panel.png.meta');
        fs.writeFileSync(panelMeta, fs.readFileSync(panelMeta, 'utf-8')
            .replaceAll('11112222-3333-4444-8555-666677778888', '99998888-7777-6666-8555-444433332222'));
        AssetIndex.invalidate(project);
        const assetIndex = new AssetIndex(project);
        const ctx = { assetIndex, projectRoot: project };

        const doc = SceneDocument.load(GOLDEN('Main.scene_V2.scene'));
        applyOperations(doc, [
            { op: 'add_node', parent: '/', name: 'Props' },
            // A group whose children sit at three separated spots
            {
                op: 'instantiate_prefab', parent: 'Props', prefab: 'Prefabs/Crate.prefab',
                name: 'CrateNear', position: { x: 2, y: 0, z: 3 }
            },
            {
                op: 'instantiate_prefab', parent: 'Props', prefab: 'Prefabs/Crate.prefab',
                name: 'CrateFar', position: { x: 40, y: 0, z: 40 }
            },
            { op: 'add_node', parent: 'Props', name: 'Marker', position: { x: 2.5, y: 1, z: 3.5 } },
            // A deep node with a non-default scale and rotation, below the depth-2 cut-off
            { op: 'add_node', parent: 'Props', name: 'Rig' },
            {
                op: 'add_node', parent: 'Props/Rig', name: 'Tilted',
                position: { x: 1, y: 2, z: 3 }, scale: { x: 2, y: 2, z: 2 },
                rotation: { x: 0, y: 90, z: 0 }
            }
        ], ctx);
        fs.mkdirSync(path.join(project, 'assets/Scenes'), { recursive: true });
        doc.save(path.join(project, SCENE_REL));
    });

    after(() => {
        fs.rmSync(project, { recursive: true, force: true });
    });

    describe('find_scene_nodes {region}', () => {
        const tool = new FindSceneNodes();

        it('keeps only nodes whose world footprint overlaps a rectangle', async () => {
            const out = await text(tool, {
                scenePath: SCENE_REL,
                pattern: 'Crate',
                region: { x: 0, z: 0, width: 10, depth: 10 }
            }, project);
            assert.match(out, /CrateNear/);
            assert.doesNotMatch(out, /CrateFar/);
            assert.match(out, /@ x 1\.9\d+\.\.2\.0\d+, z 2\.9\d+\.\.3\.0\d+/, 'prints the world extent');
            assert.match(out, /region x 0\.\.10, z 0\.\.10/);
            assert.match(out, /Extents are WORLD XZ/);
        });

        it('works as a region-only query and accepts a circle', async () => {
            const out = await text(tool, {
                scenePath: SCENE_REL,
                region: { center: [2, 3], radius: 1.5 }
            }, project);
            assert.match(out, /region 1\.5 m around \(2, 3\)/);
            assert.match(out, /CrateNear/);
            assert.match(out, /Marker/, 'a node with nothing measurable matches by position');
            assert.match(out, /position only — nothing measurable/);
            assert.doesNotMatch(out, /CrateFar/);
        });

        it('combines with the component filter', async () => {
            const out = await text(tool, {
                scenePath: SCENE_REL,
                component: 'cc.MeshRenderer',
                region: { x: 0, z: 0, width: 10, depth: 10 }
            }, project);
            assert.match(out, /component = cc\.MeshRenderer, region x 0\.\.10/);
            assert.doesNotMatch(out, /Marker/, 'no MeshRenderer on the marker');
        });

        it('rejects a malformed region and an empty filter set', async () => {
            assert.match(
                await fails(tool, { scenePath: SCENE_REL }, project),
                /Pass "pattern".*and\/or\s*"region"/s
            );
            const cases = [
                [{ x: 0, z: 0, width: 4 }, /region\.depth must be a finite number/],
                [{ x: 0, z: 0, width: 0, depth: 4 }, /must be > 0 metres/],
                [{ center: [1], radius: 2 }, /region\.center must be \[x, z\]/],
                [{ center: [1, 2] }, /region\.radius must be a number > 0/],
                [{ x: 0, z: 0, width: 4, depth: 4, radius: 2 }, /not a mix/]
            ];
            for (const [region, pattern] of cases) {
                assert.match(await fails(tool, { scenePath: SCENE_REL, region }, project), pattern);
            }
        });
    });

    describe('get_node_bounds {perChild}', () => {
        const tool = new GetNodeBounds();

        it('lists one world AABB per direct child, position for the unmeasurable ones', async () => {
            const out = await text(tool, { filePath: SCENE_REL, node: 'Props', perChild: true }, project);
            assert.match(out, /## Per child \(4\)/);
            assert.match(out, /● CrateNear: x 1\.9\d+\.\.2\.0\d+, z 2\.9\d+\.\.3\.0\d+, y 0\.4\d+\.\.0\.5\d+/);
            assert.match(out, /● CrateFar: x 39\.9\d+\.\.40\.0\d+/);
            assert.match(out, /● Marker: nothing measurable — world position \(2\.5, 1, 3\.5\)/);
            assert.match(out, /XZ is the footprint/);
        });

        it('stays off by default', async () => {
            const out = await text(tool, { filePath: SCENE_REL, node: 'Props' }, project);
            assert.doesNotMatch(out, /Per child/);
        });
    });

    describe('transforms in the read pipeline', () => {
        it('inspect_node prints scale and rotation at any depth', async () => {
            const out = await text(new InspectNode(), {
                filePath: SCENE_REL, nodeName: 'Rig'
            }, project);
            // Depth 1 below the queried node — the old depth <= 2 rule hid this
            assert.match(out, /Tilted @\(1,2,3\) scale\(2,2,2\) rot\(0,90,0\)/);
        });
    });

    describe('get_project_info self-check', () => {
        it('reports the resolved root, assets/ and library/', async () => {
            const out = await text(new GetProjectInfo(), {}, project);
            assert.match(out, /## Project root/);
            assert.match(out, new RegExp(`Resolved root: ${project.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
            assert.match(out, /assets\/: \d+ asset\(s\) indexed/);
            assert.match(out, /library\/: present/);
        });

        it('says so loudly when the root has no assets\\/', async () => {
            const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-bare-'));
            fs.cpSync(path.join(project, 'settings'), path.join(bare, 'settings'), { recursive: true });
            fs.copyFileSync(path.join(project, 'package.json'), path.join(bare, 'package.json'));
            const out = await text(new GetProjectInfo(), {}, bare);
            assert.match(out, /assets\/: MISSING — is COCOS_PROJECT_ROOT set/);
            assert.match(out, /Read tools DEGRADE QUIETLY/);
            assert.match(out, /library\/: MISSING/);
            fs.rmSync(bare, { recursive: true, force: true });
        });
    });
});
