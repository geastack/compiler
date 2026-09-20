import type { DeclarationId, FunctionId, IrValueId } from '../identity/ids.js'
import { booleanConstantsOf, deadValuesOf, unreadValuesOf, type DeadValueRules } from './dead-values.js'
import { deferrableValuesOf } from './deferral.js'
import type { ForwardedBinding, ForwardingPolicy } from './deferral.js'
import { loopInvariantHoistsOf, loopInvariantValuesOf, type HoistPlan } from './hoist.js'
import { narrowableIntegersOf, remainderFormGroups, type IntegerStorageFacts } from './integers.js'
import { localIteratorValuesOf } from './local-iterators.js'
import { allOperationsOf, type CallOperation, type ComputeOperation, type GetOperation, type IrBody, type IrOperand } from './model.js'
import { numericIntrinsicsOf, type NumericIntrinsic } from './numeric-intrinsics.js'
import { operandsOfIrOperation, resultOfIrOperation } from './queries.js'
import { sharedStringLayoutsOf, type SharedStringLayout } from './string-layout-reuse.js'
import { stringLengthReuseOf } from './string-length-reuse.js'
import { typeQueryResultsOf, type TypeQueryComparison } from './type-query-results.js'

/**
 * Every per-body census the printer needs before it renders a line, computed
 * in one place, in the one order they depend on each other in.
 *
 * Distinct from `IrBody.facts` (`ir/captures.ts`), which is the whole-program
 * capture answer sealed onto the body before rendering starts. These are the
 * per-body questions, asked once per body at render entry; the two converge
 * when the remaining Phase 3 rows land.
 *
 * These thirteen analyses used to run inline in `targets/cpp/emit.ts`, each
 * copying its answer into the emit context. Nothing about them is C++: they ask
 * what a body does -- which results nothing reads, which reads may be deferred
 * to their single use, which numbers fit a `long long`, which loop-invariant
 * reads may be hoisted -- and the printer only spells the answers. What made
 * them live in the target was the ORDER, which is real and subtle and was
 * recorded only as comments between the calls: the type-query census removes
 * values from the deferral census, the hoists remove more, and the string
 * length reuse removes more still, so reading the deferral set at the wrong
 * point in the sequence silently answers a question with a set that is about
 * to shrink. Here that order is the body of one function, stated once, and a
 * reader who needs to know why a step sits where it does finds the reason at
 * the step rather than in a comment beside a call site.
 *
 * The target still owns two decisions inside the sequence, because both are
 * about C++ storage rather than about the program, and both are needed
 * mid-order. They arrive as `IrBodyCensusPolicy` hooks, invoked exactly where
 * the inline pipeline invoked them.
 */
export interface IrBodyCensus {
  /** Protocol cursors that never escape their `get-iterator`, so the printer may hold them by value. */
  readonly localIterators: ReadonlySet<IrValueId>
  /** Values with exactly one reader, renderable at that reader -- already shrunk by every later census that claims one. */
  readonly deferrable: ReadonlySet<IrValueId>
  readonly callArgumentOnly: ReadonlySet<IrValueId>
  /** Cells whose one write renders nothing and whose one read spells the written value -- see `deferral.ts`'s `ForwardedBinding`. Shrunk with `deferrable`: a forwarding whose value or read stopped deferring is withdrawn. */
  readonly forwardedBindings: ReadonlyMap<DeclarationId, ForwardedBinding>
  /** Results nothing reads and whose producer has no other effect. Disjoint from `deferrable` by construction. */
  readonly dead: ReadonlySet<IrValueId>
  /** Results nothing reads, whatever their producer does. */
  readonly unread: ReadonlySet<IrValueId>
  readonly booleanConstants: ReadonlyMap<IrValueId, boolean>
  readonly typeQueryValues: ReadonlySet<IrValueId>
  readonly typeQueryBindings: ReadonlySet<DeclarationId>
  readonly typeQueryComparisons: ReadonlyMap<ComputeOperation, TypeQueryComparison>
  readonly integerValues: ReadonlySet<IrValueId>
  readonly integerBindings: ReadonlySet<DeclarationId>
  readonly remainderForms: ReadonlyMap<IrValueId, 'restated' | 'dynamic'>
  readonly numericCalls: ReadonlyMap<CallOperation, NumericIntrinsic>
  readonly numericCallOnly: ReadonlySet<IrValueId>
  readonly loopInvariantValues: ReadonlySet<IrValueId>
  readonly hoists: HoistPlan
  readonly hoistedResults: ReadonlySet<IrValueId>
  readonly sharedStringLayouts: ReadonlyMap<IrValueId, SharedStringLayout>
  readonly reusedStringLengths: ReadonlyMap<IrValueId, IrOperand>
}

