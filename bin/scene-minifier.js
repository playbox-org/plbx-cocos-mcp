#!/usr/bin/env node
/**
 * PLBX Cocos Scene Minifier - CLI
 *
 * Standalone CLI for scene minification without MCP.
 */

import * as fs from 'fs';
import * as path from 'path';
import { SceneMinifier } from '../src/core/SceneMinifier.js';

function printHelp() {
    console.log(`
PLBX Cocos Scene Minifier

Usage:
  plbx-scene <scene-path> [options]
  node bin/scene-minifier.js <scene-path> [options]

Options:
  --output, -o <file>       Write output to file
  --json, -j                Output as JSON instead of text
  --stats, -s               Include statistics (default: on)
  --no-stats                Omit statistics
  --project-root <dir>      Cocos project root (default: COCOS_PROJECT_ROOT env,
                            or the nearest ancestor of the scene containing assets/)
  --help, -h                Show this help

Examples:
  plbx-scene assets/Scenes/game.scene
  plbx-scene assets/Scenes/game.scene -o graph.txt
  plbx-scene assets/Scenes/game.scene --json > scene.json
`);
}

function parseArgs(args) {
    const options = {
        scenePath: null,
        outputPath: null,
        projectRoot: null,
        json: false,
        stats: true,
        help: false
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg === '--help' || arg === '-h') {
            options.help = true;
        } else if (arg === '--json' || arg === '-j') {
            options.json = true;
        } else if (arg === '--stats' || arg === '-s') {
            options.stats = true;
        } else if (arg === '--no-stats') {
            options.stats = false;
        } else if (arg === '--output' || arg === '-o') {
            options.outputPath = args[++i];
        } else if (arg === '--project-root') {
            options.projectRoot = args[++i];
        } else if (!arg.startsWith('-')) {
            options.scenePath = arg;
        }
    }

    return options;
}

/**
 * Resolve the Cocos project root:
 * COCOS_PROJECT_ROOT env → --project-root flag → nearest ancestor
 * of the scene file containing an assets/ directory.
 */
function resolveProjectRoot(scenePath, options) {
    if (process.env.COCOS_PROJECT_ROOT) {
        return path.resolve(process.env.COCOS_PROJECT_ROOT);
    }
    if (options.projectRoot) {
        return path.resolve(options.projectRoot);
    }

    let dir = path.dirname(scenePath);
    while (true) {
        if (fs.existsSync(path.join(dir, 'assets'))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) break; // reached filesystem root
        dir = parent;
    }

    // Fallback: script names just won't resolve
    return path.dirname(scenePath);
}

function main() {
    const args = process.argv.slice(2);
    const options = parseArgs(args);

    if (options.help || !options.scenePath) {
        printHelp();
        process.exit(options.help ? 0 : 1);
    }

    const scenePath = path.resolve(options.scenePath);
    const projectRoot = resolveProjectRoot(scenePath, options);

    if (!fs.existsSync(scenePath)) {
        console.error(`Error: Scene file not found: ${scenePath}`);
        process.exit(1);
    }

    console.error(`🎮 PLBX Scene Minifier`);
    console.error(`   Input: ${path.relative(process.cwd(), scenePath)}`);

    try {
        const minifier = new SceneMinifier(scenePath, projectRoot);
        const graph = minifier.minify();

        if (!graph) {
            console.error('Error: Could not parse scene');
            process.exit(1);
        }

        let output;

        if (options.json) {
            output = minifier.toJson(graph);
        } else {
            output = `# Scene: ${path.basename(scenePath, '.scene')}\n\n`;
            output += minifier.toText(graph);

            if (options.stats) {
                output += minifier.formatStats();
            }
        }

        if (options.outputPath) {
            fs.writeFileSync(options.outputPath, output);
            console.error(`   Output: ${options.outputPath}`);
        } else {
            console.log(output);
        }

        // Compression stats
        const originalSize = fs.statSync(scenePath).size;
        const minifiedSize = Buffer.byteLength(output, 'utf-8');
        const ratio = Math.round(originalSize / minifiedSize);
        console.error(`   Compression: ${(originalSize/1024).toFixed(0)}KB → ${(minifiedSize/1024).toFixed(1)}KB (${ratio}:1)`);

    } catch (error) {
        console.error(`Error: ${error.message}`);
        process.exit(1);
    }
}

main();
