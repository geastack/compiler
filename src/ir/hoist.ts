import type { DeclarationId, IrValueId } from '../identity/ids.js'
import { controlFlowGraphOf, cyclicBlocksOf, dominatorTreeOf, naturalLoopsOf, type DominatorTree } from './dominance.js'
import type { IrBlockId, IrBody, IrNonTerminatorOperation, IrOperand } from './model.js'
import { operandsOfIrOperation, resultOfIrOperation } from './queries.js'

/**
 * Loop-invariant operations, and the block each one moves to.
 *
 * `c[i * N + j] += a[i][k] * b[k][j]` recomputes `a[i][k]`, `b[k]` and `i * N`
 * on every turn of the `j` loop, and no C++ compiler will move them out: an
 * element read goes through a handle, and a store through another handle may
 * alias it as far as the optimizer can prove, so the loads have to be repeated.
 * The compiler that DOES know they are invariant is this one -- the index
 * expressions name loop variables it can see are not written in the inner loop
 * -- and hoisting them is what lets clang see a straight-line inner loop it can
 * then vectorize.
 *
 * Two conditions make the move observationally neutral, and both are checked
 * rather than assumed:
 *
 *   - **The loop runs at least once.** Moving a load into the preheader runs
 *     it even when the body never would, and a load that would not have
 *     happened can fault. Only a loop whose counter starts at a known constant
 *     below a known constant bound is hoisted out of.
 *   - **The operation runs on every iteration.** Its block has to dominate
 *     every back edge, or the move turns a conditional load into an
 *     unconditional one -- the same fault, one level in.
 *
 * Only operations that read: arithmetic, a cell whose loop writes nothing, and
 * an Array element load, or native immutable-string length/method reads. Never
 * a call, a store, a construction, or a property access that could reach an
 * accessor. Strings need no array-storage alias proof: their values are immutable.
 */
export interface HoistPlan {
  /** Operations to render at the head of a block, in dependency order. */
  readonly into: ReadonlyMap<IrBlockId, readonly IrNonTerminatorOperation[]>
  /** The results of every relocated operation, so its original block skips it. */
  readonly relocated: ReadonlySet<IrValueId>
}

export const emptyHoistPlan: HoistPlan = { into: new Map(), relocated: new Set() }

/** The operators whose C++ spelling reads nothing and traps on nothing. */
const pureOperators: ReadonlySet<string> = new Set([
  '+',
  '-',
  '*',
  '/',
  '<',
  '>',
  '<=',
  '>=',
  '===',
  '!==',
  '==',
  '!=',
  '&',
  '|',
  '^',
  '<<',
  '>>',
  '>>>',
  '~',
  '++',
  '--',
  // `%` traps on nothing: a narrowed one only ever reaches
  // `gea::integerRemainder` with a non-zero CONSTANT divisor (the integer
  // census admits no other), and an unnarrowed one is a double `fmod`.
  '%'
])

/**
 * The operation kinds that cannot change what an array answers.
 *
 * Deliberately a whitelist: a kind absent here blocks the move, so a kind
 * added to the IR later is fail-closed rather than silently admitted. `set`,
 * `convert` and every allocation are out on purpose -- a store writes array
 * storage, and a conversion of an unknown value can reach user code.
 */
const storageNeutralKinds: ReadonlySet<string> = new Set([
  'constant',
  'compute',
  'binding-read',
  'binding-write',
  'parameter',
  'receiver',
  'get'
])