/**
 * What the target answers for its own carriers, plus the two points in the
 * order where it must act.
 *
 * Every field here is a question the IR genuinely cannot answer for itself: it
 * is about how this backend spells or stores a thing, and a second answer
 * derived from the IR would be a second authority over the printer's own
 * storage decisions.
 */
export interface IrBodyCensusPolicy {
  /** Whether this member read is a plain load the printer can move to its single use (not, for instance, a reactive cell whose spelling differs inline). */
  readonly deferrableMemberRead: (operation: GetOperation) => boolean
  /** Which renderings spell a forwarded call once, and which cells are private enough to forward -- see `deferral.ts`'s `ForwardingPolicy`. */
  readonly forwarding: ForwardingPolicy
  /** What counts as a pure or by-name-reached producer, so a result nothing reads may be deleted with it. */
  readonly deadValues: DeadValueRules
  /** Whether this cell is a private local `string` whose `typeof` result may be saved rather than recomputed. */
  readonly stringQueryCell: (declaration: DeclarationId) => boolean
  /** What a whole-program census already settled about this body's integer storage. */
  readonly integerStorage: IntegerStorageFacts
  /**
   * The target's constant spelling, which runs after the dead/unread censuses
   * and before the type-query census.
   *
   * Position is the whole contract: the spellings are read by the predicates
   * this sequence calls later, and the dead set is what decides which of them
   * are worth minting at all.
   */
  readonly spellConstants: () => void
  /**
   * The target's formal-cell and capacity decisions, which run after the
   * integer census -- the one thing that can make a cell and its own formal
   * two different storages -- and before the hoists, whose relocations this
   * step is allowed to name. Returns the values that ended up carried by a
   * formal cell, which is what the string-length reuse census treats as stable.
   *
   * It is handed the facts settled so far, because the deferral set it reads
   * is still the one the hoists have not yet claimed from: a bound this step
   * declines to name because a deferred value already withholds it must go on
   * declining after that value is relocated, and a step reading the final set
   * would name it a second time.
   */
  readonly formalStorage: (settled: IrBodyCensusBeforeHoists) => ReadonlySet<DeclarationId>
}

/** What is known when `formalStorage` runs: everything except the hoists and the two censuses that read them. */
export type IrBodyCensusBeforeHoists = Pick<
  IrBodyCensus,
  | 'localIterators'
  | 'deferrable'
  | 'callArgumentOnly'
  | 'forwardedBindings'
  | 'dead'
  | 'unread'
  | 'booleanConstants'
  | 'typeQueryValues'
  | 'typeQueryBindings'
  | 'typeQueryComparisons'
  | 'integerValues'
  | 'integerBindings'
  | 'remainderForms'
  | 'numericCalls'
  | 'numericCallOnly'
>

