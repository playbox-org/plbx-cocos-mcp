/**
 * assetPaths - the containment check every tool that touches `assets/` shares
 *
 * A path string that starts with `<project>/assets/` is not proof that the write
 * lands inside the project: with `assets/ext -> /outside` on disk, the unresolved
 * `assets/ext/Foo.prefab` passes a plain prefix test while the write follows the
 * link. So BOTH sides are canonicalized before the prefix test — and the target
 * through its closest EXISTING ancestor, because a file about to be created has no
 * realpath of its own yet.
 */

import * as fs from 'fs';
import * as path from 'path';

/** Canonical path (symlinks resolved); the input itself when it does not exist */
export function realpathOrSelf(p) {
    try { return fs.realpathSync(p); } catch { return p; }
}

/**
 * Canonical path for a target that need not exist yet: realpath the closest existing
 * ancestor and re-append the rest.
 * @param {string} target - Absolute or cwd-relative path
 * @returns {string}
 */
export function realpathTarget(target) {
    const abs = path.resolve(target);
    const rest = [];
    let cur = abs;
    for (;;) {
        try {
            return path.join(fs.realpathSync(cur), ...rest);
        } catch {
            const parent = path.dirname(cur);
            if (parent === cur) return abs;
            rest.unshift(path.basename(cur));
            cur = parent;
        }
    }
}

/**
 * Containment verdict for two paths that are ALREADY canonical.
 *
 * The separator suffix is what keeps `<proj>/assets-backup` from passing as being
 * under `<proj>/assets`.
 *
 * @param {string} abs - Canonical candidate
 * @param {string} assetsRoot - Canonical assets/ directory
 * @param {{allowRoot?: boolean}} [options] - allowRoot: `assets/` itself counts as inside
 * @returns {boolean}
 */
export function isInsideAssets(abs, assetsRoot, options = {}) {
    if (abs === assetsRoot) return options.allowRoot === true;
    return abs.startsWith(assetsRoot + path.sep);
}

/**
 * Resolve an asset reference against a project and answer where it lands.
 *
 * `requested` is the caller's own path, resolved but NOT canonicalized: what the file
 * is named is the caller's decision, so an extension check belongs on that string —
 * following a link first would let the target's name answer a question about the source.
 *
 * @param {string} projectRoot
 * @param {string} ref - Project-relative (or absolute) path; need not exist
 * @param {{allowRoot?: boolean}} [options] - allowRoot: `assets/` itself counts as inside
 * @returns {{path: string, requested: string, assetsRoot: string, inside: boolean}}
 */
export function resolveInAssets(projectRoot, ref, options = {}) {
    const assetsRoot = realpathOrSelf(path.resolve(projectRoot, 'assets'));
    const requested = path.resolve(projectRoot, ref);
    const abs = realpathTarget(requested);
    return { path: abs, requested, assetsRoot, inside: isInsideAssets(abs, assetsRoot, options) };
}
