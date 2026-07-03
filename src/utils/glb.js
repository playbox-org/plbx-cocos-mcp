/**
 * Minimal GLB (binary glTF) reader
 *
 * Extracts per-mesh AABB from POSITION accessor min/max — glTF requires
 * min/max on POSITION accessors, so no binary buffer parsing is needed.
 * Used as a fallback when the Cocos library/ cache has no compiled mesh.
 */

import * as fs from 'fs';

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a; // "JSON"

/**
 * Read the JSON chunk of a .glb file
 * @param {string} filePath
 * @returns {object|null} Parsed glTF JSON, or null if not a valid GLB
 */
export function readGlbJson(filePath) {
    const buf = fs.readFileSync(filePath);
    if (buf.length < 20 || buf.readUInt32LE(0) !== GLB_MAGIC) return null;

    let offset = 12;
    while (offset + 8 <= buf.length) {
        const chunkLength = buf.readUInt32LE(offset);
        const chunkType = buf.readUInt32LE(offset + 4);
        if (chunkType === CHUNK_JSON) {
            const json = buf.toString('utf-8', offset + 8, offset + 8 + chunkLength);
            return JSON.parse(json);
        }
        offset += 8 + chunkLength;
    }
    return null;
}

/**
 * Extract AABB per mesh from a .glb file
 * @param {string} filePath
 * @returns {Array<{name: string, min: number[], max: number[]}>}
 */
export function extractMeshBounds(filePath) {
    const gltf = readGlbJson(filePath);
    if (!gltf?.meshes) return [];

    const bounds = [];

    gltf.meshes.forEach((mesh, idx) => {
        let min = null;
        let max = null;

        for (const prim of mesh.primitives ?? []) {
            const accessorIdx = prim.attributes?.POSITION;
            const accessor = gltf.accessors?.[accessorIdx];
            if (!accessor?.min || !accessor?.max) continue;

            min = min
                ? min.map((v, i) => Math.min(v, accessor.min[i]))
                : [...accessor.min];
            max = max
                ? max.map((v, i) => Math.max(v, accessor.max[i]))
                : [...accessor.max];
        }

        if (min && max) {
            bounds.push({ name: mesh.name ?? `mesh_${idx}`, min, max });
        }
    });

    return bounds;
}
