import type { OperationId, SemanticResultId } from '../identity/ids.js'
import type { IrBodyBuilder } from './build.js'
import {
  armSideOf,
  IrLoweringBlockedError,
  scopeKeyOf,
  type ConditionalMembership,
  type ScopeRef,
  type TestPredicate
} from './lower-graph.js'
import type { IrBlockId, IrOperand } from './model.js'

/**
 * Turning `ConditionalEdge` membership into real basic blocks.
 *
 * `a && b`, `a?.b`, and an `if` statement's guarded body all reduce to the same
 * shape once the census states them as edges: a boolean guard, a region that
 * only runs on one side of it, and a point where control rejoins. This module
 * owns exactly that shape -- opening a branch the first time a guard is seen,
 * reusing its blocks if the lowering later revisits the opposite arm, and
 * closing every open branch to a join block once no operation needs it. It
 * never decides *what value* a merge should carry; that is a computation the
 * object-substrate IR has no primitive for yet, so a caller that needs one
 * must block instead of asking this module to invent one.
 */

interface GuardBlocks {
  readonly armTrue: IrBlockId
  readonly armFalse: IrBlockId
  joinBlock: IrBlockId | null
  /**
   * The block each arm actually ended in when it jumped to the join. It is not
   * `armTrue`/`armFalse` in general: an arm that itself branched ends somewhere
   * deeper. A merge over this guard has to name the real predecessors, and
   * nothing else in the lowering knows them.
   */
  truthySource: IrBlockId | null
  falsySource: IrBlockId | null
}

/**
 * The blocks one try statement's region needs.
 *
 * `tryEntry` and (when a catch clause exists) `catchEntry` are what the C++
 * emitter needs to render real `try { ... } catch (...) { ... }` text instead
 * of the ordinary goto-linked block sequence: C++ forbids jumping into either
 * from outside, so both are entered by fallthrough at emission, never by a
 * rendered `goto`+label pair. `join` is where both sides land on ordinary
 * completion -- there is exactly one, shared, because falling off the end of
 * `try` and falling off the end of `catch` reach the same continuation.
 */
interface RegionBlocks {
  readonly tryEntry: IrBlockId
  catchEntry: IrBlockId | null
  /** The finally clause's first block; entered from a scope guard's destructor, never by a jump. See `IrTryRegion.finallyEntry`. */
  finallyEntry: IrBlockId | null
  /** Where the finally clause's own normal completion goes; the emitter renders reaching it as falling off the end of the guard body. See `IrTryRegion.finallyExit`. */
  finallyExit: IrBlockId | null
  join: IrBlockId | null
}

interface LoopBlocks {
  /** Where the condition is evaluated. Every iteration re-enters here, so it must start clean. */
  readonly header: IrBlockId
  /**
   * The `for` incrementor's own block, when this loop's gating reserved one
   * (`ConditionalMembership.hasLatch`). `continue` jumps here instead of to
   * the header, so the update expression always runs before the condition is
   * re-tested. `null` for a loop with no incrementor.
   */
  readonly latch: IrBlockId | null
  /**
   * Where control lands when a loop with no test ends -- reserved the first
   * time something asks for it, and `null` while nothing has.
   *
   * A head-tested loop needs no such block: its test's falsy arm already goes
   * to a join, and that join *is* the exit. `while (true)` states its
   * condition as a constant, so the census publishes no guard for it and no
   * branch is ever built; the only thing that ends such a loop is a `break`,
   * and the block that `break` lands in has to come from somewhere. Reserving
   * it lazily is what keeps a genuinely infinite loop from being followed by
   * an empty block nothing reaches and nothing terminates.
   */
  exit: IrBlockId | null
}

type OpenFrame =
  | { readonly kind: 'guard'; readonly guard: SemanticResultId; readonly takenWhen: 'truthy' | 'falsy'; readonly info: GuardBlocks }
  | { readonly kind: 'loop'; readonly loop: OperationId; readonly info: LoopBlocks }
  | { readonly kind: 'loop-latch'; readonly loop: OperationId; readonly info: { readonly latch: IrBlockId } }
  | { readonly kind: 'region'; readonly region: OperationId; readonly part: 'try' | 'catch' | 'finally'; readonly info: RegionBlocks }

/** The identity a frame is keyed by, so `enterScope` can tell a chain that continues from one that diverges. */
const frameKeyOf = (frame: OpenFrame): string =>
  frame.kind === 'loop'
    ? `loop|${frame.loop}`
    : frame.kind === 'loop-latch'
      ? `loop-latch|${frame.loop}`
      : frame.kind === 'region'
        ? `region|${frame.region}|${frame.part}`
        : `guard|${frame.guard}|${frame.takenWhen}`

export interface GuardMergeSources {
  readonly truthy: IrBlockId
  readonly falsy: IrBlockId
  /** The block both arms rejoin in, which is where a merge over them belongs. */
  readonly join: IrBlockId
}

