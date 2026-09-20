import type { DeclarationId, FunctionId, IrValueId, RegionId } from '../identity/ids.js'
import type { BindingPlacement } from '../projection/bindings.js'
import { representationKey } from '../representation/model.js'
import { borrowEffectsOf, type PlainFieldRead } from './borrow-effects.js'
import { callableIdentityDemandOf, type CallableIdentityDemand } from './callable-identity-demand.js'
import { fixedFieldDeletionsOf, integrityRestrictionsOf } from './integrity-restrictions.js'
import { singleEvaluationClassesOf } from './class-evaluation.js'
import { callableMemberCandidatesOf } from './callable-member-candidates.js'
import { cyclicBlocksOf } from './dominance.js'
import { allOperationsOf, type IrBody, type IrNonTerminatorOperation } from './model.js'
import { operandsOfIrOperation } from './queries.js'
import { buildDyingArgumentIndex } from './transfer.js'

/**
 * Whole-program indices a translation unit needs before any of its bodies are
 * rendered: which module-level cells route their call by name, which
 * constructor cells this unit constructs repeatedly, which arguments die into
 * their callee, and which formal parameters may be declared `const&` rather
 * than copied.
 *
 * These used to run inline at the top of `targets/cpp/translation-unit.ts`'s
 * `renderTranslationUnit` (a whole-program index, so it belongs to the IR
 * rather than the target). Nothing here is about C++ text: every one of these
 * questions is answered by walking the lowered IR of every body in the unit,
 * the same way `ir/facts.ts` answers the PER-body questions that used to live
 * beside them in `targets/cpp/emit.ts`. What stays with the target is
 * `targets/cpp/captures.ts`'s `buildCaptureIndex`/`buildDirectCallableIndex`:
 * the first is blocked on `CallOperation.target` (Phase 3, not yet moved),
 * and the second's admission genuinely depends on comparing two carriers'
 * C++ SPELLING (`cppTypeOf`), which is a target decision, not a program one.
 * Both are computed by the caller and handed in.
 */
export interface ProgramFacts {
  /** Module-level function cells a call may spell by name, keyed by the receiver-shape/key slot `callableMemberSlot` names. */
  readonly callableMemberCandidates: ReadonlyMap<string, FunctionId>
  /** Constructor cells this unit constructs through repeatedly, and the class each names. */
  readonly repeatedConstructors: ReadonlyMap<DeclarationId, DeclarationId>
  /** Argument reads whose value has no use after the call it feeds, so the printer may spell them `std::move(...)`. */
  readonly dyingArguments: ReadonlySet<IrValueId>
  /** Which parameter positions this body may declare `const T&` instead of `T`. */
  readonly formalsBorrowedIn: (owner: FunctionId | RegionId) => ReadonlySet<number>
  /**
   * Whether this body calls a callee this program CAN name and has NOT proven
   * effect-free -- as opposed to a callee reached only through an opaque value
   * (a callback parameter), which no whole-program analysis can ever resolve.
   *
   * `ir/borrowed-call-arguments.ts`'s `readonlyBorrowFormalsOf` proves
   * a formal read-only from LOCAL evidence alone (its own cell is never
   * rewritten) and relies on the CALLER supplying a stable actual
   * (`stableBorrowEntryAccepts`) to rule out external mutation. That call-site
   * proof is sound against a truly UNKNOWN callee -- nothing this compiler
   * could learn about it would change what the caller must guarantee -- but it
   * is NOT sound against a KNOWN, in-program callee this compiler already
   * knows is unsafe: `function snapshot(text: string, holder: Holder) {
   * middle(holder); return text }` reaches, through `middle`, a `mutate` that
   * writes `holder.text` -- a field of holder, which is THIS body's OWN other
   * parameter -- and the read-only proof has no way to see that, because it
   * never looks at 'call' operations at all. `borrowEffectsOf`'s `targets` map
   * already resolves such calls to a known `FunctionId`, and its `operations`
   * map already answers whether that particular call was ever proven safe
   * (present in the callee-safe set at the fixed point's end) -- this fact is
   * just that same answer, indexed by owner, so a target-side entry point
   * builder can refuse to treat a read-only formal as borrowable whenever its
   * body still has an unresolved known call in it. An opaque call (no `target`
   * resolves) never sets this: it is the caller-stability proof's job alone.
   */
  readonly bodyCallsUnsafeKnownCallee: (owner: FunctionId | RegionId) => boolean
  /** Which callable allocations must mint their function-object identity up front -- see `callable-identity-demand.ts`. */
  readonly callableIdentityDemand: CallableIdentityDemand
  /** Whether any operation can freeze, seal or redefine a native object's properties -- see `ir/integrity-restrictions.ts`. */
  readonly nativeIntegrityRestricted: boolean
  /**
   * Whether every generated struct's required-field presence bits and
   * attribute triples are program-wide constants: nothing can freeze, seal
   * or redefine (`nativeIntegrityRestricted`) and nothing can delete a
   * declared field (`fixedFieldDeletionsOf`). `records.ts` then states them
   * once per struct instead of once per instance, and a field store skips
   * the presence byte it would otherwise re-set.
   */
  readonly fixedFieldStateConstant: boolean
  /** The classes evaluated exactly once, whose method state a struct may hold statically -- see `ir/class-evaluation.ts`. */
  readonly singleEvaluationClasses: ReadonlySet<DeclarationId>
}

