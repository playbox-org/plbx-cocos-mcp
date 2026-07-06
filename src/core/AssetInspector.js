/**
 * AssetInspector - Single Responsibility: Extract detailed info for a single asset
 *
 * Per asset kind:
 * - image:    sprite-frame rect/trim/rawSize/9-slice borders from .meta subMetas
 * - fbx/gltf: sub-assets (meshes/materials/prefab) + mesh AABB from compiled
 *             library/ JSON, falling back to .glb accessor min/max
 * - prefab:   summary (root, node count, component types) without full dump
 * - material: effect reference + active defines
 *
 * SOLID: S - Only responsible for single-asset introspection
 * SOLID: D - Depends on AssetIndex abstraction for resolution
 */

import * as fs from 'fs';
import * as path from 'path';
import { extractMeshBounds } from '../utils/glb.js';
import { compressUuid, decompressUuid, isCompressedUuid } from '../utils/uuid.js';

export class AssetInspector {
    #projectRoot;
    #index;

    /**
     * @param {string} projectRoot - Path to Cocos project root
     * @param {AssetIndex} index - Asset index for reference resolution
     */
    constructor(projectRoot, index) {
        this.#projectRoot = projectRoot;
        this.#index = index;
    }

    /**
     * Inspect an asset by path, UUID or compressed UUID
     * @param {string} ref
     * @returns {object|null} Info object, or null if the asset is not found
     */
    inspect(ref) {
        const resolved = this.#index.resolve(ref);
        if (!resolved) return null;

        const { entry, subAsset } = resolved;
        const base = {
            path: entry.path,
            name: entry.name,
            uuid: subAsset?.uuid ?? entry.uuid,
            importer: subAsset?.importer ?? entry.importer
        };

        switch (entry.importer) {
            case 'image':
                return { ...base, ...this.#inspectImage(entry, subAsset) };
            case 'fbx':
            case 'gltf':
                return { ...base, ...this.#inspectModel(entry) };
            case 'prefab':
                return { ...base, ...this.#inspectPrefab(entry) };
            case 'material':
                return { ...base, ...this.#inspectMaterial(entry) };
            case 'typescript':
            case 'javascript':
                return { ...base, compressedUuid: compressUuid(entry.uuid) };
            default:
                return { ...base, subAssets: this.#listSubAssets(entry) };
        }
    }

    // ---------- image / sprite ----------

    #inspectImage(entry, subAsset) {
        const meta = this.#readJson(entry.metaPath);
        if (!meta) return {};

        const info = {
            imageType: meta.userData?.type ?? null,
            hasAlpha: meta.userData?.hasAlpha ?? null,
            subAssets: this.#listSubAssets(entry)
        };

        // Sprite-frame details: requested sub-asset, or the first one present
        const frames = Object.values(meta.subMetas ?? {})
            .filter(s => s.importer === 'sprite-frame');
        const target = subAsset
            ? frames.filter(f => f.id === subAsset.id)
            : frames;

        if (target.length > 0) {
            info.spriteFrame = this.#spriteFrameInfo(target[0]);
        }

        return info;
    }

    #spriteFrameInfo(sub) {
        const d = sub.userData ?? {};
        const borders = {
            top: d.borderTop ?? 0,
            bottom: d.borderBottom ?? 0,
            left: d.borderLeft ?? 0,
            right: d.borderRight ?? 0
        };

        return {
            uuid: sub.uuid,
            rect: { x: d.trimX ?? 0, y: d.trimY ?? 0, width: d.width, height: d.height },
            rawSize: { width: d.rawWidth, height: d.rawHeight },
            offset: { x: d.offsetX ?? 0, y: d.offsetY ?? 0 },
            rotated: d.rotated ?? false,
            trimType: d.trimType ?? null,
            packable: d.packable ?? null,
            pixelsToUnit: d.pixelsToUnit ?? null,
            borders,
            isSliced: Object.values(borders).some(v => v > 0)
        };
    }

    // ---------- fbx / gltf model ----------

    #inspectModel(entry) {
        const groups = {};
        for (const sub of entry.subAssets) {
            (groups[sub.importer] ??= []).push(sub);
        }

        const meshes = (groups['gltf-mesh'] ?? []).map(sub => ({
            uuid: sub.uuid,
            name: sub.displayName || sub.name,
            aabb: null,
            aabbSource: null
        }));

        this.#fillMeshBounds(entry, meshes);

        return {
            meshes,
            materials: this.#namesOf(groups['gltf-material']),
            skeletons: this.#namesOf(groups['gltf-skeleton']),
            animations: this.#namesOf(groups['gltf-animation']),
            modelPrefab: groups['gltf-scene']?.[0]?.uuid ?? null
        };
    }

    #fillMeshBounds(entry, meshes) {
        // Primary source: compiled mesh JSON in library/<uuid[0..2]>/<subUuid>.json
        let missing = [];
        for (const mesh of meshes) {
            const libPath = path.join(
                this.#projectRoot, 'library', mesh.uuid.slice(0, 2), `${mesh.uuid}.json`
            );
            const compiled = this.#readJson(libPath);
            const min = compiled?._struct?.minPosition;
            const max = compiled?._struct?.maxPosition;

            if (min && max) {
                mesh.aabb = this.#makeAabb([min.x, min.y, min.z], [max.x, max.y, max.z]);
                mesh.aabbSource = 'library';
            } else {
                missing.push(mesh);
            }
        }

        // Fallback: POSITION accessor min/max straight from the .glb
        if (missing.length === 0 || !/\.glb$/i.test(entry.path)) return;

        let glbBounds;
        try {
            glbBounds = extractMeshBounds(path.join(this.#projectRoot, entry.path));
        } catch {
            return;
        }

        for (const mesh of missing) {
            // Sub-asset "Circle.019.mesh" ↔ glTF mesh "Circle.019"
            const plainName = mesh.name.replace(/\.mesh$/, '');
            const found = glbBounds.find(b => b.name === plainName) ??
                          (glbBounds.length === 1 ? glbBounds[0] : null);
            if (found) {
                mesh.aabb = this.#makeAabb(found.min, found.max);
                mesh.aabbSource = 'glb';
            }
        }
    }

    #makeAabb(min, max) {
        return {
            min: { x: min[0], y: min[1], z: min[2] },
            max: { x: max[0], y: max[1], z: max[2] },
            size: {
                x: max[0] - min[0],
                y: max[1] - min[1],
                z: max[2] - min[2]
            }
        };
    }

    #namesOf(subs) {
        return (subs ?? []).map(s => ({ uuid: s.uuid, name: s.displayName || s.name }));
    }

    // ---------- prefab ----------

    #inspectPrefab(entry) {
        const objects = this.#readJson(path.join(this.#projectRoot, entry.path));
        if (!Array.isArray(objects)) return { error: 'Cannot parse prefab file' };

        const prefab = objects.find(o => o.__type__ === 'cc.Prefab');
        const root = prefab?.data?.__id__ !== undefined ? objects[prefab.data.__id__] : null;

        const nodeCount = objects.filter(o => o.__type__ === 'cc.Node').length;
        // Components carry a back-reference `node` to their owner
        const componentCounts = {};
        for (const obj of objects) {
            if (!obj.__type__ || obj.node === undefined) continue;
            const name = this.#resolveComponentType(obj.__type__);
            componentCounts[name] = (componentCounts[name] ?? 0) + 1;
        }

        const rootComponents = (root?._components ?? [])
            .map(ref => objects[ref.__id__]?.__type__)
            .filter(Boolean)
            .map(t => this.#resolveComponentType(t));

        return {
            rootName: root?._name ?? null,
            nodeCount,
            prefabInstances: objects.filter(o => o.__type__ === 'cc.PrefabInstance').length,
            rootComponents,
            components: componentCounts,
            topLevelChildren: (root?._children ?? [])
                .map(ref => objects[ref.__id__]?._name)
                .filter(Boolean)
        };
    }

    #resolveComponentType(type) {
        if (type.startsWith('cc.')) return type.replace('cc.', '');
        if (isCompressedUuid(type)) {
            const full = decompressUuid(type);
            const resolved = full && this.#index.resolve(full);
            if (resolved) return resolved.entry.name.replace(/\.(ts|js)$/, '');
        }
        return `Script:${type.slice(0, 8)}`;
    }

    // ---------- material ----------

    #inspectMaterial(entry) {
        const material = this.#readJson(path.join(this.#projectRoot, entry.path));
        if (!material) return { error: 'Cannot parse material file' };

        const effectUuid = material._effectAsset?.__uuid__ ?? null;
        const effectRef = effectUuid ? this.#index.resolve(effectUuid) : null;

        const defines = {};
        for (const pass of material._defines ?? []) {
            Object.assign(defines, pass);
        }

        return {
            effect: {
                uuid: effectUuid,
                name: effectRef?.entry.name ?? null
            },
            technique: material._techIdx ?? 0,
            defines
        };
    }

    // ---------- shared ----------

    #listSubAssets(entry) {
        return entry.subAssets.map(s => ({
            id: s.id,
            uuid: s.uuid,
            name: s.name,
            importer: s.importer
        }));
    }

    #readJson(filePath) {
        try {
            return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        } catch {
            return null;
        }
    }
}
