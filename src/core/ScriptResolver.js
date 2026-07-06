/**
 * ScriptResolver - Single Responsibility: Resolve UUID to script names
 *
 * SOLID: S - Only responsible for UUID-to-name mapping
 * SOLID: D - Can be injected as dependency, abstracts UUID resolution
 */

import * as fs from 'fs';
import * as path from 'path';
import { compressUuid } from '../utils/uuid.js';

export class ScriptResolver {
    #byCompressedUuid = new Map();

    /**
     * @param {string} projectRoot - Path to Cocos project root
     */
    constructor(projectRoot) {
        this.#scanDirectory(path.join(projectRoot, 'assets'));
    }

    #scanDirectory(dir) {
        if (!fs.existsSync(dir)) return;

        const entries = fs.readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);

            if (entry.isDirectory()) {
                this.#scanDirectory(fullPath);
            } else if (/\.(ts|js)\.meta$/.test(entry.name)) {
                this.#processMeta(fullPath, entry.name);
            }
        }
    }

    #processMeta(fullPath, fileName) {
        try {
            const meta = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
            if (!meta.uuid) return;

            const scriptName = fileName.replace(/\.(ts|js)\.meta$/, '');

            // Scene files reference scripts by compressed UUID (__type__)
            this.#byCompressedUuid.set(compressUuid(meta.uuid), scriptName);
        } catch {
            // Skip invalid meta files
        }
    }

    /**
     * Resolve a type string to human-readable name
     * @param {string} type - Type from scene file
     * @returns {string} Resolved name
     */
    resolve(type) {
        // Built-in types
        if (type.startsWith('cc.')) {
            return type.replace('cc.', '');
        }

        // Exact compressed UUID match
        const name = this.#byCompressedUuid.get(type);
        if (name) return name;

        return `Script:${type.slice(0, 8)}`;
    }
}
