import type { StructuralTypeId } from '../../identity/ids.js'
import { structuralShapeKey, type StructuralShape, type StructuralType } from './structural-types.js'

/**
 * The interning table for structural types.
 *
 * Interning is what makes structural identity decidable: two shapes are the
 * same type exactly when they intern to the same id. Recursion is handled by
 * anchoring: a declared shape reserves its id before its members are built, so
 * a member that refers back to the declaration resolves to an id that already
 * exists instead of recursing forever.
 *
 * An id is a counter, never the shape's key. A key names the whole shape, and a
 * nested shape's key contains its members' keys -- so embedding the key in the
 * id would make identity strings grow with the depth of the type, and every
 * consumer that concatenates two of them grow quadratically. The key stays in
 * the interning map, where it is compared once.
 */

/**
 * An anchor and whether this call is the one that reserved it.
 *
 * `fresh` is the whole answer to "may I complete this?", and it has to come
 * from the table because the table is the only thing that knows. A caller
 * keeping its own set of anchors-it-has-marked is a second authority over one
 * fact, and the two drift: an anchor completed by one walk and then unmarked by
 * another walk's unwind reads as "not completed" and gets built a second time,
 * which `complete` then refuses.
 */
export interface AnchorReservation {
  readonly id: StructuralTypeId
  /** True exactly when this call created the reservation, so this caller owns completing or abandoning it. */
  readonly fresh: boolean
}

export interface StructuralTypeTable {
  /** Intern a shape and return its canonical identity. */
  readonly intern: (shape: StructuralShape) => StructuralTypeId
  /**
   * Reserve the identity of a recursive declared shape before its members are
   * known, then complete it. A shape must be completed before the table seals;
   * an anchor left open is a normalization defect, not an unresolved type.
   */
  readonly anchor: (declarationKey: string) => AnchorReservation
  readonly complete: (id: StructuralTypeId, shape: StructuralShape) => void
  /**
   * Give up on an anchor whose walk was abandoned.
   *
   * A walk can be unwound before it completes an anchor it reserved -- a
   * self-referential type retrying an outer entry does exactly that
   * (`semantics/normalize/structural-self-reference.ts`) -- and the retry does
   * not always reach the same anchor again: a declared anchor's key embeds its
   * type arguments' ids, and those change when a member that interned as a
   * union the first time anchors the second. So the reservation would sit open
   * forever and the table would refuse to seal.
   *
   * The id is not deleted: shapes interned during the abandoned walk still name
   * it, and reading one must answer rather than throw. It is completed with an
   * `unresolved` shape saying exactly what happened, and its *key* is released
   * so a retry that asks for the same key gets a fresh, completable anchor.
   */
  readonly abandon: (id: StructuralTypeId) => void
  /**
   * Release an anchor's KEY without touching its completed shape, so a later
   * `anchor()` call for the same declaration mints a fresh id instead of
   * reusing this one.
   *
   * Different from `abandon`: this anchor did not fail -- it completed, and
   * its shape stays exactly as built, valid forever for anyone who already
   * captured this id. The hazard is narrower and only visible from outside the
   * table: this anchor's build may have read another anchor's id while that
   * OTHER anchor was still open (a legitimate self-reference at the time), and
   * that other anchor has since been abandoned and, on retry, completes under
   * a *different* id. Reusing this anchor's key would keep handing out a
   * shape that cites the abandoned id forever, even though the retry produced
   * a correct answer nobody asked for again. The caller (`structural.ts`)
   * knows which ids were touched inside a failed attempt's journal and calls
   * this for every one of them; only the ones that are still an anchor key
   * (i.e. really were built by `anchor()`, not `intern()`) do anything -- a
   * plain content-addressed shape has no such key to release, so this is a
   * no-op for it and safe to call unconditionally.
   */
  readonly releaseKey: (id: StructuralTypeId) => void
  readonly get: (id: StructuralTypeId) => StructuralType
  /**
   * Whether this id is an anchor reserved and not yet completed -- the one
   * state `get` cannot answer. A walk that inspects the shapes behind ids it
   * was handed while sibling anchors are still open (`structural.ts`'s family
   * layout, flattening a member's union) asks this first.
   */
  readonly isOpen: (id: StructuralTypeId) => boolean
  /** Whether the shape at this id reaches an anchor a frame abandoned. See the implementation. */
  readonly citesAbandoned: (id: StructuralTypeId) => boolean
  readonly seal: () => ReadonlyMap<StructuralTypeId, StructuralType>
}