/**
 * The target's own decisions this census needs mid-order, none of them
 * answerable from the IR alone:
 *
 * - `captureFree`/`isBoxed` come from `targets/cpp/captures.ts`'s whole-unit
 *   capture index, which stays in the target (see `ProgramFacts`'s doc).
 * - `isCoroutineBody` is a rendering fact -- whether this backend spells the
 *   body's `yield` as `co_yield`, which is what makes a function a C++20
 *   coroutine -- not a property the IR states about itself.
 * - `isPrivateLocal` is the binding-placement plan's answer to "does this
 *   declaration's storage belong only to this body", which the borrow-effect
 *   proof needs to admit a local write as safe.
 */
export interface ProgramFactsPolicy {
  readonly captureFree: (functionId: FunctionId) => boolean
  readonly isBoxed: (declaration: DeclarationId) => boolean
  readonly isCoroutineBody: (body: IrBody) => boolean
  readonly isPrivateLocal: (body: IrBody, declaration: DeclarationId) => boolean
  /** The instance carrier a class lays out, or `null` for one with no native layout -- the class table is the target's. */
  readonly classInstanceOf: (declaration: DeclarationId) => import('../representation/model.js').Representation | null
  /** Whether `receiver.key` is a plain data-field load -- see `borrow-effects.ts`'s `PlainFieldRead`. */
  readonly plainFieldRead: PlainFieldRead
}

/**
 * Constructor cells whose construction this unit should call BY NAME.
 *
 * Not every one of them: naming the construct function lets clang inline the
 * whole construction -- `gea::makeRef`, its pool refill, its `try`/`catch` --
 * into whatever body constructs, and that is either the point or a disaster
 * depending on how often the body constructs. Both were measured, on the same
 * day, with the same compiler:
 *
 * - `bench/comparison/fixtures/binary_trees.ts` constructs a million times
 *   inside a recursive body. Through the carrier the construction is an
 *   INDIRECT call taking two `gea::Ref` arguments by address, with a retain
 *   and a release around each: 46.1ms. Named, and therefore inlined: 41.9ms.
 * - `bench/comparison/fixtures/method_calls.ts` constructs ONCE, before its
 *   hot loop. Naming it there spent the caller's inlining budget on a
 *   construction that runs a single time, and the loop's own callee stopped
 *   being inlined: 38.1ms to 49.0ms.
 *
 * So the question is not "can this be devirtualized" -- an earlier attempt
 * asked that, got `yes` for both, and was reverted as a net loss -- but "does
 * the program construct through this cell REPEATEDLY". A construction inside a
 * cyclic block or in a body that calls itself runs many times; one in
 * straight-line code in a non-recursive body runs as many times as its caller
 * does. Callback arguments and the known call graph extend that repeated
 * context to event-driven bodies without marking all initialization hot.
 *
 * `noinline` on the construct function was measured too, as the way to have
 * the direct call without the inlining, and it is worse than either
 * (binary_trees 41.9ms to 44.5ms): the inlining IS the win where the win is.
 */
