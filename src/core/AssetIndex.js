/**
 * AssetIndex - Single Responsibility: Index project assets by scanning .meta files
 *
 * Builds bidirectional path↔UUID maps over assets/**\/*.meta, including
 * sub-assets ("<uuid>@<subId>": spriteFrame, texture, gltf-mesh, ...).
 * Accepts full UUIDs, compressed UUIDs and project-relative paths as input.
 *
 * SOLID: S - Only responsible for asset discovery and resolution
 */

import * as fs from 'fs';
import * as path from 'path';
import { splitSubAssetRef, isFullUuid, isCompressedUuid, decompressUuid, compressUuid } from '../utils/uuid.js';
import { builtinLabel } from './builtins.js';

/** Friendly type aliases → meta importer names (keys normalized: lowercase, no -/_) */
const TYPE_ALIASES = {
    image: ['image'],
    sprite: ['image'],
    spriteframe: ['image'], // sprite frames are sub-assets of images, not a top-level type
    texture: ['image'],
    model: ['fbx', 'gltf'],
    mesh: ['fbx', 'gltf'],
    prefab: ['prefab'],
    scene: ['scene'],
    material: ['material'],
    script: ['typescript', 'javascript'],
    audio: ['audio-clip'],
    font: ['ttf-font', 'bitmap-font'],
    animation: ['animation-clip', 'animation-graph', 'animation-mask'],
    effect: ['effect'],
    directory: ['directory']
};

// Per-projectRoot cache: the TTL bounds staleness from editor-side changes;
// our own asset-creating writes call AssetIndex.invalidate() explicitly.
const SHARED_CACHE = new Map(); // resolved projectRoot → {index, builtAt}
const SHARED_TTL_MS = 5000;

export class AssetIndex {
    #projectRoot;
    #entries = [];
    #byUuid = new Map();
    #byPath = new Map();
    #scriptClassNames = null;

    /**
     * @param {string} projectRoot - Path to Cocos project root
     */
    constructor(projectRoot) {
        this.#projectRoot = projectRoot;
        this.#scanDirectory(path.join(projectRoot, 'assets'));
    }

    /** Cached index for a project — the way tools should obtain one */
    static shared(projectRoot) {
        const key = path.resolve(projectRoot);
        const hit = SHARED_CACHE.get(key);
        if (hit && Date.now() - hit.builtAt < SHARED_TTL_MS) return hit.index;
        const index = new AssetIndex(projectRoot);
        SHARED_CACHE.set(key, { index, builtAt: Date.now() });
        return index;
    }

    /** Drop the cached index (all projects when no root given) */
    static invalidate(projectRoot = null) {
        if (projectRoot === null) SHARED_CACHE.clear();
        else SHARED_CACHE.delete(path.resolve(projectRoot));
    }

    #scanDirectory(dir) {
        if (!fs.existsSync(dir)) return;

