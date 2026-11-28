/**
 * A possibly-absent collection's contents as a fresh array, `[]` when absent.
 *
 * `[...(map?.keys() ?? [])]` says the same thing, but its operand is a union
 * of an iterator and an empty array literal, and a spread over that has no
 * single native range copy. Each helper spreads only the present collection.
 */

export const mapKeys = <K, V>(map: ReadonlyMap<K, V> | null | undefined): K[] => (map == null ? [] : [...map.keys()])

export const mapValues = <K, V>(map: ReadonlyMap<K, V> | null | undefined): V[] => (map == null ? [] : [...map.values()])

export const mapEntries = <K, V>(map: ReadonlyMap<K, V> | null | undefined): [K, V][] => (map == null ? [] : [...map.entries()])

export const setValues = <T>(set: ReadonlySet<T> | null | undefined): T[] => (set == null ? [] : [...set])
