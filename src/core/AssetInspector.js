/**
 * AssetInspector - Single Responsibility: Extract detailed info for a single asset
 *
 * Per asset kind:
 * - image:    sprite-frame rect/trim/rawSize/9-slice borders from .meta subMetas
 * - fbx/gltf: sub-assets (meshes/materials/prefab) + mesh AABB from compiled
 *             library/ JSON, falling back to .glb accessor min/max
 * - prefab:   summary (root, node count, component types) without full dump
 * - material: effect reference + active defines
 * - terrain:  geometry/height/layer card from the native binary (terrainBin)
 *
 * SOLID: S - Only responsible for single-asset introspection
 * SOLID: D - Depends on AssetIndex abstraction for resolution
 */

import * as fs from 'fs';
import * as path from 'path';
import { extractMeshBounds } from '../utils/glb.js';
import { readTerrainInfo, TERRAIN_HEIGHT_FACTOR } from '../utils/terrainBin.js';
import { compressUuid, decompressUuid, isCompressedUuid } from '../utils/uuid.js';

export class AssetInspector {
    #projectRoot;
    #index;
    /** `${abs}:${mtimeNs}:${size}` → readTerrainInfo result | {error} | null */
    #terrainCache = new Map();

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
            case 'terrain':
                return { ...base, terrain: this.#inspectTerrain(entry) };
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

    // ---------- terrain ----------

    /**
     * Geometry/height/layer card of a `.terrain` native binary. The layer table's
     * detail/normal map ids are `<uuid>@6c48a` texture sub-asset refs — resolved to
     * names here, with the raw id kept so `format:"json"` stays machine-usable.
     *
     * Returns `{error}` when the file is missing or not a parsable terrain — the
     * same convention as #inspectPrefab/#inspectMaterial (note that GetAssetInfo's
     * text formatter has to print it explicitly, #formatText never does).
     *
     * `query_terrain` is the CANONICAL json shape for a terrain: an ABSENT texture id
     * is `null` (the binary spells it `""`) and the height statistics live in a nested
     * `height: {min, max, mean, minRaw, maxRaw, flat, quantum}` block. Both are emitted
     * here so a consumer can read either tool with one code path; the flat `heightMin`/
     * `isFlat`/… keys stay for compatibility and this text card renders from them.
     */
    #inspectTerrain(entry) {
        const info = this.#terrainInfo(path.resolve(this.#projectRoot, entry.path));
        if (!info) return { error: 'Cannot read terrain file' };
        if (info.error) return { error: info.error };

        const warnings = [...info.warnings];
        const layers = info.layers.map((layer) => {
            const resolved = {
                ...layer,
                // "" is how the binary stores "no map"; query_terrain says null
                detailMapId: layer.detailMapId || null,
                normalMapId: layer.normalMapId || null,
                detailMapName: layer.detailMapId ? this.#index.label(layer.detailMapId) : null,
                normalMapName: layer.normalMapId ? this.#index.label(layer.normalMapId) : null
            };
            for (const [key, idKey] of [['detailMapName', 'detailMapId'], ['normalMapName', 'normalMapId']]) {
                if (layer[idKey] && resolved[key] === null) {
                    warnings.push(
                        `layer slot ${layer.slot} ${idKey} "${layer[idKey]}" does not resolve to a ` +
                        'project asset — the texture was deleted, or its .meta has no texture sub-asset'
                    );
                }
            }
            return resolved;
        });

        // `filePath` is the absolute path readTerrainInfo echoes back — the card
        // already carries the project-relative `path`, so drop it.
        const { filePath, ...card } = info;
        return {
            ...card,
            height: {
                min: info.heightMin,
                max: info.heightMax,
                mean: info.heightMean,
                minRaw: info.heightMinRaw,
                maxRaw: info.heightMaxRaw,
                flat: info.isFlat,
                quantum: TERRAIN_HEIGHT_FACTOR
            },
            layers,
            warnings
        };
    }

    /**
     * `readTerrainInfo` memoized per file identity. Keyed on path + mtime + size,
     * NOT on path alone: edit_terrain rewrites the binary in-process and a reader
     * that follows in the same tool call must see the fresh bytes. Negatives and
     * parse errors are cached too (mirrors Bounds' #meshCache).
     */
    #terrainInfo(abs) {
        let st;
        try {
            // NANOsecond mtime, not mtimeMs: pow-2 padding makes a rewritten terrain the
            // same size, so the timestamp is the only thing separating two versions and
            // it should carry every bit the filesystem has. (This does NOT help on a
            // filesystem whose mtime granularity is coarser than the rewrite interval —
            // exFAT 2 s, SMB 1 s. Nothing shipping today rewrites a terrain in-process;
            // when edit_terrain does, it needs an explicit invalidation hook here.)
            st = fs.statSync(abs, { bigint: true });
        } catch (err) {
            return { error: `Cannot read terrain file: ${err.message}` };
        }
        const key = `${abs}:${st.mtimeNs}:${st.size}`;
        if (this.#terrainCache.has(key)) return this.#terrainCache.get(key);

        let info;
        try {
            info = readTerrainInfo(abs);
            if (!info) info = { error: 'Not a Cocos .terrain binary (unrecognized version magic)' };
        } catch (err) {
            info = { error: err.message };
        }
        this.#terrainCache.set(key, info);
        return info;
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
