/**
 * Shared measurement helpers for GetNodeBounds / ComputeFitScale
 */

import { AssetIndex } from '../core/AssetIndex.js';
import { AssetInspector } from '../core/AssetInspector.js';

export function buildBoundsContext(projectRoot) {
    const assetIndex = AssetIndex.shared(projectRoot);
    const assetInspector = new AssetInspector(projectRoot, assetIndex);
    return { assetIndex, assetInspector, projectRoot };
}

export function fmt(n) {
    if (typeof n !== 'number' || !isFinite(n)) return String(n);
    return String(Math.round(n * 10000) / 10000);
}

export function fmtVec(v) {
    return `(${fmt(v.x)}, ${fmt(v.y)}, ${fmt(v.z)})`;
}
