import type { DeclarationId, IrValueId } from '../identity/ids.js'
import type { ConversionNode } from '../conversion/algebra.js'
import type { ConversionCensus } from '../conversion/nodes.js'
import type { BindingPlacement } from '../projection/bindings.js'
import { controlFlowGraphOf, dominatorTreeOf, naturalLoopsOf, type ControlFlowGraph, type NaturalLoop } from './dominance.js'
import { loopInvariantHoistsOf, type HoistPlan } from './hoist.js'
import { borrowSafeOperationsOf } from './borrow-effects.js'
import { representationKey, type Representation, type TypedArrayElementDomain } from '../representation/model.js'
import type { IrBlockId, IrBody, IrNonTerminatorOperation, IrOperand } from './model.js'
import { operandsOfIrOperation, resultOfIrOperation } from './queries.js'

/**
 * Loops whose Array accesses can run against a raw element pointer, and the
 * one loop-invariant condition that makes that sound.
 *
 * `c[i * N + j] += a_ik * b_kj` compiles to a load and a store through
 * `ArrayObject`, and both of them can GROW the array -- a store past the end
 * appends, which is what `a[a.length] = x` means in JavaScript. clang has to
 * assume the storage may be reallocated on every iteration, so it reloads the
 * base pointer each time and cannot vectorize anything. Measured on
 * `bench/comparison`'s matrix_multiply: 35.5 ms, against 4.9 ms for the
 * hand-written C++ that indexes a `std::vector` it knows nobody resizes.
 *
 * Hoisting the base pointer alone does not fix it, and neither does a
 * per-access bounds check -- both measured 35 ms, because the branch that
 * could still reallocate is inside the loop either way. What does fix it is a
 * condition computed ONCE, before the loop:
 *
 *     geaFast = arr->holes.empty() && lower >= 0 && upper <= arr->size()
 *
 * and an access written `geaFast ? base[i].value : <the general form>`. The
 * flag is loop-invariant, so clang's own loop unswitching produces the two
 * loop bodies, and in the fast one nothing can resize: 7.9 ms, same answer.
 * That is why this is a flag rather than a duplicated block -- the versioning
 * already exists in the backend, and it only needed something invariant to
 * version on.
 *
 * The proof this computes is that the loop's own test bounds every index:
 *
 *   - the loop is ascending (`i < B` / `i <= B`) with the counter on the left,
 *     and the counter advances by a loop-invariant step, so inside the body
 *     `i` never exceeds `B`;
 *   - every index is the counter, or a loop-invariant base plus the counter,
 *     so the highest index the loop can reach is `base + B`;
 *   - and every use of the array inside the loop is one of those accesses --
 *     one `push`, one call taking the array, one write of the cell, and the
 *     window is no longer a window.
 *
 * The bound itself, the base and the counter's seed are all read at the
 * preheader and checked there. Nothing here assumes a length.
 */
export interface DenseArray {
  /** Distinguishes this window's pointer name within one body. */
  readonly ordinal: number
  /** The loop this window belongs to. One flag per loop, not per array: two invariant flags would ask the backend for four loop versions where one condition covers every window. */
  readonly group: number
  /** The array, as the emitter already knows how to spell it. */
  readonly reference: DenseReference
  /** The element carrier, for the pointer's own type. */
  readonly element: Representation
  /** Typed-array storage has no Cell wrapper or holes. */
  readonly typed: TypedArrayElementDomain | null
  /** The block the flag and the pointer are computed in. */
  readonly preheader: IrBlockId
  /** Every invariant addend used by an access, with `null` for the bare counter. All ranges must fit before any access is unchecked. */
  readonly bases: readonly DenseOffset[]
  /** The counter cell, read at the preheader for the lowest index the loop can touch. */
  readonly counter: DeclarationId
  /** The loop's own bound. */
  readonly bound: IrOperand
  /** Whether the test admits the bound itself (`<=`), so the window is one wider. */
  readonly inclusive: boolean
  /** The counter's step, checked non-negative at the preheader. */
  readonly step: IrOperand | null
  /**
   * Whether this window's indices are REMAINDERS by the array's own length
   * rather than the loop's counter -- `ring[i % ring.length]`, the shape every
   * ring buffer and hash bucket is written in.
   *
   * A different proof, and a simpler one: `x % n` lies in `(-n, n)` for every
   * dividend whenever `n > 0` -- and in `[0, n)` once the access has tested
   * its sign (`DenseAccess.signed`) -- so the window needs no bound, no base and no
   * counter -- only that the array is non-empty and has no holes, which is what
   * the preheader checks. `bases`, `bound`, `inclusive`, `step` and `widened`
   * carry no meaning for one of these.
   *
   * Worth its own shape because the ordinary bounds test is not cheap enough to
   * leave in the loop. Measured on `bench/comparison/fixtures/object_create.ts`:
   * 11.3ms as emitted, 11.8ms with a per-access `key < size()` guard (no better
   * than doing nothing at all), 10.1ms with an unsigned integer one, and 7.9ms
   * with the bound gone. A per-access size read is what stops clang keeping the
   * base pointer in a register, so the bound has to leave the loop entirely.
   */
  readonly wrapped: boolean
  /**
   * What a wrapped window's indices are taken modulo: `null` for the array's
   * own `length`, a positive integer for a CONSTANT divisor.
   *
   * `x % n` lies in `[0, n)` either way, so the proof is the same one; what
   * differs is what the preheader has to check. The array's own length needs
   * only `size() > 0`, because an index below the length is inside the storage
   * by definition. A constant needs `size() >= n`, because nothing ties the two
   * together -- and that check is what makes `table[i % 16]` a window, which is
   * how every fixed-capacity ring buffer, hash bucket and dispatch table is
   * written.
   *
   * Meaningless when `wrapped` is false.
   */
  readonly modulus: number | null
  /**
   * Whether an access can see the counter AFTER this turn's advance.
   *
   * The loop's test bounds the counter at the top of the body; a body that
   * advances the counter and THEN reads reaches one step further, and the
   * window has to be that much wider. A latch that advances and jumps straight
   * back to the header -- which is what every `for` loop compiles to -- reaches
   * nothing, and widening it there would cost the window outright: an array of
   * exactly `bound` elements would fail `bound + 1 <= size` on every turn.
   */
  readonly widened: boolean
}

/**
 * What an index adds to the counter: a signed sum of loop invariants, `null`
 * for the bare counter. A stencil names its neighbours by subtracting
 * (`u[c - 1]`, `u[c - PITCH]`) and by chaining (`u[c + up - 1]`), and every
 * one of those is the counter plus a number the preheader can add up and
 * check like any other base.
 */
