/**
 * One-off harvester: engine built-in asset UUIDs → src/assets-data/builtins-3.8.json
 *
 * Scans the editor's internal asset db (db://internal) of an installed
 * Cocos Creator — every *.meta under editor/assets — and emits a static
 * table the MCP server ships with, so builtin UUIDs referenced by scenes
 * (primitives, default materials/effects, sprite frames, …) resolve to
 * names instead of "Asset not found".
 *
 * Usage:
 *   node scripts/harvest-builtins.mjs [path-to-CocosCreator.app-engine-dir]
 * Default engine dir:
 *   /Applications/Cocos/Creator/3.8.7/CocosCreator.app/Contents/Resources/resources/3d/engine
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ENGINE =
    '/Applications/Cocos/Creator/3.8.7/CocosCreator.app/Contents/Resources/resources/3d/engine';

const engineDir = process.argv[2] ?? DEFAULT_ENGINE;
const assetsDir = path.join(engineDir, 'editor', 'assets');
if (!fs.existsSync(assetsDir)) {
    console.error(`Engine internal db not found: ${assetsDir}`);
    process.exit(1);
}

const version = /\/(\d+\.\d+\.\d+)\//.exec(engineDir)?.[1] ??
    JSON.parse(fs.readFileSync(path.join(engineDir, 'package.json'), 'utf-8')).version;

const assets = [];
const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walk(full);
        } else if (entry.name.endsWith('.meta')) {
            let meta;
            try {
                meta = JSON.parse(fs.readFileSync(full, 'utf-8'));
            } catch {
                continue;
            }
            if (!meta.uuid || meta.importer === 'directory') continue;
            const rel = path.relative(assetsDir, full.slice(0, -'.meta'.length))
                .replaceAll(path.sep, '/');
            const subAssets = Object.entries(meta.subMetas ?? {}).map(([id, sub]) => ({
                id,
                name: sub.name ?? sub.displayName ?? '',
                importer: sub.importer ?? ''
            }));
            assets.push({
                uuid: meta.uuid,
                path: rel,
                name: path.basename(rel),
                importer: meta.importer,
                ...(subAssets.length ? { subAssets } : {})
            });
        }
    }
};
walk(assetsDir);
assets.sort((a, b) => a.path.localeCompare(b.path));

const out = {
    engine: version,
    source: 'editor/assets (db://internal) of Cocos Creator ' + version,
    harvestedAt: new Date().toISOString().slice(0, 10),
    assets
};
const outFile = path.join(__dirname, '..', 'src', 'assets-data', 'builtins-3.8.json');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(out, null, 2) + '\n', 'utf-8');
console.log(`Wrote ${assets.length} builtin assets (engine ${version}) → ${outFile}`);