export const irBodyCensusOf = (body: IrBody, policy: IrBodyCensusPolicy): IrBodyCensus => {
  const localIterators = localIteratorValuesOf(body)

  const censused = deferrableValuesOf(body, policy.deferrableMemberRead, policy.forwarding)
  const dead = deadValuesOf(body, policy.deadValues)
  const unread = unreadValuesOf(body)
  const booleanConstants = booleanConstantsOf(body)
  policy.spellConstants()

  // Mutable from here on: the three censuses below each claim values out of the
  // deferral set, and a claimed value must not be deferred by anyone.
  const deferrable = new Set(censused.values)

  const typeQueries = typeQueryResultsOf(body, policy.stringQueryCell)
  // A tag observes the value at the query/read site, even if a later call
  // mutates the input. Do not turn a saved result into a repeated typeof.
  for (const value of typeQueries.values) deferrable.delete(value)

  // Which `number` values may be held in a `long long`, before any rendering:
  // storage is decided at a first write. See `ir/integers.ts`.
  const narrowed = narrowableIntegersOf(body, policy.integerStorage)
  const numericIntrinsics = numericIntrinsicsOf(body)
  const remainderForms = new Map<IrValueId, 'restated' | 'dynamic'>()
  for (const [form, values] of remainderFormGroups(narrowed)) for (const value of values) remainderForms.set(value, form)

  // The two cell facts the forwarding census leaves to this sequence: a
  // narrowed cell is `long long` storage and a type-query cell a saved tag,
  // and a read spelled as the written expression would be neither.
  const forwardedBindings = new Map<DeclarationId, ForwardedBinding>()
  for (const [declaration, forwarded] of censused.forwardedBindings) {
    if (narrowed.bindings.has(declaration) || typeQueries.bindings.has(declaration)) continue
    forwardedBindings.set(declaration, forwarded)
  }
  const settled: IrBodyCensusBeforeHoists = {
    localIterators,
    deferrable,
    callArgumentOnly: censused.consumedByCall,
    forwardedBindings,
    dead,
    unread,
    booleanConstants,
    typeQueryValues: typeQueries.values,
    typeQueryBindings: typeQueries.bindings,
    typeQueryComparisons: typeQueries.comparisons,
    integerValues: narrowed.values,
    integerBindings: narrowed.bindings,
    remainderForms,
    numericCalls: numericIntrinsics.calls,
    numericCallOnly: numericIntrinsics.callOnly
  }
  const stableFormals = policy.formalStorage(settled)

  const loopInvariantValues = loopInvariantValuesOf(body)
  const hoists = loopInvariantHoistsOf(body)
  const sharedStringLayouts = sharedStringLayoutsOf(body, hoists, dead)
  // A relocated value leaves the deferral census: a deferred value renders at
  // its use -- the place inside the loop the move exists to get it out of.
  const hoistedResults = new Set<IrValueId>()
  for (const value of hoists.relocated) {
    deferrable.delete(value)
    hoistedResults.add(value)
  }

  const reusedStringLengths = stringLengthReuseOf(body, stableFormals, new Set([...dead, ...hoists.relocated]))
  // A reused result must be stored at its dominating definition, even if its
  // original single consumer would otherwise defer that computation.
  for (const prior of reusedStringLengths.values()) deferrable.delete(prior.value)

  // Every census above that claimed a value out of `deferrable` may have taken
  // a forwarding's written value or read with it; a forwarding whose halves no
  // longer both defer would spell a value that now has storage of its own at
  // a place that storage is not written yet.
  for (const [declaration, forwarded] of forwardedBindings) {
    if (!deferrable.has(forwarded.value.value) || !deferrable.has(forwarded.read)) forwardedBindings.delete(declaration)
  }
  return { ...settled, loopInvariantValues, hoists, hoistedResults, sharedStringLayouts, reusedStringLengths }
}

/**
 * Where every value in this body came from -- purely syntactic indices over
 * the IR, with no C++ in the answer at all.
 *
 * The no-write-during-render rule, which moved these facts out of the target:
 * `targets/cpp/emit.ts`'s `emitCompute`, `targets/cpp/emit-properties.ts`'s
 * `emitGet` and `targets/cpp/emit-bindings.ts`'s `emitBindingRead` used to
 * record `computeOrigins`/`propertyReadOrigins`/`bindingReadDeclarations` as a
 * SIDE EFFECT of rendering the very operation each map is keyed by -- "the
 * compute operation that defined this value" needs nothing about what has
 * been printed, or in what order; it is answered by the operation's own
 * `result.id`, which exists before any statement is emitted. Recording it at
 * print time made the printer a second authority over a fact the IR already
 * settles, and meant a value visited twice (`ir/dead-values.ts`'s dead-value
 * short-circuit skipped `emitCompute` entirely, so `emit.ts`'s
 * `registerDirectCalleeOfDeadValue` had its OWN, independent
 * `bindingReadDeclarations.set` to avoid a hole) was one fact filled from two
 * places instead of one.
 *
 * `valueCellReads` (`targets/cpp/deferral-safety.ts`'s former
 * `collectValueCellReads`) is the fixed-point closure of `bindingReadDeclarations`
 * over every operand a value derives from -- also purely a property of the
 * operand graph, also unrelated to render order.
 */