export type DenseOffset = { readonly terms: readonly { readonly operand: IrOperand; readonly negated: boolean }[] } | null

export type DenseReference =
  | {
      readonly kind: 'cell'
      readonly declaration: DeclarationId
      readonly representation: Representation
      readonly conversion?: ConversionNode
    }
  | { readonly kind: 'value'; readonly operand: IrOperand; readonly storage: Representation; readonly conversion?: ConversionNode }
  /**
   * A ROW of another array: `grid[i]` read inside the `j` loop.
   *
   * The receiver of `grid[i][j]` is loop-invariant and yet defined inside the
   * loop -- the row load is one of the loop's own operations -- so neither of
   * the two references above names it. `holder` is the array the row comes out
   * of and `key` the invariant index; the emitter re-reads the row at the
   * preheader, behind the condition that says the read is in range, and takes
   * the pointer from there. `operand` is the row value itself, whose every
   * other use inside the loop the window still has to account for.
   */
  | { readonly kind: 'element'; readonly holder: DenseReference; readonly key: IrOperand; readonly operand: IrOperand }

/**
 * One loop's condition.
 *
 * The flag is per LOOP and CUMULATIVE -- it ands its enclosing loop's flag --
 * because the backend's loop unswitching is what turns the ternary into two
 * loop bodies, and it versions on one invariant condition, not on several. An
 * inner body that named three flags measured 62 ms against 7.9 for the same
 * body behind one (`bench/comparison`'s matrix_multiply): clang gave up rather
 * than emit eight versions. Anding outward is also what lets an access reached
 * inside a nested loop cite the innermost flag -- the only one that loop's own
 * unswitching can see -- and still stand for its own window's proof.
 */
export interface DenseGroup {
  readonly ordinal: number
  /** The enclosing loop's group, whose flag this one ands. */
  readonly parent: number | null
  readonly preheader: IrBlockId
}

export interface DenseAccess {
  /** The window whose pointer this access indexes. */
  readonly array: number
  /** The flag it renders behind: the innermost enclosing loop's, which implies the window's own. */
  readonly flag: number
  /**
   * Whether this access's index is a REMAINDER, which the window's flag does
   * not bound below: `x % n` takes the dividend's sign, so `-3 % 16` is `-3`
   * and no preheader check can see that coming. The emitter tests the index's
   * sign at the access itself -- a register compare, not the size reload the
   * window exists to remove. A mask (`x & M`) is never negative and needs none.
   */
  readonly signed: boolean
}

export interface DenseLoopPlan {
  readonly arrays: readonly DenseArray[]
  readonly groups: readonly DenseGroup[]
  /** Which window each access renders against. */
  readonly accesses: ReadonlyMap<IrNonTerminatorOperation, DenseAccess>
  /**
   * Every read of a WRAPPED window's own `length`, and the window it belongs to.
   *
   * The divisor of `i % ring.length` is loop-invariant by the same admission
   * that made the window dense -- nothing in the loop resizes the array -- but
   * clang will not hoist the load: the element stores go through a pointer it
   * cannot prove disjoint from the vector's own header, so the length is
   * re-read on every turn and the base pointer never stays in a register.
   * Measured on `object_create.ts`: 11.5ms as emitted, 10.3ms with only the
   * length hoisted, 10.1ms with only the guard branch gone, 8.1ms with both.
   */
  readonly lengths: ReadonlyMap<IrValueId, number>
}

export const emptyDenseLoopPlan: DenseLoopPlan = { arrays: [], groups: [], accesses: new Map(), lengths: new Map() }

/** Dense preheaders perform real reads; their transport belongs to the lowered body's certificate too. */
export const publishDenseLoopPlan = (
  body: IrBody,
  placements: ReadonlyMap<DeclarationId, BindingPlacement>,
  conversions: ConversionCensus
): IrBody => {
  const raw = denseLoopsOf(body)
  const seal = (reference: DenseReference): DenseReference | null => {
    if (reference.kind === 'element') {
      const holder = seal(reference.holder)
      return holder === null ? null : { ...reference, holder }
    }
    const source = reference.kind === 'cell' ? placements.get(reference.declaration)?.representation : reference.storage
    const target = reference.kind === 'cell' ? reference.representation : reference.operand.representation
    if (source === undefined || source === null) return null
    const conversion = conversions.nodeFor(source, target)
    return conversion.capability.kind === 'never' ? null : { ...reference, conversion }
  }
  const arrays = raw.arrays.flatMap((array) => {
    const reference = seal(array.reference)
    return reference === null ? [] : [{ ...array, reference }]
  })
  const ordinals = new Set(arrays.map((array) => array.ordinal))
  const accesses = new Map([...raw.accesses].filter(([, access]) => ordinals.has(access.array)))
  const lengths = new Map([...raw.lengths].filter(([, ordinal]) => ordinals.has(ordinal)))
  return { ...body, denseLoopPlan: { arrays, accesses, lengths, groups: raw.groups } }
}

export const denseLoopConversionsOf = (plan: DenseLoopPlan): readonly ConversionNode[] => {
  const nodes = new Map<string, ConversionNode>()
  const visit = (reference: DenseReference): void => {
    if (reference.kind === 'element') visit(reference.holder)
    else if (reference.conversion !== undefined) nodes.set(reference.conversion.id, reference.conversion)
  }
  for (const array of plan.arrays) visit(array.reference)
  return [...nodes.values()]
}

export const denseLoopPlanMatches = (
  body: IrBody,
  plan: DenseLoopPlan,
  placements: ReadonlyMap<DeclarationId, BindingPlacement>,
  conversions: ConversionCensus
): boolean => {
  const matches = (reference: DenseReference): boolean => {
    if (reference.kind === 'element') return matches(reference.holder)
    const node = reference.conversion
    const source = reference.kind === 'cell' ? placements.get(reference.declaration)?.representation : reference.storage
    const target = reference.kind === 'cell' ? reference.representation : reference.operand.representation
    if (node === undefined || source === undefined || source === null || node.capability.kind === 'never') return false
    if (reference.kind === 'value') {
      const storage = body.values.get(reference.operand.value)
      if (storage === undefined || representationKey(storage) !== representationKey(reference.storage)) return false
    }
    return (
      conversions.nodeById(node.id) === node &&
      representationKey(node.source) === representationKey(source) &&
      representationKey(node.target) === representationKey(target)
    )
  }
  return plan.arrays.every((array) => matches(array.reference))
}

