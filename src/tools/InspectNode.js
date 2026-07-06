/**
 * InspectNode - MCP tool for drilling into a specific node's subtree
 *
 * Complements query_scene_graph: that tool gives a filtered overview,
 * this tool gives full unfiltered detail for a single node.
 */

import * as fs from 'fs';
import * as path from 'path';
import { BaseTool } from './BaseTool.js';
import { SceneMinifier } from '../core/SceneMinifier.js';
import { AssetIndex } from '../core/AssetIndex.js';
import { TextFormatter } from '../formatters/TextFormatter.js';
import { JsonFormatter } from '../formatters/JsonFormatter.js';
import { SceneDocument, isRef } from '../document/SceneDocument.js';
import { loadSourcePrefabByUuid, removedComponentEntries } from '../document/instances.js';
import { fileIdTargets } from '../document/targetOverrides.js';
import { compressUuid } from '../utils/uuid.js';

export class InspectNode extends BaseTool {
    get name() {
        return 'inspect_node';
    }

    get description() {
        return 'Drill into a specific node in a Cocos Creator scene or prefab. ' +
               'Returns the full unfiltered subtree with all properties. ' +
               'On a collapsed prefab instance it expands the source prefab internals ' +
               '(read-only) with target paths for set_instance_property, plus the ' +
               'current override list. ' +
               'Use nodeId (from #N in detailed mode) for precision, or nodeName to search. ' +
               'Args: {filePath (required), nodeId? | nodeName?, format?: "text"|"json"} — ' +
               'nodeName accepts a plain name ("BuyBtn") or a path ("Canvas/Panel/BuyBtn").';
    }

    get aliases() {
        return { node: 'nodeName' };
    }

    get inputSchema() {
        return {
            type: 'object',
            properties: {
                filePath: {
                    type: 'string',
                    description: "Path to .scene or .prefab file relative to project root"
                },
                nodeId: {
                    type: 'number',
                    description: "Node index from #N suffix in detailed mode output (e.g., 42 from '→Player#42')"
                },
                nodeName: {
                    type: 'string',
                    description: "Node name to search for, or a path like 'Canvas/Panel/BuyBtn'. If multiple matches, returns a disambiguation list."
                },
                format: {
                    type: 'string',
                    enum: ['text', 'json'],
                    description: "Output format",
                    default: 'text'
                }
            },
            required: ['filePath']
        };
    }

    async execute(args, projectRoot) {
        const filePath = path.resolve(projectRoot, args.filePath);

        if (!fs.existsSync(filePath)) {
            return this.error(`File not found: ${filePath}`);
        }

        if (args.nodeId === undefined && !args.nodeName) {
            return this.error('Either nodeId or nodeName is required');
        }

        try {
            const ctx = { filePath, projectRoot };
            const minifier = new SceneMinifier(filePath, projectRoot);

            // Direct id lookup
            if (args.nodeId !== undefined) {
                return this.#inspectById(minifier, args, ctx);
            }

            // Name search with disambiguation
            return this.#inspectByName(minifier, args, ctx);
        } catch (err) {
            return this.error(err.message);
        }
    }

    #inspectById(minifier, args, ctx) {
        const stub = minifier.instanceStubInfo(args.nodeId);
        if (stub) {
            return this.#inspectInstance(minifier, args.nodeId, stub, args.format, ctx);
        }

        const graph = minifier.inspectNode(args.nodeId);

        if (!graph) {
            return this.error(`Node #${args.nodeId} not found or has no content`);
        }

