import type { DeclarationId } from '../../identity/ids.js'

/**
 * The property keys a whole-program write may have created, replaced or
 * deleted, and the per-key obligations that ask about them.
 *
 * The host-mutation census used to answer one question per object -- "was it
 * touched at all" -- plus one wildcard, `*`, for any write it could not pin to
 * an object. A single `o.needsUpdate = true` through a receiver it could not
 * prove non-global therefore failed every proof about every intrinsic
 * prototype, including "Object.prototype lacks `glslVersion`". The write's KEY
 * was always known; only its receiver was not. This module keeps the key.
 *
 * Soundness is carried by three rules, and nothing here may weaken them:
 *
 * 1. A key is recorded exactly only when it is statically known. A key the
 *    census cannot name is `every`, which is the old wildcard.
 * 2. A number-typed key is not an array index: `o[n]` with `n: number` can
 *    write "-1", "1.5", "NaN" or "Infinity". It is recorded as the NUMERIC
 *    domain -- every `ToString(Number)` string -- and an obligation on a key
 *    is touched by it exactly when that key is such a string.
 * 3. An object's taint never masks the surface taint: a query asks both the
 *    object's own keys and the keys written on "any surface that might be an
 *    intrinsic or the global object".
 *
 * Symbol-keyed obligations are named `@@name` (`@@iterator`), after the
 * WELL-KNOWN symbols. No write ever records a symbol key by name, so such an
 * obligation is touched only by `every`.
 *
 * A symbol key the program itself declared is the one case that records NO key
 * rather than `every`: it can name no string member, and it can name no
 * `@@well-known` member either, so it touches nothing this module models. That
 * is not a fourth kind -- it is the empty key set, decided in
 * `host-mutation-key-reader.ts`'s `isProgramDeclaredSymbolKey`, which is also
 * where the soundness argument lives.
 */

/** @semanticCategory generic-primitive */
export type MutationKey = { readonly kind: 'name'; readonly name: string } | { readonly kind: 'numeric' } | { readonly kind: 'every' }

export const everyKey: MutationKey = { kind: 'every' }
export const numericKeys: MutationKey = { kind: 'numeric' }
export const namedKey = (name: string): MutationKey => ({ kind: 'name', name })

/** @semanticCategory generic-primitive */
export interface MutationKeySet {
  readonly names: ReadonlySet<string>
  /** Some `ToString(Number)` key: canonical numeric strings, "NaN" and "Infinity" included. */
  readonly numeric: boolean
  /** A key nobody can name: every key, prototype replacement included. */
  readonly every: boolean
}

/** Exactly the strings `ToPropertyKey` produces from some Number. "-0" is not one: `String(-0)` is "0". */
export const isCanonicalNumericKey = (key: string): boolean => String(Number(key)) === key

/** 7.1.21 CanonicalNumericIndexString restricted to array indices: "0" .. "4294967294", no other spelling. */
export const isArrayIndexKey = (key: string): boolean => {
  if (!isCanonicalNumericKey(key)) return false
  const value = Number(key)
  return Number.isInteger(value) && value >= 0 && value < 4294967295
}

/** The key a numeric LITERAL writes: `o[1.50]` writes "1.5", `o[0x10]` writes "16". */
export const numericLiteralKey = (text: string): string | null => {
  const value = Number(text.replace(/_/g, ''))
  return Number.isNaN(value) ? null : String(value)
}

/**
 * What a proof depends on. `names` are exact keys (methods it calls, keys it
 * proves absent); `arrayIndices` asks for every canonical array index at once
 * (a hole read consults the prototype chain for that index).
 * @semanticCategory generic-primitive
 */
export interface PrototypeKeyQuery {
  readonly names?: readonly string[]
  readonly arrayIndices?: boolean
  /** Every ToString(Number) key, including fractions, infinities and NaN. */
  readonly numeric?: boolean
}

/** A stable spelling of a query, for ledgers that deduplicate obligations. */
export const prototypeKeyQuerySignature = (query: PrototypeKeyQuery): string =>
  `${[...new Set(query.names ?? [])].sort().join(',')}${query.arrayIndices ? '|indices' : ''}${query.numeric ? '|numeric' : ''}`

