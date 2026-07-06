import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
    compressUuid, decompressUuid, isFullUuid, isCompressedUuid, splitSubAssetRef
} from '../../src/utils/uuid.js';

// Real pair verified against a production Cocos Creator 3.8 project:
// script meta uuid ↔ compressed __type__ in a .scene file
const FULL = '34eed213-ed8a-4324-8223-a47ca98b8685';
const COMPRESSED = '34eedIT7YpDJIIjpHypi4aF';

describe('uuid utils', () => {
    it('should compress a full UUID to the Cocos 23-char form', () => {
        assert.strictEqual(compressUuid(FULL), COMPRESSED);
    });

    it('should decompress back to the full dashed form', () => {
        assert.strictEqual(decompressUuid(COMPRESSED), FULL);
    });

    it('should round-trip arbitrary UUIDs', () => {
        const uuid = 'ecec319a-6a4c-448b-b5d5-3d500f0666aa';
        assert.strictEqual(decompressUuid(compressUuid(uuid)), uuid);
    });

    it('should return null for invalid compressed input', () => {
        assert.strictEqual(decompressUuid('not-a-uuid'), null);
        assert.strictEqual(decompressUuid(''), null);
        assert.strictEqual(decompressUuid(FULL), null);
    });

    it('should validate full and compressed forms', () => {
        assert.strictEqual(isFullUuid(FULL), true);
        assert.strictEqual(isFullUuid(COMPRESSED), false);
        assert.strictEqual(isCompressedUuid(COMPRESSED), true);
        assert.strictEqual(isCompressedUuid(FULL), false);
    });

    it('should split sub-asset references', () => {
        assert.deepStrictEqual(
            splitSubAssetRef(`${FULL}@f9941`),
            { uuid: FULL, subId: 'f9941' }
        );
        assert.deepStrictEqual(
            splitSubAssetRef(FULL),
            { uuid: FULL, subId: null }
        );
    });
});
