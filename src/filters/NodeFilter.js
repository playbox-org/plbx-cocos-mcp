/**
 * NodeFilter - Open/Closed Principle: Extensible node filtering
 *
 * SOLID: O - New filter rules can be added without modifying existing logic
 * SOLID: S - Only responsible for node visibility decisions
 */

// Bone name keywords - skeleton nodes that add noise
const BONE_NAMES = [
    'Root', 'Spine', 'Chest', 'Neck', 'Head',
    'Shoulder', 'Arm', 'Hand', 'Finger',
    'Hip', 'Leg', 'Foot', 'Toe',
    'Eye', 'Jaw', 'Pelvis', 'Clavicle'
];

// A name is a bone only when a keyword matches a whole "word": it may be
// preceded by a separator (rig prefixes like "mixamorig:Head") and must be
// followed by end-of-name, a separator, a digit, or a bare L/R side suffix
// ("Head", "Head_L", "Hand.R", "Spine1", "EyeL"). Plain continuations are
// not bones ("Header", "Handle", "Armor", "RootNode").
const SEPARATOR = '[\\s_\\-.:]';
const BONE_PATTERNS = BONE_NAMES.map(name =>
    new RegExp(`(?:^|${SEPARATOR})${name}(?:[LR])?(?=$|${SEPARATOR}|\\d)`, 'i')
);

export class NodeFilter {
    #maxDepth = 10;
    #boneMaxDepth = 3;
    #filterNestedBones = true;
    #customFilters = [];

    /**
     * Configure filter options
     */
    configure(options = {}) {
        if (options.maxDepth !== undefined) this.#maxDepth = options.maxDepth;
        if (options.boneMaxDepth !== undefined) this.#boneMaxDepth = options.boneMaxDepth;
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