const buildRepeatedConstructorIndex = (
  bodies: readonly IrBody[],
  directCallables: ReadonlyMap<DeclarationId, FunctionId>
): ReadonlyMap<DeclarationId, DeclarationId> => {
  const allocated = new Map<IrValueId, DeclarationId>()
  const writeCounts = new Map<DeclarationId, number>()
  const written = new Map<DeclarationId, DeclarationId>()
  for (const body of bodies) {
    for (const block of body.blocks.values()) {
      for (const operation of block.operations) {
        if (operation.kind === 'allocate-constructor' && operation.captures.length === 0)
          allocated.set(operation.result.id, operation.declaration)
        if (operation.kind !== 'binding-write') continue
        writeCounts.set(operation.declaration, (writeCounts.get(operation.declaration) ?? 0) + 1)
        const declaration = allocated.get(operation.value.value)
        if (declaration !== undefined) written.set(operation.declaration, declaration)
      }
    }
  }
  // Callbacks may be invoked repeatedly by their consumer, including a host
  // event loop. Propagate that context through known calls instead of treating
  // every acyclic callback body as one-time initialization. This is an inlining
  // heuristic; the single-write constructor proof below remains mandatory.
  const callbacks = new Map<IrValueId, FunctionId>()
  const callbackReads = new Map<IrValueId, DeclarationId>()
  for (const body of bodies) {
    for (const block of body.blocks.values()) {
      for (const operation of block.operations) {
        if (operation.kind === 'allocate-callable') callbacks.set(operation.result.id, operation.functionId)
        if (operation.kind === 'binding-read') callbackReads.set(operation.result.id, operation.declaration)
      }
    }
  }
  const functionOf = (value: IrValueId): FunctionId | undefined => {
    const declaration = callbackReads.get(value)
    return callbacks.get(value) ?? (declaration === undefined ? undefined : directCallables.get(declaration))
  }
  const repeatedBodies = new Set<IrBody['sourceOwner']>()
  const calls = new Map<IrBody['sourceOwner'], Set<FunctionId>>()
  for (const body of bodies) {
    const cyclic = cyclicBlocksOf(body)
    for (const [blockId, block] of body.blocks) {
      for (const operation of block.operations) {
        if (operation.kind !== 'call' && operation.kind !== 'construct') continue
        for (const argument of operation.arguments) {
          const callback = functionOf(argument.value)
          if (callback !== undefined) repeatedBodies.add(callback)
        }
        if (operation.kind !== 'call') continue
        const callee = functionOf(operation.callee.value)
        if (callee === undefined) continue
        const targets = calls.get(body.sourceOwner) ?? new Set<FunctionId>()
        targets.add(callee)
        calls.set(body.sourceOwner, targets)
        if (cyclic.has(blockId) || callee === body.sourceOwner) repeatedBodies.add(callee)
      }
    }
  }
  for (const caller of repeatedBodies) {
    for (const callee of calls.get(caller) ?? []) repeatedBodies.add(callee)
  }
  const repeated = new Map<DeclarationId, DeclarationId>()
  for (const body of bodies) {
    const cyclic = cyclicBlocksOf(body)
    const reads = new Map<IrValueId, DeclarationId>()
    let recursive = false
    for (const block of body.blocks.values()) {
      for (const operation of block.operations) {
        if (operation.kind === 'binding-read') reads.set(operation.result.id, operation.declaration)
        // A body that calls ITSELF constructs as many times as it recurses,
        // which is the same fact a cyclic block states one level down. The
        // callee is a cell like any other, so the same index the emitter
        // devirtualizes calls through is what answers which body it names.
        if (operation.kind !== 'call') continue
        const callee = reads.get(operation.callee.value)
        if (callee !== undefined && directCallables.get(callee) === body.sourceOwner) recursive = true
      }
    }
    for (const [blockId, block] of body.blocks) {
      if (!recursive && !repeatedBodies.has(body.sourceOwner) && !cyclic.has(blockId)) continue
      for (const operation of block.operations) {
        if (operation.kind !== 'construct') continue
        const cell = reads.get(operation.callee.value)
        if (cell === undefined || writeCounts.get(cell) !== 1) continue
        const declaration = written.get(cell)
        if (declaration !== undefined) repeated.set(cell, declaration)
      }
    }
  }
  return repeated
}

/**
 * Which parameter positions this body may declare `const T&` instead of `T`.
 *
 * A `std::string` formal taken by value is a heap copy per call and a
 * `gea::Ref<T>` one an atomic pair, paid for an argument the caller already
 * holds for the whole call. Like the target's `borrowsReceiver`, this is the
 * BODY's spelling only: the ABI, the carrier and the thunk keep the by-value
 * convention every caller agrees on, and the thunk's own copy binds to the
 * reference.
 *
 * Unlike the receiver, a parameter may ALIAS storage the body can write.
 * `this.label = f(this.label)` passes the field itself (a plain read is spelled
 * inline, so the reference binds to `gea_this->label`), and a body that then
 * assigned that field before reading its parameter would read the new value
 * where the language gives it the old one. So a body borrows only when it can
 * change no caller-owned handle/string slot or re-enter program code. The
 * shared IR effect proof admits native byte stores and non-coercing primitive
 * calls, but excludes accessors, arbitrary calls, deletes and construction.
 * There is no `await`/`yield` (a
 * reference across a suspension dangles -- the coroutine rule
 * `borrowsReceiver` states), and writes only to its own locals. And a
 * parameter the body hands on as a DYING argument is not borrowed either: that
 * read is spelled `std::move(...)` (`emit-narrowing.ts`), which a `const&`
 * refuses.
 *
 * `examples/apps/weather` formats temperatures and labels through forty such
 * string parameters; every one of them was a copy.
 */