/**
 * The plan a body can actually RENDER, once the target has answered the one
 * question that is genuinely about its own storage.
 *
 * `denseLoopsOf` states what the loop's own control flow proves; it cannot
 * say whether THIS backend already has a plain name for a window's array or
 * counter cell to dereference through -- a local this body owns outright,
 * unboxed, or a global -- because that is the target's own placement, capture
 * and boxing decision, not a fact of the program. `admitsCell` is that one
 * hook (`emit-arrays.ts`'s `denseCellName` is its sole implementation).
 */
export type DenseCellPolicy = (declaration: DeclarationId) => boolean

/** The windows a body ends up able to render, once `admittedDenseLoopPlanOf` has trimmed the raw plan. */
export interface AdmittedDenseLoopPlan {
  readonly arrays: readonly DenseArray[]
  readonly groups: ReadonlyMap<number, DenseGroup>
  readonly accesses: ReadonlyMap<IrNonTerminatorOperation, DenseAccess>
  readonly lengths: ReadonlyMap<IrValueId, number>
}

/**
 * Whether a window's array is one this body can actually dereference: a plain
 * cell needs the target's own storage answer; a value defined before the loop
 * needs nothing (it is simply named); and a ROW needs its own key already
 * settled to a real integer -- an un-narrowed `number` key is not an element
 * access at all (`ir/integers.ts`) -- on top of the same question for the
 * array it is a row of.
 */
const referenceIsAdmitted = (reference: DenseReference, integerValues: ReadonlySet<IrValueId>, admitsCell: DenseCellPolicy): boolean => {
  if (reference.kind === 'cell') return admitsCell(reference.declaration)
  if (reference.kind === 'value') return true
  return integerValues.has(reference.key.value) && referenceIsAdmitted(reference.holder, integerValues, admitsCell)
}

/**
 * Narrows `denseLoopsOf`'s raw plan to the windows this body may actually
 * render.
 *
 * A window not admitted here is never a refusal: the array still renders
 * through the ordinary indexed path, which is always correct, and this only
 * decides which windows get the additional fast one. Three things a plan
 * built from the IR alone cannot settle are decided here, and only the first
 * is about this backend's own storage rather than about the program:
 *
 * - whether this body already has a plain name for the cells a window
 *   reaches through (`admitsCell`);
 * - whether the integer census narrowed every index a window's accesses
 *   read -- an un-narrowed `number` key is not an element access at all --
 *   except a WRAPPED window, which is exempt: its own admission already
 *   proves the array non-empty and hole-free (`DenseArray.wrapped`), so a
 *   remainder by that length or by a literal modulus needs no narrowed index
 *   to be a real one; one un-narrowed access anywhere in an ordinary window
 *   takes the WHOLE window down, since every access shares the one pointer
 *   the narrowing proof is about;
 * - and, once the two above have dropped some accesses, whether anything is
 *   left of a window at all: an array with no surviving access has no
 *   pointer worth materializing, and a flag chain with no claimed window
 *   below it has nothing to compute either -- a flag ands its enclosing
 *   loop's, so every group on a claimed window's chain has to exist even
 *   when nothing indexes anything in that loop, and no group outside that
 *   chain is needed at all.
 */
export const admittedDenseLoopPlanOf = (
  plan: DenseLoopPlan,
  integerValues: ReadonlySet<IrValueId>,
  admitsCell: DenseCellPolicy
): AdmittedDenseLoopPlan => {
  if (plan.arrays.length === 0) return { arrays: [], groups: new Map(), accesses: new Map(), lengths: new Map() }
  const admitted = new Set<number>(
    plan.arrays
      .filter((array) => admitsCell(array.counter) && referenceIsAdmitted(array.reference, integerValues, admitsCell))
      .map((array) => array.ordinal)
  )
  for (const [operation, access] of plan.accesses) {
    const array = plan.arrays[access.array]
    if (operation.kind !== 'get' && operation.kind !== 'set') admitted.delete(access.array)
    else if (!array?.wrapped && array?.typed === null && !integerValues.has(operation.key.value)) admitted.delete(access.array)
  }
  const accesses = new Map<IrNonTerminatorOperation, DenseAccess>()
  const claimed = new Set<number>()
  for (const [operation, access] of plan.accesses) {
    if (!admitted.has(access.array)) continue
    accesses.set(operation, access)
    claimed.add(access.array)
  }
  const arrays = plan.arrays.filter((array) => claimed.has(array.ordinal))
  const lengths = new Map([...plan.lengths].filter(([, ordinal]) => claimed.has(ordinal)))
  const groups = new Map<number, DenseGroup>()
  for (const array of arrays)
    for (const access of accesses.values()) {
      if (access.array !== array.ordinal) continue
      for (let at: number | null = access.flag; at !== null;) {
        const group: DenseGroup | undefined = plan.groups[at]
        if (!group || groups.has(at)) break
        groups.set(at, group)
        at = group.parent
      }
    }
  return { arrays, groups, accesses, lengths }
}