/** Does a write set reach any key the query depends on? `'all'` is the whole-object query. */
export const keySetTouches = (keys: MutationKeySet | undefined, query: PrototypeKeyQuery | 'all'): boolean => {
  if (!keys) return false
  if (keys.every) return true
  if (query === 'all') return keys.numeric || keys.names.size > 0
  for (const name of query.names ?? []) {
    if (keys.names.has(name) || (keys.numeric && isCanonicalNumericKey(name))) return true
  }
  if (query.arrayIndices && (keys.numeric || [...keys.names].some(isArrayIndexKey))) return true
  if (query.numeric && (keys.numeric || [...keys.names].some(isCanonicalNumericKey))) return true
  return false
}

/**
 * The sealed census. As a set it is the legacy view, kept so every consumer
 * that asks about a declaration identity keeps working unchanged:
 *
 * - `'*'` is present exactly when some surface may have been written under
 *   an unknown key (`surfaceKeys.every`);
 * - a declaration is present when anything at all was recorded against it --
 *   a host binding replaced, a member overwritten, a key added to an
 *   intrinsic prototype.
 *
 * Keys written through a receiver that might be ANY intrinsic surface are
 * NOT in the legacy view (they would be `'*'` there), which is why every
 * consumer that asks about an intrinsic object's contents must ask per key:
 * `intrinsicObjectKeysIntact`, or `intactIntrinsicPrototypeType` for the
 * whole-object question.
 * @semanticCategory generic-primitive
 */
export interface GlobalHostMutationTaint extends ReadonlySet<DeclarationId | '*'> {
  /** Keys written on some receiver that may be the global object or any intrinsic object. */
  readonly surfaceKeys: MutationKeySet
  /** Keys written on this specific object identity; `undefined` when nothing was. */
  readonly keysOf: (object: DeclarationId) => MutationKeySet | undefined
}

/**
 * TEMPORARY INSTRUMENT -- not for landing. `GEA_KEY_BLOCK_DEBUG=1` names, per
 * distinct outcome, WHICH of the three disjuncts refused and which key matched.
 * Suppressing the wildcard alone left the three.js app's 300 census diagnostics at 300,
 * so the question this answers is whether the NAMED surface keys (three's own
 * `linecap`, `version`, `isTexture` ... written through opaque receivers) are
 * doing the blocking on their own.
 */
const keyBlockDebug = process.env['GEA_KEY_BLOCK_DEBUG'] === '1'
const reportedKeyBlocks = new Set<string>()
const matchedKeys = (keys: MutationKeySet | undefined, query: PrototypeKeyQuery | 'all'): string =>
  !keys
    ? ''
    : keys.every
      ? 'every'
      : query === 'all'
        ? [...keys.names].join(',')
        : [...(query.names ?? [])].filter((name) => keys.names.has(name)).join(',')

/** May a proof that depends on `query` of this intrinsic object still stand? */
export const intrinsicObjectKeysIntact = (
  taint: GlobalHostMutationTaint,
  object: DeclarationId,
  query: PrototypeKeyQuery | 'all'
): boolean => {
  const star = taint.has('*')
  const surface = keySetTouches(taint.surfaceKeys, query)
  const own = keySetTouches(taint.keysOf(object), query)
  if (keyBlockDebug && (star || surface || own)) {
    const asked = query === 'all' ? 'all' : prototypeKeyQuerySignature(query)
    // The OBJECT belongs in the line. Without it every blocked query on every
    // intrinsic collapsed into one row -- `own=true(every) asked=keys` says
    // that SOME object is wildcarded, not which, and the whole next question
    // (which arguments reach the objects a program's own obligations name) is
    // unreadable from it. It is also what makes the dedupe per object rather
    // than per outcome.
    const line = `[KEY-BLOCK] ${object} star=${star} surface=${surface}(${matchedKeys(taint.surfaceKeys, query)}) own=${own}(${matchedKeys(taint.keysOf(object), query)}) asked=${asked}`
    if (!reportedKeyBlocks.has(line)) {
      reportedKeyBlocks.add(line)
      process.stderr.write(`${line}\n`)
    }
  }
  return !star && !surface && !own
}

type MutableKeySet = { names: Set<string>; numeric: boolean; every: boolean }
const emptyKeys = (): MutableKeySet => ({ names: new Set(), numeric: false, every: false })

