import { controlFlowGraphOf } from '../../ir/dominance.js'
import type { IrValueId } from '../../identity/ids.js'
import { thrownValueCarrier } from '../../ir/lower-exceptions.js'
import type {
  IrBlockId,
  IrBody,
  IrIteratorCloseRegion,
  IrNonTerminatorOperation,
  IrOperand,
  IrTerminatorOperation,
  IrTryRegion
} from '../../ir/model.js'
import { successorsOfTerminator } from '../../ir/queries.js'
import { createCppEmitBlockedError, defineValueBoundElsewhere, operandText, type EmitContext } from './emit-context.js'
import { cppFinallyGuardName, cppFinallyPendingName, cppTypeOf } from './types.js'

/**
 * One try statement's block range, rendered as native C++ `try`/`catch` text.
 *
 * The flat block model connects everything by `goto`, but C++ forbids a `goto`
 * that jumps into a `try` block or a `catch` handler from outside it -- the one
 * transition `emit.ts`'s ordinary per-block loop otherwise never has to
 * special-case. `lower-flow.ts` already keeps that one entry a fallthrough
 * rather than a jump (see `RegionBlocks`'s own comment there); this is where the
 * fallthrough is actually rendered, and where the matching `}` of one side and
 * the `catch (...) {`/closing `}` of the other are written by hand instead of by
 * the ordinary per-block loop.
 *
 * Everything else about a region's blocks is ordinary. This used to walk only a
 * straight run of unconditional jumps and refuse the moment it met a branch,
 * on the stated grounds that "nothing in `lower-flow.ts`'s region bookkeeping
 * tracks which *extra* blocks a nested guard/loop would open while a region is
 * active". That was true of `lower-flow.ts` and irrelevant to the question:
 * the blocks a part owns are not bookkeeping to be carried forward, they are
 * a property of the finished graph -- every block reachable from the part's
 * entry without passing through the region's join. `collectPartBlocks` reads
 * that off the sealed body, so a `try` body may now branch, loop and merge
 * like any other code. What C++ actually forbids is narrower than what was
 * being refused, and it is checked directly in `verifyNoInboundJumps`.
 *
 * Two facts make rendering interior blocks safe. Every SSA value is declared at
 * function scope (see the declaration block `emitBody` emits first, and its own
 * comment about `goto` and initialized scopes), so a label inside a `try` never
 * jumps past an initialization. And a `goto` OUT of a try -- to the join, to an
 * enclosing loop, to a `return` -- is perfectly legal C++; only jumping IN is
 * not.
 *
 * `emitOperation`/`emitTerminator`/`labelOf` are parameters rather than imports
 * to avoid a cycle: all three are `emit.ts`'s own, and this module renders a
 * whole set of arbitrary blocks -- their operations, their merge writes and
 * their real terminators -- by calling back into them.
 */
type EmitOperation = (ctx: EmitContext, lines: string[], operation: IrNonTerminatorOperation) => void
type EmitTerminator = (
  ctx: EmitContext,
  lines: string[],
  labels: ReadonlyMap<IrBlockId, string>,
  isSingleBlock: boolean,
  terminator: IrTerminatorOperation
) => void

