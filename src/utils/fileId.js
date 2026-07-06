/**
 * fileId / node _id generation for Cocos Creator documents
 *
 * The editor uses 22-char base64-alphabet strings (A-Za-z0-9+/) for
 * PrefabInfo.fileId, CompPrefabInfo.fileId, PrefabInstance.fileId and
 * node/component _id in scenes (verified on real 3.8.7 files, e.g.
 * "0auORVX99QSYHjxYweQevA", "c0y6F5f+pAvI805TdmxIjx").
 */

import { randomBytes } from 'crypto';

const BASE64_KEYS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Generate a random 22-char id in the editor's alphabet.
 * @param {Set<string>} [taken] - Existing ids to avoid colliding with
 * @returns {string}
 */
export function generateFileId(taken) {
    for (;;) {
        const bytes = randomBytes(22);
        let id = '';
        for (let i = 0; i < 22; i++) {
            id += BASE64_KEYS[bytes[i] & 63];
        }
        if (!taken || !taken.has(id)) return id;
    }
}