export interface BodyValueOrigins {
  /** Every `compute` operation's own definition, by the value it produced. */
  readonly computeOrigins: ReadonlyMap<IrValueId, ComputeOperation>
  /** Every `get` operation's own definition, by the value it produced. */
  readonly propertyReadOrigins: ReadonlyMap<IrValueId, GetOperation>
  /**
   * Every `constant` operation's own literal text, by the value it defined.
   *
   * The same table the printer builds for itself in `spellConstants`, stated
   * here because a census that has to ask "is this property key a literal, and
   * which one" needs the answer before any spelling exists -- a static member
   * name is a fact about the operation, not about the line it becomes.
   *
   * Named for what it ANSWERS rather than for how it is built, because there
   * is a second map that would otherwise share the name and must never be
   * confused with it: `EmitContext.constantTexts` starts EMPTY at the point
   * this one is already complete, and then grows during the render as a
   * `typeof` whose operand's tag is known folds to a literal. Feeding that one
   * to a claim lets a fold decide a key the program computed. Both are
   * `ReadonlyMap<IrValueId, string>`, so only the name stands between them --
   * which is why `scripts/architecture.mjs` now also refuses to let
   * `ctx.constantTexts` be passed as an argument at all.
   */
  readonly staticKeyTexts: ReadonlyMap<IrValueId, string>
  /** The declaration every `binding-read` value loaded from, live or dead. */
  readonly bindingReadDeclarations: ReadonlyMap<IrValueId, DeclarationId>
  /** The operand every `convert` result was converted FROM, so a consumer can walk a value's history through a carrier change. */
  readonly conversionSources: ReadonlyMap<IrValueId, IrOperand>
  /**
   * The callee value behind every call's result -- which value it CALLED,
   * which is the same fact whichever of the printer's dispatch paths spells
   * the call.
   */
  readonly callCallees: ReadonlyMap<IrValueId, IrValueId>
  /**
   * Every value whose EVERY read in this body is as a call's callee -- a host
   * function read and called on the spot (`Math.pow(x)`), never compared,
   * stored, passed or returned. Counted over the operands and terminators the
   * body states, so a read that also feeds a binding write (`(f = Math.pow)(x)`)
   * is not in it. The printer uses it to leave the hot call path alone: the
   * identity a value read of a host builtin must carry (`emit-host-properties.ts`)
   * is only observable where the value goes somewhere other than a call.
   */
  readonly calleeOnlyValues: ReadonlySet<IrValueId>
  /**
   * Where each member of a record-shaped value came FROM, by member key, so a
   * consumer can still see a member's expression after it has become struct
   * storage.
   *
   * Two producers, and the accumulation between them is why this is a walk in
   * block order rather than a map comprehension: an `allocate-record` states
   * every member at once, while an object literal that installs its members
   * by STORE builds the same answer one `set` at a time, each carrying the
   * accumulated map onto the receiver and onto its own result (a store
   * threads its receiver onward).
   *
   * A store counts only when its key is a `constant` -- the same test the
   * printer made against its own constant table, restated against the IR the
   * table is filled from.
   *
   * BOTH store kinds, because `emit-properties.ts`'s `emitPropertyStore`
   * serves both and accumulated for both: an object literal whose members are
   * installed by `define-own-property` (which is what a descriptor literal
   * is) builds its answer exactly the way a `set`-installed one does, and
   * covering only `set` loses the descriptor `Object.defineProperty` on a
   * dictionary reads its typed `value` operand out of.
   */
  readonly recordFieldSources: ReadonlyMap<IrValueId, ReadonlyMap<string, IrOperand>>
  /**
   * Every callable this body allocated as a THUNK -- a zero-parameter,
   * receiver-less `function-value-dispatch` -- to the function whose body it
   * runs.
   *
   * The carrier is unwrapped through `optional` first, because a thunk stored
   * into an absence-capable slot is still a thunk; that is the shape the
   * printer's own two write sites tested, one of them on the unwrapped
   * carrier and one on the bare one.
   */
  readonly thunkValues: ReadonlyMap<IrValueId, FunctionId>
  /** Every cell a value transitively reads, over the whole body -- see `targets/cpp/deferral-safety.ts`'s `readsCell`. */
  readonly valueCellReads: ReadonlyMap<IrValueId, ReadonlySet<DeclarationId>>
}