/** One try statement's blocks, as the C++ emitter needs to know them. */
export interface RegionBlockInfo {
  readonly region: OperationId
  readonly tryEntry: IrBlockId
  readonly catchEntry: IrBlockId | null
  readonly finallyEntry: IrBlockId | null
  readonly finallyExit: IrBlockId | null
  readonly join: IrBlockId | null
}

export interface FlowController {
  readonly currentBlock: () => IrBlockId
  /**
   * The two blocks that reach this guard's join, opening the branch and closing
   * either arm if the lowering has not already done so.
   *
   * An arm can be empty of operations -- `flag ? 1 : 2` puts a constant on both
   * sides -- and then nothing ever asked for that arm's scope, so no branch
   * exists at all. A merge still needs one: the value differs per side, and the
   * only thing that can decide which side ran is a real branch. Opening it here
   * keeps that decision with the module that owns block structure.
   *
   * Only legal for a guard whose arms are not currently open, which is the case
   * for every consumer of a guard's merged value: such a consumer runs after the
   * branch, so its own scope never contains this guard.
   */
  readonly requireMergeSources: (guard: SemanticResultId) => GuardMergeSources
  /**
   * Whether one of this guard's arms is still an open frame, which is exactly
   * when `requireMergeSources` would refuse it.
   *
   * Asked so a settle step can SKIP such a guard instead of blocking on it.
   * Unwinding closes frames innermost-first and a short circuit is settled as
   * soon as its own frame closes, so at that moment a guard further out is
   * still open and its pending merge is simply not this frame's turn.
   */
  readonly isGuardOpen: (guard: SemanticResultId) => boolean
  /**
   * Where `continue` and `break` land: a loop's header re-runs the test, its
   * exit is the block its test's failing arm rejoins in. `null` before the loop
   * has been entered, which for a transfer out of that loop's own body cannot
   * happen -- the body is inside it.
   */
  readonly loopHeaderOf: (loop: OperationId) => IrBlockId | null
  readonly loopExitOf: (loop: OperationId) => IrBlockId | null
  /**
   * Where `break` out of a switch lands: the statement's own exit block,
   * reserved the first time a break asks for it, exactly as a testless
   * loop's exit is. A switch lowers as a guard chain, and while no clause
   * could fall through and no statement followed a `break` in its clause,
   * the end of a clause's arm WAS the exit and `break` needed no jump at
   * all. Both are ordinary source shapes (tsc's checker writes `if (...) {
   * break; } // falls through`), and with them a clause's arm end is where
   * the NEXT clause may start, so a `break` has to name where the switch
   * itself ends. Reserved lazily so a switch nothing breaks out of grows no
   * empty block.
   */
  readonly switchExitOf: (switchOp: OperationId) => IrBlockId
  /**
   * The switch statement's own close, at its marker: control that fell out
   * of the last clause joins whatever the breaks reserved, and lowering
   * continues in that block. A switch whose exit was never reserved closes
   * as it always did -- in the chain's own join.
   */
  readonly closeSwitch: (switchOp: OperationId, lineage: SemanticResultId | null) => void
  /**
   * Where `continue` re-enters a `for` loop that has an incrementor: the
   * latch block reserved for it, run before the header re-tests the
   * condition. `null` for a loop with no incrementor (a `while`, or a `for`
   * with an empty update clause) -- such a loop's `continue` targets the
   * header directly, exactly as it always has.
   */
  readonly loopLatchOf: (loop: OperationId) => IrBlockId | null
  /** The branch target selected when a head-tested loop exhausts normally. */
  readonly loopNormalExitOf: (loop: OperationId) => IrBlockId | null
  /** The truthy condition arm, including an empty loop body's synthetic back edge. */
  readonly loopBodyEntryOf: (loop: OperationId) => IrBlockId | null
  /** End the current straight-line block without changing lexical scope. */
  readonly splitCurrentBlock: (lineage: SemanticResultId | null) => IrBlockId
  /** Every try-region this owner opened, for `lowerOwner` to publish on the sealed `IrBody`. */
  readonly regionsOpened: () => readonly RegionBlockInfo[]
  /**
   * Positions `currentBlock` for the next operation's exact guard chain,
   * opening/closing/switching branches as needed. Must be called before every
   * operation, including the first, with that operation's own guard chain
   * (empty for an unconditional operation).   *
   * `afterUnwind`, if given, runs once this call has closed every frame the
   * new scope leaves and before it opens any frame the new scope adds. A
   * guard's own boolean test can itself be a value only settled once its
   * *previous* guard has closed -- an optional chain used as a `?:` or `&&`
   * condition is exactly that, since the chain's short-circuit result is a
   * merge over the chain's own presence guard, and the ternary's guard is that
   * same result. Settling after this whole call returns is too late for such a
   * guard: opening it happens inside this call. This module still never decides
   * what to settle or how -- the callback is opaque to it -- only when the one
   * legal moment for settling arrives.
   *
   * `placesNothing` says the operation being positioned for is a MARKER: it
   * emits no IR of its own and the transfers it stands for were already built
   * out of scope membership. Such an operation still has to be positioned --
   * unwinding the frames its scope leaves is what joins the arms it closes --
   * but it must not be given a home when every path already ended, because the
   * home would be an orphan block nothing reaches and nothing fills, and the
   * body-completion terminator synthesized into it is a valueless `return` in
   * a function that must return a value.
   */
  readonly enterScope: (requiredScope: readonly ScopeRef[], afterUnwind?: () => void, placesNothing?: boolean) => IrBlockId
  /** Records that `currentBlock` just received a terminator, so the next `enterScope` opens a fresh block instead of appending to a dead one. */
  /**
   * Closes every still-open branch once the owner's operation list is
   * exhausted. `alreadyTerminated` distinguishes a body every path already
   * returned/threw from one that fell off the end -- the latter needs a
   * terminator this controller has no semantic operation to cite as lineage
   * for, so it is the caller's job to fail closed on it rather than this
   * module synthesizing an unattributed one.
   */
  readonly finish: () => { readonly block: IrBlockId; readonly alreadyTerminated: boolean }
}

