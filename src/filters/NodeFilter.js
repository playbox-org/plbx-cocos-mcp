/**
 * NodeFilter - Open/Closed Principle: Extensible node filtering
 *
 * SOLID: O - New filter rules can be added without modifying existing logic
 * SOLID: S - Only responsible for node visibility decisions
 */

// Bone name patterns - skeleton nodes that add noise
const BONE_PATTERNS = [
    /^Root/i, /^Spine/i, /^Chest/i, /^Neck/i, /^Head/i,
    /^Shoulder/i, /^Arm/i, /^Hand/i, /^Finger/i,
    /^Hip/i, /^Leg/i, /^Foot/i, /^Toe/i,
    /^Eye/i, /^Jaw/i, /^Pelvis/i, /^Clavicle/i
];

export class NodeFilter {
    #maxDepth = 10;
    #boneMaxDepth = 3;
    #filterNestedBones = true;
    #customFilters = [];

    /**
     * Configure filter options
     */
    configure(options = {}) {
        if (options.maxDepth) this.#maxDepth = options.maxDepth;
        if (options.boneMaxDepth) this.#boneMaxDepth = options.boneMaxDepth;
        if (options.filterNestedBones !== undefined) this.#filterNestedBones = options.filterNestedBones;
        return this;
    }

    /**
     * Add custom filter function (Open for extension)
     * @param {(node: object, depth: number) => boolean} filterFn - Return true to filter out
     */
    addFilter(filterFn) {
        this.#customFilters.push(filterFn);
        return this;
    }

    /**
     * Check if node should be filtered out
     */
    shouldFilter(node, depth, parentIsBone = false) {
        // Max depth check
        if (depth > this.#maxDepth) return true;

        // Bone filtering
        const isBone = this.#isBone(node._name);
        if (isBone && depth > this.#boneMaxDepth) return true;
        if (this.#filterNestedBones && parentIsBone && isBone) return true;

        // Custom filters
        for (const filter of this.#customFilters) {
            if (filter(node, depth)) return true;
        }

        return false;
    }

    /**
     * Check if node is a bone (skeleton node)
     */
    #isBone(name) {
        if (!name) return false;
        return BONE_PATTERNS.some(pattern => pattern.test(name));
    }

    /**
     * Check if node name matches bone pattern
     */
    isBone(name) {
        return this.#isBone(name);
    }
}
