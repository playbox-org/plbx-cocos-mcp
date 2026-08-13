/**
 * terrainCard - the compact `readTerrainInfo` card shared by build_terrain and edit_terrain
 *
 * Both tools answer with "here is the terrain that is now on disk", from the same
 * `readTerrainInfo`/`terrainInfoFromData` object, so they must print the same numbers in
 * the same shape: building a terrain and then editing it without changing anything used to
 * produce two visibly different cards over identical bytes.
 *
 * query_terrain deliberately keeps its own, far wider rendering (tables, per-channel
 * coverage, sampling sections) — this is the summary, not that report.
 */

/**
 * @param {object|null} info - `readTerrainInfo`/`terrainInfoFromData` result
 * @param {object} [assetIndex] - Resolves layer texture ids to names; ids are printed raw without it
 * @returns {string[]} report lines
 */
export function terrainCard(info, assetIndex) {
    if (!info) return ['(the written file could not be re-read as a terrain — this is a bug)'];
    const [w, d] = info.size;
    const [vx, vz] = info.vertexCount;
    const [ux, uz] = info.weightMapTexels;
    const lines = [
        '## Terrain',
        `Size: ${fmt(w)} x ${fmt(d)} m (${info.blockCount[0]} x ${info.blockCount[1]} blocks, ${vx} x ${vz} vertices)`,
        `tileSize: ${fmt(info.tileSize)} m | weightMapSize: ${info.weightMapSize} (${ux} x ${uz} texels) | lightMapSize: ${info.lightMapSize}`,
        `Height: ${fmt(info.heightMin)} .. ${fmt(info.heightMax)} m (mean ${fmt(info.heightMean)})${info.isFlat ? ' — flat' : ''}`,
        `File: ${info.fileSize} bytes (${info.payloadLength} payload + ${info.padding} zero padding), ${info.versionLabel}`
    ];

    // Weight data dominates a terrain binary and grows with
    // `blockCount[0] * blockCount[1] * weightMapSize^2 * 4`, then the whole file is rounded
    // up to the next power of two. A perfectly ordinary "512 x 512 m" request lands 33 MB in
    // `assets/`, so anything above the threshold says so, cheaper setting spelled out.
    if (info.fileSize > LARGE_ASSET_BYTES) {
        const blocks = info.blockCount[0] * info.blockCount[1];
        const cheaper = Math.max(4, Math.min(info.weightMapSize, 32));
        const weightBytes = blocks * info.weightMapSize * info.weightMapSize * 4;
        const line = `Large asset: ${mb(info.fileSize)} (${mb(info.padding)} of it pow-2 padding); ` +
            `${mb(weightBytes)} is weight data = ${blocks} blocks x ${info.weightMapSize}^2 texels x 4 channels.`;
        lines.push(cheaper < info.weightMapSize
            ? `${line} weightMapSize ${cheaper} would need about ` +
              `${mb(blocks * cheaper * cheaper * 4)} of weight data instead.`
            : line);
    }

    if (info.layers.length === 0) {
        lines.push('Layers: none — every block renders the effect\'s flat grey fallback');
    } else {
        lines.push('Layers:');
        for (const layer of info.layers) {
            const usage = info.layerUsage.find((u) => u.slot === layer.slot);
            const normal = layer.normalMapId
                ? `, normal ${assetIndex?.label(layer.normalMapId) ?? layer.normalMapId}`
                : '';
            lines.push(
                `  ${layer.slot}. ${assetIndex?.label(layer.detailMapId) ?? layer.detailMapId} ` +
                `(tileSize ${fmt(layer.tileSize)} m, roughness ${fmt(layer.roughness)}, ` +
                `metallic ${fmt(layer.metallic)}${normal}) — used by ` +
                `${usage?.blocks.length ?? 0} block(s)` +
                (usage ? `, coverage ${(usage.coverage * 100).toFixed(1)}%` : '')
            );
        }
    }

    // Small terrains: the per-block slot assignment is the thing paint_layer changes and
    // the cheapest way to see that it landed.
    if (info.blockLayers.length > 0 && info.blockLayers.length <= 16) {
        lines.push(`Block slots: ${info.blockLayers.map((s) => `[${s.join(',')}]`).join(' ')} (row-major, R/G/B/A per block)`);
    }
    // Without this line a report has no way of showing that a block ended up single-layer,
    // which is exactly how a paint spills over a whole neighbouring block unnoticed.
    const sole = info.blockLayers.filter((s) => s[0] >= 0 && s[1] < 0 && s[2] < 0 && s[3] < 0).length;
    if (sole) {
        lines.push(
            `${sole} block(s) assign only channel R — the shader draws that layer flat over the ` +
            'whole block there and never samples the weight map.'
        );
    }
    return lines;
}

/** Compact metre formatting: no trailing zeros, null-safe */
function fmt(v, digits = 3) {
    if (v === null || v === undefined) return 'n/a';
    return String(Number(v.toFixed(digits)));
}

/** MB with one decimal, for the large-asset note */
function mb(bytes) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const LARGE_ASSET_BYTES = 8 * 1024 * 1024;