export const denseLoopsOf = (body: IrBody, hoists: HoistPlan = loopInvariantHoistsOf(body)): DenseLoopPlan => {
  // A try region renders as one assembled chunk, so a preheader inside one has
  // no single place for the setup to land -- the same restriction `hoist.ts`
  // takes, and for the same reason.
  if (body.tryRegions.length > 0 || (body.iteratorCloseRegions?.length ?? 0) > 0) return emptyDenseLoopPlan

  const graph = controlFlowGraphOf(body)
  const dominance = dominatorTreeOf(body)
  const loops = naturalLoopsOf(graph, dominance)
  if (loops.length === 0) return emptyDenseLoopPlan

  const location = new Map<IrValueId, IrBlockId>()
  const operationOf = new Map<IrValueId, IrNonTerminatorOperation>()
  const readsCell = new Map<IrValueId, DeclarationId>()
  const constantTexts = new Map<IrValueId, string>()
  const cellWrites = new Map<DeclarationId, { readonly value: IrOperand; readonly block: IrBlockId }[]>()
  const usesOf = new Map<IrValueId, { readonly operation: IrNonTerminatorOperation; readonly block: IrBlockId }[]>()
  const blockOfOperation = new Map<IrNonTerminatorOperation, IrBlockId>()

  for (const blockId of body.blockOrder) {
    const block = body.blocks.get(blockId)
    if (!block) continue
    for (const operation of block.operations) {
      blockOfOperation.set(operation, blockId)
      const result = 'result' in operation ? operation.result : null
      if (result) {
        location.set(result.id, blockId)
        operationOf.set(result.id, operation)
      }
      if (operation.kind === 'constant') constantTexts.set(operation.result.id, operation.text)
      if (operation.kind === 'binding-read') readsCell.set(operation.result.id, operation.declaration)
      if (operation.kind === 'binding-write') {
        const written = cellWrites.get(operation.declaration) ?? []
        written.push({ value: operation.value, block: blockId })
        cellWrites.set(operation.declaration, written)
      }
      for (const operand of operandsOfIrOperation(operation)) {
        const sites = usesOf.get(operand.value) ?? []
        sites.push({ operation, block: blockId })
        usesOf.set(operand.value, sites)
      }
    }
    // A terminator's own operand is a use like any other: an array named by a
    // branch condition is an array this window cannot account for.
    const terminator = block.terminator
    if (terminator.kind === 'branch') {
      const sites = usesOf.get(terminator.condition.value) ?? []
      usesOf.set(terminator.condition.value, sites)
    }
  }

  // A value the emitter HOISTS is defined where the hoist puts it, not where
  // the IR wrote it: `i * N` and the row load `a[i]` both live in the inner
  // loop's own body until `ir/hoist.ts` moves them to its preheader, and asking
  // the raw IR where they are answers "inside the loop" for every one of them.
  // `emitBody` runs the same plan, and renders it before this setup.
  for (const [blockId, operations] of hoists.into)
    for (const operation of operations) {
      blockOfOperation.set(operation, blockId)
      const result = resultOfIrOperation(operation)
      if (result) location.set(result.id, blockId)
    }

  const arrays: DenseArray[] = []
  const accesses = new Map<IrNonTerminatorOperation, DenseAccess>()
  const groups: DenseGroup[] = []

  const definedOutside = (value: IrValueId, blocks: ReadonlySet<IrBlockId>): boolean => {
    const where = location.get(value)
    return where === undefined || !blocks.has(where)
  }

  // A `const` local read inside a loop reaches it as a header phi whose
  // incoming values are the one value from before the loop and the phi
  // itself: invariant, but defined in the loop, so every offset Bloom's
  // stencil adds to its counter (`c + up`) looked like an unbounded index.
  // The preheader names what the phi always holds.
  const invariantOperand = (operand: IrOperand, blocks: ReadonlySet<IrBlockId>): IrOperand | null => {
    const seen = new Set<IrValueId>()
    let current = operand
    while (!definedOutside(current.value, blocks)) {
      if (seen.has(current.value)) return null
      seen.add(current.value)
      const phi = operationOf.get(current.value)
      if (phi?.kind !== 'phi') return null
      const sources = phi.incoming.map((incoming) => incoming.value).filter((value) => !seen.has(value.value))
      const first = sources[0]
      if (first === undefined || sources.some((source) => source.value !== first.value)) return null
      current = first
    }
    return current
  }

  // A value the preheader may NAME: defined before the loop, so it is both
  // unchanged by the loop (SSA) and already assigned where the setup renders.
  // A cell the loop never writes is not enough -- the READ of it can be one of
  // the loop's own operations, and naming that value in the preheader emits a
  // use of a variable no statement has assigned yet.

  const found = loops.map((loop) =>
    loopWindowsOf(loop, body, graph, loops, {
      body,
      values: body.values,
      readsCell,
      constantTexts,
      cellWrites,
      usesOf,
      operationOf,
      definedOutside,
      invariantOperand
    })
  )

  const groupOfLoop = new Map<number, number>()
  for (const [index, loop] of found.entries()) {
    if (loop === null) continue
    // Innermost-first, so an inner loop is numbered before the outer one it
    // ands: the ordinals are identities, not an emission order.
    groupOfLoop.set(index, groups.length)
    groups.push({ ordinal: groups.length, parent: null, preheader: loop.preheader })
  }
  for (const [index, group] of groupOfLoop) {
    const inner = loops[index]
    if (!inner) continue
    const enclosing = loops.findIndex((outer, at) => at !== index && outer.blocks.has(inner.header) && groupOfLoop.has(at))
    const parent = enclosing < 0 ? null : (groupOfLoop.get(enclosing) ?? null)
    groups[group] = { ordinal: group, parent, preheader: groups[group]?.preheader ?? inner.header }
  }

  /** The flag an access renders behind: the innermost enclosing loop that has one. */
  const flagAt = (blockId: IrBlockId): number | null => {
    for (const [index, loop] of loops.entries()) {
      if (!loop.blocks.has(blockId)) continue
      const group = groupOfLoop.get(index)
      if (group !== undefined) return group
    }
    return null
  }

  const blocksOfArray = new Map<number, ReadonlySet<IrBlockId>>()
  for (const [index, loop] of found.entries()) {
    const group = groupOfLoop.get(index)
    if (loop === null || group === undefined) continue
    for (const candidate of loop.candidates) {
      const ordinal = arrays.length
      const blocks = loops[index]?.blocks
      if (blocks) blocksOfArray.set(ordinal, blocks)
      arrays.push({
        ordinal,
        group,
        reference: candidate.reference,
        element: candidate.element,
        typed: candidate.typed,
        preheader: loop.preheader,
        wrapped: candidate.wrapped,
        modulus: candidate.modulus,
        bases: candidate.bases,
        counter: loop.counter,
        bound: loop.bound,
        inclusive: loop.inclusive,
        step: loop.step,
        widened: loop.widened
      })
      for (const operation of candidate.operations) {
        const flag = flagAt(blockOfOperation.get(operation) ?? loop.preheader)
        if (flag === null) continue
        accesses.set(operation, { array: ordinal, flag, signed: candidate.signed.includes(operation) })
      }
    }
  }

  // A window whose array is reached THROUGH one (`grid[i]`) names it behind a
  // null check, and the preheader has no unconditional place to read a length.
  // A read the loop does not contain is already outside it -- and substituting
  // the preheader's name for one that renders BEFORE the preheader would name a
  // variable no statement has assigned yet, so `location` (which the hoist pass
  // updates) is what decides membership, not the block the IR wrote it in.
  const lengths = new Map<IrValueId, number>()
  for (const array of arrays) {
    // A constant modulus has no length to hoist: the divisor is already in the
    // emitted text, and `gea::Divisor`'s prepared reciprocal answers a question
    // a literal never asks.
    if (!array.wrapped || array.modulus !== null || array.reference.kind === 'element') continue
    const blocks = blocksOfArray.get(array.ordinal)
    if (!blocks) continue
    const cell = array.reference.kind === 'cell' ? array.reference.declaration : null
    const held = array.reference.kind === 'value' ? array.reference.operand.value : null
    for (const [result, operation] of operationOf) {
      if (operation.kind !== 'get' || constantTexts.get(operation.key.value) !== 'length') continue
      // The re-check every sibling `'length'` site in this file keeps
      // (line ~560, ~610, `wrapsOwnLength` above) and this one omitted: a
      // `get` whose key merely RENDERS as the text "length" says nothing on
      // its own about what kind of receiver it reads. The receiver-identity
      // test below (`readsCell.get(receiver) === cell` / `receiver === held`)
      // already only matches a value this loop's own `arrays` census settled
      // as `array-object` -- `array.reference` is never anything else once
      // `wrapped` is true -- so this is a defensive restatement of a fact
      // already implied, not a new refusal; kept for the same reason the
      // siblings state it locally rather than leaving it to be re-derived
      // from a different function's invariant.
      if (operation.receiver.representation.kind !== 'array-object') continue
      const where = location.get(result)
      if (where === undefined || !blocks.has(where)) continue
      const receiver = operation.receiver.value
      if (cell !== null ? readsCell.get(receiver) === cell : receiver === held) lengths.set(result, array.ordinal)
    }
  }

  return { arrays, groups, accesses, lengths }
}