export const loopInvariantHoistsOf = (body: IrBody): HoistPlan => {
  // A try region renders as one `try { } catch { }` chunk assembled from
  // several blocks at once, so a relocation into or out of one has no single
  // place to land. Bodies with a region are left alone entirely.
  if (body.tryRegions.length > 0 || (body.iteratorCloseRegions?.length ?? 0) > 0) return emptyHoistPlan

  const graph = controlFlowGraphOf(body)
  const dominance = dominatorTreeOf(body)
  const loops = naturalLoopsOf(graph, dominance)
  if (loops.length === 0) return emptyHoistPlan

  const constants = new Map<IrValueId, number>()
  const constantTexts = new Map<IrValueId, string>()
  const cellWrites = new Map<DeclarationId, { readonly value: IrOperand; readonly block: IrBlockId }[]>()
  const readsCell = new Map<IrValueId, DeclarationId>()
  const location = new Map<IrValueId, IrBlockId>()
  const operationOf = new Map<IrValueId, IrNonTerminatorOperation>()
  const conditionOf = new Map<IrBlockId, IrValueId>()

  for (const blockId of body.blockOrder) {
    const block = body.blocks.get(blockId)
    if (!block) continue
    if (block.terminator.kind === 'branch') conditionOf.set(blockId, block.terminator.condition.value)
    for (const operation of block.operations) {
      const result = 'result' in operation ? operation.result : null
      if (result) {
        location.set(result.id, blockId)
        operationOf.set(result.id, operation)
      }
      if (operation.kind === 'constant') constantTexts.set(operation.result.id, operation.text)
      if (operation.kind === 'constant' && operation.literal === 'number') {
        const value = Number(operation.text)
        if (Number.isFinite(value)) constants.set(operation.result.id, value)
      }
      if (operation.kind === 'binding-read') readsCell.set(operation.result.id, operation.declaration)
      if (operation.kind === 'binding-write') {
        const written = cellWrites.get(operation.declaration) ?? []
        written.push({ value: operation.value, block: blockId })
        cellWrites.set(operation.declaration, written)
      }
    }
  }

  // Local closure allocation can expose bindings to writes in another body.
  // IR allocation operands alone do not carry the emitter's complete capture
  // layout. Until that proof is published here, keep local reads in place in
  // bodies that create closures/constructors; SSA parameters remain eligible.
  const mayCaptureLocals = [...operationOf.values()].some(
    (operation) => operation.kind === 'allocate-callable' || operation.kind === 'allocate-constructor'
  )

  /** The number this value always holds, through at most one single-assignment cell. */
  const knownNumber = (value: IrValueId): number | null => {
    const literal = constants.get(value)
    if (literal !== undefined) return literal
    const cell = readsCell.get(value)
    if (cell === undefined) return null
    const written = cellWrites.get(cell) ?? []
    const only = written.length === 1 ? written[0] : undefined
    return only ? (constants.get(only.value.value) ?? null) : null
  }

  /**
   * Whether this loop's first test is known to pass.
   *
   * The counter's seed and the bound both have to be constants, and the seed
   * has to satisfy the test. Anything less is a loop that might run zero times,
   * and its preheader is not a place a load may be moved to.
   */
  const entersAtLeastOnce = (header: IrBlockId, blocks: ReadonlySet<IrBlockId>): boolean => {
    const condition = conditionOf.get(header)
    if (condition === undefined) return false
    const test = operationOf.get(condition)
    if (test?.kind !== 'compute' || test.form !== 'binary') return false
    const ascending = test.operator === '<' || test.operator === '<='
    const descending = test.operator === '>' || test.operator === '>='
    if (!ascending && !descending) return false
    const [left, right] = test.operands
    if (!left || !right) return false
    const bound = knownNumber(right.value)
    if (bound === null) return false
    const counter = readsCell.get(left.value)
    if (counter === undefined) return false
    // Every write outside the loop is a seed; each one has to be a constant
    // that passes the test, because any of them could be the value the loop
    // starts from.
    const seeds = (cellWrites.get(counter) ?? []).filter((write) => !blocks.has(write.block))
    if (seeds.length === 0) return false
    return seeds.every((seed) => {
      const start = constants.get(seed.value.value)
      if (start === undefined) return false
      if (test.operator === '<') return start < bound
      if (test.operator === '<=') return start <= bound
      if (test.operator === '>') return start > bound
      return start >= bound
    })
  }

  /** The single entry into this loop from outside it. */
  const preheaderOf = (header: IrBlockId, blocks: ReadonlySet<IrBlockId>): IrBlockId | null => {
    const outside = (graph.predecessors.get(header) ?? []).filter((predecessor) => !blocks.has(predecessor))
    return outside.length === 1 ? (outside[0] ?? null) : null
  }

  const dominatesEveryLatch = (blockId: IrBlockId, header: IrBlockId, blocks: ReadonlySet<IrBlockId>, tree: DominatorTree): boolean =>
    (graph.predecessors.get(header) ?? []).every((latch) => !blocks.has(latch) || tree.dominates(blockId, latch))

  /**
   * Whether running this operation where it never would have run can fault.
   *
   * Only an element LOAD can: its index is a value the loop computed, and off
   * the end of the storage is a read of memory the array does not own. A
   * `length` read, a cell read and arithmetic all answer from something that
   * already exists, so running one an extra time costs a few instructions and
   * changes nothing -- which is what lets them leave a loop whose trip count is
   * a parameter nobody can bound. Those loops are most of them: `for (let i =
   * 0; i < iterations; i++)` is the shape of every fixture's outer loop, and
   * requiring the entry proof for a `ring.length` read left it inside.
   */
  const immutableStringRead = (operation: IrNonTerminatorOperation): boolean =>
    operation.kind === 'get' &&
    operation.receiver.representation.kind === 'string' &&
    ['length', 'charCodeAt'].includes(constantTexts.get(operation.key.value) ?? '')

  const mayFault = (operation: IrNonTerminatorOperation): boolean =>
    operation.kind === 'get' && !immutableStringRead(operation) && constantTexts.get(operation.key.value) !== 'length'

  /**
   * Whether anything inside this loop can change what an array answers.
   *
   * A `get` on an `array-object` is invariant only while its STORAGE is, and the
   * operand check below proves something strictly weaker: that the HANDLE is
   * defined outside the loop. `wanted.length` in
   *
   *     while (wanted.length > 0) { ...; wanted.splice(best, 1) }
   *
   * passes the operand check -- it is the same array every turn -- and hoisting
   * it froze the loop's own condition at the value it had before the loop began.
   * Measured on `examples/apps/maps`: the `while`'s test AND the inner
   * `for (j = 1; j < wanted.length; j++)` bound were both computed once in the
   * preheader, and the app aborted on its first frame reading `grid[11]` of an
   * eleven-element array.
   *
   * So the storage has to be proved unmodified, and what proves it here is a
   * body that writes no array at all: `push`/`splice`/`pop` are CALLS, and a
   * call may reach any array the program can name -- including one this loop
   * never spells, which is why the check is not narrowed to the receiver. The
   * cost is that a loop which stores into one array no longer hoists a load out
   * of another; regaining that needs an alias proof (distinct allocation sites),
   * not a weaker invariance test.
   */
  const mutatesArrayStorage = (blocks: ReadonlySet<IrBlockId>): boolean => {
    for (const blockId of blocks) {
      const block = body.blocks.get(blockId)
      if (!block) continue
      for (const operation of block.operations) {
        if (!storageNeutralKinds.has(operation.kind)) return true
      }
    }
    return false
  }

  /** Answered once per loop: the walk is over every operation the loop owns. */
  const arrayStorageMutated = new Map<IrBlockId, boolean>()

  const relocated = new Set<IrValueId>()
  const into = new Map<IrBlockId, IrNonTerminatorOperation[]>()

  /** Whether this operation reads only, and reads only things that cannot move. */
  const isPureRead = (operation: IrNonTerminatorOperation, blocks: ReadonlySet<IrBlockId>): boolean => {
    if (operation.kind === 'constant') return true
    if (operation.kind === 'compute') {
      if (!pureOperators.has(operation.operator)) return false
      // Only a non-zero constant divisor: a narrowed `%` becomes an integer
      // division, and moving one whose divisor could be zero would move a trap.
      return true
    }
    if (operation.kind === 'binding-read') {
      if (mayCaptureLocals) return false
      // Invariant only while the loop writes the cell nowhere.
      return (cellWrites.get(operation.declaration) ?? []).every((write) => !blocks.has(write.block))
    }
    if (operation.kind === 'get') {
      // Array elements and immutable string builtins: a record or class receiver can
      // reach an accessor, which is a call, and a call is not something this
      // may run an extra time or in a different order.
      return operation.receiver.representation.kind === 'array-object' || immutableStringRead(operation)
    }
    return false
  }

  const operandsOf = (operation: IrNonTerminatorOperation): readonly IrOperand[] => {
    if (operation.kind === 'compute') return operation.operands
    if (operation.kind === 'get') return [operation.receiver, operation.key]
    return []
  }

  for (let moving = true; moving;) {
    moving = false
    for (const loop of loops) {
      const preheader = preheaderOf(loop.header, loop.blocks)
      if (preheader === null) continue
      const entered = entersAtLeastOnce(loop.header, loop.blocks)
      for (const blockId of body.blockOrder) {
        if (!loop.blocks.has(blockId)) continue
        if (!dominatesEveryLatch(blockId, loop.header, loop.blocks, dominance)) continue
        const block = body.blocks.get(blockId)
        if (!block) continue
        // Everything that renders here NOW: what the block owns, plus whatever
        // an inner loop already moved in. The second half is what lets an
        // operation invariant in two nested loops travel all the way out --
        // it lands in the inner preheader on one round and leaves it on the
        // next.
        for (const operation of [...(into.get(blockId) ?? []), ...block.operations]) {
          const result = 'result' in operation ? operation.result : null
          if (!result) continue
          if (location.get(result.id) !== blockId) continue
          if (!isPureRead(operation, loop.blocks)) continue
          if (mayFault(operation) && !entered) continue
          // An element load and a `length` read both answer from storage this
          // loop may rewrite. `isPureRead` proved the handle invariant; this
          // proves the bytes behind it are too.
          if (operation.kind === 'get' && !immutableStringRead(operation)) {
            const mutated = arrayStorageMutated.get(loop.header) ?? mutatesArrayStorage(loop.blocks)
            arrayStorageMutated.set(loop.header, mutated)
            if (mutated) continue
          }
          // A cell read moved ahead of the loop has to name a cell something
          // already assigned; a write that only happens AFTER the loop leaves
          // the variable uninitialized at the new position.
          if (operation.kind === 'binding-read') {
            const written = cellWrites.get(operation.declaration) ?? []
            if (!written.some((write) => dominance.dominates(write.block, preheader))) continue
          }
          const invariant = operandsOf(operation).every((operand) => {
            const where = location.get(operand.value)
            return where === undefined || !loop.blocks.has(where)
          })
          if (!invariant) continue
          relocated.add(result.id)
          const previous = into.get(blockId)
          if (previous)
            into.set(
              blockId,
              previous.filter((held) => held !== operation)
            )
          location.set(result.id, preheader)
          const landing = into.get(preheader) ?? []
          landing.push(operation)
          into.set(preheader, landing)
          moving = true
        }
      }
    }
  }

  return { into, relocated }
}

