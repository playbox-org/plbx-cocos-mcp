/**
 * validateArgs - MCP tool argument normalization & validation
 *
 * The MCP SDK passes tool arguments through unvalidated, so a wrong
 * parameter name used to surface as Node's cryptic
 * `The "paths[1]" argument must be of type string. Received undefined`
 * out of path.resolve(projectRoot, undefined). This runs before execute():
 * maps accepted aliases onto canonical names, rejects unknown keys with a
 * suggestion, and checks required/type/enum constraints so the caller can
 * correct the call from the error text alone.
 */

const TYPE_OK = {
    string: (v) => typeof v === 'string',
    number: (v) => typeof v === 'number' && Number.isFinite(v),
    integer: (v) => Number.isInteger(v),
    boolean: (v) => typeof v === 'boolean',
    array: (v) => Array.isArray(v),
    object: (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
};

/**
 * @param {object} args - Raw arguments from the MCP client
 * @param {object} schema - The tool's inputSchema (type: 'object')
 * @param {Record<string, string>} aliases - {aliasKey: canonicalKey}, applied
 *   before validation; the canonical key wins if both are present
 * @returns {{args: object, error: string|null}}
 */
export function normalizeArgs(args, schema, aliases = {}) {
    const props = schema?.properties ?? {};
    const required = schema?.required ?? [];
    const normalized = { ...args };
    const problems = [];

    for (const [alias, canonical] of Object.entries(aliases)) {
        if (!(alias in normalized)) continue;
        if (!(canonical in normalized)) normalized[canonical] = normalized[alias];
        delete normalized[alias];
    }

    for (const key of Object.keys(normalized)) {
        if (key in props) continue;
        const hint = suggestParam(key, props);
        problems.push(`unknown parameter "${key}"${hint ? ` — did you mean "${hint}"?` : ''}`);
    }

    for (const key of required) {
        if (normalized[key] === undefined) {
            problems.push(`missing required parameter "${key}"`);
        }
    }

    for (const [key, value] of Object.entries(normalized)) {
        const prop = props[key];
        if (!prop || value === undefined) continue;
        problems.push(...checkValue(key, value, prop));
    }

    if (problems.length === 0) {
        return { args: normalized, error: null };
    }

    return {
        args: normalized,
        error: `Invalid arguments: ${problems.join('; ')}.\n` +
               `Valid parameters: ${describeParams(props, required)}`
    };
}

function checkValue(key, value, prop) {
    const check = TYPE_OK[prop.type];
    if (check && !check(value)) {
        return [`parameter "${key}" must be of type ${prop.type}, got ${typeName(value)}`];
    }
    if (prop.enum && !prop.enum.includes(value)) {
        return [`parameter "${key}" must be one of ${prop.enum.map(e => JSON.stringify(e)).join(', ')}`];
    }
    if (prop.type === 'array') {
        if (prop.minItems !== undefined && value.length < prop.minItems) {
            return [`parameter "${key}" needs at least ${prop.minItems} item(s)`];
        }
        if (prop.items) {
            for (let i = 0; i < value.length; i++) {
                const bad = checkValue(`${key}[${i}]`, value[i], prop.items);
                if (bad.length) return bad;
            }
        }
    }
    return [];
}

function typeName(v) {
    if (v === null) return 'null';
    return Array.isArray(v) ? 'array' : typeof v;
}

function suggestParam(key, props) {
    const names = Object.keys(props);

    // A wrong file-path key (path, file, scenePath on a prefabPath tool, ...)
    // almost always means the schema's own path parameter
    if (/path|file|scene|prefab/i.test(key)) {
        const pathParam = names.find(n => /path/i.test(n) && props[n].type === 'string');
        if (pathParam && pathParam !== key) return pathParam;
    }

    let best = null;
    let bestDist = Infinity;
    for (const name of names) {
        const d = levenshtein(key.toLowerCase(), name.toLowerCase());
        if (d < bestDist) {
            bestDist = d;
            best = name;
        }
    }
    return best !== null && bestDist <= Math.max(2, Math.floor(best.length / 3)) ? best : null;
}

function describeParams(props, required) {
    const parts = Object.entries(props).map(([name, p]) => {
        const kind = p.enum
            ? p.enum.map(e => JSON.stringify(e)).join('|')
            : (p.type ?? 'any');
        return `${name} (${kind}${required.includes(name) ? ', required' : ''})`;
    });
    return parts.length ? parts.join(', ') : 'none';
}

function levenshtein(a, b) {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        for (let j = 1; j <= b.length; j++) {
            cur[j] = Math.min(
                prev[j] + 1,
                cur[j - 1] + 1,
                prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
            );
        }
        prev = cur;
    }
    return prev[b.length];
}