/** What `renderTryRegion` needs from `emit.ts` to render a region's blocks the same way the ordinary per-block loop renders every other block. */
export interface RegionRendering {
  readonly emitOperation: EmitOperation
  readonly emitTerminator: EmitTerminator
  readonly labelOf: (labels: ReadonlyMap<IrBlockId, string>, block: IrBlockId) => string
  readonly labels: ReadonlyMap<IrBlockId, string>
  readonly isSingleBlock: boolean
  /**
   * The merge writes `emit.ts` computed for the whole body.
   *
   * A branching try body is exactly the shape that produces these -- two arms
   * of an `if` writing one merged variable -- and the write belongs in the
   * predecessor, which is an interior block of this region. Rendering the
   * region without them would drop the write and leave the merge holding
   * whatever the declaration default was.
   */
  readonly mergeWrites: ReadonlyMap<IrBlockId, readonly { readonly name: string; readonly value: IrOperand }[]>
  /** Every region in this body by its own `tryEntry`, so a nested one can be recognized -- and refused by name -- rather than rendered as ordinary blocks. */
  readonly regionByTryEntry: ReadonlyMap<IrBlockId, IrTryRegion>
  /**
   * Every iterator-close/finite-destructuring-close region in this body by its
   * own `entry`, for the identical reason `regionByTryEntry` exists: a `for`
   * `(const x of xs) { ... }` or `const [a] = xs` written directly inside a
   * `try` body/handler/finally clause makes that region's entry block one of
   * THIS part's ordinary reachable blocks, and without recognizing it here it
   * rendered as plain statements -- silently dropping the `CompletionGuard`
   * and the inner protective `try`/`catch` IteratorClose needs. A `for`-`of`
   * loop wrapped in a `try` already worked before this map existed, because
   * that shape nests the other way (the loop's own iterator-close region
   * contains the `try`, not the reverse); a source-level `try` wrapping a
   * FINITE destructuring statement is the one shape only `preparePart` sees.
   */
  readonly iteratorCloseRegionByEntry: ReadonlyMap<IrBlockId, IrIteratorCloseRegion>
  /**
   * Renders one iterator-close region as `emit.ts`'s own per-block loop does
   * for a top-level one -- a callback rather than a direct import, because
   * `emit-iterator.ts` already imports `renderTryRegion` from this module for
   * the opposite nesting (a plain `try` written inside a `for`-`of` body), and
   * importing back would cycle the two modules.
   */
  readonly renderIteratorCloseRegion: (
    ctx: EmitContext,
    lines: string[],
    body: IrBody,
    region: IrIteratorCloseRegion,
    rendering: RegionRendering
  ) => readonly IrBlockId[]
  /**
   * The hoist plan's two halves and the block tail, as `emit.ts` writes them
   * for every block it renders itself.
   *
   * A region's blocks are not a different kind of block, and this file's own
   * header says so -- but `renderPart` used to write only operations, merge
   * writes and a terminator, so a hoisted read, a dense window's setup and a
   * counted fill loop were all silently dropped for anything inside a `try`.
   * The first of those is not a missed optimization but a double DEFINITION:
   * the relocated read renders at its destination AND at its origin.
   */
  readonly relocated: ReadonlySet<IrValueId>
  readonly emitHoistedInto: (ctx: EmitContext, lines: string[], block: IrBlockId) => void
  /** A dense window's setup and a counted fill loop; `true` when the fill loop replaced the block's terminator. */
  readonly emitBlockTail: (ctx: EmitContext, lines: string[], block: IrBlockId) => boolean
}

/**
 * Every block one part of a region owns: reachable from that part's entry
 * without passing through the region's join, minus everything the try
 * STATEMENT does not contain.
 *
 * The join is where both parts hand control back to the ordinary per-block
 * loop, so it belongs to neither and stops the walk. A part that never reaches
 * it -- both arms `return` -- simply runs out of successors instead.
 *
 * Reachability alone is not ownership, and a jump OUT of the part is what
 * exposes the difference. A `continue` written inside a catch handler --
 * hono's `SmartRouter.match` skipping a router that rejected the route set --
 * targets the enclosing loop's latch, so the plain walk collected the latch,
 * then the loop header, then the header's test, and then walked straight back
 * into the try body: the handler "owned" the body's blocks and emission
 * refused with `a catch handler contains a block reached by a jump from
 * outside it`. The jump the source wrote is legal C++ (leaving a try block is
 * fine; only entering one is not); it was the walk that was wrong.
 *
 * Two cuts fix it, and both are about what the BRACES may contain rather than
 * about what control can reach.
 *
 * The first is the enclosing loop's own cycle. A block from which the region's
 * `tryEntry` is reachable again -- without going through the join, which the
 * walk already stops at -- can only be on a path that RE-ENTERS the try
 * statement, so it is the enclosing loop's latch, header or test and not part
 * of this statement at all. That is exactly what ECMAScript says: `continue`
 * completes the try statement first and the incrementor runs after it, so
 * rendering the latch inside `try { }` would put a throwing `for (;; next())`
 * under a handler the language says it has left. A loop written INSIDE the try
 * body is untouched, because its latch reaches its own header and never
 * `tryEntry` -- nothing jumps back to the first block of a try statement from
 * within it.
 *
 * The second is entry-dominance, as a fixpoint rather than a dominator query:
 * a catch entry is reached by NO control-flow edge and so is globally
 * unreachable, and `dominatorTreeOf` fails closed on exactly the part that
 * needs it most. Dropping every non-entry block that has a predecessor outside
 * the set, until nothing more drops, computes entry-dominance within the
 * walked subgraph, which is what the braces require: a block rendered inside
 * them must have no way in except through them.
 *
 * Neither cut can shrink a set that used to be accepted. `verifyNoInboundJumps`
 * already demanded that no non-entry owned block have an outside predecessor
 * -- the fixpoint's own stopping condition -- and a set holding a block that
 * re-enters `tryEntry` necessarily held `tryEntry`'s outside predecessor too,
 * which that check refused.
 */