        const entries = fs.readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);

            if (entry.isDirectory()) {
                this.#scanDirectory(fullPath);
            } else if (entry.name.endsWith('.meta')) {
                this.#processMeta(fullPath);
            }
        }
    }

    #processMeta(metaPath) {
        let meta;
        try {
            meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        } catch {
            return; // Skip invalid meta files
        }
        if (!meta.uuid) return;

        const assetPath = this.#normalize(
            path.relative(this.#projectRoot, metaPath.slice(0, -'.meta'.length))
        );

        const entry = {
            path: assetPath,
            name: path.basename(assetPath),
            uuid: meta.uuid,
            importer: meta.importer,
            subAssets: Object.entries(meta.subMetas ?? {}).map(([id, sub]) => ({
                id,
                uuid: sub.uuid ?? `${meta.uuid}@${id}`,
                name: sub.name ?? '',
                displayName: sub.displayName ?? '',
                importer: sub.importer ?? ''
            })),
            metaPath
        };

        this.#entries.push(entry);
        // Lower-case key: lookups normalize with toLowerCase() too
        this.#byUuid.set(meta.uuid.toLowerCase(), entry);
        this.#byPath.set(assetPath.toLowerCase(), entry);
    }

    #normalize(p) {
        return p.replaceAll('\\', '/').replace(/^\.\//, '');
    }

    /** All indexed entries (directories included) */
    get entries() {
        return this.#entries;
    }

    /**
     * Resolve a path, full UUID, compressed UUID or "<uuid>@<subId>" reference
     * @param {string} ref
     * @returns {{entry: object, subAsset: object|null}|null}
     */
    resolve(ref) {
        if (!ref) return null;

        const { uuid, subId } = splitSubAssetRef(ref);

        // Full UUID
        if (isFullUuid(uuid)) {
            return this.#withSubAsset(this.#byUuid.get(uuid.toLowerCase()), subId);
        }

        // Compressed UUID
        if (isCompressedUuid(uuid)) {
            const full = decompressUuid(uuid);
            const found = full && this.#byUuid.get(full);
            if (found) return this.#withSubAsset(found, subId);
        }

        // Path (as given, or relative to assets/), optionally "path@subId"
        const lookupPath = (p) => {
            const normalized = this.#normalize(p).toLowerCase();
            return this.#byPath.get(normalized) ?? this.#byPath.get(`assets/${normalized}`);
        };
        const direct = lookupPath(ref);
        if (direct) return { entry: direct, subAsset: null };
        if (subId) {
            return this.#withSubAsset(lookupPath(uuid), subId);
        }
        return null;
    }

    #withSubAsset(entry, subId) {
        if (!entry) return null;
        if (!subId) return { entry, subAsset: null };

        const subAsset = entry.subAssets.find(s => s.id === subId);
        return subAsset ? { entry, subAsset } : null;
    }

    /**
     * Short human label for a reference: "Mat.mtl" for top-level assets,
     * "Model.fbx@subId" for sub-assets — with " (embedded)" appended for
     * materials baked into a model file (they usually should be replaced by a
     * project material). Engine built-ins (db://internal) label as
     * "builtin:<name>"; null when the reference is neither in the project
     * nor a known builtin.
     * @param {string} ref
     * @returns {string|null}
     */
    label(ref) {
        const resolved = this.resolve(ref);
        if (!resolved) return builtinLabel(ref);
        const { entry, subAsset } = resolved;
        if (!subAsset) return entry.name;
        const embedded = subAsset.importer === 'gltf-material' ? ' (embedded)' : '';
        return `${entry.name}@${subAsset.id}${embedded}`;
    }

    /** Friendly type names accepted by list()'s type filter */
    static get knownTypes() {
        return Object.keys(TYPE_ALIASES);
    }

    /** Distinct importer names present in the project (directories excluded) */
    importers() {
        const set = new Set(
            this.#entries.filter(e => e.importer !== 'directory').map(e => e.importer)
        );
        return [...set].sort();
    }

    /** True when the type filter can match anything: a known alias or an importer present in the project */
    isKnownType(type) {
        return normalizeType(type) in TYPE_ALIASES ||
               this.#entries.some(e => e.importer === type.toLowerCase());
    }

    /**
     * List assets with optional filters
     * @param {object} [filters]
     * @param {string} [filters.type] - Friendly alias (sprite, model, ...) or raw importer name
     * @param {string} [filters.folder] - Path prefix relative to project root or assets/
     * @param {string} [filters.pattern] - File-name filter: substring, or anchored wildcard when it contains * / ?
     * @returns {object[]} Matching entries (directories excluded unless type=directory)
     */
    list({ type, folder, pattern } = {}) {
        let result = this.#entries;

        if (type !== 'directory') {
            result = result.filter(e => e.importer !== 'directory');
        }

        if (type) {
            const aliasKey = normalizeType(type);
            const importers = TYPE_ALIASES[aliasKey] ?? [type.toLowerCase()];
            result = result.filter(e => importers.includes(e.importer));

            // 'sprite'/'spriteFrame' narrows images to those with a spriteFrame sub-asset
            if (aliasKey === 'sprite' || aliasKey === 'spriteframe') {
                result = result.filter(e => e.subAssets.some(s => s.importer === 'sprite-frame'));
            }
        }

        if (folder) {
            const prefix = this.#normalize(folder).toLowerCase().replace(/\/$/, '');
            result = result.filter(e => {
                const p = e.path.toLowerCase();
                return p.startsWith(`${prefix}/`) || p.startsWith(`assets/${prefix}/`);
            });
        }

        if (pattern) {
            const body = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
                                .replaceAll('*', '.*')
                                .replaceAll('?', '.');
            // Bare text means substring; wildcards anchor to the whole file name
            const re = new RegExp(/[*?]/.test(pattern) ? `^${body}$` : body, 'i');
            result = result.filter(e => re.test(e.name));
        }

        return result;
    }

    /**
     * compressed script UUID → class name (the meta name with its .ts/.js
     * extension stripped) — the form scripts appear as in component __type__.
     * The extension-stripping regex is the load-bearing shared detail; keeping
     * it here means every caller labels script components identically. Memoized.
     */
    scriptClassNames() {
        if (!this.#scriptClassNames) {
            this.#scriptClassNames = new Map(
                this.list({ type: 'script' }).map(e =>
                    [compressUuid(e.uuid), e.name.replace(/\.[jt]s$/, '')])
            );
        }
        return this.#scriptClassNames;
    }
}

function normalizeType(type) {
    return type.toLowerCase().replace(/[-_\s]/g, '');
}