export interface FlowControllerDeps {
  readonly builder: IrBodyBuilder
  readonly membership: ConditionalMembership
  /** Resolves a guard's own published result to the operand its branch tests. Throws to block when the guard cannot supply one. */
  readonly resolveGuardOperand: (guard: SemanticResultId) => IrOperand
}

export const createFlowController = (deps: FlowControllerDeps): FlowController => {
  const { builder, membership, resolveGuardOperand } = deps
  const guardCache = new Map<SemanticResultId, GuardBlocks>()
  const loopCache = new Map<OperationId, LoopBlocks>()
  const regionCache = new Map<OperationId, RegionBlocks>()
  /** A switch statement's own exit block, reserved by the first `break` that names the switch -- see `switchExitOf`. */
  const switchCache = new Map<OperationId, IrBlockId>()
  let stack: OpenFrame[] = []
  let currentBlock: IrBlockId = builder.openBlock()
  /**
   * Whether the block control is currently in already has a terminator.
   *
   * Asked of the builder rather than tracked beside `currentBlock`. A flag was
   * two answers to one question, and they drifted: a frame closing into a block
   * that was already terminated -- which happens whenever no join block was
   * ever opened, because both arms had already gone elsewhere -- cleared the
   * flag anyway, and the next frame to close wrote a second terminator that
   * `build.ts` refused, several frames away from the one that lied.
   */
  const isTerminated = (): boolean => builder.isTerminated(currentBlock)

  /**
   * `falsy` is built by swapping which successor is the "taken" one, never by
   * negating the condition -- there is no boolean-negation primitive in this
   * IR, so the branch operands themselves carry the inversion instead.
   *
   * A guard that is not already a boolean is not an error and not a cast: the
   * language tests truthiness, and `ToBoolean` is the operation that does it.
   * It is emitted here rather than assumed at the branch because the answer
   * depends entirely on the carrier -- an empty string is false, an empty
   * object is true -- and a branch instruction has no carrier to consult.
   */
  const requireBooleanGuardOperand = (guard: SemanticResultId, block: IrBlockId, predicate: TestPredicate): IrOperand => {
    const operand = resolveGuardOperand(guard)
    // Only a `to-boolean` guard can already be in the form it needs. A boolean
    // is present whatever its value, so a presence test over one is the
    // constant `true` -- and skipping the test would hand the branch the
    // boolean's *value*, which is a different question with a different answer.
    if (predicate === 'to-boolean' && operand.representation.kind === 'scalar' && operand.representation.domain === 'boolean') {
      return operand
    }
    return { value: builder.test(block, guard, operand, predicate), representation: { kind: 'scalar', domain: 'boolean' } }
  }

  const sendArmToJoin = (guard: SemanticResultId, info: GuardBlocks, arm: IrBlockId, side: 'truthy' | 'falsy'): void => {
    const join = info.joinBlock ?? builder.openBlock()
    info.joinBlock = join
    if (side === 'truthy') info.truthySource = arm
    else info.falsySource = arm
    // The jump exists only because this guard's branch does; citing the
    // guard's own result as lineage keeps every synthesized control-transfer
    // traceable to the semantic decision that required it.
    builder.jump(arm, guard, join)
  }

  const ensureGuardBlocks = (guard: SemanticResultId, predicate: TestPredicate = membership.predicateOf(guard)): GuardBlocks => {
    const cached = guardCache.get(guard)
    if (cached) return cached
    // The test runs in the block the branch leaves from, before that branch:
    // it is the guard's own evaluation, so it belongs where the guard is, not
    // in an arm it decides between.
    const condition = requireBooleanGuardOperand(guard, currentBlock, predicate)
    const armTrue = builder.openBlock()
    const armFalse = builder.openBlock()
    builder.branch(currentBlock, guard, condition, armTrue, armFalse)
    const info: GuardBlocks = { armTrue, armFalse, joinBlock: null, truthySource: null, falsySource: null }
    guardCache.set(guard, info)
    const arms = membership.armsOf(guard)
    // An arm nothing ever runs in would otherwise seal with no terminator: it
    // is dead as far as this owner's operations go, so it heads straight to
    // whichever join the live arm eventually creates.
    if (!arms.hasTruthy) sendArmToJoin(guard, info, armTrue, 'truthy')
    if (!arms.hasFalsy) sendArmToJoin(guard, info, armFalse, 'falsy')
    return info
  }

  const armBlockOf = (info: GuardBlocks, takenWhen: 'truthy' | 'falsy'): IrBlockId =>
    takenWhen === 'truthy' ? info.armTrue : info.armFalse

  /**
   * Moving control into one of a guard's arms, refusing an arm that has
   * already ended.
   *
   * An arm block is terminated once it has jumped to its join, branched into a
   * nested guard, or returned; appending to it is impossible, and the caller's
   * next `enterScope` would silently open an unreachable block instead --
   * which is exactly how an owner ended up sealing a block that held real
   * operations and was reached from nothing.
   *
   * That only happens when the execution order left this arm and came back to
   * it, which `orderOwnerOperations` is what prevents: it keeps one scope's
   * operations contiguous. So reaching here is an ordering defect rather than
   * a source-program one, and it is reported as a blocker rather than worked
   * around -- a re-entered arm has no correct block to continue in.
   */
  const enterArm = (guard: SemanticResultId, info: GuardBlocks, side: 'truthy' | 'falsy'): IrBlockId => {
    const arm = armBlockOf(info, side)
    if (builder.isTerminated(arm)) {
      throw new IrLoweringBlockedError(
        `the ${side} arm of guard ${guard} was re-entered after it had already ended; this owner's execution order does not keep one branch's operations together`
      )
    }
    return arm
  }

  /**
   * Which arm of a two-sided branch an edge takes, and which predicate decides
   * it.
   *
   * `nullish`/`present` are not a third and fourth kind of branch -- they are
   * the same two arms tested differently. `a?.b` runs its member access when
   * `a` is present and skips it when `a` is nullish, exactly as `if (a)` runs
   * its body when `a` is truthy; what differs is the question asked of `a`, and
   * that travels on the test rather than on the branch. Mapping `present` to
   * the true arm of an `is-present` test is what makes them one shape.
   */
  const branchArmOf = (ref: Extract<ScopeRef, { kind: 'guard' }>): { side: 'truthy' | 'falsy'; predicate: TestPredicate } => {
    const side = armSideOf(ref.takenWhen)
    // An absence arm asks the census which absence test this guard carries --
    // `is-present` for `?.` and `??`, `is-defined` for a defaulted parameter,
    // which are two different questions about the same two arms. Deciding it
    // from `takenWhen` alone would answer `is-present` for both and re-run a
    // default on an explicit `null`.
    const predicate: TestPredicate =
      ref.takenWhen === 'truthy' || ref.takenWhen === 'falsy' ? 'to-boolean' : membership.predicateOf(ref.guard)
    return { side, predicate }
  }

  const openFreshLevel = (ref: ScopeRef): void => {
    if (ref.kind === 'loop') {
      // Every iteration re-enters the header, so it cannot share a block with
      // whatever ran before the loop -- that code would run again each time.
      // A `for` with an incrementor also reserves its latch here, at the same
      // moment the header is reserved: the incrementor's own operations are
      // ordered after the body in this owner's walk, but a `continue` inside
      // the body must be able to name the latch before the walk ever reaches
      // the incrementor -- exactly the forward-reference the header itself
      // already needs solving for the loop's own back edge.
      const cached = loopCache.get(ref.loop)
      const info = cached ?? {
        header: builder.openBlock(),
        latch: membership.hasLatch(ref.loop) ? builder.openBlock() : null,
        exit: null
      }
      if (!cached) loopCache.set(ref.loop, info)
      if (!isTerminated()) builder.jump(currentBlock, null, info.header)
      currentBlock = info.header
      // The cached record itself, not a copy: `exit` is filled in later, by
      // whichever `break` asks for it first, and a copy would not see it.
      stack.push({ kind: 'loop', loop: ref.loop, info })
      return
    }
    if (ref.kind === 'loop-latch') {
      // Reserved when the loop's own header was, above; a scope asking to
      // enter it before that happened is this module's own invariant broken,
      // not a source program's fault.
      const latch = loopCache.get(ref.loop)?.latch
      if (!latch) throw new IrLoweringBlockedError('a loop-latch scope opened for a loop whose header never reserved one')
      if (!isTerminated()) builder.jump(currentBlock, null, latch)
      currentBlock = latch
      stack.push({ kind: 'loop-latch', loop: ref.loop, info: { latch } })
      return
    }
    if (ref.kind === 'region') {
      // `finally` is refused before any operation of its own ever requests
      // this scope: `lowerControl`'s `'try'` case reads the try's own
      // evaluation edges and blocks the whole owner the moment it sees one
      // reaching a finally-region operation, well before the ordering could
      // ever schedule anything gated on it. Reaching here regardless is a
      // lowering invariant broken, not a source-program shape -- reported the
      // same way rather than silently opening a scope the emitter has no
      // rendering for.
      const cached = regionCache.get(ref.region)
      const info: RegionBlocks = cached ?? {
        tryEntry: builder.openBlock(),
        catchEntry: null,
        finallyEntry: null,
        finallyExit: null,
        join: null
      }
      if (!cached) regionCache.set(ref.region, info)
      if (ref.part === 'try') {
        // The one transition a `goto`+label pair cannot render: C++ forbids
        // jumping into a `try` block from outside it. The jump is still built
        // here, exactly like a guard's arm entry, because the IR's own
        // reachability and dominance guards need a real predecessor edge --
        // `emit.ts` is what recognizes `tryEntry` from the region table this
        // controller publishes and renders the transition as fallthrough into
        // `try {` instead of `goto`.
        if (!isTerminated()) builder.jump(currentBlock, null, info.tryEntry)
        currentBlock = info.tryEntry
        stack.push({ kind: 'region', region: ref.region, part: 'try', info })
        return
      }
      // `catch` is reached only by the C++ runtime unwinding an exception out
      // of the try body -- there is no source-level control-flow edge from
      // "inside try" to "inside catch" for this lowering to build, so
      // `currentBlock` is left exactly where the try's own `finalizeFrame`
      // put it (normally the region's shared join, mid-construction). The
      // catch entry is a block nothing in this owner's own sequence ever
      // `goto`s to.
      if (ref.part === 'catch') {
        const catchEntry = info.catchEntry ?? builder.openBlock()
        info.catchEntry = catchEntry
        currentBlock = catchEntry
        stack.push({ kind: 'region', region: ref.region, part: 'catch', info })
        return
      }
      // `finally` is entered by no control-flow edge either, for a reason one
      // step further from `catch`'s: the emitter runs it from a scope guard's
      // DESTRUCTOR wrapped around the whole region, so every way out of the
      // try body -- falling off the end, `return`, `break`/`continue` to an
      // enclosing loop, an exception unwinding -- already runs it, and none of
      // them is a jump this controller could build. Like `catch`, control is
      // left exactly where the previous part's `finalizeFrame` put it.
      const finallyEntry = info.finallyEntry ?? builder.openBlock()
      info.finallyEntry = finallyEntry
      currentBlock = finallyEntry
      stack.push({ kind: 'region', region: ref.region, part: 'finally', info })
      return
    }
    const { side, predicate } = branchArmOf(ref)
    const info = ensureGuardBlocks(ref.guard, predicate)
    currentBlock = enterArm(ref.guard, info, side)
    stack.push({ kind: 'guard', guard: ref.guard, takenWhen: side, info })
  }

  /**
   * The jump that closes one iteration, written from wherever that iteration
   * ends.
   *
   * A loop with no test at all (`while (true)`, `do { ... } while (true)`)
   * takes it unconditionally: nothing but a `break` ends such a loop, and the
   * block that `break` lands in is reserved lazily by `loopExitOf`.
   *
   * A tail-tested loop's test is evaluated *here* -- the condition ran in this
   * very block, after the body -- so its back edge is a real two-way branch:
   * true repeats, false leaves. This is the one place a branch is built without
   * going through `ensureGuardBlocks`, and deliberately: that function opens two
   * fresh arm blocks for a guard that has operations on its sides, and a tail
   * test has none. Both successors already exist -- the header the body starts
   * in, and the loop's own exit -- so arms would be two empty blocks jumping to
   * a join nothing ever reaches.
   *
   * A head-tested loop never reaches here: its truthy arm writes the back edge
   * as that arm closes, and `finalizeFrame` returns before calling this.
   */
  const closeBackEdge = (loop: OperationId, header: IrBlockId): void => {
    const tail = membership.tailTestOf(loop)
    if (tail === null) {
      builder.jump(currentBlock, null, header)
      return
    }
    const exit = loopExitOf(loop)
    if (exit === null) throw new IrLoweringBlockedError('a tail-tested loop closed its iteration before its own blocks were reserved')
    const condition = requireBooleanGuardOperand(tail, currentBlock, membership.predicateOf(tail))
    builder.branch(currentBlock, tail, condition, header, exit)
  }

  const finalizeFrame = (frame: OpenFrame): void => {
    if (frame.kind === 'region' && frame.part === 'finally') {
      // A finally clause's normal completion is NOT an arrival anywhere. The
      // try body and the catch handler both converge on the region's join
      // because that is where control actually goes when either falls off its
      // end; a finally clause decides nothing -- control resumes wherever the
      // completion that ran the clause was already headed, and the clause's own
      // end just hands it back. Sending it to the join anyway made the join
      // look reached, so a region whose every other part `return`ed grew a
      // trailing block that lowering then had to terminate with a valueless
      // `return` in a function that returns a value.
      //
      // Its own exit block instead, owned by the region and reached by nothing
      // else, which `targets/cpp/emit-exceptions.ts` renders as falling off the
      // end of the guard body. A block, rather than leaving the part
      // unterminated, because every IR block has a terminator by construction
      // -- and a block of its own, rather than reusing a `return` terminator
      // here, because a `return` written inside the clause by the SOURCE is a
      // different fact that must still refuse by name.
      if (!isTerminated()) {
        const exit = frame.info.finallyExit ?? builder.openBlock()
        frame.info.finallyExit = exit
        builder.jump(currentBlock, null, exit)
        builder.return(exit, null, null)
      }
      // `leaveInto(null)` leaves `currentBlock` inside the clause, which would
      // be a miscompile if anything were placed there afterwards -- it would
      // land inside the guard's lambda rather than after the statement. Nothing
      // can be: a null `join` means neither the try body nor the catch handler
      // completes normally, which is exactly when TypeScript's own reachability
      // proves the code after the try statement unreachable, so the census
      // publishes no operation for it. That is the same reason the try and
      // catch frames below may leave into a null join.
      leaveInto(frame.info.join)
      return
    }
    if (frame.kind === 'region') {
      // Both parts converge on one shared join: falling off the end of `try`
      // and falling off the end of `catch` reach the same continuation, and
      // there is exactly one join because the language never runs both. A
      // part that already ended (`return`/`throw`/`break`/`continue` inside
      // it) leaves the join to whichever side does complete normally, exactly
      // as a guard arm that already ended leaves the join to its sibling --
      // which means the join must NOT be allocated at all just because this
      // part finished; a `join` conjured here for an already-terminated part
      // is abandoned the moment the sibling part also terminates (nothing
      // ever jumps into it, and `openFreshLevel`'s catch branch overwrites
      // `currentBlock` right behind it), sealing with zero operations and no
      // terminator. Gating the allocation itself behind `!isTerminated()`,
      // exactly like `sendArmToJoin`'s own guard, is what keeps a join from
      // ever existing before something is actually known to reach it.
      if (!isTerminated()) {
        const join = frame.info.join ?? builder.openBlock()
        frame.info.join = join
        builder.jump(currentBlock, null, join)
      }
      leaveInto(frame.info.join)
      return
    }
    if (frame.kind === 'loop') {
      // A head-tested loop's test already sent control forward to the exit
      // when it failed, and its taken arm writes the back edge as that arm
      // closes -- so leaving such a loop is nothing more than closing this
      // frame.
      if (membership.guardOfLoop(frame.loop) !== null) return
      // A loop with no test has neither. Without the back edge below, the body
      // of `while (true)` ran exactly once and fell through to whatever came
      // after it -- an ordinary construct compiled into something that is not
      // a loop at all, with nothing refusing it.
      //
      // A tail-tested loop reaches here in exactly one shape: `do`/`while`
      // whose condition published no operation of its own, so no latch was
      // ever reserved for it and the test still has to be written somewhere.
      // The usual shape closes in the latch branch below, already terminated
      // by the time this frame pops.
      if (!isTerminated()) closeBackEdge(frame.loop, frame.info.header)
      if (frame.info.exit !== null) currentBlock = frame.info.exit
      return
    }
    if (frame.kind === 'loop-latch') {
      // The latch's only job is running the incrementor and falling through
      // to re-test the condition -- the same back edge a loop's own truthy
      // arm takes, just one block earlier. For a `do`/`while` the latch *is*
      // the test: the condition's own operations ran here, so the back edge
      // this writes is the conditional one.
      const header = loopCache.get(frame.loop)?.header
      if (header === undefined) throw new IrLoweringBlockedError('a loop latch closed before its loop header was opened')
      if (!isTerminated()) closeBackEdge(frame.loop, header)
      // Left terminated, not running: the frame this latch sits inside (the
      // loop's own truthy guard arm) closes next, on this very block, and the
      // jump above is what stops it writing a second terminator there.
      return
    }
    const loop = membership.loopOfGuard(frame.guard)
    // The taken arm of a loop's test ends in a back edge, not a join: that jump
    // is the loop.
    if (loop !== null && frame.takenWhen === 'truthy') {
      const header = loopCache.get(loop)?.header
      if (header === undefined) throw new IrLoweringBlockedError('a loop test closed its body before the loop header was opened')
      if (!isTerminated()) builder.jump(currentBlock, frame.guard, header)
      leaveInto(frame.info.joinBlock)
      return
    }
    if (!isTerminated()) sendArmToJoin(frame.guard, frame.info, currentBlock, frame.takenWhen)
    leaveInto(frame.info.joinBlock)
  }

  /**
   * Where a closed frame leaves control.
   *
   * A frame with no join block -- both arms already gone somewhere else, so
   * nothing ever opened one -- leaves control exactly where it was, terminator
   * and all. Moving to a `null` join would have been moving nowhere while
   * announcing a fresh start.
   */
  const leaveInto = (join: IrBlockId | null): void => {
    if (join !== null) currentBlock = join
  }

  const enterScope = (requiredScope: readonly ScopeRef[], afterUnwind?: () => void, placesNothing = false): IrBlockId => {
    let common = 0
    while (common < stack.length && common < requiredScope.length) {
      const frame = stack[common]
      const ref = requiredScope[common]
      if (!frame || !ref || frameKeyOf(frame) !== scopeKeyOf(ref)) break
      common += 1
    }

    const boundaryFrame = stack[common]
    const boundaryRef = requiredScope[common]
    const isSwitch =
      boundaryFrame !== undefined &&
      boundaryRef !== undefined &&
      boundaryFrame.kind === 'guard' &&
      boundaryRef.kind === 'guard' &&
      boundaryFrame.guard === boundaryRef.guard

    // Settled after EACH frame closes, not once after the whole unwind. A short
    // circuit's merge lands in its own guard's join block, and that block is
    // consumed the moment the ENCLOSING frame closes -- it becomes the arm that
    // frame sends onward to its own join. Settling after everything unwound
    // therefore built the merge in a block that had already jumped away, and
    // then went on lowering into it: `enterScope` found the block terminated
    // and opened a fresh one, orphaning the outer join with no terminator at
    // all ("sealed without a terminator; it holds 0 operation(s)"). Which is
    // every `?.` inside an `if`, a loop, a ternary or a `try`. Settling as the
    // owning frame closes puts the merge in its join while that join is still
    // the live block, and the enclosing frame then sends it onward exactly as
    // it would any other. A guard still open further out is skipped rather than
    // blocked on -- see `isGuardOpen`.
    while (stack.length > common) {
      const frame = stack.pop()
      if (!frame) break
      if (isSwitch && frame === boundaryFrame && frame.kind === 'guard') {
        // Same guard, opposite arm: the old arm is done, so it heads to the
        // shared join eventually, but execution continues in the sibling arm
        // rather than at the join itself.
        if (!isTerminated()) sendArmToJoin(frame.guard, frame.info, currentBlock, frame.takenWhen)
        break
      }
      finalizeFrame(frame)
      afterUnwind?.()
    }

    const startIndex = isSwitch ? common + 1 : common
    if (isSwitch && boundaryRef && boundaryRef.kind === 'guard') {
      const { side } = branchArmOf(boundaryRef)
      const info = boundaryFrame && boundaryFrame.kind === 'guard' ? boundaryFrame.info : ensureGuardBlocks(boundaryRef.guard)
      currentBlock = enterArm(boundaryRef.guard, info, side)
      stack.push({ kind: 'guard', guard: boundaryRef.guard, takenWhen: side, info })
    }
    // Every frame this scope leaves has just closed (or, for a same-guard arm
    // switch, been sent toward its join) -- and no frame this scope adds has
    // opened yet. That is the one window in which a guard the new scope is
    // about to open can safely be resolved when its own boolean test is a value
    // only just settled here, which is exactly what a chained optional access
    // used as a `?:`/`&&` condition needs.
    afterUnwind?.()
    for (let index = startIndex; index < requiredScope.length; index += 1) {
      const ref = requiredScope[index]
      if (ref) openFreshLevel(ref)
    }

    // Still terminated after unwinding every frame this scope left: nothing
    // reaches here, and closing a frame did not hand control to a join. Such
    // code still needs a legal home, so it gets a block of its own rather than
    // being appended to one that already ended.
    //
    // Reaching this only *after* unwinding is the point. A `return` inside an
    // `if` terminates its arm, but the code after the `if` is reached by the
    // other arm -- discarding the frames on sight would orphan that join and
    // leave it with no terminator at all.
    //
    // A marker is the exception, and the whole reason `placesNothing` exists:
    // it is not code, so there is nothing to give a home to. `if (n === 1)
    // return 'one'; else return 'other';` reaches its own `branch` marker with
    // both arms terminated and no join -- the census orders a statement's
    // marker after everything inside it -- and the block opened here was then
    // sealed empty, unreached, and terminated by `lower.ts`'s body-completion
    // `return`, which in a `string`-returning function is C++ clang rejects
    // outright. Leaving `currentBlock` on the terminated block instead makes
    // `finish` report `alreadyTerminated`, which is the truth.
    if (isTerminated() && !placesNothing) {
      stack = []
      currentBlock = builder.openBlock()
    }

    return currentBlock
  }

  const finish = (): { block: IrBlockId; alreadyTerminated: boolean } => {
    // `currentBlock` alone answers "did the arm the walk last tracked end",
    // never "is every open frame's OTHER path also settled". A `region`
    // frame still on `stack` at this point is exactly a case where those
    // differ: `try { push(...) } catch { throw }` as a function's last
    // statement leaves `currentBlock` on the catch arm (terminated by its
    // own `throw`) while the region frame representing the try side's
    // normal completion is still open -- that side fell off its own end
    // without terminating, and its join has not been created yet.
    // Believing `isTerminated()` here skipped popping that frame at all, so
    // `finalizeFrame`'s region case (the one place that join gets opened and
    // connected) never ran, and `builder.seal()` caught the join later as a
    // block sealed without a terminator. Only when NOTHING remains open can
    // the current block's own state answer the question by itself.
    if (stack.length === 0 && isTerminated()) {
      // Every path through the remaining open frames already ended in its own
      // terminator (a return/throw/break/continue lowered while that frame
      // was active); nothing further can execute, so there is nothing left to
      // join, and reopening a block here would just manufacture dead code.
      return { block: currentBlock, alreadyTerminated: true }
    }
    while (stack.length > 0) {
      const frame = stack.pop()
      if (frame) finalizeFrame(frame)
    }
    // Draining a frame whose every path already terminated (both arms of a
    // guard return, say) leaves `currentBlock` exactly where it was --
    // `leaveInto(null)` is a no-op -- so the answer has to be asked fresh
    // rather than assumed false now that the stack is provably empty.
    return { block: currentBlock, alreadyTerminated: isTerminated() }
  }

  const isGuardOpen = (guard: SemanticResultId): boolean => stack.some((frame) => frame.kind === 'guard' && frame.guard === guard)

  const requireMergeSources = (guard: SemanticResultId): GuardMergeSources => {
    if (isGuardOpen(guard)) {
      throw new IrLoweringBlockedError("a merge over a guard was requested while one of that guard's arms was still open")
    }
    const info = ensureGuardBlocks(guard)
    if (info.truthySource === null) sendArmToJoin(guard, info, info.armTrue, 'truthy')
    if (info.falsySource === null) sendArmToJoin(guard, info, info.armFalse, 'falsy')
    const join = info.joinBlock
    const truthy = info.truthySource
    const falsy = info.falsySource
    if (join === null || truthy === null || falsy === null) {
      throw new IrLoweringBlockedError('a guard closed both arms without producing a join block to merge in')
    }
    currentBlock = join
    return { truthy, falsy, join }
  }

  const loopExitOf = (loop: OperationId): IrBlockId | null => {
    const guard = membership.guardOfLoop(loop)
    if (guard !== null) return guardCache.get(guard)?.joinBlock ?? null
    const info = loopCache.get(loop)
    // Asked for before the loop was entered, which for a transfer out of that
    // loop's own body cannot happen -- the body is inside it.
    if (!info) return null
    if (info.exit === null) info.exit = builder.openBlock()
    return info.exit
  }

  const switchExitOf = (switchOp: OperationId): IrBlockId => {
    const cached = switchCache.get(switchOp)
    if (cached !== undefined) return cached
    const exit = builder.openBlock()
    switchCache.set(switchOp, exit)
    return exit
  }

  const closeSwitch = (switchOp: OperationId, lineage: SemanticResultId | null): void => {
    const exit = switchCache.get(switchOp)
    if (exit === undefined) return
    if (!isTerminated()) builder.jump(currentBlock, lineage, exit)
    currentBlock = exit
  }

  const regionsOpened = (): readonly RegionBlockInfo[] =>
    [...regionCache.entries()].map(([region, info]) => ({
      region,
      tryEntry: info.tryEntry,
      catchEntry: info.catchEntry,
      finallyEntry: info.finallyEntry,
      finallyExit: info.finallyExit,
      join: info.join
    }))

  const splitCurrentBlock = (lineage: SemanticResultId | null): IrBlockId => {
    if (isTerminated()) throw new IrLoweringBlockedError('cannot split a terminated block for an iterator cleanup boundary')
    const next = builder.openBlock()
    builder.jump(currentBlock, lineage, next)
    currentBlock = next
    return next
  }

  return {
    currentBlock: () => currentBlock,
    requireMergeSources,
    isGuardOpen,
    loopHeaderOf: (loop) => loopCache.get(loop)?.header ?? null,
    loopLatchOf: (loop) => loopCache.get(loop)?.latch ?? null,
    loopNormalExitOf: (loop) => {
      const guard = membership.guardOfLoop(loop)
      return guard === null ? null : (guardCache.get(guard)?.armFalse ?? null)
    },
    loopBodyEntryOf: (loop) => {
      const guard = membership.guardOfLoop(loop)
      return guard === null ? null : (guardCache.get(guard)?.armTrue ?? null)
    },
    loopExitOf,
    switchExitOf,
    closeSwitch,
    splitCurrentBlock,
    regionsOpened,
    enterScope,
    finish
  }
}