const collectPartBlocks = (body: IrBody, entry: IrBlockId, join: IrBlockId | null, regionEntry: IrBlockId): ReadonlySet<IrBlockId> => {
  const owned = new Set<IrBlockId>()
  const pending: IrBlockId[] = [entry]
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === undefined || current === join || owned.has(current)) continue
    owned.add(current)
    const block = body.blocks.get(current)
    if (!block) throw new Error(`ir body ${body.owner} names block ${current} in a try region but has no matching block`)
    for (const successor of successorsOfTerminator(block.terminator)) pending.push(successor)
  }
  const predecessors = controlFlowGraphOf(body).predecessors
  // Backwards from the region's own first block, over predecessors the walk
  // already admitted: every block from which the try statement is re-entered.
  const reenters = new Set<IrBlockId>()
  const backwards: IrBlockId[] = [regionEntry]
  while (backwards.length > 0) {
    const current = backwards.pop()
    if (current === undefined) continue
    for (const from of predecessors.get(current) ?? []) {
      if (!owned.has(from) || reenters.has(from)) continue
      reenters.add(from)
      backwards.push(from)
    }
  }
  for (const id of reenters) if (id !== entry) owned.delete(id)
  for (let dropped = true; dropped;) {
    dropped = false
    for (const id of owned) {
      if (id === entry) continue
      if ((predecessors.get(id) ?? []).every((from) => owned.has(from))) continue
      owned.delete(id)
      dropped = true
    }
  }
  return owned
}

/**
 * The rendering order for one part: its entry first, then everything else in
 * the body's own block order.
 *
 * The entry has to come first because it is reached by FALLTHROUGH -- into
 * `try {` from the predecessor whose `goto` `emit.ts` omits, and into
 * `catch (...) {` from the native unwinder. Neither can land on a label, so
 * whatever is written first inside those braces is what runs first. Every other
 * block is reached by an ordinary `goto` and so may sit in any order; taking
 * the body's own keeps the output stable and matches the loop outside.
 */
const partOrder = (
  body: IrBody,
  owned: ReadonlySet<IrBlockId>,
  entry: IrBlockId,
  rendersItself: ReadonlySet<IrBlockId>
): readonly IrBlockId[] => [entry, ...body.blockOrder.filter((id) => owned.has(id) && id !== entry && !rendersItself.has(id))]

/**
 * Every block a region owns, across all three of its parts and every region
 * nested inside them. A nested region's catch handler and finally clause are
 * reached by no control-flow edge, so a reachability walk from the outer
 * part's entry never finds them -- yet textually they sit inside the outer
 * braces, and a jump out of them to the outer part is a jump WITHIN the outer
 * try block, which C++ allows. Counting them as the outer part's own is what
 * lets `verifyNoInboundJumps` see that edge for what it is.
 */
const blocksOfRegion = (body: IrBody, region: IrTryRegion, rendering: RegionRendering): ReadonlySet<IrBlockId> => {
  const all = new Set<IrBlockId>()
  for (const entry of [region.tryEntry, region.catchEntry, region.finallyEntry]) {
    if (entry === null) continue
    for (const id of collectPartBlocks(body, entry, region.join, region.tryEntry)) all.add(id)
  }
  for (const id of [...all]) {
    const nested = id === region.tryEntry ? undefined : rendering.regionByTryEntry.get(id)
    if (nested) for (const inner of blocksOfRegion(body, nested, rendering)) all.add(inner)
    // A finite destructuring / `for`-`of` written directly inside this try
    // region's own body/handler/finally names its OWN block list already
    // (`IrIteratorCloseRegion.blocks`, computed by `iterator-close-regions-of`
    // in `ir/lower.ts` over the very same predecessor-closure `closeRegionOverGraph`
    // uses for a loop's) -- no recursive reachability walk is needed here the
    // way a try region's needs one for its handler/finally, which no ordinary
    // control-flow edge reaches.
    const nestedIteratorClose = id === region.tryEntry ? undefined : rendering.iteratorCloseRegionByEntry.get(id)
    if (nestedIteratorClose) for (const inner of nestedIteratorClose.blocks) all.add(inner)
  }
  return all
}