/** An `optional` over a reference-counted or string payload: physically one handle, copied by value only because the wrapper states no ownership. */
const refCarrierByValue = (value: import('../representation/model.js').Representation): boolean =>
  value.kind === 'optional' &&
  (value.payload.kind === 'string' || ('ownership' in value.payload && value.payload.ownership === 'shared-refcount'))

const borrowedFormalsOf = (
  body: IrBody,
  dyingArguments: ReadonlySet<IrValueId>,
  isBoxed: (declaration: DeclarationId) => boolean,
  isCoroutineBody: (body: IrBody) => boolean,
  placements: ReadonlyMap<DeclarationId, BindingPlacement>,
  safeOperations: ReadonlySet<IrNonTerminatorOperation>,
  borrowedForwarding: ReadonlySet<IrValueId>
): ReadonlySet<number> => {
  const borrowed = new Set<number>()
  if (!body.abi || isCoroutineBody(body)) return borrowed
  const parameters = new Map<IrValueId, number>()
  const seededBy = new Map<DeclarationId, IrValueId[]>()
  const readsOf = new Map<DeclarationId, IrValueId[]>()
  for (const block of body.blocks.values()) {
    for (const operation of block.operations) {
      if (!safeOperations.has(operation)) return borrowed
      if (operation.kind === 'parameter') parameters.set(operation.result.id, operation.ordinal)
      if (operation.kind === 'binding-write') {
        const placement = placements.get(operation.declaration)
        if (!placement || placement.storage.kind !== 'local' || String(placement.storage.owner) !== String(body.sourceOwner))
          return borrowed
        seededBy.set(operation.declaration, [...(seededBy.get(operation.declaration) ?? []), operation.value.value])
      }
      if (operation.kind === 'binding-read')
        readsOf.set(operation.declaration, [...(readsOf.get(operation.declaration) ?? []), operation.result.id])
    }
  }
  for (const [value, ordinal] of parameters) {
    const parameter = body.abi.parameters[ordinal]
    if (!parameter || parameter.ownership === 'borrowed') continue
    // A nullable handle (`TreeNode | null`) is passed by value -- `passingOf`
    // gives an `optional` no ownership of its own -- yet copying it is the
    // same retain/release as copying the handle it wraps, so it borrows on
    // the same terms.
    if (parameter.passing !== 'const-ref' && !refCarrierByValue(parameter.value)) continue
    // The parameter's own value usually has exactly one reader -- the write
    // that seeds its cell -- and is therefore "dying" into it. That write is
    // the one `collectFormalCells` elides (the body then reads the formal by
    // name), so it moves nothing; but it is elided only under that function's
    // own conditions -- one write, an unboxed cell, the same carrier -- and a
    // seed that stays is spelled `std::move(gea_arg_N)`, which a `const&`
    // refuses. So the same conditions decide here.
    let moved = false
    for (const [declaration, values] of seededBy) {
      if (!values.includes(value)) continue
      const placement = placements.get(declaration)
      const sameCarrier =
        placement?.representation != null && representationKey(placement.representation) === representationKey(parameter.value)
      if (values.length !== 1 || isBoxed(declaration) || !sameCarrier) moved = true
      for (const read of readsOf.get(declaration) ?? []) if (dyingArguments.has(read) && !borrowedForwarding.has(read)) moved = true
    }
    if (!moved) borrowed.add(ordinal)
  }
  return borrowed
}

/**
 * Everything a translation unit needs to know about the whole program before
 * it renders a body, in the one dependency order these questions actually
 * have: a callable must be named before repeated construction through it can
 * be counted, and both must exist before the borrow fixed point can ask which
 * calls forward an already-borrowed argument unchanged.
 */