export const bodyValueOriginsOf = (body: IrBody): BodyValueOrigins => {
  const computeOrigins = new Map<IrValueId, ComputeOperation>()
  const propertyReadOrigins = new Map<IrValueId, GetOperation>()
  const bindingReadDeclarations = new Map<IrValueId, DeclarationId>()
  const conversionSources = new Map<IrValueId, IrOperand>()
  const callCallees = new Map<IrValueId, IrValueId>()
  const recordFieldSources = new Map<IrValueId, ReadonlyMap<string, IrOperand>>()
  const thunkValues = new Map<IrValueId, FunctionId>()
  const staticKeyTexts = new Map<IrValueId, string>()
  const reads = new Map<IrValueId, number>()
  const calleeReads = new Map<IrValueId, number>()
  for (const block of body.blocks.values()) {
    for (const operation of allOperationsOf(block)) {
      for (const operand of operandsOfIrOperation(operation)) {
        reads.set(operand.value, (reads.get(operand.value) ?? 0) + 1)
        if (operation.kind === 'call' && operand === operation.callee)
          calleeReads.set(operand.value, (calleeReads.get(operand.value) ?? 0) + 1)
      }
      if (operation.kind === 'compute') computeOrigins.set(operation.result.id, operation)
      else if (operation.kind === 'get') propertyReadOrigins.set(operation.result.id, operation)
      else if (operation.kind === 'binding-read') bindingReadDeclarations.set(operation.result.id, operation.declaration)
      else if (operation.kind === 'convert') conversionSources.set(operation.result.id, operation.source)
      else if (operation.kind === 'constant') staticKeyTexts.set(operation.result.id, operation.text)
      else if (operation.kind === 'call') {
        if (operation.result) callCallees.set(operation.result.id, operation.callee.value)
      } else if (operation.kind === 'allocate-callable') {
        const carrier = operation.result.representation
        const payload = carrier.kind === 'optional' ? carrier.payload : carrier
        if (payload.kind === 'function-value-dispatch' && payload.abi.parameters.length === 0 && payload.abi.receiver === null) {
          thunkValues.set(operation.result.id, operation.functionId)
        }
      } else if (operation.kind === 'allocate-record') {
        recordFieldSources.set(operation.result.id, new Map(operation.fields.map((field) => [field.key, field.value])))
      } else if (operation.kind === 'set' || operation.kind === 'define-own-property') {
        const storedKey = staticKeyTexts.get(operation.key.value)
        if (storedKey !== undefined) {
          const sources = new Map(recordFieldSources.get(operation.receiver.value) ?? [])
          sources.set(storedKey, operation.value)
          recordFieldSources.set(operation.receiver.value, sources)
          if (operation.result) recordFieldSources.set(operation.result.id, sources)
        }
      }
    }
  }

  // The transitive closure needs its own fixed point: a value's read set is
  // its own binding-read declaration (if any) unioned with every operand's
  // already-settled read set, iterated until nothing grows.
  const valueCellReads = new Map<IrValueId, ReadonlySet<DeclarationId>>()
  let changed = true
  while (changed) {
    changed = false
    for (const block of body.blocks.values()) {
      for (const operation of allOperationsOf(block)) {
        const result = resultOfIrOperation(operation)
        if (result === null) continue
        const current = valueCellReads.get(result.id)
        const next = new Set<DeclarationId>(current ?? [])
        const ownDeclaration = bindingReadDeclarations.get(result.id)
        if (ownDeclaration !== undefined) next.add(ownDeclaration)
        for (const operand of operandsOfIrOperation(operation)) {
          for (const declaration of valueCellReads.get(operand.value) ?? []) next.add(declaration)
        }
        if (current !== undefined && current.size === next.size) continue
        valueCellReads.set(result.id, next)
        changed = true
      }
    }
  }

  return {
    computeOrigins,
    propertyReadOrigins,
    staticKeyTexts,
    bindingReadDeclarations,
    conversionSources,
    callCallees,
    calleeOnlyValues: new Set([...calleeReads].filter(([value, count]) => reads.get(value) === count).map(([value]) => value)),
    recordFieldSources,
    thunkValues,
    valueCellReads
  }
}