/**
 * The values a loop cannot change: what clang's licm would lift, stated here.
 *
 * A value defined where no loop re-enters is invariant by position. Inside a
 * loop it still is when nothing the loop does can move it: a constant, a formal,
 * a read of a cell no cyclic block writes, or arithmetic over those. Everything
 * else -- a merge, a call, a load through a receiver -- is not, and is refused
 * rather than guessed at, because the caller's transform is only free for a
 * value that is genuinely computed once.
 *
 * This distinction is the whole difference between restating a loop's BOUND and
 * restating the quantity it is compared against: `x * x + y * y <= 4` in
 * `mandelbrot.ts` reads two cells the loop writes every iteration, and turning
 * its left side into an integer bound cost 13% of that fixture before this
 * existed.
 */
export const loopInvariantValuesOf = (body: IrBody): ReadonlySet<IrValueId> => {
  const cyclic = cyclicBlocksOf(body)
  const invariant = new Set<IrValueId>()
  const pending: IrNonTerminatorOperation[] = []
  const writtenInLoop = new Set<DeclarationId>()
  for (const id of body.blockOrder) {
    const block = body.blocks.get(id)
    if (block === undefined) continue
    for (const operation of block.operations) {
      if (operation.kind === 'binding-write' && cyclic.has(id)) writtenInLoop.add(operation.declaration)
      const result = resultOfIrOperation(operation)
      if (result === null) continue
      if (!cyclic.has(id)) invariant.add(result.id)
      else pending.push(operation)
    }
  }
  let growing = true
  while (growing) {
    growing = false
    for (const operation of pending) {
      const result = resultOfIrOperation(operation)
      if (result === null || invariant.has(result.id)) continue
      const stable =
        operation.kind === 'constant' ||
        operation.kind === 'parameter' ||
        (operation.kind === 'binding-read' && !writtenInLoop.has(operation.declaration)) ||
        (operation.kind === 'compute' && operandsOfIrOperation(operation).every((operand) => invariant.has(operand.value)))
      if (!stable) continue
      invariant.add(result.id)
      growing = true
    }
  }
  return invariant
}