/**
 * Refuses a part no native `try`/`catch` can express, by name, before a line of it is written.
 *
 * The rule C++ states is narrow and exact: a `goto` may not enter a `try` block
 * or a handler from outside. So every edge into an interior block must come
 * from inside the same part, and the entry itself may be entered from outside
 * at most once -- that one entry being the fallthrough. A second outside
 * predecessor would need a `goto` the language does not allow, and a source
 * program cannot write one anyway; reaching this means the graph disagrees with
 * the source, which is worth saying rather than silently emitting a jump the
 * compiler will reject.
 */
const verifyNoInboundJumps = (body: IrBody, owned: ReadonlySet<IrBlockId>, entry: IrBlockId, describe: string): void => {
  const predecessors = controlFlowGraphOf(body).predecessors
  for (const id of owned) {
    const outside = (predecessors.get(id) ?? []).filter((from) => !owned.has(from))
    if (id === entry) {
      if (outside.length > 1) {
        throw createCppEmitBlockedError(
          'runtime-helper:control:try',
          `${describe} is entered from ${outside.length} places outside it; C++ enters a try block by falling into it, which admits exactly one`
        )
      }
      continue
    }
    if (outside.length > 0) {
      throw createCppEmitBlockedError(
        'runtime-helper:control:try',
        `${describe} contains a block reached by a jump from outside it, which C++ forbids ("goto" into a try block)`
      )
    }
  }
}

/**
 * One part's blocks, rendered exactly as the ordinary per-block loop renders
 * every other block: label, operations, merge writes, terminator.
 *
 * A label is written only for a block something in this part actually jumps to.
 * Nothing outside can (that is what `verifyNoInboundJumps` just established),
 * so an untargeted block needs no label -- which keeps the common straight-line
 * case rendering as the plain run of statements it always was.
 *
 * The terminator is always rendered, including the trailing `jump` to the
 * region's join. That jump used to be omitted, on the reasoning that the join's
 * own text follows immediately and fallthrough reaches it either way. That
 * holds for exactly one exit; a body that branches has several, and only one of
 * them can be the last thing inside the brace. Writing the `goto` every time is
 * correct for all of them, and costs a jump to the next line in the case that
 * used to fall through.
 */
