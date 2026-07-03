/**
 * MiniTree - minified subtree rendering for apply_edits responses
 *
 * After each operation the model needs to see the result without re-reading
 * the scene (~100-300 tokens per affected area).
 */

import { isRef } from './SceneDocument.js';

function fmtNum(n) {
    if (typeof n !== 'number') return String(n);
    const rounded = Math.round(n * 1000) / 1000;
    return String(rounded);
}

function fmtVec(v) {
    if (!v || typeof v !== 'object') return '?';
    return [v.x, v.y, v.z].map(fmtNum).join(',');
}

/**
 * Render a node subtree as indented text.
 * @param {import('./SceneDocument.js').SceneDocument} doc
 * @param {number} nodeIdx
 * @param {{maxDepth?: number, scriptNames?: Map<string, string>}} [options]
 *        scriptNames: compressed UUID → readable script name
 * @returns {string}
 */
export function renderSubtree(doc, nodeIdx, { maxDepth = 3, scriptNames } = {}) {
    const lines = [];

    const describe = (idx, depth) => {
        const indent = '  '.repeat(depth);
        const node = doc.getObject(idx);
        const name = doc.nodeName(idx) ?? '<unnamed>';

        if (doc.isInstanceStub(idx)) {
            lines.push(`${indent}${name} [prefab instance]`);
            return;
        }

        const parts = [name];
        if (node._active === false) parts.push('(inactive)');

        const pos = node._lpos;
        if (pos && (pos.x || pos.y || pos.z)) parts.push(`pos(${fmtVec(pos)})`);
        const scale = node._lscale;
        if (scale && (scale.x !== 1 || scale.y !== 1 || scale.z !== 1)) {
            parts.push(`scale(${fmtVec(scale)})`);
        }
        const euler = node._euler;
        if (euler && (euler.x || euler.y || euler.z)) parts.push(`rot(${fmtVec(euler)})`);

        const comps = doc.componentIndices(idx).map(c => {
            const type = doc.getObject(c).__type__;
            if (type.startsWith('cc.')) return type.slice(3);
            return scriptNames?.get(type) ?? `script:${type.slice(0, 8)}…`;
        });
        if (comps.length) parts.push(`[${comps.join(', ')}]`);

        lines.push(indent + parts.join(' '));

        const children = doc.childIndices(idx);
        if (depth + 1 > maxDepth) {
            if (children.length) lines.push(`${indent}  … ${children.length} child(ren) collapsed`);
            return;
        }
        for (const child of children) describe(child, depth + 1);
    };

    describe(nodeIdx, 0);
    return lines.join('\n');
}