export const programFactsOf = (
  bodies: readonly IrBody[],
  directCallables: ReadonlyMap<DeclarationId, FunctionId>,
  placements: ReadonlyMap<DeclarationId, BindingPlacement>,
  policy: ProgramFactsPolicy
): ProgramFacts => {
  const callableMemberCandidates = callableMemberCandidatesOf(bodies, directCallables)
  const repeatedConstructors = buildRepeatedConstructorIndex(bodies, directCallables)
  const dyingArguments = buildDyingArgumentIndex(bodies)
  const borrowEffects = borrowEffectsOf(
    bodies,
    directCallables,
    policy.captureFree,
    (body) => !policy.isCoroutineBody(body),
    policy.isPrivateLocal,
    policy.plainFieldRead
  )

  // A fixed point over the whole unit: a call forwarding one of ITS OWN
  // already-borrowed formals to a callee position that callee also borrows
  // adds no new alias the callee doesn't already tolerate, so the caller may
  // borrow that formal too even though it also passes it on. Any other use
  // -- read for anything but such a forwarded argument -- disqualifies it.
  // Because a callee's admitted set can grow on a later pass (it may itself
  // depend on a third body not yet settled), this iterates until nothing
  // grows, exactly as `borrowEffectsOf`'s own effect proof does.
  const borrowedFormals = new Map<string, ReadonlySet<number>>()
  let borrowingChanged = true
  while (borrowingChanged) {
    borrowingChanged = false
    for (const body of bodies) {
      const forwarded = new Set<IrValueId>()
      const otherUses = new Set<IrValueId>()
      for (const block of body.blocks.values())
        for (const operation of allOperationsOf(block)) {
          const target = operation.kind === 'call' ? borrowEffects.targets.get(operation.callee.value) : undefined
          const admitted = target === undefined ? undefined : borrowedFormals.get(String(target))
          for (const operand of operandsOfIrOperation(operation)) {
            const positions =
              operation.kind === 'call'
                ? operation.arguments.flatMap((argument, index) => (argument.value === operand.value ? [index] : []))
                : []
            if (admitted && positions.length > 0 && positions.every((position) => admitted.has(position))) forwarded.add(operand.value)
            else otherUses.add(operand.value)
          }
        }
      for (const value of otherUses) forwarded.delete(value)
      const owner = String(body.sourceOwner)
      const next = borrowedFormalsOf(
        body,
        dyingArguments,
        policy.isBoxed,
        policy.isCoroutineBody,
        placements,
        borrowEffects.operations.get(owner) ?? new Set(),
        forwarded
      )
      if (next.size > (borrowedFormals.get(owner)?.size ?? 0)) borrowingChanged = true
      borrowedFormals.set(owner, next)
    }
  }
  const formalsBorrowedIn = (owner: FunctionId | RegionId): ReadonlySet<number> => borrowedFormals.get(String(owner)) ?? new Set<number>()

  // See `ProgramFacts.bodyCallsUnsafeKnownCallee`'s doc: a body is flagged the
  // moment ONE of its 'call' operations names a resolvable target
  // (`borrowEffects.targets`) that the fixed point above never proved safe
  // (absent from that owner's own final safe-operation set). An opaque call
  // -- no resolvable target -- never flags anything here, on purpose: that
  // hazard is the call-SITE's to rule out, not this body's.
  const unsafeKnownCallees = new Set<string>()
  for (const body of bodies) {
    const owner = String(body.sourceOwner)
    const safe = borrowEffects.operations.get(owner)
    for (const block of body.blocks.values())
      for (const operation of allOperationsOf(block)) {
        if (operation.kind !== 'call' || !borrowEffects.targets.has(operation.callee.value)) continue
        if (!safe?.has(operation)) unsafeKnownCallees.add(owner)
      }
  }
  const bodyCallsUnsafeKnownCallee = (owner: FunctionId | RegionId): boolean => unsafeKnownCallees.has(String(owner))

  const callableIdentityDemand = callableIdentityDemandOf(bodies, { classInstanceOf: policy.classInstanceOf })
  const nativeIntegrityRestricted = integrityRestrictionsOf(bodies)
  const fixedFieldStateConstant = !nativeIntegrityRestricted && !fixedFieldDeletionsOf(bodies)
  const singleEvaluationClasses = singleEvaluationClassesOf(bodies)

  return {
    callableMemberCandidates,
    repeatedConstructors,
    dyingArguments,
    formalsBorrowedIn,
    bodyCallsUnsafeKnownCallee,
    callableIdentityDemand,
    nativeIntegrityRestricted,
    fixedFieldStateConstant,
    singleEvaluationClasses
  }
}