export const createStructuralTypeTable = (): StructuralTypeTable => {
  const byKey = new Map<string, StructuralTypeId>()
  // The reverse of `byKey`, kept in lockstep. `abandon` and `releaseKey` both
  // need "what key does this id currently own, if any" -- without this, that
  // question is a linear scan of `byKey`, paid on every rollback entry.
  const idToKey = new Map<StructuralTypeId, string>()
  const byId = new Map<StructuralTypeId, StructuralShape>()
  // The CONTENT key a completed anchor also owns, kept apart from `idToKey`
  // because an anchor owns two keys at once: `anchor:<declaration>`, which is
  // what recursion resolves through, and its shape's own canonical key, which
  // is what makes it findable by anyone who builds the identical shape later.
  const contentKeys = new Map<StructuralTypeId, string>()
  const openAnchors = new Set<StructuralTypeId>()
  // Which anchors were given up on, and under which key. Kept only so the
  // completion guard below can say *why* an anchor is closed: "abandoned" and
  // "completed twice" are different defects with different fixes, and one
  // message covering both sends the reader to the wrong one.
  const abandoned = new Map<StructuralTypeId, string>()
  // A monotonic counter, never `byKey.size`: `abandon` releases a key, and a
  // size-derived id would then hand the next shape an id already in use --
  // two unrelated types under one identity, which is not a wrong answer this
  // table could ever notice.
  let nextId = 0
  let sealed = false

  const requireOpen = (): void => {
    if (sealed) throw new Error('structural type table is sealed; interning a new shape after seal would create a second answer')
  }

  // Union is associative: a synthesized (A | B | undefined) | C | null
  // names the same values as A | B | C | undefined | null. Keeping the inner
  // union as an arm hides one absence from carrier selection and gives the
  // same type different identities depending on how inference grouped it.
  // Expand only known union shapes. Open anchors remain references; following
  // an object/class member here would change the type rather than normalize it.
  const canonicalShape = (shape: StructuralShape): StructuralShape => {
    if (shape.kind !== 'union') return shape
    const members = new Set<StructuralTypeId>()
    const expanding = new Set<StructuralTypeId>()
    const visit = (id: StructuralTypeId): void => {
      const member = byId.get(id)
      if (member?.kind !== 'union' || expanding.has(id)) {
        members.add(id)
        return
      }
      expanding.add(id)
      for (const child of member.members) visit(child)
      expanding.delete(id)
    }
    for (const member of shape.members) visit(member)
    return { kind: 'union', members: [...members] }
  }

  const intern = (input: StructuralShape): StructuralTypeId => {
    requireOpen()
    const shape = canonicalShape(input)
    const key = structuralShapeKey(shape)
    const existing = byKey.get(key)
    if (existing) return existing
    const id = `type|${nextId++}` as StructuralTypeId
    byKey.set(key, id)
    idToKey.set(id, key)
    byId.set(id, shape)
    return id
  }

  const anchor = (declarationKey: string): AnchorReservation => {
    requireOpen()
    const key = `anchor:${declarationKey}`
    const existing = byKey.get(key)
    if (existing) return { id: existing, fresh: false }
    const id = `type|${nextId++}` as StructuralTypeId
    byKey.set(key, id)
    idToKey.set(id, key)
    openAnchors.add(id)
    return { id, fresh: true }
  }

  const keyOf = (id: StructuralTypeId): string | null => idToKey.get(id) ?? null

  const complete = (id: StructuralTypeId, input: StructuralShape): void => {
    requireOpen()
    if (!openAnchors.delete(id)) {
      const why = abandoned.has(id)
        ? `it was abandoned (key ${abandoned.get(id) ?? ''})`
        : `it was already completed (key ${keyOf(id) ?? '<released>'})`
      throw new Error(`structural type ${id} is not an open anchor and cannot be completed: ${why}`)
    }
    const shape = canonicalShape(input)
    byId.set(id, shape)
    // An anchor is reserved by DECLARATION and completed with CONTENT, and
    // until this line the content was never addressable: `intern` looks a
    // shape up by `structuralShapeKey`, `complete` only wrote `byId`, so the
    // very next `intern` of the identical shape missed and minted a second
    // id for it. One type, two ids -- and every consumer keyed on the id then
    // sees two carriers where the language has one, which is the
    // "field X is stored as ... and this read publishes ..." refusal with two
    // sides that print the same thing.
    //
    // Measured on hono: the `H` handler union's own call signature was
    // anchored as `type|955` and re-interned as `type|1307`, which split the
    // router's `Result` tuple, its `add`/`match` member conventions and the
    // `#matchResult` cell into twins in five separate refusals.
    //
    // Nominal identity is not at risk: `declared`, `class-instance`,
    // `class-constructor` and `object-anchor` all carry their declaration in
    // their key, so two declarations with identical bodies keep two ids. What
    // this merges is what has no nominal identity to lose -- a signature, an
    // object body -- which is exactly what interning is for.
    //
    // An existing owner wins. A structurally identical shape interned WHILE
    // this anchor was open is already the id everything built since then
    // cites, and re-pointing the key would make `byKey` disagree with what is
    // already in the graph. The anchor stays reachable by its own key either
    // way.
    const contentKey = structuralShapeKey(shape)
    if (!byKey.has(contentKey)) {
      byKey.set(contentKey, id)
      contentKeys.set(id, contentKey)
    }
  }

  const abandon = (id: StructuralTypeId): void => {
    requireOpen()
    if (!openAnchors.delete(id)) return
    const realKey = idToKey.get(id)
    const key = realKey ?? '<key already released>'
    abandoned.set(id, key)
    if (realKey) {
      idToKey.delete(id)
      byKey.delete(realKey)
    }
    // The key travels into the reason. An abandoned anchor is only ever seen
    // downstream as an unresolved member of some other shape, and without the
    // key that report names neither the type that was being walked nor the
    // declaration it came from -- which is the whole question when one shows up.
    byId.set(id, { kind: 'unresolved', reason: `a walk reserved this anchor for ${key} and was unwound before completing it` })
  }

  /**
   * Whether the shape at `id` reaches, through any of the ids it names, an
   * anchor some frame gave up on.
   *
   * This is the question `releaseKey`'s only caller actually has. An unwound
   * walk has to withdraw the shapes it built *on an abandoned sibling* --
   * those cite an id that is now an `unresolved` stub -- but withdrawing the
   * rest is not conservative, it MINTS DUPLICATES: an anchor whose key is
   * released and whose declaration is walked again by a later specialization
   * view gets a second id for one type, and every consumer keyed on the id
   * then sees two carriers where the language has one. Measured on hono:
   * `Headers` held three ids and `Request` two, which is where
   * `binding-read-conversion:function-value-dispatch(...)->...(identical...)`
   * came from -- a conversion between a carrier and itself, unsatisfiable
   * because there is nothing to convert.
   *
   * A structural scan rather than a per-kind walk: this answers a diagnostic
   * question about ids a shape happens to name, not a semantic one about what
   * a shape MEANS, so it must not go stale when a shape kind gains a field --
   * which is exactly what a hand-maintained enumeration would do.
   */
  const citesAbandoned = (id: StructuralTypeId): boolean => {
    const seen = new Set<StructuralTypeId>()
    const pending: StructuralTypeId[] = [id]
    while (pending.length > 0) {
      const next = pending.pop()
      if (next === undefined || seen.has(next)) continue
      seen.add(next)
      if (abandoned.has(next)) return true
      const shape = byId.get(next)
      if (!shape) continue
      const scan = (value: unknown): void => {
        if (typeof value === 'string') {
          if (/^type\|\d+$/.test(value)) pending.push(value as StructuralTypeId)
          return
        }
        if (Array.isArray(value)) {
          for (const element of value) scan(element)
          return
        }
        if (value !== null && typeof value === 'object') for (const element of Object.values(value)) scan(element)
      }
      scan(shape)
    }
    return false
  }

  const releaseKey = (id: StructuralTypeId): void => {
    requireOpen()
    // An anchor still open belongs to `abandon`, not this: it has not
    // completed yet, and releasing its key out from under an in-flight build
    // would let a second, concurrent reservation mint a duplicate anchor for
    // the same declaration. Every caller of `releaseKey` only ever names an
    // id whose build already returned (see the docstring), so this is a
    // defensive no-op, not a path this table expects to take.
    if (openAnchors.has(id)) return
    // Both keys, for the one reason this function exists: nothing may reach
    // this id by name again. Leaving the content key behind would keep
    // handing it out to every later build of the identical shape, which is
    // precisely the "keeps citing an abandoned id forever" hazard the
    // docstring describes, reached by the other road.
    const contentKey = contentKeys.get(id)
    if (contentKey !== undefined) {
      contentKeys.delete(id)
      byKey.delete(contentKey)
    }
    const key = idToKey.get(id)
    if (!key || !key.startsWith('anchor:')) return
    idToKey.delete(id)
    byKey.delete(key)
  }

  const get = (id: StructuralTypeId): StructuralType => {
    const shape = byId.get(id)
    if (!shape) throw new Error(`structural type ${id} was referenced before it was interned`)
    return { id, shape }
  }

  const seal = (): ReadonlyMap<StructuralTypeId, StructuralType> => {
    if (openAnchors.size > 0) {
      throw new Error(
        `structural type table sealed with ${openAnchors.size} incomplete recursive anchor(s): ${[...openAnchors].join(', ')}`
      )
    }
    sealed = true
    const result = new Map<StructuralTypeId, StructuralType>()
    for (const [id, shape] of byId) result.set(id, Object.freeze({ id, shape }))
    return result
  }

  const isOpen = (id: StructuralTypeId): boolean => openAnchors.has(id)

  return { intern, anchor, complete, abandon, citesAbandoned, releaseKey, get, isOpen, seal }
}