/**
 * One loop's counter, its bound, and the windows its body opens -- or `null`
 * when the loop is not one this can bound at all.
 */
interface LoopWindows {
  readonly preheader: IrBlockId
  readonly counter: DeclarationId
  readonly bound: IrOperand
  readonly inclusive: boolean
  readonly step: IrOperand | null
  readonly widened: boolean
  readonly candidates: readonly WindowCandidate[]
}

const loopWindowsOf = (
  loop: NaturalLoop,
  body: IrBody,
  graph: ControlFlowGraph,
  loops: readonly NaturalLoop[],
  context: Omit<WindowContext, 'counter'>
): LoopWindows | null => {
  const outside = (graph.predecessors.get(loop.header) ?? []).filter((predecessor) => !loop.blocks.has(predecessor))
  const preheader = outside.length === 1 ? outside[0] : undefined
  if (preheader === undefined) return null
  const header = body.blocks.get(loop.header)
  if (header?.terminator.kind !== 'branch') return null
  const test = context.operationOf.get(header.terminator.condition.value)
  if (test?.kind !== 'compute' || test.form !== 'binary') return null
  if (test.operator !== '<' && test.operator !== '<=') return null
  const [left, right] = test.operands
  if (!left || !right) return null
  const counter = context.readsCell.get(left.value)
  const bound = counter === undefined ? null : context.invariantOperand(right, loop.blocks)
  if (counter === undefined || bound === null) return null
  // Exactly one advance, by an amount the preheader can name. Several
  // advances, or a step the loop itself computes, and "the counter never
  // exceeds the bound" stops being something the preheader can check.
  const steps = (context.cellWrites.get(counter) ?? []).filter((write) => loop.blocks.has(write.block))
  const advance = steps.length === 1 ? steps[0] : undefined
  if (!advance) return null
  // ...and reached at most once per turn. A write inside an INNER loop runs an
  // unknown number of times per turn of this one, and then no arithmetic on
  // this loop's own bound says where the counter got to. Structured TypeScript
  // compiles to reducible control flow, so every cycle within this loop is one
  // of `loops`.
  if (loops.some((inner) => inner.header !== loop.header && inner.blocks.has(advance.block) && loop.blocks.has(inner.header))) return null
  const advanced = stepOf(advance.value, counter, context.operationOf, context.readsCell)
  if (advanced === undefined) return null
  const step = advanced === null ? null : context.invariantOperand(advanced, loop.blocks)
  if (advanced !== null && step === null) return null
  const candidates = windowsOfLoop(loop.blocks, body, { ...context, counter })
  if (candidates.length === 0) return null
  return {
    preheader,
    counter,
    bound,
    inclusive: test.operator === '<=',
    step,
    widened: advanceReachesAnAccess(loop, body, graph, advance.block, counter),
    candidates
  }
}

/**
 * Whether an element access can run after this turn's advance of the counter.
 *
 * True only when the body can reach an access from the counter's own write
 * without going back through the header -- which a `for` loop's latch, whose
 * one successor IS the header, never does.
 */
const advanceReachesAnAccess = (
  loop: NaturalLoop,
  body: IrBody,
  graph: ControlFlowGraph,
  advanceBlock: IrBlockId,
  counter: DeclarationId
): boolean => {
  const after = new Set<IrBlockId>()
  const pending = (graph.successors.get(advanceBlock) ?? []).filter((next) => loop.blocks.has(next) && next !== loop.header)
  while (pending.length > 0) {
    const blockId = pending.pop()
    if (blockId === undefined || after.has(blockId)) continue
    after.add(blockId)
    for (const next of graph.successors.get(blockId) ?? []) if (loop.blocks.has(next) && next !== loop.header) pending.push(next)
  }
  for (const blockId of after) {
    const block = body.blocks.get(blockId)
    if (block?.operations.some((operation) => operation.kind === 'get' || operation.kind === 'set')) return true
  }
  const written = body.blocks.get(advanceBlock)?.operations ?? []
  const at = written.findIndex((operation) => operation.kind === 'binding-write' && operation.declaration === counter)
  return at >= 0 && written.slice(at + 1).some((operation) => operation.kind === 'get' || operation.kind === 'set')
}

/** `counter + s` / `counter++`: the amount one turn adds, or `undefined` when the write is not an advance. */
const stepOf = (
  written: IrOperand,
  counter: DeclarationId,
  operationOf: ReadonlyMap<IrValueId, IrNonTerminatorOperation>,
  readsCell: ReadonlyMap<IrValueId, DeclarationId>
): IrOperand | null | undefined => {
  const compute = operationOf.get(written.value)
  if (compute?.kind !== 'compute') return undefined
  if (compute.form === 'update') {
    const target = compute.operands[0]
    return target && readsCell.get(target.value) === counter && compute.operator === '++' ? null : undefined
  }
  if (compute.form !== 'binary' || compute.operator !== '+') return undefined
  const [left, right] = compute.operands
  if (!left || !right) return undefined
  if (readsCell.get(left.value) === counter) return right
  if (readsCell.get(right.value) === counter) return left
  return undefined
}

interface WindowCandidate {
  readonly reference: DenseReference
  readonly element: Representation
  readonly typed: TypedArrayElementDomain | null
  readonly wrapped: boolean
  readonly modulus: number | null
  readonly bases: readonly DenseOffset[]
  readonly operations: readonly IrNonTerminatorOperation[]
  readonly signed: readonly IrNonTerminatorOperation[]
}

