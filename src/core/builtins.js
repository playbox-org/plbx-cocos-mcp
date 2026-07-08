/**
 * Engine built-in assets (db://internal) — static table lookup
 *
 * Cocos scenes routinely reference editor-internal assets (primitive meshes,
 * default materials/effects/sprite frames) whose UUIDs exist in no project
 * .meta. The table in src/assets-data/builtins-3.8.json is harvested from an
 * installed Cocos Creator 3.8.7 (scripts/harvest-builtins.mjs); lookups here
 * let read tools label such references `builtin:<name>` and let the
 * validator tell a real broken reference from an engine built-in.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { splitSubAssetRef, isFullUuid, isCompressedUuid, decompressUuid } from '../utils/uuid.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TABLE_FILE = path.join(__dirname, '..', 'assets-data', 'builtins-3.8.json');

let table = null; // lazy: {engine, byUuid: Map, byPath: Map}

function load() {
    if (table) return table;
    const byUuid = new Map();
    const byPath = new Map();
    let engine = 'unknown';
    // Fail-soft: a missing/corrupt table must degrade to "no builtin
    // matches" (labels fall back to null, the validator warns again) —
    // never crash the read pipeline.
    try {
        const parsed = JSON.parse(fs.readFileSync(TABLE_FILE, 'utf-8'));
        for (const asset of parsed.assets) {
            byUuid.set(asset.uuid.toLowerCase(), asset);
            byPath.set(asset.path.toLowerCase(), asset);
        }
        engine = parsed.engine ?? engine;
    } catch {
        // table stays empty
    }
    table = { engine, byUuid, byPath };
    return table;
}

/**
 * Resolve a reference against the builtin table: full/compressed UUID,
 * "<uuid>@<subId>", or an internal path ("primitives.fbx").
 * @returns {{entry: object, subAsset: object|null, engine: string}|null}
 */
export function resolveBuiltin(ref) {
    if (typeof ref !== 'string' || ref === '') return null;
    const { byUuid, byPath, engine } = load();
    const { uuid, subId } = splitSubAssetRef(ref);

    let entry = null;
    if (isFullUuid(uuid)) {
        entry = byUuid.get(uuid.toLowerCase()) ?? null;
    } else if (isCompressedUuid(uuid)) {
        const full = decompressUuid(uuid);
        entry = full ? byUuid.get(full) ?? null : null;
    } else {
        entry = byPath.get(uuid.toLowerCase().replace(/^db:\/\/internal\//, '')) ?? null;
    }
    if (!entry) return null;

    if (!subId) return { entry, subAsset: null, engine };
    const subAsset = (entry.subAssets ?? []).find(s => s.id === subId);
    return subAsset ? { entry, subAsset, engine } : null;
}

/**
 * Display label for a builtin reference: `builtin:<name>` for the asset,
 * `builtin:<subName>` (falling back to `builtin:<name>@<subId>`) for
 * sub-assets. Null when the reference is not a known builtin.
 */
export function builtinLabel(ref) {
    const hit = resolveBuiltin(ref);
    if (!hit) return null;
    if (!hit.subAsset) return `builtin:${hit.entry.name}`;
    return hit.subAsset.name
        ? `builtin:${hit.subAsset.name}`
        : `builtin:${hit.entry.name}@${hit.subAsset.id}`;
}

/** True when the (sub-)reference is a known engine builtin */
export function isBuiltin(ref) {
    return resolveBuiltin(ref) !== null;
}