const renderPart = (
  ctx: EmitContext,
  body: IrBody,
  rendering: RegionRendering,
  order: readonly IrBlockId[],
  owned: ReadonlySet<IrBlockId>,
  skipFirstOperation: boolean,
  entryLabelledOutside: boolean
): string[] => {
  const targeted = new Set<IrBlockId>()
  for (const id of owned) {
    const block = body.blocks.get(id)
    if (!block) continue
    for (const successor of successorsOfTerminator(block.terminator)) if (owned.has(successor)) targeted.add(successor)
  }
  const lines: string[] = []
  order.forEach((id, index) => {
    const block = body.blocks.get(id)
    if (!block) return
    // A nested try statement is rendered where its entry falls, as its own
    // `try`/`catch` text inside this part's braces: C++ nests try blocks
    // freely, and the nested region's interior blocks were left out of this
    // part's order (`partOrder`) precisely so the nested rendering owns them.
    const nested = index === 0 ? undefined : rendering.regionByTryEntry.get(id)
    if (nested) {
      renderTryRegion(ctx, lines, body, nested, rendering)
      return
    }
    // The identical accommodation for a `for`-`of`/finite-destructuring
    // IteratorClose region whose entry falls inside this part: it renders its
    // own `CompletionGuard`/`try`/`catch` text, exactly as a nested try does.
    const nestedIteratorClose = index === 0 ? undefined : rendering.iteratorCloseRegionByEntry.get(id)
    if (nestedIteratorClose) {
      rendering.renderIteratorCloseRegion(ctx, lines, body, nestedIteratorClose, rendering)
      return
    }
    // The entry's own label belongs OUTSIDE the braces -- `renderTryRegion`
    // writes it there so a jump into the region is an ordinary `goto` -- and
    // repeating it here would define one label twice.
    if (targeted.has(id) && !(index === 0 && entryLabelledOutside)) lines.push(`${rendering.labelOf(rendering.labels, id)}:`)
    const operations = index === 0 && skipFirstOperation ? block.operations.slice(1) : block.operations
    for (const operation of operations) {
      // A read the hoist plan RELOCATED renders in its destination block, not
      // here. The ordinary per-block loop has always skipped it at its origin;
      // this part did not, and a try body holding a loop-invariant read inside
      // an enclosing loop -- `try { found = attempt(i) } catch { continue }`,
      // whose `attempt` binding is hoisted to the loop's preheader -- defined
      // the same SSA value twice. It went unseen only because every shape that
      // reaches it was refused a step earlier, for the unrelated reason
      // `collectPartBlocks` records.
      const result = 'result' in operation ? operation.result : null
      if (result && rendering.relocated.has(result.id)) continue
      rendering.emitOperation(ctx, lines, operation)
    }
    // The other half of the same plan, in the same order the ordinary loop
    // writes it: the reads hoisted INTO this block, then the merge writes,
    // then a dense window's setup, then a counted fill loop -- which REPLACES
    // the terminator, and says so by answering `true`.
    rendering.emitHoistedInto(ctx, lines, id)
    for (const write of rendering.mergeWrites.get(id) ?? []) lines.push(`${write.name} = ${operandText(ctx, write.value)};`)
    if (rendering.emitBlockTail(ctx, lines, id)) return
    rendering.emitTerminator(ctx, lines, rendering.labels, rendering.isSingleBlock, block.terminator)
  })
  return lines
}

/** Every block of one part, refused as a whole if it holds a shape no native handler can express. */
const preparePart = (
  body: IrBody,
  rendering: RegionRendering,
  region: IrTryRegion,
  entry: IrBlockId,
  join: IrBlockId | null,
  describe: string
): { readonly owned: ReadonlySet<IrBlockId>; readonly order: readonly IrBlockId[] } => {
  const reachable = collectPartBlocks(body, entry, join, region.tryEntry)
  // A nested try statement's blocks -- all three parts, handlers included --
  // belong to this part for ownership and for the inbound-jump check, and are
  // rendered by the nested region itself rather than by this part's loop.
  const owned = new Set<IrBlockId>(reachable)
  const rendersItself = new Set<IrBlockId>()
  for (const id of reachable) {
    const nested = id === entry ? undefined : rendering.regionByTryEntry.get(id)
    if (nested) {
      for (const inner of blocksOfRegion(body, nested, rendering)) {
        owned.add(inner)
        if (inner !== id) rendersItself.add(inner)
      }
      continue
    }
    // A finite destructuring/`for`-`of` IteratorClose region written directly
    // in this part is the reverse nesting of the ordinary case above -- see
    // `RegionRendering.iteratorCloseRegionByEntry`'s own comment -- and is
    // folded in the identical way: its blocks belong to this part's ownership
    // and inbound-jump check, but its ENTRY renders itself.
    const nestedIteratorClose = id === entry ? undefined : rendering.iteratorCloseRegionByEntry.get(id)
    if (nestedIteratorClose) {
      for (const inner of nestedIteratorClose.blocks) {
        owned.add(inner)
        if (inner !== id) rendersItself.add(inner)
      }
    }
  }
  verifyNoInboundJumps(body, owned, entry, describe)
  return { owned, order: partOrder(body, owned, entry, rendersItself) }
}