interface WindowRecord {
  readonly reference: DenseReference
  /** The references whose every in-loop use this window has to account for: the array itself, and the array it is a row of. */
  readonly watch: readonly DenseReference[]
  /** Uses that are the window's own bookkeeping rather than a use of the storage -- the row load, for a row. */
  readonly excused: readonly IrNonTerminatorOperation[]
  readonly element: Representation
  readonly typed: TypedArrayElementDomain | null
  wrapped: boolean
  modulus: number | null
  readonly bases: DenseOffset[]
  readonly operations: IrNonTerminatorOperation[]
  /** The accesses whose index is a remainder and may be negative (`DenseAccess.signed`). */
  readonly signed: IrNonTerminatorOperation[]
  sound: boolean
}

/** One window's identity, so two accesses to the same array in one loop meet. */
const referenceKey = (reference: DenseReference): string =>
  reference.kind === 'cell'
    ? `cell:${reference.declaration}`
    : reference.kind === 'value'
      ? `value:${reference.operand.value}`
      : `element:${referenceKey(reference.holder)}:${reference.key.value}`

/** Every in-loop site that names the storage this reference stands for. */
const usesOfReference = (
  reference: DenseReference,
  context: WindowContext
): readonly { readonly operation: IrNonTerminatorOperation; readonly block: IrBlockId }[] => {
  if (reference.kind === 'cell')
    return [...context.usesOf.entries()]
      .filter(([value]) => context.readsCell.get(value) === reference.declaration)
      .flatMap(([, sites]) => sites)
  const operand = reference.kind === 'value' ? reference.operand : reference.operand
  return context.usesOf.get(operand.value) ?? []
}

/**
 * The array one access reaches, as something the preheader can name.
 *
 * A cell the loop never writes, a value defined before the loop, or -- one
 * level in -- a row loaded from one of those by a loop-invariant index.
 */
const heldArrayOf = (
  receiver: IrOperand,
  context: WindowContext,
  blocks: ReadonlySet<IrBlockId>
): {
  readonly reference: DenseReference
  readonly watch: readonly DenseReference[]
  readonly excused: readonly IrNonTerminatorOperation[]
} | null => {
  const cell = context.readsCell.get(receiver.value)
  if (cell !== undefined) {
    if (!(context.cellWrites.get(cell) ?? []).every((write) => !blocks.has(write.block))) return null
    const reference: DenseReference = { kind: 'cell', declaration: cell, representation: receiver.representation }
    return { reference, watch: [reference], excused: [] }
  }
  if (context.definedOutside(receiver.value, blocks)) {
    const reference: DenseReference = {
      kind: 'value',
      operand: receiver,
      storage: context.values.get(receiver.value) ?? receiver.representation
    }
    return { reference, watch: [reference], excused: [] }
  }
  const load = context.operationOf.get(receiver.value)
  if (load?.kind !== 'get' || load.receiver.representation.kind !== 'array-object') return null
  if (!context.definedOutside(load.key.value, blocks)) return null
  const holder = heldArrayOf(load.receiver, context, blocks)
  // One level only: a row of a row would need the preheader to unpack two
  // loads behind two conditions, and nothing in the corpus asks for it.
  if (holder === null || holder.reference.kind === 'element') return null
  const reference: DenseReference = { kind: 'element', holder: holder.reference, key: load.key, operand: receiver }
  return { reference, watch: [reference, holder.reference], excused: [load] }
}

interface WindowContext {
  readonly body: IrBody
  /** Every value's producer carrier, before a use site applies flow narrowing. */
  readonly values: ReadonlyMap<IrValueId, Representation>
  readonly readsCell: ReadonlyMap<IrValueId, DeclarationId>
  /** Constant spellings, so a `length` read can be told from any other property get. */
  readonly constantTexts: ReadonlyMap<IrValueId, string>
  readonly cellWrites: ReadonlyMap<DeclarationId, { readonly value: IrOperand; readonly block: IrBlockId }[]>
  readonly usesOf: ReadonlyMap<IrValueId, { readonly operation: IrNonTerminatorOperation; readonly block: IrBlockId }[]>
  readonly operationOf: ReadonlyMap<IrValueId, IrNonTerminatorOperation>
  readonly counter: DeclarationId
  readonly definedOutside: (value: IrValueId, blocks: ReadonlySet<IrBlockId>) => boolean
  /** What the preheader may name for this operand, looking through the loop's trivial phis; `null` when it varies. */
  readonly invariantOperand: (operand: IrOperand, blocks: ReadonlySet<IrBlockId>) => IrOperand | null
}

/**
 * The arrays this loop touches only through counter-indexed element accesses.
 *
 * Grouped by the array's own identity -- the CELL, not the read: every turn of
 * the loop reads the cell again, so asking where the receiver VALUE was defined
 * answers "inside the loop" for an array the loop plainly never changes.
 */
