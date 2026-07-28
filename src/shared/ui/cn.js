/**
 * className merge utility.
 *
 * A small, dependency-free helper for composing conditional `className` strings
 * used by the design-system components. It accepts any number of arguments and
 * joins only the truthy string values into a single, space-separated class
 * string, de-duplicating repeated tokens while preserving their first-seen
 * order.
 *
 * Supported argument shapes:
 *
 *   - Strings — included when non-empty after trimming.
 *   - Arrays — flattened recursively (to a bounded depth) so nested class lists
 *     compose naturally.
 *   - Plain objects — each key is included when its value is truthy, so
 *     conditional classes can be expressed as `{ 'is-active': isActive }`.
 *
 * All other values (numbers, booleans, `null`, `undefined`, functions) are
 * ignored. The function is pure: it never mutates its arguments and never
 * throws for malformed input.
 */

/** Maximum recursion depth applied when flattening nested array arguments. */
const MAX_DEPTH = 4;

/**
 * Determines whether a value is a plain, non-array object.
 * @param {unknown} value - The candidate value.
 * @returns {boolean} `true` when `value` is a plain object.
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Collects the class tokens contributed by a single argument into an ordered
 * accumulator, recursing through arrays to a bounded depth.
 * @param {unknown} value - The argument to resolve.
 * @param {string[]} tokens - The accumulator receiving class tokens.
 * @param {number} depth - The current recursion depth.
 * @returns {void}
 */
function collect(value, tokens, depth) {
  if (value === null || value === undefined || value === false || value === true) {
    return;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      for (const token of trimmed.split(/\s+/)) {
        tokens.push(token);
      }
    }
    return;
  }

  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) {
      return;
    }
    for (const item of value) {
      collect(item, tokens, depth + 1);
    }
    return;
  }

  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      if (value[key]) {
        const trimmed = key.trim();
        if (trimmed.length > 0) {
          tokens.push(trimmed);
        }
      }
    }
  }
}

/**
 * Merges any number of class-name arguments into a single, space-separated
 * class string, ignoring falsy values and de-duplicating repeated tokens.
 * @param {...unknown} inputs - The class-name arguments to merge.
 * @returns {string} A merged class string (may be empty).
 */
export function cn(...inputs) {
  const tokens = [];
  for (const input of inputs) {
    collect(input, tokens, 0);
  }

  const seen = new Set();
  const output = [];
  for (const token of tokens) {
    if (!seen.has(token)) {
      seen.add(token);
      output.push(token);
    }
  }

  return output.join(' ');
}

export default cn;