/**
 * The C++ type of a finally clause's scope guard, and the name one region's
 * guard is declared under.
 *
 * A destructor is the mechanism for THREE of the four completions. ECMAScript
 * says a finally block runs however the try body completes, and C++ says a
 * scoped object is destroyed however the scope is left -- falling off the end,
 * `return`, and a `goto` past it (which is what `break`/`continue` lower to
 * here). Those stay ordinary IR terminators and the guard covers each with no
 * completion record and no dispatch.
 *
 * The fourth -- an exception propagating out of the try body or the catch
 * handler -- is the one a destructor CANNOT express, and it is why a pending
 * slot sits beside the guard. C++ destroys the guard while that exception is
 * unwinding, and a destructor that throws during unwinding calls
 * `std::terminate`; ECMAScript instead says the clause's own throw REPLACES
 * the in-flight completion (14.15.3: the finally block's abrupt completion is
 * the statement's completion). The two are not reconcilable while the clause
 * runs under an unwind, so the emitted region does not let it: an outer
 * `catch (...)` parks the exception in an `std::exception_ptr` declared before
 * the guard's scope, the scope then closes NORMALLY -- so a clause that throws
 * propagates ordinarily and the parked exception is simply dropped, which is
 * exactly the replacement ECMAScript asks for -- and a rethrow after the scope
 * resumes the parked one when the clause completes normally.
 *
 * `generator-finite-destructuring-close.ts` is the program that made this
 * necessary: `.return()` on a paused generator is delivered as a `ReturnSignal`
 * throw at the `yield` (`gea_runtime.h`'s `YieldAwaiter::await_resume`), so a
 * `finally { throw x }` in that generator ran under an unwind on EVERY close,
 * not on some rare path, and aborted the process instead of delivering `x` to
 * the caller's `catch`. The park makes `ReturnSignal` an ordinary parked
 * completion like any other: dropped when the clause throws, rethrown into the
 * promise's `unhandled_exception` when it does not.
 *
 * The names are keyed by the region's own operation id so two try statements in
 * one function never collide, and so the declarations are stable across builds.
 */
const finallyGuardType = 'const gea::ScopeExit'

const finallyGuardName = (region: IrTryRegion): string => cppFinallyGuardName(region.region)

const finallyPendingName = (region: IrTryRegion): string => cppFinallyPendingName(region.region)

/**
 * The finally clause's own blocks, refused by name for every shape a
 * destructor body cannot express.
 *
 * Three of them, and each is a real source program rather than a hypothetical:
 *
 * - a `return` written inside the finally clause. `producers/control.ts`'s
 *   `nearestInterceptingFinally` deliberately does NOT intercept a completion
 *   originating inside the clause itself, so such a return reaches lowering as
 *   an ordinary one -- and an ordinary `return` inside the guard's lambda would
 *   return from the LAMBDA, leaving the enclosing function running. That is a
 *   silent miscompile, not a compile error, which is exactly the kind this
 *   refuses rather than emits.
 * - a `break`/`continue` inside the clause targeting an enclosing loop. It
 *   lowers to a jump to a block outside the clause, and `verifyNoInboundJumps`
 *   catches it from the other side: the loop's own exit or latch becomes
 *   reachable from this part while the loop's branch also reaches it from
 *   outside.
 * - a clause sharing a block with the try body or the catch handler, which
 *   would put one run of statements inside two different braces.
 *
 * A `throw` inside the clause is NOT refused here and does not need to be: it
 * lowers to an ordinary `throw` terminator, and `gea::ScopeExit` is
 * deliberately not `noexcept`, so it propagates the way ECMAScript says it
 * does. It used to need the caveat that a clause throwing while an exception
 * was ALREADY propagating terminated instead of replacing it; the region's
 * pending slot removes that case rather than stating it -- see
 * `finallyGuardType`.
 */
const prepareFinallyPart = (
  body: IrBody,
  rendering: RegionRendering,
  region: IrTryRegion,
  tryOwned: ReadonlySet<IrBlockId>,
  catchOwned: ReadonlySet<IrBlockId> | null
): { readonly owned: ReadonlySet<IrBlockId>; readonly order: readonly IrBlockId[] } => {
  if (region.finallyEntry === null) throw new Error('prepareFinallyPart called for a region with no finally clause')
  const part = preparePart(body, rendering, region, region.finallyEntry, region.join, 'a finally clause')
  for (const id of part.owned) {
    if (tryOwned.has(id) || catchOwned?.has(id) === true) {
      throw createCppEmitBlockedError(
        'runtime-helper:control:finally',
        'a finally clause shares a block with the try body or catch handler, so neither owns it'
      )
    }
    // The clause's own exit is the one `return` terminator here that is not a
    // source `return`: `lower-flow.ts` builds it to give the part's normal
    // completion a block, and falling off the end of the guard body is exactly
    // what it means. Every other one came from the program.
    if (id === region.finallyExit) continue
    const block = body.blocks.get(id)
    if (block?.terminator.kind === 'return') {
      throw createCppEmitBlockedError(
        'abrupt-edge:return',
        'a "return" written inside a finally clause would return from the scope guard that runs the clause, not from the function'
      )
    }
  }
  return part
}