const windowsOfLoop = (blocks: ReadonlySet<IrBlockId>, body: IrBody, context: WindowContext): readonly WindowCandidate[] => {
  const byReference = new Map<string, WindowRecord>()
  const nativeOperations = borrowSafeOperationsOf(body)
  // No pointer may outlive a callback that can replace/detach its storage.
  // Numeric typed-array writes alias bytes but cannot invalidate geometry.
  const nativeOnly = [...blocks].every((id) => body.blocks.get(id)?.operations.every((operation) => nativeOperations.has(operation)))

  const noteUnsound = (key: string): void => {
    const found = byReference.get(key)
    if (found) found.sound = false
  }

  for (const blockId of body.blockOrder) {
    if (!blocks.has(blockId)) continue
    const block = body.blocks.get(blockId)
    if (!block) continue
    for (const operation of block.operations) {
      if (operation.kind !== 'get' && operation.kind !== 'set') continue
      const receiver = operation.receiver
      if (receiver.representation.kind !== 'array-object' && receiver.representation.kind !== 'typed-array') continue
      // Dense typed-array windows lower to a cached raw T* and static
      // readInBounds/writeInBounds calls. A SharedArrayBuffer view must route
      // every ordinary access through its backing-store synchronization so it
      // cannot race Atomics or an overlapping view.
      if (receiver.representation.kind === 'typed-array' && receiver.representation.buffer === 'shared-array-buffer') continue
      const typed = receiver.representation.kind === 'typed-array' ? receiver.representation.element : null
      if (typed !== null && !nativeOnly) continue
      const element: Representation =
        receiver.representation.kind === 'array-object' ? receiver.representation.element : { kind: 'scalar', domain: 'number' }
      // `a.length` is a `get` on an array like any element read, and it is the
      // one that is not an ELEMENT access: it has no index to bound, so asking
      // for one answers "cannot bound this" and takes the window down with it.
      if (operation.kind === 'get' && context.constantTexts.get(operation.key.value) === 'length') continue
      const held = heldArrayOf(receiver, context, blocks)
      if (held === null) continue
      const key = referenceKey(held.reference)
      // The array's own length first: an index bounded by the length it is
      // taken modulo needs no number carried to the preheader, and a program
      // that spells both is better served by the shape that checks less.
      const ownLength = wrapsOwnLength(operation.key, receiver, context)
      const at = block.operations.indexOf(operation)
      const modulus = ownLength ? null : constantModulusOf(operation.key, context, block.operations, at)
      const wrapped = ownLength || modulus !== null
      const signed = ownLength || (modulus !== null && !isMaskKey(operation.key, context, block.operations, at))
      // A typed array has no own-length remainder form here (its length is not
      // `cells`), but a constant reach is checked against its `size()` like any
      // other window.
      if (typed !== null && ((wrapped && modulus === null) || held.reference.kind === 'element')) continue
      const base = wrapped ? null : indexBaseOf(operation.key, context, blocks)
      const found = byReference.get(key)
      if (base === undefined) {
        if (found) found.sound = false
        else byReference.set(key, { ...held, element, typed, wrapped, modulus, bases: [], operations: [], signed: [], sound: false })
        continue
      }
      if (!found) {
        byReference.set(key, {
          ...held,
          element,
          typed,
          wrapped,
          modulus,
          bases: [base],
          operations: [operation],
          signed: signed ? [operation] : [],
          sound: true
        })
        continue
      }
      // Different addends each contribute a range check to the one cumulative
      // preheader flag. Selecting only one would leave the others unchecked.
      // Wrapped and ordinary accesses still need different geometry proofs.
      // Two constant moduli in one window would need the LARGER checked at the
      // preheader, and taking the larger of a pair says nothing about a third
      // that arrives later. Widening the window is a change of proof, not of
      // bookkeeping, so a second modulus takes the window down exactly as a
      // second base does.
      if (found.wrapped !== wrapped || found.modulus !== modulus) found.sound = false
      else {
        const same = (known: DenseOffset): boolean =>
          known === null || base === null
            ? known === base
            : known.terms.length === base.terms.length &&
              known.terms.every(
                (term, at) => term.operand.value === base.terms[at]?.operand.value && term.negated === base.terms[at]?.negated
              )
        if (!found.bases.some(same)) found.bases.push(base)
        found.operations.push(operation)
        if (signed) found.signed.push(operation)
      }
    }
  }

  // Every OTHER use of the array inside the loop disqualifies the window: a
  // `push`, a call taking it, a store of it somewhere else -- each one can
  // resize the storage the pointer names, and none of them is something a
  // bound on the INDEX says anything about.
  for (const [key, window] of byReference) {
    if (!window.sound) continue
    for (const held of window.watch)
      for (const site of usesOfReference(held, context)) {
        if (!blocks.has(site.block)) continue
        if (window.operations.includes(site.operation) || window.excused.includes(site.operation)) continue
        // A read of the array's own `length` is not a use of the STORAGE: it
        // cannot resize anything, and it is exactly what a wrapped window's
        // index is computed from -- so counting it would make the one shape
        // that needs it impossible to admit.
        if (site.operation.kind === 'get' && context.constantTexts.get(site.operation.key.value) === 'length') continue
        noteUnsound(key)
      }
  }

  return [...byReference.values()].filter((window) => window.sound && window.operations.length > 0)
}

/**
 * Whether an index is a REMAINDER by this very array's `length`.
 *
 * `x % a.length` is in `(-a.length, a.length)` for every dividend, and the
 * access tests the sign (`DenseAccess.signed`), so an access keyed
 * by one needs no bound of its own -- which is the whole point, because the
 * bound is what a per-access size read would cost. The receiver of the length
 * read has to be the SAME value the access itself indexes: `a[x % b.length]`
 * proves nothing about `a`.
 *
 * The zero-length case is the one the arithmetic does not cover -- `x % 0` is
 * NaN, which is no index at all -- and it is the preheader's `size() > 0` that
 * rules it out, not this.
 */
const wrapsOwnLength = (key: IrOperand, receiver: IrOperand, context: WindowContext): boolean => {
  const compute = context.operationOf.get(key.value)
  if (compute?.kind !== 'compute' || compute.form !== 'binary' || compute.operator !== '%') return false
  const divisor = compute.operands[1]
  if (!divisor) return false
  const read = context.operationOf.get(divisor.value)
  if (read?.kind !== 'get' || context.constantTexts.get(read.key.value) !== 'length') return false
  if (read.receiver.representation.kind !== 'array-object') return false
  // The same ARRAY, which is not the same SSA value: every turn of the loop
  // reads the cell again, so `ring.length` and `ring[...]` name two different
  // values of one cell. Comparing the cell is what the window is grouped by
  // anyway (`referenceKey`), and the window already requires that the loop
  // never writes it.
  const own = context.readsCell.get(receiver.value)
  const divisorCell = context.readsCell.get(read.receiver.value)
  return read.receiver.value === receiver.value || (own !== undefined && own === divisorCell)
}

/**
 * The positive integer an index is taken modulo, when the divisor is a
 * CONSTANT -- `table[i % 16]`.
 *
 * The same arithmetic `wrapsOwnLength` relies on: `x % n` lies in `(-n, n)`
 * for every dividend whenever `n > 0`, and the access tests its sign. What this does NOT prove is that `n` is
 * inside the array, because a constant says nothing about a length; the
 * preheader's `size() >= n` is what closes that, and `DenseArray.modulus`
 * carries the number there.
 *
 * Rejects anything that is not a plain positive integer literal. A fractional
 * or negative divisor is not a modulus a window can be proved from, and a text
 * this cannot read is simply not one of these.
 */
const constantModulusOf = (
  key: IrOperand,
  context: WindowContext,
  operations: readonly IrNonTerminatorOperation[],
  at: number
): number | null => {
  const compute = remainderBehind(key, context, operations, at)
  if (compute?.kind !== 'compute' || compute.form !== 'binary') return null
  if (compute.operator === '&') return constantMaskReachOf(compute.operands, context)
  if (compute.operator !== '%') return null
  const divisor = compute.operands[1]
  if (!divisor) return null
  const text = context.constantTexts.get(divisor.value)
  if (text === undefined) return null
  const value = Number(text)
  if (!Number.isSafeInteger(value) || value <= 0) return null
  return value
}

/** Whether an index whose reach `constantModulusOf` read is a MASK, which is never negative. */
const isMaskKey = (key: IrOperand, context: WindowContext, operations: readonly IrNonTerminatorOperation[], at: number): boolean => {
  const compute = remainderBehind(key, context, operations, at)
  return compute?.kind === 'compute' && compute.form === 'binary' && compute.operator === '&'
}