        return this.#formatResult(graph, args.nodeId, args.format, minifier.nodeAddress(args.nodeId));
    }

    #inspectByName(minifier, args, ctx) {
        const ref = args.nodeName;
        const slash = ref.lastIndexOf('/');
        const leaf = slash === -1 ? ref : ref.slice(slash + 1);
        const candidates = minifier.resolveNodeId(leaf);
        const matches = slash === -1
            ? candidates
            : filterByPath(candidates, ref.slice(0, slash));

        if (matches.length === 0) {
            if (candidates.length > 0) {
                const list = candidates.map(m =>
                    `- ${m.name}#${m.id} → "${minifier.nodeAddress(m.id) ?? (m.path || 'root')}"`
                ).join('\n');
                return this.error(
                    `No node at path "${ref}". Nodes named "${leaf}" exist at:\n${list}\n` +
                    `Use the quoted root-anchored path or nodeId.`
                );
            }
            const inInstances = minifier.findInInstanceSources(leaf);
            if (inInstances.length > 0) {
                const list = inInstances.map(h => `"${h.instance}" [P→${h.source}]`).join(', ');
                return this.error(
                    `No addressable node named "${leaf}". It exists inside collapsed prefab ` +
                    `instance(s): ${list}. Run inspect_node on the instance node itself to see ` +
                    'its internals and target paths, then override properties via ' +
                    'set_instance_property — or edit the source .prefab asset.'
                );
            }
            return this.error(`No node named "${leaf}" found`);
        }

        // Multiple matches — return disambiguation list
        if (matches.length > 1) {
            const list = matches.map(m =>
                `- ${m.name}#${m.id} → "${minifier.nodeAddress(m.id) ?? (m.path || 'root')}"`
            ).join('\n');

            return this.success(
                `# Multiple nodes named "${ref}"\n\n` +
                `Found: ${matches.length}\n\n` +
                `${list}\n\n` +
                `Use nodeId to inspect a specific one; the quoted root-anchored path works ` +
                `as the \`node\` argument everywhere.`
            );
        }

        // Single match — inspect directly
        const stub = minifier.instanceStubInfo(matches[0].id);
        if (stub) {
            return this.#inspectInstance(minifier, matches[0].id, stub, args.format, ctx);
        }

        const graph = minifier.inspectNode(matches[0].id);

        if (!graph) {
            return this.error(`Node "${args.nodeName}"#${matches[0].id} has no content`);
        }

        return this.#formatResult(graph, matches[0].id, args.format, minifier.nodeAddress(matches[0].id));
    }

    /**
     * Expanded view of a collapsed prefab instance: the source prefab's
     * internal tree (read-only, with set_instance_property target paths)
     * plus this instance's override list.
     */
    #inspectInstance(minifier, nodeId, stub, format, ctx) {
        let expansion;
        try {
            expansion = this.#expandInstance(nodeId, stub, ctx);
        } catch (err) {
            // Fall back to the plain (collapsed) view rather than failing
            const graph = minifier.inspectNode(nodeId);
            if (!graph) return this.error(`Node #${nodeId} not found or has no content`);
            const result = this.#formatResult(graph, nodeId, format, minifier.nodeAddress(nodeId));
            result.content[0].text += `\n\n(instance internals unavailable: ${err.message})`;
            return result;
        }
        return this.#formatInstanceResult(expansion, nodeId, format);
    }

    #expandInstance(nodeId, stub, ctx) {
        const assetIndex = AssetIndex.shared(ctx.projectRoot);
        const docCtx = { assetIndex, projectRoot: ctx.projectRoot };
        const source = loadSourcePrefabByUuid(docCtx, stub.assetUuid);

        // Internal tree through the regular read pipeline over the source file
        const sourceMinifier = new SceneMinifier(source.doc.filePath, ctx.projectRoot);
        const graph = sourceMinifier.inspectNode(source.doc.root.idx);
        if (!graph) throw new Error(`source prefab ${source.label} has no readable root`);
        annotateTargets(graph);

        // This instance's overrides, resolved to target paths via fileIds
        const doc = SceneDocument.load(ctx.filePath);
        const targets = fileIdTargets(source.doc);
        const overrides = this.#collectOverrides(doc, nodeId, targets, assetIndex);
        const incomingRefs = this.#collectIncomingRefs(doc, nodeId, targets, assetIndex);
        const removedComponents = this.#collectRemovedComponents(doc, nodeId, targets);

        return {
            name: stub.name ?? graph.name,
            stubPath: doc.nodePath(nodeId),
            sourceLabel: source.label,
            overrides,
            incomingRefs,
            removedComponents,
            graph
        };
    }

    /** removedComponents entries resolved to source-prefab paths */
    #collectRemovedComponents(doc, stubIdx, targets) {
        const instance = doc.instanceOf(stubIdx);
        if (!instance) return [];
        return removedComponentEntries(doc, instance).map(({ obj }) => {
            const hit = obj.localID.length === 1 ? targets.get(obj.localID[0]) : null;
            return {
                target: hit?.target ?? null,
                component: hit?.component ?? null,
                localID: hit ? undefined : obj.localID
            };
        });
    }

    /**
     * targetOverrides whose target is this stub: document components whose
     * @property references resolve INTO the instance (serialized null +
     * cc.TargetOverrideInfo — see targetOverrides.js).
     */
    #collectIncomingRefs(doc, stubIdx, targets, assetIndex) {
        const scriptNames = new Map();
        for (const entry of assetIndex.list({ type: 'script' })) {
            scriptNames.set(compressUuid(entry.uuid), entry.name.replace(/\.[jt]s$/, ''));
        }

        const refs = [];
        for (const obj of doc.objects) {
            if (obj?.__type__ !== 'cc.TargetOverrideInfo') continue;
            if (!isRef(obj.target) || obj.target.__id__ !== stubIdx) continue;

            let source = '?';
            if (obj.sourceInfo === null && isRef(obj.source)) {
                const comp = doc.getObject(obj.source.__id__);
                const nodePath = isRef(comp?.node) ? doc.nodePath(comp.node.__id__) : null;
                const type = comp ? (scriptNames.get(comp.__type__) ?? comp.__type__) : '?';
                source = `${nodePath ?? '?'} ▸ ${type}`;
            } else if (isRef(obj.source)) {
                // Source lives inside an instance (sourceInfo form) — when it
                // is THIS instance, its localID resolves through the same map
                let detail = '';
                if (obj.source.__id__ === stubIdx) {
                    const sInfo = isRef(obj.sourceInfo) ? doc.getObject(obj.sourceInfo.__id__) : null;
                    const sHit = Array.isArray(sInfo?.localID) && sInfo.localID.length === 1
                        ? targets.get(sInfo.localID[0]) : null;
                    if (sHit) detail = ` "${sHit.target}"${sHit.component ? ` ▸ ${sHit.component}` : ''}`;
                }
                source = `${doc.nodePath(obj.source.__id__) ?? '?'}${detail} (inside instance)`;
            }

            const info = isRef(obj.targetInfo) ? doc.getObject(obj.targetInfo.__id__) : null;
            const localID = Array.isArray(info?.localID) ? info.localID : [];
            const hit = localID.length === 1 ? targets.get(localID[0]) : null;
            refs.push({
                source,
                property: Array.isArray(obj.propertyPath) ? obj.propertyPath.join('.') : '?',
                target: hit?.target ?? null,
                component: hit?.component ?? null,
                localID: hit ? undefined : localID
            });
        }
        return refs;
    }

    #collectOverrides(doc, stubIdx, targets, assetIndex) {
        const overrides = [];
        const instance = doc.instanceOf(stubIdx);
        for (const ref of instance?.propertyOverrides ?? []) {
            if (!isRef(ref)) continue;
            const o = doc.getObject(ref.__id__);
            if (o?.__type__ !== 'CCPropertyOverrideInfo') continue;
            const info = isRef(o.targetInfo) ? doc.getObject(o.targetInfo.__id__) : null;
            const localID = info?.localID ?? [];
            const hit = localID.length === 1 ? targets.get(localID[0]) : null;
            overrides.push({
                target: hit?.target ?? null,
                component: hit?.component ?? null,
                localID: hit ? undefined : localID,
                property: o.propertyPath.join('.'),
                value: formatOverrideValue(o.value, assetIndex, doc)
            });
        }
        return overrides;
    }

    #formatInstanceResult(expansion, nodeId, format) {
        if (format === 'json') {
            return this.success(JSON.stringify({
                name: expansion.name,
                nodeId,
                instanceOf: expansion.sourceLabel,
                stubPath: expansion.stubPath,
                overrides: expansion.overrides,
                incomingRefs: expansion.incomingRefs,
                removedComponents: expansion.removedComponents,
                source: expansion.graph
            }, null, 2));
        }

        const lines = [
            `# Node: ${expansion.name}#${nodeId} — instance of ${expansion.sourceLabel}`,
            '',
            'Collapsed prefab instance. Internals below come from the source prefab and are',
            'READ-ONLY in this file. Override a property with apply_edits op',
            `set_instance_property {node: "${expansion.stubPath}", target: "<path from the tree>",`,
            'component?: "<Type>", property, value} — target "/" is the instance root.',
            'Adding components to internal nodes requires unpacking the model in the editor.',
            'Removing one works: remove_component {node: "<stub>", target, component} records it',
            'in removedComponents (undo with restore_instance_component).',
            ''
        ];

        lines.push(`## Overrides (${expansion.overrides.length})`);
        if (expansion.overrides.length === 0) {
            lines.push('none');
        }
        for (const o of expansion.overrides) {
            const where = o.target !== null
                ? `"${o.target}"${o.component ? ` ${o.component}` : ''}`
                : `localID=[${o.localID.join(', ')}]${o.localID.length > 1 ? ' (nested, multi-hop)' : ''}`;
            lines.push(`- ${where} .${o.property} = ${o.value}`);
        }

        if (expansion.removedComponents.length > 0) {
            lines.push('', `## Removed components (${expansion.removedComponents.length})`);
            for (const rc of expansion.removedComponents) {
                const where = rc.target !== null
                    ? `"${rc.target}"${rc.component ? ` ▸ ${rc.component}` : ''}`
                    : `localID=[${rc.localID.join(', ')}]`;
                lines.push(`- ${where} (removed on this instance; undo with restore_instance_component)`);
            }
        }

        if (expansion.incomingRefs.length > 0) {
            lines.push('', `## Incoming scene references (${expansion.incomingRefs.length})`);
            for (const r of expansion.incomingRefs) {
                const where = r.target !== null
                    ? `"${r.target}"${r.component ? ` ▸ ${r.component}` : ''}`
                    : `localID=[${r.localID.join(', ')}]${r.localID.length > 1 ? ' (nested, multi-hop)' : ''}`;
                lines.push(`- ${r.source} .${r.property} → ${where}`);
            }
        }

        lines.push('', `## Source internals (target paths relative to the instance root)`);
        const formatter = new TextFormatter().configure({ maxProps: Infinity });
        lines.push(formatter.format(expansion.graph));

        return this.success(lines.join('\n'));
    }

    #formatResult(graph, nodeId, format, address = null) {
        if (format === 'json') {
            const formatter = new JsonFormatter().configure({ pretty: true });
            const out = address ? { name: graph.name, path: address, ...graph } : graph;
            return this.success(formatter.format(out));
        }

        const formatter = new TextFormatter().configure({ maxProps: Infinity });
        const pathLine = address
            ? `Path: "${address}" — use as \`node\` in apply_edits / get_node_bounds / compute_fit_scale.\n\n`
            : '';
        return this.success(`# Node: ${graph.name}#${nodeId}\n\n${pathLine}${formatter.format(graph)}`);
    }
}