/**
 * The finally clause's rendering, differing from every other part's in TWO
 * terminators: its own `finallyExit`, and a `throw`.
 *
 * The clause's body is a LAMBDA returning `void`, and the enclosing function's
 * return type is not this lambda's. `emit-return.ts` renders a valueless return
 * against the enclosing function's ABI -- for a `Promise<void>` result it
 * writes `return gea::Promise<void>::settled_value();`, because a bare
 * `return;` from a function declared to return a class type is a C++ error.
 * Inside the guard body that reasoning is inverted and the bare `return;` is
 * the only correct text, so the override is here rather than a condition inside
 * `emit-return.ts`: the fact that differs is which function is being returned
 * from, and only this caller knows it.
 *
 * `emit.ts`'s own `throw` case appends an unreachable `co_return;` whenever
 * `ctx.generatorBody` is set, so a `function*` whose body is nothing but a
 * `throw` still compiles as a coroutine (see that file's comment). `ctx` is
 * the whole PHYSICAL BODY's context and cannot tell "the generator's own
 * frame" apart from "a plain lambda this body happens to render inside it" --
 * and a finally clause's guard is exactly the latter: `gea::ScopeExit`'s
 * `[&]() { ... }` is an ordinary `void`-returning lambda even when the
 * generator that owns it is a coroutine. `defaultGenerator`'s `finally {
 * ...; throw x }` (`generator-finite-destructuring-close.ts`) emitted that
 * `co_return;` straight into the guard lambda, and clang refuses a `co_return`
 * in a function with a deduced return type. The throw itself is unaffected by
 * this override -- it is a real ECMAScript throw out of the guard, exactly as
 * `renderTryRegion`'s own header comment already says a `throw` in a finally
 * clause is not refused and needs no special handling beyond an ordinary
 * `throw` terminator.
 */
const finallyRendering = (rendering: RegionRendering): RegionRendering => ({
  ...rendering,
  emitTerminator: (ctx, lines, labels, isSingleBlock, terminator) => {
    if (terminator.kind === 'return' && terminator.value === null) {
      lines.push('return;')
      return
    }
    if (terminator.kind === 'throw') {
      lines.push(`throw ${operandText(ctx, terminator.value)};`)
      return
    }
    rendering.emitTerminator(ctx, lines, labels, isSingleBlock, terminator)
  }
})

