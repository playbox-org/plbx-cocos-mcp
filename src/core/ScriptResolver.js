/**
 * ScriptResolver - Single Responsibility: Resolve UUID to script names
 *
 * SOLID: S - Only responsible for UUID-to-name mapping
 * SOLID: D - Can be injected as dependency, abstracts UUID resolution
 */

import * as fs from 'fs';
import * as path from 'path';

export class ScriptResolver {
    #byPrefix = new Map();
    #byFullUuid = new Map();

    /**
     * @param {string} projectRoot - Path to Cocos project root
     */
    constructor(projectRoot) {
        const scriptsDir = path.join(projectRoot, 'assets', 'Scripts');
        this.#scanDirectory(scriptsDir);
    }

    #scanDirectory(dir) {
        if (!fs.existsSync(dir)) return;

        const entries = fs.readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);

            if (entry.isDirectory()) {
                this.#scanDirectory(fullPath);
            } else if (entry.name.endsWith('.ts.meta')) {
                this.#processMeta(fullPath, entry.name);
            }
        }
    }

    #processMeta(fullPath, fileName) {
        try {
            const meta = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
            if (!meta.uuid) return;

            const scriptName = fileName.replace('.ts.meta', '');

            // Store by full UUID
            this.#byFullUuid.set(meta.uuid, scriptName);
            this.#byFullUuid.set(meta.uuid.replace(/-/g, ''), scriptName);

            // Store by prefix (first 5 chars match scene type prefix)
            const prefix = meta.uuid.replace(/-/g, '').slice(0, 5);
            this.#byPrefix.set(prefix, scriptName);
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

        // Try full UUID match
        if (this.#byFullUuid.has(type)) {
            return this.#byFullUuid.get(type);
        }

        // Try prefix match (Cocos compressed UUID)
        const prefix = type.slice(0, 5);
        if (this.#byPrefix.has(prefix)) {
            return this.#byPrefix.get(prefix);
        }

        return `Script:${type.slice(0, 8)}`;
    }

    /**
     * Check if type is a custom script (not built-in)
     */
    isCustomScript(type) {
        return !type.startsWith('cc.') && /^[a-zA-Z0-9+/]{15,}$/.test(type);
    }
}
