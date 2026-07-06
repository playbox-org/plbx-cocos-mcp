/**
 * ProjectInfoReader - Single Responsibility: Read Cocos Creator project settings
 *
 * Sources (all optional except package.json):
 * - package.json                        → project name/uuid, creator.version
 * - settings/v2/packages/project.json   → designResolution, custom layers, physics config
 * - settings/v2/packages/engine.json    → enabled engine modules (2d/3d, physics backend)
 *
 * SOLID: S - Only responsible for reading project-level configuration
 */

import * as fs from 'fs';
import * as path from 'path';

/** Built-in cc.Layers values (bits 0–19 are free for user layers) */
export const BUILTIN_LAYERS = {
    IGNORE_RAYCAST: 1 << 20,
    GIZMOS: 1 << 21,
    EDITOR: 1 << 22,
    UI_3D: 1 << 23,
    SCENE_GIZMO: 1 << 24,
    UI_2D: 1 << 25,
    PROFILER: 1 << 28,
    DEFAULT: 1 << 30
};

export class ProjectInfoReader {
    #projectRoot;

    /**
     * @param {string} projectRoot - Path to Cocos project root
     */
    constructor(projectRoot) {
        this.#projectRoot = projectRoot;
    }

    /**
     * Read all available project info
     * @returns {object}
     */
    read() {
        const pkg = this.#readJson('package.json');
        const project = this.#readJson('settings/v2/packages/project.json');
        const engine = this.#readJson('settings/v2/packages/engine.json');

        return {
            projectName: pkg?.name ?? null,
            projectUuid: pkg?.uuid ?? null,
            engineVersion: this.detectEngineVersion(pkg),
            designResolution: project?.general?.designResolution ?? null,
            layers: {
                builtin: BUILTIN_LAYERS,
                custom: this.#readCustomLayers(project)
            },
            physics: this.#readPhysics(project, engine),
            modules: this.#readModules(engine)
        };
    }

    /**
     * Detect engine version from game project's package.json
     * @param {object|null} [pkg] - Pre-read package.json contents (avoids re-reading)
     * @returns {string|null} e.g. "3.8.7"
     */
    detectEngineVersion(pkg = this.#readJson('package.json')) {
        return pkg?.creator?.version ?? null;
    }

    #readCustomLayers(project) {
        // Project Settings → Layers; stored as [{name, value}] (bits 0–19)
        const layers = project?.layer;
        if (!Array.isArray(layers)) return [];
        return layers
            .filter(l => l && typeof l.name === 'string')
            .map(l => ({ name: l.name, value: l.value }));
    }

    #readPhysics(project, engine) {
        const config = project?.physics ?? {};
        const groups = Array.isArray(config.collisionGroups) ? config.collisionGroups : [];

        return {
            engine3d: this.#moduleOption(engine, 'physics'),
            engine2d: this.#moduleOption(engine, 'physics-2d'),
            gravity: config.gravity ?? null,
            // Group 0 is always DEFAULT; custom groups occupy indices 1–31
            collisionGroups: [{ index: 0, name: 'DEFAULT' }, ...groups],
            collisionMatrix: config.collisionMatrix ?? null
        };
    }

    #readModules(engine) {
        const cache = engine?.modules?.configs?.defaultConfig?.cache;
        if (!cache) return null;

        const enabled = Object.entries(cache)
            .filter(([, v]) => v?._value === true)
            .map(([name]) => name);

        return {
            has3d: cache['3d']?._value === true,
            has2d: cache['2d']?._value === true,
            enabled
        };
    }

    #moduleOption(engine, moduleName) {
        const mod = engine?.modules?.configs?.defaultConfig?.cache?.[moduleName];
        if (!mod || mod._value !== true) return null;
        return mod._option ?? moduleName;
    }

    #readJson(relPath) {
        const fullPath = path.join(this.#projectRoot, relPath);
        try {
            return JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
        } catch {
            return null;
        }
    }
}