/**
 * TEMPORARY EXPERIMENT -- not for landing. `GEA_NO_WILDCARD=1` drops every
 * `every`-kind key, at the ONE place all of them are recorded, so a single
 * three.js run answers the question that decides what to work on next: with the
 * wildcard gone, do the 300 census diagnostics clear, or do the 64 NAMED
 * surface keys block them anyway? Guarding `markWildcard` alone was not enough
 * -- `taintIntrinsicMember` and `markIntrinsicPrototypeKeys` reach these two
 * methods with `everyKey` without passing through it.
 */
const dropsWildcardKeys = process.env['GEA_NO_WILDCARD'] === '1'
const wildcardStackDebug = process.env['GEA_WILDCARD_STACK'] === '1'
const reportedWildcardStacks = new Set<string>()

/** The census's builder and its sealed result. Every record goes through `taintObject`/`taintSurface`. */
export class HostMutationTaint extends Set<DeclarationId | '*'> implements GlobalHostMutationTaint {
  readonly #surface: MutableKeySet = emptyKeys()
  readonly #objects = new Map<DeclarationId, MutableKeySet>()

  get surfaceKeys(): MutationKeySet {
    return this.#surface
  }

  readonly keysOf = (object: DeclarationId): MutationKeySet | undefined => this.#objects.get(object)

  /** A legacy add carries no key, so it is the whole object (or, for `'*'`, every surface key). */
  override add(entry: DeclarationId | '*'): this {
    if (entry === '*') this.taintSurface(everyKey)
    else this.taintObject(entry, everyKey)
    return this
  }

  taintObject(object: DeclarationId, key: MutationKey): void {
    if (key.kind === 'every' && dropsWildcardKeys) return
    // TEMPORARY INSTRUMENT -- not for landing. `GEA_WILDCARD_STACK=1` names the
    // RULE that stamps `every` on an object, by capturing the compiler-side call
    // path once per distinct path. Reading the census for it does not work: the
    // `add` override below routes several unrelated rules through this one
    // method, so the site is only visible from the stack.
    if (key.kind === 'every' && wildcardStackDebug) {
      const stack = (new Error().stack ?? '')
        .split('\n')
        .slice(2, 9)
        .map((line) =>
          line
            .trim()
            .replace(/^at /, '')
            .replace(/ \(.*$/, '')
        )
        .join(' <- ')
      // Deduped by OBJECT AND stack, not by stack alone. One rule wildcards
      // many objects through one code path, so a stack-only memo printed the
      // first object it reached and swallowed every other -- which reads as
      // "one intrinsic is wildcarded" when the truth is "this loop wildcards
      // all of them". That is the shape of the answer, and it was invisible:
      // located hono-hello's whole remaining census gap at ONE site only after
      // cross-checking the printed frames against the source by hand.
      const seen = `${object} :: ${stack}`
      if (!reportedWildcardStacks.has(seen)) {
        reportedWildcardStacks.add(seen)
        process.stderr.write(`[WILDCARD-STACK] ${object} :: ${stack}\n`)
      }
    }
    let keys = this.#objects.get(object)
    if (!keys) this.#objects.set(object, (keys = emptyKeys()))
    record(keys, key)
    super.add(object)
  }

  taintSurface(key: MutationKey): void {
    if (key.kind === 'every' && dropsWildcardKeys) return
    record(this.#surface, key)
    if (this.#surface.every) super.add('*')
  }

  /** Copy a sealed census into this (shared, pre-allocated) one without losing a key. */
  absorb(other: GlobalHostMutationTaint): void {
    const surface = other.surfaceKeys
    for (const name of surface.names) this.taintSurface(namedKey(name))
    if (surface.numeric) this.taintSurface(numericKeys)
    if (surface.every) this.taintSurface(everyKey)
    for (const entry of other) {
      if (entry === '*') {
        this.taintSurface(everyKey)
        continue
      }
      const keys = other.keysOf(entry)
      if (!keys) {
        this.taintObject(entry, everyKey)
        continue
      }
      for (const name of keys.names) this.taintObject(entry, namedKey(name))
      if (keys.numeric) this.taintObject(entry, numericKeys)
      if (keys.every || (keys.names.size === 0 && !keys.numeric)) this.taintObject(entry, everyKey)
    }
  }
}

const record = (keys: MutableKeySet, key: MutationKey): void => {
  if (key.kind === 'every') keys.every = true
  else if (key.kind === 'numeric') keys.numeric = true
  else keys.names.add(key.name)
}
