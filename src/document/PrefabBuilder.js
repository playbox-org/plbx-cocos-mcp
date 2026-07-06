/**
 * PrefabBuilder - compile a compact spec into a full .prefab document
 *
 * The spec (~30 lines) expands deterministically into correct 3.8.x JSON.
 * Compilation reuses the semantic operations layer:
 * the spec becomes an add_node/add_component/set_asset_ref batch applied to
 * a minimal prefab skeleton, so build_prefab and apply_edits share one
 * serialization path.
 *
 * Wrapper convention: `visual` puts the renderer on a child
 * node, keeping the root clean for logic/tweens/colliders.
 *
 * Spec shape:
 * {
 *   name?: string,                  // default: output file name
 *   layer?: number|string,          // default: "default" (3D); use "ui_2d" for UI
 *   visual?: {
 *     mesh?: "Art/crate.glb[@subId]", material?: "path|uuid",
 *     sprite?: "UI/icon.png",       // resolves the sprite-frame sub-asset
 *     name?: "Visual", position?, rotation?, scale?: number|{x,y,z}
 *   },
 *   root?: {
 *     components?: [{type, properties?}],
 *     children?: [NodeSpec]         // NodeSpec = {name, position?, rotation?,
 *   }                               //   scale?, layer?, active?, mesh?, sprite?,
 * }                                 //   material?, components?, children?}
 */

import { randomUUID } from 'crypto';
import { SceneDocument } from './SceneDocument.js';
import { applyOperations, OperationError, LAYERS } from './operations.js';
import { generateFileId } from '../utils/fileId.js';

export class PrefabBuildError extends Error {}

export class PrefabBuilder {
    #assetIndex;

    /**
     * @param {object|null} assetIndex - AssetIndex for mesh/sprite/material resolution
     */
    constructor(assetIndex = null) {
        this.#assetIndex = assetIndex;
    }

    /**
     * Compile a spec into an in-memory SceneDocument (renumbered, unsaved).
     * @param {object} spec
     * @param {string} defaultName - Used when spec.name is absent
     * @returns {{doc: SceneDocument, ops: object[], notes: string[]}}
     */
    compile(spec, defaultName) {
        const name = spec.name ?? defaultName;
        if (!name) throw new PrefabBuildError('Prefab needs a name (spec.name or output path)');

        const doc = this.#skeleton(name, spec.layer);
        const ops = [];
        const notes = [];
        this.#compileNodeContents('/', spec.root ?? {}, ops, notes);
        if (spec.visual) this.#compileVisual(spec.visual, ops, notes);

        if (ops.length > 0) {
            applyOperations(doc, ops, { assetIndex: this.#assetIndex });
        }
        doc.renumber();
        return { doc, ops, notes };
    }

    /** Minimal valid prefab: cc.Prefab head + root node + its PrefabInfo */
    #skeleton(name, layer) {
        const taken = new Set();
        const rootFileId = generateFileId(taken);
        const objects = [
            {
                __type__: 'cc.Prefab',
                _name: name,
                _objFlags: 0,
                __editorExtras__: {},
                _native: '',
                data: { __id__: 1 },
                optimizationPolicy: 0,
                persistent: false
            },
            {
                __type__: 'cc.Node',
                _name: name,
                _objFlags: 0,
                __editorExtras__: {},
                _parent: null,
                _children: [],
                _active: true,
                _components: [],
                _prefab: { __id__: 2 },
                _lpos: { __type__: 'cc.Vec3', x: 0, y: 0, z: 0 },
                _lrot: { __type__: 'cc.Quat', x: 0, y: 0, z: 0, w: 1 },
                _lscale: { __type__: 'cc.Vec3', x: 1, y: 1, z: 1 },
                _mobility: 0,
                _layer: LAYERS.default,
                _euler: { __type__: 'cc.Vec3', x: 0, y: 0, z: 0 },
                _id: ''
            },
            {
                // Root-node PrefabInfo: the editor omits nestedPrefabInstanceRoots
                // unless it holds actual instances (verified via editor re-save)
                __type__: 'cc.PrefabInfo',
                root: { __id__: 1 },
                asset: { __id__: 0 },
                fileId: rootFileId,
                instance: null,
                targetOverrides: null
            }
        ];
        const doc = new SceneDocument(objects);
        if (layer !== undefined) {
            applyOperations(doc, [{ op: 'set_node_property', node: '/', property: 'layer', value: layer }]);
        }
        return doc;
    }

    /** visual sugar → wrapper child with the renderer */
    #compileVisual(visual, ops, notes) {
        const spec = {
            name: visual.name ?? 'Visual',
            position: visual.position,
            rotation: visual.rotation,
            scale: typeof visual.scale === 'number'
                ? { x: visual.scale, y: visual.scale, z: visual.scale }
                : visual.scale,
            mesh: visual.mesh,
            sprite: visual.sprite,
            material: visual.material
        };
        this.#compileNode('/', spec, ops, notes);
    }

    #compileNode(parentPath, nodeSpec, ops, notes) {
        if (!nodeSpec.name) throw new PrefabBuildError('Every node spec needs a "name"');
        const path = parentPath === '/' ? nodeSpec.name : `${parentPath}/${nodeSpec.name}`;