/**
 * `table[v & 255]` -- the other way every lookup table is indexed, and the
 * one that needs no sign argument at all: `&` works on ToInt32 of both
 * operands, so with a mask `M` in `[0, 2^31)` the result lies in `[0, M]` for
 * EVERY left operand, NaN and negatives included. That is a window over
 * `M + 1` elements, which is exactly what a constant modulus of `M + 1` asks
 * the preheader to check, so it travels as one.
 *
 * Either operand may be the constant; a negative or fractional one bounds
 * nothing and is not one of these.
 */
const constantMaskReachOf = (operands: readonly IrOperand[], context: WindowContext): number | null => {
  for (const operand of operands) {
    const text = context.constantTexts.get(operand.value)
    if (text === undefined) continue
    const value = Number(text)
    if (Number.isSafeInteger(value) && value >= 0 && value <= 0x7fffffff) return value + 1
  }
  return null
}

/**
 * Where an index's value was computed, seeing through a binding.
 *
 * `const slot = i % 16; table[slot] = v; return table[(slot + 1) % 16]` writes
 * the remainder into a cell and indexes with a READ of it, so the store's key
 * is a `binding-read` and the load's key is the `%` itself. Asking only the
 * operation the key names would make those two accesses disagree about the
 * window's shape, and a window whose accesses disagree is no window -- which is
 * how the two halves of an ordinary table update came to prove nothing.
 *
 * The write it resolves to is the LAST one this block made before the access,
 * which is the definition the read observes: within a block, operations run in
 * order and a binding is the only thing that writes a binding. It deliberately
 * looks no further -- a write in another block would need dominance, and the
 * shape this exists for puts both in the body it indexes from.
 */
const remainderBehind = (
  key: IrOperand,
  context: WindowContext,
  operations: readonly IrNonTerminatorOperation[],
  at: number
): IrNonTerminatorOperation | undefined => {
  const direct = context.operationOf.get(key.value)
  if (direct?.kind === 'compute') return direct
  const cell = context.readsCell.get(key.value)
  if (cell === undefined) return undefined
  let seen: IrNonTerminatorOperation | undefined
  for (let index = 0; index < at; index += 1) {
    const candidate = operations[index]
    if (candidate?.kind === 'binding-write' && candidate.declaration === cell) seen = context.operationOf.get(candidate.value.value)
  }
  return seen
}

/**
 * The loop-invariant addend an index carries, `null` for the bare counter, and
 * `undefined` for an index this cannot bound.
 */
const indexBaseOf = (key: IrOperand, context: WindowContext, blocks: ReadonlySet<IrBlockId>): DenseOffset | undefined => {
  if (context.readsCell.get(key.value) === context.counter) return null
  const parallel = parallelCounterBaseOf(key, context, blocks)
  if (parallel !== undefined) return { terms: [{ operand: parallel, negated: false }] }
  const terms: { readonly operand: IrOperand; readonly negated: boolean }[] = []
  // Exactly one positive counter leaf; every other leaf invariant. Depth is
  // bounded by the expression the program wrote, a handful of terms.
  const walk = (operand: IrOperand, negated: boolean, depth: number): number | undefined => {
    if (context.readsCell.get(operand.value) === context.counter) return negated ? undefined : 1
    const invariant = context.invariantOperand(operand, blocks)
    if (invariant !== null) {
      terms.push({ operand: invariant, negated })
      return 0
    }
    const compute = context.operationOf.get(operand.value)
    if (depth > 4 || compute?.kind !== 'compute' || compute.form !== 'binary') return undefined
    if (compute.operator !== '+' && compute.operator !== '-') return undefined
    const [left, right] = compute.operands
    if (!left || !right) return undefined
    const counted = walk(left, negated, depth + 1)
    if (counted === undefined) return undefined
    const more = walk(right, compute.operator === '-' ? !negated : negated, depth + 1)
    return more === undefined ? undefined : counted + more
  }
  return walk(key, false, 0) === 1 ? { terms } : undefined
}

/** Two counters advanced together by one differ by their initial offset.
 * Requiring a zero primary seed and adjacent advances avoids synthesizing
 * arithmetic or assuming that a conditional/inner-loop advance ran. */
const parallelCounterBaseOf = (key: IrOperand, context: WindowContext, blocks: ReadonlySet<IrBlockId>): IrOperand | undefined => {
  const secondary = context.readsCell.get(key.value)
  if (secondary === undefined || secondary === context.counter) return undefined
  const primaryWrites = context.cellWrites.get(context.counter) ?? []
  const secondaryWrites = context.cellWrites.get(secondary) ?? []
  const primarySeeds = primaryWrites.filter((write) => !blocks.has(write.block))
  const secondarySeeds = secondaryWrites.filter((write) => !blocks.has(write.block))
  const primarySteps = primaryWrites.filter((write) => blocks.has(write.block))
  const secondarySteps = secondaryWrites.filter((write) => blocks.has(write.block))
  const isLiteral = (value: IrOperand, text: string): boolean => {
    const operation = context.operationOf.get(value.value)
    return operation?.kind === 'constant' && operation.literal === 'number' && operation.text === text
  }
  if (primarySeeds.length === 0 || !primarySeeds.every((seed) => isLiteral(seed.value, '0'))) return undefined
  if (secondarySeeds.length !== 1 || primarySteps.length !== 1 || secondarySteps.length !== 1) return undefined
  const seed = secondarySeeds[0]!
  const primary = primarySteps[0]!
  const other = secondarySteps[0]!
  if (primary.block !== other.block || !context.definedOutside(seed.value.value, blocks)) return undefined
  const unitStep = (value: IrOperand, cell: DeclarationId): boolean => {
    const step = stepOf(value, cell, context.operationOf, context.readsCell)
    return step === null || (step !== undefined && isLiteral(step, '1'))
  }
  if (!unitStep(primary.value, context.counter) || !unitStep(other.value, secondary)) return undefined
  const operations = context.body.blocks.get(primary.block)?.operations ?? []
  const first = operations.findIndex((operation) => operation.kind === 'binding-write' && operation.declaration === context.counter)
  const second = operations.findIndex((operation) => operation.kind === 'binding-write' && operation.declaration === secondary)
  if (first < 0 || second < 0) return undefined
  if (
    operations
      .slice(Math.min(first, second) + 1, Math.max(first, second))
      .some((operation) => operation.kind === 'get' || operation.kind === 'set')
  )
    return undefined
  return seed.value
}