/**
 * Annotate every node of a minified tree with its set_instance_property
 * `target` path (names joined by '/', "[i]" suffix on same-named siblings,
 * root = "/").
 */
function annotateTargets(graph) {
    graph.target = '/';
    const walk = (node, prefix) => {
        if (!node.children) return;
        const counts = new Map();
        for (const c of node.children) counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
        const seen = new Map();
        for (const c of node.children) {
            let segment = c.name;
            if (counts.get(c.name) > 1) {
                const i = seen.get(c.name) ?? 0;
                seen.set(c.name, i + 1);
                segment = `${c.name}[${i}]`;
            }
            c.target = prefix ? `${prefix}/${segment}` : segment;
            walk(c, c.target);
        }
    };
    walk(graph, '');
}

/** Compact display form for an override value */
function formatOverrideValue(value, assetIndex, doc) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if ('__uuid__' in value) {
        return assetIndex.label(value.__uuid__) ?? value.__uuid__;
    }
    if ('__id__' in value) {
        const name = doc.nodeName(value.__id__) ?? doc.getObject(value.__id__)?.__type__ ?? '?';
        return `→${name}#${value.__id__}`;
    }
    if (value.__type__ === 'cc.Vec3') return `(${value.x}, ${value.y}, ${value.z})`;
    const json = JSON.stringify(value);
    return json.length > 90 ? `${json.slice(0, 90)}…` : json;
}

/**
 * Match candidates whose parent path equals the requested prefix. Read-side
 * paths start at the scene root (its name included), while callers usually
 * write paths the way apply_edits addresses nodes — so an exact match wins,
 * otherwise a suffix match on a segment boundary is accepted.
 */
function filterByPath(candidates, prefix) {
    const exact = candidates.filter(m => m.path === prefix);
    if (exact.length > 0) return exact;
    return candidates.filter(m => m.path.endsWith(`/${prefix}`));
}
