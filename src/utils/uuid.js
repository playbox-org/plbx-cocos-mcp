/**
 * UUID utilities for Cocos Creator assets
 *
 * Cocos compresses asset UUIDs when serializing scenes/prefabs:
 * the first 5 hex chars are kept as-is, the remaining 27 hex chars
 * are packed 3-hex → 2-base64 chars (verified on real project data).
 * Full form:  "34eed213-ed8a-4324-8223-a47ca98b8685"
 * Compressed: "34eedIT7YpDJIIjpHypi4aF"
 *
 * Sub-assets use the "<uuid>@<subId>" form (e.g. "@f9941" = spriteFrame,
 * "@6c48a" = texture2D).
 */

import { createHash } from 'crypto';

const BASE64_KEYS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_VALUES = new Map([...BASE64_KEYS].map((c, i) => [c, i]));

const FULL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMPRESSED_RE = /^[0-9a-f]{5}[0-9a-zA-Z+/]{18}$/;

const NAME_TO_ID_EXTEND = [
    1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14,
    15, 17, 18, 19, 20, 21, 22, 23, 24, 26, 27, 28, 29, 30
];

/**
 * Sub-asset id from its name — port of Cocos `nameToId`
 * (npm @cocos/asset-db, libs/utils.js): 5 chars sampled from the md5-hex of
 * the name at positions 0, 6, 16, 25, 31, plus `extend` more on collision.
 * "texture" → "6c48a", "spriteFrame" → "f9941" (verified on real metas).
 * @param {string} name - Sub-asset name (the subMeta's `name` field)
 * @param {number} [extend] - Extra chars appended on id collision
 * @returns {string}
 */
export function nameToId(name, extend = 0) {
    const h = createHash('md5').update(name).digest('hex');
    let id = h[0] + h[6] + h[16] + h[25] + h[31];
    for (let i = 0; i < extend; i++) id += h[NAME_TO_ID_EXTEND[i]];
    return id;
}

/**
 * Split "<uuid>@<subId>" into { uuid, subId }. subId is null when absent.
 * @param {string} ref
 * @returns {{uuid: string, subId: string|null}}
 */
export function splitSubAssetRef(ref) {
    const at = ref.indexOf('@');
    if (at === -1) return { uuid: ref, subId: null };
    return { uuid: ref.slice(0, at), subId: ref.slice(at + 1) };
}

/**
 * Check if a string is a full dashed UUID (without sub-asset suffix)
 */
export function isFullUuid(str) {
    return FULL_UUID_RE.test(str);
}

/**
 * Check if a string looks like a Cocos compressed UUID
 */
export function isCompressedUuid(str) {
    return COMPRESSED_RE.test(str);
}

/**
 * Compress a full dashed UUID into the 23-char Cocos form
 * @param {string} uuid - "34eed213-ed8a-4324-8223-a47ca98b8685"
 * @returns {string} "34eedIT7YpDJIIjpHypi4aF"
 */
export function compressUuid(uuid) {
    const hex = uuid.replace(/-/g, '');
    let out = hex.slice(0, 5);
    for (let i = 5; i < hex.length; i += 3) {
        const value = parseInt(hex.slice(i, i + 3), 16);
        out += BASE64_KEYS[value >> 6] + BASE64_KEYS[value & 63];
    }
    return out;
}

/**
 * Decompress a 23-char Cocos UUID back to the full dashed form.
 * Returns null if the input is not a valid compressed UUID.
 * @param {string} compressed - "34eedIT7YpDJIIjpHypi4aF"
 * @returns {string|null} "34eed213-ed8a-4324-8223-a47ca98b8685"
 */
export function decompressUuid(compressed) {
    if (!isCompressedUuid(compressed)) return null;

    let hex = compressed.slice(0, 5);
    for (let i = 5; i < compressed.length; i += 2) {
        const hi = BASE64_VALUES.get(compressed[i]);
        const lo = BASE64_VALUES.get(compressed[i + 1]);
        if (hi === undefined || lo === undefined) return null;
        hex += ((hi << 6) | lo).toString(16).padStart(3, '0');
    }

    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
           `${hex.slice(16, 20)}-${hex.slice(20)}`;
}