        ops.push({
            op: 'add_node',
            parent: parentPath,
            name: nodeSpec.name,
            position: nodeSpec.position,
            rotation: nodeSpec.rotation,
            scale: typeof nodeSpec.scale === 'number'
                ? { x: nodeSpec.scale, y: nodeSpec.scale, z: nodeSpec.scale }
                : nodeSpec.scale,
            layer: nodeSpec.layer,
            active: nodeSpec.active
        });
        this.#compileNodeContents(path, nodeSpec, ops, notes);
    }

    #compileNodeContents(path, nodeSpec, ops, notes) {
        if (nodeSpec.mesh) this.#compileMesh(path, nodeSpec, ops, notes);
        if (nodeSpec.sprite) this.#compileSprite(path, nodeSpec, ops);

        for (const comp of nodeSpec.components ?? []) {
            if (!comp.type) throw new PrefabBuildError(`Component on "${path}" needs a "type"`);
            ops.push({
                op: 'add_component',
                node: path,
                type: comp.type,
                properties: comp.properties
            });
        }
        for (const child of nodeSpec.children ?? []) {
            this.#compileNode(path, child, ops, notes);
        }
    }

    #compileMesh(path, nodeSpec, ops, notes) {
        const { meshRef, materialRefs } = this.#resolveMesh(nodeSpec.mesh, nodeSpec.material);
        ops.push({ op: 'add_component', node: path, type: 'cc.MeshRenderer' });
        ops.push({ op: 'set_asset_ref', node: path, component: 'cc.MeshRenderer', property: 'mesh', asset: meshRef });
        ops.push({
            op: 'set_component_property',
            node: path,
            component: 'cc.MeshRenderer',
            property: '_materials',
            value: materialRefs.length
                ? materialRefs.map(m => ({ $asset: m, $type: 'cc.Material' }))
                : [null]
        });
        if (materialRefs.length === 0) {
            notes.push(
                `"${path}": model "${nodeSpec.mesh}" embeds no materials and none was specified — ` +
                `the mesh will render INVISIBLE. Assign one: apply_edits op ` +
                `{op: "set_asset_ref", node: "${path}", component: "cc.MeshRenderer", ` +
                `property: "materials[0]", asset: "<path/to/.mtl>"} ` +
                `(or pass spec.visual.material / node material).`
            );
        }
    }

    /** Resolve "model.glb[@sub]" into a concrete mesh sub-asset + materials */
    #resolveMesh(meshRef, materialRef) {
        if (!this.#assetIndex) throw new PrefabBuildError('mesh resolution requires a project (assetIndex)');
        const resolved = this.#assetIndex.resolve(meshRef);
        if (!resolved) throw new PrefabBuildError(`Mesh asset not found: "${meshRef}"`);
        const { entry, subAsset } = resolved;

        let mesh = subAsset;
        if (!mesh) {
            const meshes = entry.subAssets.filter(s => s.importer === 'gltf-mesh');
            if (meshes.length === 0) {
                throw new PrefabBuildError(`"${meshRef}" has no gltf-mesh sub-assets (importer: ${entry.importer})`);
            }
            if (meshes.length > 1) {
                const list = meshes.map(m => `${entry.path}@${m.id} (${m.name || m.displayName})`).join(', ');
                throw new PrefabBuildError(`"${meshRef}" has ${meshes.length} meshes — pick one: ${list}`);
            }
            mesh = meshes[0];
        } else if (mesh.importer !== 'gltf-mesh') {
            throw new PrefabBuildError(`"${meshRef}" is a ${mesh.importer}, not a gltf-mesh`);
        }

        let materialRefs = [];
        if (materialRef) {
            materialRefs = [materialRef];
        } else {
            // Default to the model's own materials (order as imported)
            materialRefs = entry.subAssets
                .filter(s => s.importer === 'gltf-material' || s.importer === 'material')
                .map(s => `${entry.uuid}@${s.id}`);
        }
        return { meshRef: `${entry.uuid}@${mesh.id}`, materialRefs };
    }

    #compileSprite(path, nodeSpec, ops) {
        if (!this.#assetIndex) throw new PrefabBuildError('sprite resolution requires a project (assetIndex)');
        const resolved = this.#assetIndex.resolve(nodeSpec.sprite);
        if (!resolved) throw new PrefabBuildError(`Sprite asset not found: "${nodeSpec.sprite}"`);
        const { entry, subAsset } = resolved;

        let frame = subAsset;
        if (!frame) {
            frame = entry.subAssets.find(s => s.importer === 'sprite-frame');
            if (!frame) {
                throw new PrefabBuildError(
                    `"${nodeSpec.sprite}" has no sprite-frame sub-asset ` +
                    `(imported as plain texture? Re-import as sprite-frame in the editor)`
                );
            }
        }

        ops.push({ op: 'add_component', node: path, type: 'cc.UITransform' });
        ops.push({ op: 'add_component', node: path, type: 'cc.Sprite' });
        ops.push({
            op: 'set_asset_ref',
            node: path,
            component: 'cc.Sprite',
            property: 'spriteFrame',
            asset: `${entry.uuid}@${frame.id}`
        });
    }

    /**
     * Standard .prefab.meta content for a freshly built prefab.
     * The editor keeps our UUID, so the asset is referencable immediately.
     */
    static createMeta(rootName) {
        return {
            ver: '1.1.50',
            importer: 'prefab',
            imported: true,
            uuid: randomUUID(),
            files: ['.json'],
            subMetas: {},
            userData: { syncNodeName: rootName }
        };
    }
}

export { OperationError };
