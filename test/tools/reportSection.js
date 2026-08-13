/**
 * Shared test helper: parse one `## <name>` section out of a tool report.
 *
 * Lives next to the tests that use it — the test tree has no helpers/ convention — and is
 * shared because build_terrain and edit_terrain assert the SAME header-vs-bullets invariant
 * (the count in the header against the bullets under it), which two copies are free to drift on.
 * Not named `*.test.js`, so the `test/**\/*.test.js` runner glob leaves it alone.
 */

/**
 * One `## <name>` section of a report: its bullets and the count in its header (null if absent).
 * A trailing elision line is not a bullet, so `count === bullets.length` only holds uncapped.
 * @param {string} report
 * @param {string} name
 * @returns {{count: number|null, bullets: string[]}|null}
 */
export function section(report, name) {
    const lines = report.split('\n');
    const start = lines.findIndex((l) => l.startsWith(`## ${name}`));
    if (start < 0) return null;
    const bullets = [];
    for (let i = start + 1; i < lines.length && lines[i].startsWith('- '); i++) {
        bullets.push(lines[i].slice(2));
    }
    const count = lines[start].match(/\((\d+)\)/);
    return { count: count ? Number(count[1]) : null, bullets };
}
