/**
 * A memo of answers that are mostly `null`, as a drop-in for the
 * `Map<K, V | null>` it replaces: misses go to a `Set`, which holds a key in
 * two slots where the map spent three on a key and its `null`.
 *
 * The binding censuses memoize a type per node they are asked about, and on a
 * 48K-line app over 99% of those answers are `null` -- one stated-type memo
 * holds 232K nodes and 512 types -- for the whole compile, since each round's
 * census stays the upstream of the next.
 */
export class NullableMemo<K, V> {
  readonly #answers = new Map<K, V>()
  readonly #misses = new Set<K>()

  get(key: K): V | null | undefined {
    const answer = this.#answers.get(key)
    if (answer !== undefined) return answer
    return this.#misses.has(key) ? null : undefined
  }

  has(key: K): boolean {
    return this.#answers.has(key) || this.#misses.has(key)
  }

  set(key: K, value: V | null): this {
    if (value === null) {
      this.#answers.delete(key)
      this.#misses.add(key)
    } else {
      this.#misses.delete(key)
      this.#answers.set(key, value)
    }
    return this
  }

  clear(): void {
    this.#answers.clear()
    this.#misses.clear()
  }
}