/** Renders one region's `try { } catch (...) { }` text and returns every block it consumed, so the caller can skip them in the ordinary per-block loop. */
export const renderTryRegion = (
  ctx: EmitContext,
  lines: string[],
  body: IrBody,
  region: IrTryRegion,
  rendering: RegionRendering
): readonly IrBlockId[] => {
  const tryPart = preparePart(body, rendering, region, region.tryEntry, region.join, 'a try body')
  if (region.catchEntry === null && region.finallyEntry === null) {
    // Every `TryStatement` the checker accepted has a catch or a finally, so
    // a region with neither is one whose handler the lowering proved dead --
    // a try body nothing in it can throw out of. The body is then ordinary
    // straight-line code and is rendered as exactly that: no braces, no
    // handler, the same blocks in the same order.
    lines.push(`${rendering.labelOf(rendering.labels, region.tryEntry)}:`)
    lines.push(...renderPart(ctx, body, rendering, tryPart.order, tryPart.owned, false, true))
    return [...tryPart.owned]
  }
  const catchPart =
    region.catchEntry === null ? null : preparePart(body, rendering, region, region.catchEntry, region.join, 'a catch handler')
  for (const id of catchPart?.owned ?? []) {
    // Two parts sharing a block would put one run of statements inside both
    // braces, which is not a rendering problem but a claim about the graph that
    // cannot be true: nothing reaches a handler except by throwing.
    if (tryPart.owned.has(id))
      throw createCppEmitBlockedError('runtime-helper:control:try', 'a try body and its catch handler share a block, so neither owns it')
  }
  const finallyPart =
    region.finallyEntry === null ? null : prepareFinallyPart(body, rendering, region, tryPart.owned, catchPart?.owned ?? null)

  const catchEntryBlock = region.catchEntry === null ? null : body.blocks.get(region.catchEntry)
  if (region.catchEntry !== null && !catchEntryBlock) {
    throw new Error(`ir body ${body.owner} names catch block ${region.catchEntry} but has no matching block`)
  }
  const firstOperation = catchEntryBlock?.operations[0]
  const binding = firstOperation && firstOperation.kind === 'catch-binding' ? firstOperation : null
  // A native C++ handler catches BY TYPE, so this parameter's type and the type
  // every `throw` actually throws are one fact, not two. `ir/lower.ts` converts
  // every thrown value into `thrownValueCarrier` for that reason; this is the
  // other half of the same agreement, checked rather than assumed -- the two
  // sides sat in different files with no test between them, and the version
  // that disagreed emitted `throw v0;` of a `std::string` against
  // `catch (const gea::Value& v1)`: clang-clean, certificate clean, and the
  // handler the source program wrote never ran. Compared on the C++ spelling
  // rather than on `representationKey`, because agreeing physically is the
  // whole requirement: a caught binding's carrier states the reason
  // `'declared-any-never-narrowed'` (the checker's `unknown`) where the thrown
  // one states `'thrown-error-carrier'`, and those are the same storage.
  if (binding && cppTypeOf(binding.result.representation) !== cppTypeOf(thrownValueCarrier)) {
    throw createCppEmitBlockedError(
      'runtime-helper:control:catch',
      `a catch clause binds its parameter as "${cppTypeOf(binding.result.representation)}" but every throw carries ` +
        `"${cppTypeOf(thrownValueCarrier)}"; a native handler matches by type, so this handler could never catch`
    )
  }
  const parameter = binding ? `const ${cppTypeOf(binding.result.representation)}& ${defineValueBoundElsewhere(ctx, binding.result)}` : '...'

  // The region's entry label, immediately BEFORE the `try` rather than inside
  // it. C++ forbids transferring control into a try block, which is why this
  // rendering used to demand that the predecessor fall through -- the region's
  // text had to be the next thing emitted, and a block order that put anything
  // between the two refused. A label on the try STATEMENT is not inside the
  // block, so an ordinary `goto` reaches it and the region can be rendered
  // wherever the block order puts it. The cost is a jump to the next line in
  // the case that used to fall through, the same trade `renderPart`'s own
  // terminator note already records.
  lines.push(`${rendering.labelOf(rendering.labels, region.tryEntry)}:`)
  // The guard's own scope opens OUTSIDE the label's statement, so a `goto` to
  // the region enters this block from the top and initializes the guard on the
  // way in. Jumping PAST the initialization of an object with a destructor is
  // what C++ forbids, and entering the block normally is not that.
  // The pending slot is declared OUTSIDE the guard's scope, so the rethrow that
  // reads it can be written AFTER the guard has been destroyed -- which is the
  // whole reason the slot exists (`finallyGuardType`'s comment says why).
  if (finallyPart) {
    lines.push('{')
    lines.push(`std::exception_ptr ${finallyPendingName(region)};`)
    lines.push('{')
    lines.push(`${finallyGuardType} ${finallyGuardName(region)}{[&]() {`)
    lines.push(...renderPart(ctx, body, finallyRendering(rendering), finallyPart.order, finallyPart.owned, false, true))
    lines.push('}};')
    lines.push('try {')
  }
  if (catchPart !== null) lines.push('try {')
  lines.push(...renderPart(ctx, body, rendering, tryPart.order, tryPart.owned, false, true))
  if (catchPart) {
    lines.push('}')
    lines.push(`catch (${parameter}) {`)
    lines.push(...renderPart(ctx, body, rendering, catchPart.order, catchPart.owned, binding !== null, false))
    lines.push('}')
  }
  if (finallyPart) {
    lines.push(`} catch (...) { ${finallyPendingName(region)} = std::current_exception(); }`)
    lines.push('}')
    lines.push(`if (${finallyPendingName(region)}) std::rethrow_exception(${finallyPendingName(region)});`)
    lines.push('}')
  }
  return [...tryPart.owned, ...(catchPart?.owned ?? []), ...(finallyPart?.owned ?? [])]
}
