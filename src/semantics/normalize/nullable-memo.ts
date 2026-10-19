/**
 * A dense number for every key any `KeySet` has held, in first-held order.
 *
 * Shared, because the sets that use it hold largely the same keys: the
 * binding censuses' null-answer memos held 652K entries over 169K distinct
 * nodes on a 48K-line app, every one of them alive at the end of production,
 * the frontend's peak. A key is one entry here and one bit in each set that
 * holds it. Weak, so a number goes with its node; numbers are never reused.
 */
const keyNumbers = new WeakMap<object, number>()
let nextKeyNumber = 0

/**
 * Membership as one bit per key number, over the span of numbers this set has
 * held -- a `Set` spent two slots and a share of a bucket on every key.
 */
export class KeySet<K extends object> {
  /** Bit `n` is word `(n >>> 5) - #base`, bit `n & 31`. */
  #words = new Uint32Array(0)
  #base = 0

  has(key: K): boolean {
    const number = keyNumbers.get(key)
    if (number === undefined) return false
    const word = (number >>> 5) - this.#base
    return word >= 0 && word < this.#words.length && (this.#words[word]! & (1 << (number & 31))) !== 0
  }

  add(key: K): void {
    let number = keyNumbers.get(key)
    if (number === undefined) keyNumbers.set(key, (number = nextKeyNumber++))
    const word = number >>> 5
    if (this.#words.length === 0) {
      this.#words = new Uint32Array(8)
      this.#base = word
    } else if (word < this.#base || word >= this.#base + this.#words.length) {
      const end = Math.max(this.#base + this.#words.length, word + 1)
      const base = Math.min(this.#base, word)
      // Grown by half again past what is needed, so a set filled in rising
      // number order -- the common case, numbers being handed out as asked --
      // copies its words a logarithmic number of times.
      const words = new Uint32Array(end - base + ((end - base) >>> 1))
      words.set(this.#words, this.#base - base)
      this.#words = words
      this.#base = base
    }
    this.#words[word - this.#base]! |= 1 << (number & 31)
  }

  delete(key: K): void {
    const number = keyNumbers.get(key)
    if (number === undefined) return
    const word = (number >>> 5) - this.#base
    if (word >= 0 && word < this.#words.length) this.#words[word]! &= ~(1 << (number & 31))
  }

  clear(): void {
    this.#words = new Uint32Array(0)
    this.#base = 0
  }
}

/**
 * A memo of answers that are mostly `null`, as a drop-in for the
 * `Map<K, V | null>` it replaces: misses go to a `KeySet`, a bit per key where
 * the map spent three slots on a key and its `null`.
 *
 * The binding censuses memoize a type per node they are asked about, and on a
 * 48K-line app over 99% of those answers are `null` -- one stated-type memo
 * holds 232K nodes and 512 types -- for the whole compile, since each round's
 * census stays the upstream of the next.
 */
export class NullableMemo<K extends object, V> {
  readonly #answers = new Map<K, V>()
  readonly #misses = new KeySet<K>()

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
