import type { BindingReadOperation, BindingWriteOperation, IrBody, IrOperand } from '../../ir/model.js'
import { allOperationsOf } from '../../ir/model.js'
import { operandsOfIrOperation } from '../../ir/queries.js'
import type { DeclarationId, IrValueId } from '../../identity/ids.js'
import type { BindingPlacement } from '../../projection/bindings.js'
import { representationKey, type Representation } from '../../representation/model.js'
import { carrierDifference, shortCarrierText } from '../../representation/difference.js'
import {
  bindingReference,
  createCppEmitBlockedError,
  cppFormalName,
  cppReceiverName,
  declareCell,
  defineValue,
  defineValueAlias,
  isCppEmitBlockedError,
  operandText,
  type EmitBodyPrepassFacts,
  type EmitContext
} from './emit-context.js'
import { alignedValueText, classFamilyLoadText, emptyArraySentinelText, movedValueText } from './emit-narrowing.js'
import { stringAppendStatement } from './emit-tostring.js'
import { cppAbiParameterType, cppBoxedType, cppNarrowedIntegerType, cppStringLiteral, cppTypeOf } from './types.js'
import { receiverBoundCallableText } from './emit-callable.js'
import { structuralRecordViewText } from './emit-record-view.js'
import { owningConversionInputText } from './owning-conversion-input.js'

/**
 * The expression a boxed cell's handle reads as an ordinary value, versus the
 * handle itself.
 *
 * `bindingReference` always names the cell's own storage -- a plain `T`
 * variable, or a `std::shared_ptr<T>` handle when `CaptureSlot.boxed`/
 * `CaptureIndex.isBoxed` says this declaration is shared by aliasing
 * (`emit-callable.ts`'s field-copy line wants exactly that raw handle, to
 * copy the pointer into a deeper environment unchanged). Every OTHER use of
 * the cell -- a read, or the assignment target of a write -- wants the
 * pointee, not the pointer, so those two call sites dereference here instead
 * of inlining the same parenthesized `*` twice.
 */
export const cellValueText = (cell: { readonly name: string; readonly boxed: boolean }): string =>
  cell.boxed ? `(*${cell.name})` : cell.name

/**
 * A checker-narrowed structural record carried inside one arm of a cell's
 * union. `convertedValueText` can dispatch through representation-only
 * conversions, but a native-record/class arm needs the emitter's layout table
 * to prove and build its structural view. Walk only sum wrappers here and let
 * `structuralRecordViewText` remain the one authority on the leaf conversion.
 */
const structuralUnionLoadText = (ctx: EmitContext, held: Representation, read: Representation, text: string): string | null => {
  // A whole-carrier conversion owns the source discriminant and every live
  // target arm. Searching only structural leaves first can pick a record arm
  // and silently discard still-live primitive/absent arms of the same sum.
  try {
    const converted = alignedValueText(ctx, 'emit-bindings.ts:118', held, read, text)
    if (converted !== null) return converted
  } catch (error) {
    if (!isCppEmitBlockedError(error)) throw error
  }
  const completeView = structuralRecordViewText(ctx, held, read, text)
  if (completeView !== null) return completeView
  // A target sum must be converted as a whole. A partial structural-arm
  // search cannot prove that it covers all of that target's live members.
  if (read.kind === 'optional' || read.kind === 'tagged-union') return null
  if (held.kind === 'optional') return structuralUnionLoadText(ctx, held.payload, read, `(*${text})`)
  if (held.kind !== 'tagged-union') return structuralRecordViewText(ctx, held, read, text)
  const candidates = held.arms.flatMap((arm, index) => {
    const loaded = (() => {
      try {
        return structuralUnionLoadText(ctx, arm.value, read, `${text}.get<${index}>()`)
      } catch (error) {
        // A union-arm search routinely asks incompatible arms before finding
        // the one the checker proved live. A named conversion refusal rejects
        // that candidate; it does not reject a later arm with a valid view.
        if (isCppEmitBlockedError(error)) return null
        throw error
      }
    })()
    return loaded === null ? [] : [{ index, loaded }]
  })
  const last = candidates[candidates.length - 1]
  if (!last) return null
  let dispatched = last.loaded
  for (const candidate of candidates.slice(0, -1).reverse()) {
    dispatched = `${text}.is<${candidate.index}>() ? ${candidate.loaded} : (${dispatched})`
  }
  return candidates.length > 1 ? `(${dispatched})` : dispatched
}

/**
 * Binding cells: the one place the plan's per-result carrier and the
 * projection's per-declaration carrier have to be reconciled.
 *
 * They disagree routinely and legitimately -- control-flow narrowing makes a
 * read narrower than its cell, and a declared union makes a cell wider than its
 * initializer -- so both directions are written out here rather than left to
 * C++ to interpret.
 */

/**
 * Reading a binding is a load from its cell.
 *
 * The carrier the read publishes and the carrier the cell holds are decided by
 * two different authorities -- the plan selects per result, the placement
 * projects per declaration -- and control-flow narrowing routinely makes them
 * disagree: inside `if (tag)` the checker types `tag` as `string`, so the
 * read's carrier is `string`, while the cell still holds `Optional<string>`
 * because that is what the declaration binds. `if (typeof x === 'string')` does
 * the same to a cell holding a tagged union.
 *
 * Those loads exist and this renders them -- `gea::Optional::operator*`,
 * `gea::TaggedUnion::get`. The proof is the checker's: it established presence,
 * or which arm is live, before this read ever runs, and re-deciding it here
 * would be a second authority answering a settled question with nowhere to go
 * when it disagreed. What this file owns is whether the load exists at all, and
 * it does not decide that either: `targets/cpp/conversions.ts` states the
 * capability, preflight censuses it, and a program whose narrowed read has no
 * installed load is refused before emission rather than here.
 *
 * Every other disagreement is still refused by name. A cell and a read that
 * differ in a way no load explains are two unrelated C++ types, and emitting
 * the bare assignment would hand the C++ compiler a program this one already
 * knows is wrong.
 */
export const emitBindingRead = (ctx: EmitContext, lines: string[], operation: BindingReadOperation): void => {
  if (ctx.typeQueryValues.has(operation.result.id)) {
    const cell = bindingReference(ctx, operation.declaration, 'a type-query snapshot read')
    lines.push(`${defineValue(ctx, operation.result)} = ${cellValueText(cell)};`)
    return
  }
  // `ctx.bindingReadDeclarations` already names this read's declaration --
  // settled in `EmitBodyFacts`, for every `binding-read` in the body, live or
  // dead (the type-query early return above no longer withholds it).
  //
  // A cell the whole unit writes once, with a callable that captures nothing,
  // holds one body forever, so a CALL through this read is a call by name --
  // but that is a fact about the eventual CALL, not about this read, and
  // `emitBody`'s own up-front walk of `CallOperation.target` already
  // registered it (`ir/call-dispatch.ts`) before this operation ever
  // rendered. Nothing is left for this read to decide here.
  // A cell that holds one host method forever is read as that member: the
  // access that filled it recorded a deferred host read and rendered nothing
  // (`nativeHandleMemberText`), and this read is the same fact one body away.
  // `receiver: null` is what a class object or namespace receiver records
  // there too, which is why the index admits only those.
  if (ctx.hostMethodAliases.has(operation.declaration)) return
  // A class object this program introduces no cell for, recorded by
  // `classObjectReadsOf` above: there is nothing to load, and every site that
  // can use the class spells it from its declaration.
  if (ctx.classObjectReads.has(operation.result.id)) return
  const placement = ctx.placements.get(operation.declaration)
  // A host's class object produces no C++ at all, the same way a host METHOD
  // access does: there is no cell to load from, and what the program actually
  // does with the class -- constructs it, reads its class members -- is spelled
  // whole by the host at the site that does it. Registering it as a deferred
  // read is what makes a program that instead wants the class as a VALUE refuse
  // by name (`operandText`) rather than name a variable nothing declares.
  if (placement?.storage.kind === 'host-class') return
  // A host singleton is the same physical answer for the same reason: there is
  // no cell to load and no value to hold, only members the host spells whole.
  // Registered in the same map, so the one question every consumer asks --
  // "does this receiver render as a value?" -- keeps one answer.
  if (placement?.storage.kind === 'host-singleton') return
  // A host FUNCTION is not a cell either, and unlike a constant it has no text
  // that stands on its own: what the host states is the function's name, and a
  // name is only C++ where it is called. Registering the read is what lets the
  // call render `gea::apple::AppKit::installRootViewController(vc)` and what
  // makes any OTHER use of it -- storing it, passing it -- refuse by name in
  // `operandText` rather than emit a variable nothing defines.
  // Settled before this body rendered a line, by `host-namespace-reads.ts`'s
  // `hostNamespaceReadsOf`, from this exact `placement.storage.kind` test.
  // Nothing is left for the read to record; it only has to render nothing.
  if (placement?.storage.kind === 'host-function') return
  // A host NAMESPACE is not a cell and has no text of its own either: it is a
  // path, and only the leaf a path reaches is C++. Registering the path is what
  // lets the member access extend or resolve it, and what makes the namespace
  // used as a value refuse by name in `operandText`.
  if (placement?.storage.kind === 'host-namespace') return
  // A host constant is a text, not a cell: the host said what the value is, so
  // the read is that text and nothing declares storage for it.
  if (placement?.storage.kind === 'host-constant') {
    const constantName = defineValue(ctx, operation.result)
    lines.push(`${constantName} = ${placement.storage.emit};`)
    // A constant can also be the root of a member path: the host states
    // `audioContext` as a value AND states its methods under that name, since
    // the methods really are members of that one object. That pairing is
    // recorded in `ctx.hostNamespaceValues` by the same settled fixed point,
    // not here -- the value still renders, which is the whole difference
    // between it and a pure namespace.
    return
  }
  // The one read of a forwarded cell names the written value -- a withheld
  // expression, or the temporary its producer kept -- and no cell exists.
  const forwarded = ctx.forwardedBindings.get(operation.declaration)
  if (forwarded !== undefined && forwarded.read === operation.result.id) {
    defineValueAlias(ctx, operation.result, operandText(ctx, forwarded.value))
    return
  }
  const held = placement?.representation
  const read = operation.result.representation
  // The carrier travels with the description because the one refusal this can
  // raise -- `native-boundary:external-binding` -- says only that no placement
  // exists, and what the read was going to PRODUCE is the fact that separates
  // a missing host cell from a class object whose own declaration published no
  // binding. Reading that back from raw ids took a whole build.
  const cell = bindingReference(ctx, operation.declaration, `a binding read of ${representationKey(read)}`)
  const cellText = cellValueText(cell)
  // A read whose OWN carrier has exactly one value needs no load: `undefined`
  // and `void` are storage-free (`representation/primitives.ts`), so whatever
  // the cell holds, the value this read produces is that one value. Do this
  // before asking a union conversion to locate an arm: a nested union may
  // encode absence in an enclosing tag rather than expose an exact leaf, but
  // there is still no payload to recover from that tag.
  //
  // The other case is an unreachable branch: a generic narrowed by
  // `instanceof` to a class its own monomorphized copy cannot be gives the
  // narrowed binding an uninhabited intersection, which `derive.ts` answers
  // with `never`'s storage-free carrier. Rendering the singleton is honest in
  // both cases: the branch never runs, and the result has no payload even if it
  // did.
  if (read.kind === 'undefined' || read.kind === 'void') {
    const literalName = defineValue(ctx, operation.result)
    lines.push(`${literalName} = ${cppTypeOf(read)}{};`)
    return
  }
  // The empty-array sentinel is tried first and only for an array-object
  // pair: `narrowedLoadText` has no shape for it at all and would otherwise be
  // asked a question it can only answer `null` to, same as today. An element
  // DISAGREEMENT is deliberately not bridged here -- see `conversions.ts`'s
  // refusal to install one, and why a copy is never sound for a mutable array.
  const arrayRecast = held?.kind === 'array-object' && read.kind === 'array-object' ? emptyArraySentinelText(held, read, cellText) : null
  // A cell/read disagreement is not always a narrowing. The placement is the
  // storage authority while the operation publishes the checker's view at
  // this use, and that view can be wider: a scalar cell read as
  // `number | undefined`, or a Scene cell read as `Scene | null |
  // undefined`, needs the same optional/union construction a write uses.
  // `convertedValueText` is the shared superset of narrowed loads and widened
  // stores, so ask it after the array-element recast rather than assuming
  // every disagreement points inward.
  const classUnion = held ? classFamilyLoadText(ctx, held, read, cellText) : null
  // An unchanged union is the cell itself. Searching its arms for a
  // structural conversion can find one compatible arm, project it with
  // `get<N>()`, and rebuild a fresh union tagged as N. That destroys the
  // original discriminant (`A | B` holding B became an A-tagged value) even
  // though no conversion was requested. Structural arm search is only for a
  // real cell/read carrier disagreement; identity stays with the shared
  // conversion authority below.
  const structural =
    held?.kind === 'tagged-union' && representationKey(held) !== representationKey(read)
      ? structuralUnionLoadText(ctx, held, read, cellText)
      : null
  // convertedValueText returns the input expression for identity, not null.
  // Identity must remain "no narrowing" here: otherwise every unchanged read
  // loses the stable-cell alias path below and copies its owning storage.
  const narrowed =
    held && representationKey(held) === representationKey(read)
      ? null
      : (arrayRecast ?? classUnion ?? structural ?? (held ? alignedValueText(ctx, 'emit-bindings.ts:332', held, read, cellText) : null))
  if (held && narrowed === null && representationKey(held) !== representationKey(read)) {
    throw createCppEmitBlockedError(
      `conversion:${representationKey(held)}->${representationKey(read)}`,
      `reads ${operation.declaration} as "${representationKey(read)}" from a cell holding ` +
        `"${representationKey(held)}"; a narrowed read needs the conversion the narrowing proves, which is not installed`
    )
  }
  // A HOST OBJECT is read by naming its cell, never by copying out of it.
  //
  // `native-handle` is the carrier for a value whose type belongs to the host,
  // and in the source language such a value is an OBJECT: `const ctx =
  // Display.ctx` binds a reference, so `ctx.fillStyle = c` and the
  // `ctx.fillText(...)` on the next line act on one object. Copying the cell
  // into a fresh temporary per read makes each of those a separate C++ value,
  // and a host type that carries state behind its handle then loses it between
  // statements: `gea::embedded::ui::CanvasRenderingContext2D` holds
  // `batchDepth_`, `presentRecording_`, `batchDirty_`, `fillStyle_`,
  // `fontSizePx_` and the present-command buffer, all of which
  // `gea_ir::canvas*` mutates through a `CanvasRenderingContext2D &`. Copied,
  // `beginBatch()` opened a batch on one temporary and `endBatch()` closed a
  // depth-0 one on another, so nothing was ever presented and the app's
  // fillStyle never reached its fillText -- a blank screen with no diagnostic
  // anywhere, because every individual call compiled and ran.
  //
  // Sound only while the cell holds the same object at every use of this read,
  // which is why a body that writes the cell more than once keeps the copy: a
  // reassigned `let` would make the alias name whatever the cell holds LATER,
  // and the copy's staleness is the lesser of the two wrong answers. Reads
  // needing a narrowed load keep the copy too -- that load is a conversion, and
  // a converted value is a new value, not the cell.
  if (read.kind === 'native-handle' && narrowed === null && (ctx.bindingWriteCounts.get(operation.declaration) ?? 0) <= 1) {
    defineValueAlias(ctx, operation.result, cellText)
    return
  }
  // The same argument, for the same reason, on every OTHER carrier a copy
  // costs something real to make.
  //
  // A `std::shared_ptr` copy is an atomic increment and a matching decrement,
  // and a `std::string` copy is a heap allocation; neither is a copy the C++
  // compiler is allowed to elide, because both are observable -- through the
  // refcount and through the allocator. A `const` array indexed in a loop was
  // paying one atomic pair per iteration purely to name the array its own cell
  // was already holding, and every read of a captured string paid an
  // allocation to hand the same characters to the next operation.
  //
  // Sound under exactly the conditions the host-object case needs, and the
  // reasons are not the same in both directions: a cell written more than once
  // would let the alias see a LATER value than the read did, and a BOXED cell
  // is shared by aliasing with some closure that this body's own write count
  // cannot speak for. A scalar keeps the copy, because `double v = b;` costs
  // nothing after register allocation and the temporary reads better.
  const copyIsMachineWork = read.kind !== 'scalar' && read.kind !== 'null'
  // A per-body write count proves stability only for that frame's own local.
  // Module cells and enclosing-frame cells can change in a called function.
  // Otherwise use the deferral census's effect-free window or snapshot now.
  const stableLocal =
    placement?.storage.kind === 'local' &&
    placement.storage.owner === ctx.owner &&
    (ctx.bindingWriteCounts.get(operation.declaration) ?? 0) <= 1
  // A class cell `buildRepeatedConstructorIndex` admitted is written exactly
  // once in the WHOLE unit, by the class evaluation, so no call between this
  // read and its use can change what the cell holds -- the proof a module
  // cell otherwise lacks. Copying a `ConstructorObject` is two `Ref` pairs
  // (its environment owner and its function identity), and `binary_trees`
  // paid them per node: `build` read the class into a temporary, recursed
  // twice, then constructed through the copy.
  const stableClassCell = ctx.repeatedConstructors.has(operation.declaration)
  if (
    copyIsMachineWork &&
    narrowed === null &&
    !cell.boxed &&
    (stableLocal || stableClassCell || ctx.deferrable.has(operation.result.id))
  ) {
    defineValueAlias(ctx, operation.result, cellText)
    return
  }
  const name = defineValue(ctx, operation.result)
  lines.push(`${name} = ${narrowed ?? cellText};`)
}

/**
 * A cell's own update, written into the cell instead of through a copy of it.
 *
 * `s += 'a'` is `s = s + 'a'` (ECMA-262 13.15.2), and the IR carries it that
 * way: a read of the cell, an addition, a write back. Rendered literally over a
 * `std::string` that is three operations of which two are copies of the whole
 * string, so a loop that appends one character to a growing string does
 * quadratic work -- 100,000 appends copied five gigabytes. `std::string`'s own
 * `operator+=` appends in place, amortized constant, and the two forms differ
 * in nothing else: `s = s + x` and `s += x` are the same characters in the same
 * order, self-append (`s += s`) included, which the standard requires
 * `basic_string::append` to handle.
 *
 * The written value must be a string addition whose first operand is a read of
 * this cell, and the addition itself must be withheld. A withheld old-value
 * read appends directly. A materialized old-value read is admitted only when
 * ownership liveness proves its SSA snapshot dies here; that snapshot grows
 * and moves back into the cell. `string` only: on a `double` the two forms
 * compile to the same instruction, and on any other carrier `+` is not an
 * append.
 */
const compoundAppendLines = (ctx: EmitContext, operation: BindingWriteOperation, target: string): readonly string[] | null => {
  if (ctx.placements.get(operation.declaration)?.representation?.kind !== 'string') return null
  const addition = ctx.computeOrigins.get(operation.value.value)
  if (!addition || addition.form !== 'binary' || addition.operator !== '+') return null
  if (addition.result.representation.kind !== 'string' || addition.operands.length < 2) return null
  const [left, ...suffix] = addition.operands
  if (!left || left.representation.kind !== 'string' || suffix.some((operand) => operand.representation.kind !== 'string')) return null
  if (ctx.bindingReadDeclarations.get(left.value) !== operation.declaration) return null
  if (!ctx.deferredTexts.has(addition.result.id)) return null
  // Two spellings of "the old value is the cell itself, not a copy of it": a
  // withheld read renders as the cell's expression, and an ALIASED read
  // (`emitBindingRead`'s `defineValueAlias`, taken when the read is
  // deferrable and copying the string would be machine work) renders as the
  // cell's own name. Both read the cell in place and neither made a snapshot,
  // so both append in place. The alias form is the one `s += 'a'` in a loop
  // takes; when only the withheld form was recognised here the loop fell to
  // `s = concatStrings({s, 'a'})` -- the quadratic copy this function exists
  // to remove, 0.2 ms to 82 ms on `string_concat`.
  if (ctx.deferredTexts.has(left.value) || ctx.valueNames.get(left.value) === target) return [stringAppendStatement(ctx, target, suffix)]
  // A call between the read and write forces the old value into a snapshot.
  // Grow a final-use snapshot and move it home, preserving the observable
  // pre-call read without copying the whole prefix again in concatStrings.
  if (!ctx.ownedValues.has(left.value) || !ctx.ownedDyingValues.has(left.value)) return null
  const snapshot = operandText(ctx, left)
  return [stringAppendStatement(ctx, snapshot, suffix), `${target} = std::move(${snapshot});`]
}

export const emitBindingWrite = (ctx: EmitContext, lines: string[], operation: BindingWriteOperation): void => {
  const placement = ctx.placements.get(operation.declaration)
  // A namespace cell has nothing to store into, and its initializer is the
  // namespace itself -- the framework's own re-export of a host global
  // (`placeNamespaceAliases`). The write is the alias, and the alias is
  // already the path, so it renders nothing. A write of anything ELSE into
  // that name falls through to `bindingReference`, which refuses it by name.
  if (placement?.storage.kind === 'host-namespace' && ctx.hostNamespaceReads.get(operation.value.value) === placement.storage.linkageName) {
    return
  }
  // The one write that seeded a formal-cell alias renders nothing: the value is
  // already in the storage the cell now names (`EmitContext.formalCells`), and
  // `gea_arg_0 = gea_arg_0` is the copy this exists to remove.
  if (ctx.formalCells.has(operation.declaration)) return
  // The one write that makes a cell a host-method alias stores nothing: the
  // value is a host member with no C++ spelling of its own, and every read of
  // the cell names that member directly (`emitBindingRead`).
  if (ctx.hostMethodAliases.has(operation.declaration)) return
  // The one write of a forwarded cell: its one read spells the value instead
  // (`EmitContext.forwardedBindings`), so there is no cell to declare or fill.
  if (ctx.forwardedBindings.get(operation.declaration)?.value.value === operation.value.value) return
  const cell = bindingReference(ctx, operation.declaration, 'a binding write')
  // The value is already published under this very cell's storage, because the
  // operation that produced it wrote INTO the cell rather than into a
  // temporary (`emit-json.ts`'s `jsonStringifyFillLines`). `b = b` is the copy
  // that would undo it, and `b = std::move(b)` is worse.
  if (ctx.valueNames.get(operation.value.value) === cellValueText(cell)) return
  // The same two authorities the read reconciles: the placement says what the
  // cell holds, the plan says what the value is. `const x: string | number = 3`
  // stores a `double` into a `TaggedUnion`, and that store has to be written
  // out. Assigning the raw text and trusting C++ to sort it out is what
  // produced `TaggedUnion<std::string, double> = double`, which C++ rejects,
  // and which would have been worse had it been accepted: an implicit
  // conversion there picks an arm nobody chose.
  //
  // This asked `widenedStoreText` alone until 2026-09-03, on the reasoning
  // that a read narrows and a write widens. That is true of the direction a
  // cell's DECLARED type travels and false of the direction a VALUE can: a
  // binding initialized from a dynamic carrier -- `const back = boxed as Point`
  // -- is a write whose value must be NARROWED out of a box before the cell can
  // hold it. Those stores fell through to the raw operand text and emitted
  // `double = gea::Value` / `gea::Ref<Point> = gea::Value`, which only clang
  // caught, and only because `gea::Value` happens to declare no conversion
  // operator. `convertedValueText` is a strict superset of the call this
  // replaces -- its own last line is this same `widenedStoreText` -- so the
  // widening cases are untouched and the narrowing ones stop being dropped.
  const held = ctx.placements.get(operation.declaration)?.representation
  const rawText = operandText(ctx, operation.value)
  const conversionInput = held ? owningConversionInputText(ctx, operation.value, held, rawText) : rawText
  const converted = held
    ? (() => {
        try {
          return (
            alignedValueText(ctx, 'emit-bindings.ts:491', operation.value.representation, held, conversionInput) ??
            structuralRecordViewText(ctx, operation.value.representation, held, rawText)
          )
        } catch (error) {
          // A representation-only conversion may reject a record pair before
          // the emitter's layout table gets a chance to prove its structural
          // view. Treat only the named conversion refusal as a failed first
          // candidate; the layout-aware converter remains authoritative for
          // native-record and class-backed records.
          if (!isCppEmitBlockedError(error)) throw error
          return structuralRecordViewText(ctx, operation.value.representation, held, rawText)
        }
      })()
    : null
  // FAIL CLOSED, the same rule `emit-return.ts`'s own ABI-result guard already
  // enforces for a `return`: `convertedValueText` answers `rawText` unchanged
  // whenever the two carriers already agree, so `null` here -- with a `held`
  // carrier actually present -- means no recipe exists for this pair, not that
  // none was needed. Falling through to the bare operand anyway is how a
  // `class-ref` value came to be assigned into a cell placed as an unrelated
  // `record`: certified, preflight-clean, and rejected only by clang with
  // "no viable overloaded '='" pointing at generated code, not at this refusal.
  // A missing conversion is a refusal, not a silently unconverted store.
  // A method read as a value stored into a cell the program declared without
  // a receiver -- `const twice: (n: number) => number = fmt.double`. The
  // receiver travels with the value, recovered from the read itself
  // (`emit-callable.ts`'s `receiverBoundCallableText`); it is asked here
  // rather than inside `convertedValueText` because the answer depends on
  // this emitter's record of which read produced the value, not on the two
  // carriers alone.
  const boundReceiver = held && converted === null ? receiverBoundCallableText(ctx, operation.value, held, rawText) : null
  if (held && converted === null && boundReceiver === null) {
    throw createCppEmitBlockedError(
      `conversion:${representationKey(operation.value.representation)}->${representationKey(held)}`,
      // The KIND alone reads as a contradiction whenever both sides share it --
      // "writes a function-value-dispatch into a cell placed as
      // function-value-dispatch" says a value cannot be stored in a cell that
      // holds exactly what it is. What differs is nested, so the difference
      // walk names the position, which is the fact that says what to fix.
      `writes ${operation.declaration} as a ${shortCarrierText(operation.value.representation)} into a cell placed as ` +
        `${shortCarrierText(held)}, and no conversion is installed between them; ` +
        carrierDifference(operation.value.representation, held)
    )
  }
  // A DYING owning value moves into the cell rather than being copied into it.
  // `movedValueText` declines whenever the cell holds something other than what
  // the value holds, so a converted store below is never wrapped.
  const valueText = movedValueText(ctx, operation.value, held ?? null, converted ?? boundReceiver ?? rawText)
  // A file-scope cell is declared once by the translation unit, so every write
  // to it here is an assignment. Re-declaring it in the body that happens to
  // write it first would shadow the file-scope one and leave every other body
  // reading a cell this one never touched. A boxed OWNED cell can also already
  // be declared before its own first write reaches here: a self-referencing
  // closure's allocation pre-declares an empty box so its environment can
  // capture a handle to it (`emit-callable.ts`'s `ensureBoxedSlotDeclared`),
  // and this initializing write then only has to fill it in.
  if (!cell.owned || ctx.declaredBindings.has(operation.declaration)) {
    const append = compoundAppendLines(ctx, operation, cellValueText(cell))
    if (append === null) lines.push(`${cellValueText(cell)} = ${valueText};`)
    else lines.push(...append)
    // A module symbol may key a struct's declared field; its dispatcher
    // recognizes the symbol by the id registered here (`records.ts`).
    if (held?.kind === 'symbol' && ctx.placements.get(operation.declaration)?.storage.kind === 'region')
      lines.push(`gea::detail::registerDeclaredSymbol(${cppStringLiteral(`sym(${operation.declaration})`)}, ${cellValueText(cell)});`)
    return
  }
  // The cell's own carrier, not the first value written into it: a cell holding
  // a union that is initialized with one arm is still a union, and declaring it
  // as the arm would make every later write of another arm a type error.
  // A narrowed cell is declared as the integer the census chose, not as the
  // double its carrier spells -- the cell IS the storage, so this is where the
  // choice takes effect. A boxed cell keeps its carrier: the box is shared
  // with frames this census never looked at.
  const heldType = ctx.typeQueryBindings.has(operation.declaration)
    ? 'gea::Value::Tag'
    : ctx.integerBindings.has(operation.declaration) && !cell.boxed
      ? cppNarrowedIntegerType
      : cppTypeOf(held ?? operation.value.representation)
  if (cell.boxed) {
    // The box itself, not its pointee, is what gets declared and allocated: a
    // shared cell is born already holding this first value, so every other
    // frame that later copies the handle -- including a nested closure this
    // very allocation is capturing itself into -- sees a fully-initialized
    // cell and never observes the moment before it existed.
    declareCell(ctx, cell.name, cppBoxedType(held ?? operation.value.representation))
    lines.push(`${cell.name} = gea::makeRef<${heldType}>(${valueText});`)
  } else {
    declareCell(ctx, cell.name, heldType)
    lines.push(`${cell.name} = ${valueText};`)
  }
  ctx.declaredBindings.add(operation.declaration)
}

/**
 * Allocates captured cells whose writes only initialize them along separate
 * control-flow paths. No one branch write dominates the later closure
 * allocation, so making the first rendered write allocate the handle makes
 * C++ block order decide whether another branch sees a null `Ref`. The capture
 * index carries the dominance proof; allocate only those cells at function
 * entry and let every source write fill the already-shared pointee.
 */
export const earlyCapturedCellPrologue = (ctx: EmitContext, body: IrBody): readonly string[] => {
  const lines: string[] = []
  for (const blockId of body.blockOrder) {
    const block = body.blocks.get(blockId)
    if (!block) continue
    for (const operation of block.operations) {
      if (operation.kind !== 'binding-write' || !ctx.captures.requiresEarlyBox(operation.declaration)) continue
      if (ctx.declaredBindings.has(operation.declaration)) continue
      const placement = ctx.placements.get(operation.declaration)
      if (placement?.storage.kind !== 'local' || placement.storage.owner !== ctx.owner) continue
      const held = placement.representation
      if (!held || held.kind === 'unresolved' || held.kind === 'void') continue
      const cell = bindingReference(ctx, operation.declaration, 'an early captured cell')
      if (!cell.owned || !cell.boxed) continue
      declareCell(ctx, cell.name, cppBoxedType(held))
      lines.push(`${cell.name} = gea::makeRef<${cppTypeOf(held)}>();`)
      ctx.declaredBindings.add(operation.declaration)
    }
  }
  return lines
}
/**
 * Which of this body's cells are a formal it already holds.
 *
 * A parameter's cell is seeded by one write whose value is the `parameter`
 * operation itself, and where nothing writes it again the cell and the formal
 * are the same value in two storages. Naming the formal removes the second --
 * one `gea::Ref` retain/release, or one `std::string` heap copy, per call.
 *
 * Every condition here is a way the two could be different storages rather
 * than a heuristic. More than one write means a later value the formal would
 * not have. A boxed cell is shared with a closure this body cannot speak for.
 * A cell some other frame owns is not this frame's formal at all. And a
 * narrowed cell is a `long long` where its formal is a `double`, which is the
 * one case where the C++ spellings genuinely disagree -- so they are compared,
 * rather than assumed equal because the representations are.
 */
export const collectFormalCells = (ctx: EmitContext, prepass: EmitBodyPrepassFacts, body: IrBody): void => {
  const formals = new Map<IrValueId, { readonly name: string; readonly type: string }>()
  const seeds = new Map<DeclarationId, IrOperand>()
  for (const block of body.blocks.values()) {
    for (const operation of allOperationsOf(block)) {
      if (operation.kind === 'parameter') {
        const declared = ctx.abi?.parameters[operation.ordinal]
        if (declared) formals.set(operation.result.id, { name: cppFormalName(operation.ordinal), type: cppAbiParameterType(declared) })
        if (ctx.narrowedFormals.has(operation.ordinal)) prepass.narrowedFormalValues.add(operation.result.id)
        continue
      }
      if (operation.kind === 'receiver') {
        const declared = ctx.abi?.receiver
        if (declared) formals.set(operation.result.id, { name: cppReceiverName, type: cppTypeOf(declared) })
        continue
      }
      if (operation.kind === 'binding-write') seeds.set(operation.declaration, operation.value)
    }
  }
  for (const [declaration, value] of seeds) {
    const formal = formals.get(value.value)
    if (formal === undefined) continue
    if ((ctx.bindingWriteCounts.get(declaration) ?? 0) !== 1) continue
    if (ctx.integerBindings.has(declaration) || ctx.captures.isBoxed(declaration)) continue
    const placement = ctx.placements.get(declaration)
    if (!placement || placement.storage.kind !== 'local' || placement.storage.owner !== ctx.owner) continue
    const held = placement.representation
    if (!held || held.kind === 'unresolved' || held.kind === 'void') continue
    if (cppTypeOf(held) !== formal.type || representationKey(held) !== representationKey(value.representation)) continue
    prepass.formalCells.set(declaration, formal.name)
  }
}

/**
 * A call result whose ONLY use is the binding write that immediately follows
 * it, censused before anything renders.
 *
 * `s = JSON.stringify(v)` lowers to a call that mints a fresh `std::string`
 * and a write that copies -- or moves -- that string into `s`'s cell. The
 * string the call built is a heap buffer of the whole document, allocated on
 * every call and freed on the next; a loop that stringifies the same value ten
 * thousand times allocates and frees ten thousand buffers of the same size,
 * when the cell already holds one big enough. Serializing straight INTO the
 * cell reuses its capacity and skips the temporary entirely -- measured on the
 * five stringify fixtures at 5.3% (number array) to 13.7% (records).
 *
 * Only the IMMEDIATELY following write qualifies, and only when the value has
 * no other use: anything between the call and the write could read the cell,
 * and the fill has already emptied it by then. A relocated result is excluded
 * for the same reason -- a loop-invariant call renders in the preheader, which
 * is not in front of the write at all.
 *
 * Who may act on it is `emit-json.ts`'s `jsonStringifyFillLines`; this only
 * says which results are adjacent to their sink.
 */
export const collectDirectBindingSinks = (prepass: EmitBodyPrepassFacts, body: IrBody, relocated: ReadonlySet<IrValueId>): void => {
  const uses = new Map<IrValueId, number>()
  for (const block of body.blocks.values()) {
    for (const operation of allOperationsOf(block)) {
      for (const operand of operandsOfIrOperation(operation)) uses.set(operand.value, (uses.get(operand.value) ?? 0) + 1)
    }
  }
  for (const block of body.blocks.values()) {
    for (const [index, operation] of block.operations.entries()) {
      if (operation.kind !== 'call' || operation.result === null) continue
      if (relocated.has(operation.result.id)) continue
      const next = block.operations[index + 1]
      if (!next || next.kind !== 'binding-write' || next.value.value !== operation.result.id) continue
      if (uses.get(operation.result.id) !== 1) continue
      prepass.directBindingSinks.set(operation.result.id, next.declaration)
    }
  }
}

/**
 * Which SSA values ARE a PROGRAM class object that this program introduces no
 * cell for.
 *
 * A class object becomes a cell through `bind-class-value` and the name
 * binding minted beside it (`normalize/producers/class-lifecycle.ts`), and the
 * census does not walk a generic declaration the program never instantiates
 * (`normalize/census.ts`: "There is no such function in this program, so
 * nothing is recorded for it"). A program can still NAME such a class -- a
 * `ReadableStream` arm the checker types, never constructed, tested for with
 * `body instanceof ReadableStream` -- and that read then names a declaration
 * nothing introduced.
 *
 * Rendering nothing is the whole answer for that read, because every site that
 * can use a program class spells it from the DECLARATION its carrier names
 * rather than from a cell: `new C` goes through the class's construct
 * convention, `C.m` through the static's own home, and `v instanceof C`
 * through the hierarchy census's recipe -- `emit-instanceof.ts`'s
 * `constructor-family` branch never renders this operand at all. Recorded
 * rather than silently skipped so that a genuine VALUE use -- storing the
 * class object, passing it -- refuses by name in `operandText` instead of
 * crashing on a value no operation defined.
 *
 * Settled before anything renders, from two authorities' settled answers: the
 * placement map and the read's own planned carrier.
 */
export const classObjectReadsOf = (
  body: IrBody,
  placements: ReadonlyMap<DeclarationId, BindingPlacement>
): ReadonlyMap<IrValueId, DeclarationId> => {
  const reads = new Map<IrValueId, DeclarationId>()
  for (const block of body.blocks.values()) {
    for (const operation of allOperationsOf(block)) {
      if (operation.kind !== 'binding-read') continue
      if (placements.has(operation.declaration)) continue
      if (operation.result.representation.kind !== 'constructor-family') continue
      reads.set(operation.result.id, operation.declaration)
    }
  }
  return reads
}

/**
 * Which SSA values ARE a host class object or singleton rather than hold one.
 *
 * A host's class object produces no C++ at all: there is no cell to load from,
 * and what the program does with the class -- constructs it, reads its class
 * members -- is spelled whole by the host at the site that does it. A
 * singleton is the same physical answer for the same reason. Both are
 * recorded so a program that instead wants the class as a VALUE refuses by
 * name (`operandText`) rather than naming a variable nothing declares, and so
 * `emit-host-properties.ts` can tell a receiver that renders as text from one
 * that renders as nothing at all.
 *
 * Settled before anything renders (invariant 5: no write during render).
 * Every input is already an authority's answer: the seed is
 * `BindingPlacement.storage`, which projection decided, and the three
 * propagation steps carry that identity onto the SSA views a program makes of
 * it -- a `convert` to a native handle, and a store threading its receiver
 * onward. Nothing here asks a printer anything, which is why it was never a
 * render-time write except by history.
 */
export const hostClassReadsOf = (
  body: IrBody,
  placements: ReadonlyMap<DeclarationId, BindingPlacement>
): ReadonlyMap<IrValueId, { readonly kind: 'class' | 'singleton'; readonly declaration: DeclarationId; readonly linkageName: string }> => {
  const reads = new Map<
    IrValueId,
    { readonly kind: 'class' | 'singleton'; readonly declaration: DeclarationId; readonly linkageName: string }
  >()
  for (const block of body.blocks.values()) {
    for (const operation of allOperationsOf(block)) {
      if (operation.kind === 'binding-read') {
        const storage = placements.get(operation.declaration)?.storage
        if (storage?.kind === 'host-class' || storage?.kind === 'host-singleton') {
          reads.set(operation.result.id, {
            kind: storage.kind === 'host-class' ? 'class' : 'singleton',
            declaration: operation.declaration,
            linkageName: storage.linkageName
          })
        }
      } else if (operation.kind === 'convert') {
        // The identity travels onto the new SSA view so its native member path
        // stays available; only a native handle can carry it.
        const inherited = reads.get(operation.source.value)
        if (inherited !== undefined && operation.result.representation.kind === 'native-handle') reads.set(operation.result.id, inherited)
      } else if (operation.kind === 'set' || operation.kind === 'define-own-property') {
        // A store threads its receiver onward, and a store whose receiver IS
        // the host object is a host property store by construction.
        const inherited = reads.get(operation.receiver.value)
        if (inherited !== undefined && operation.result !== null) reads.set(operation.result.id, inherited)
      }
    }
  }
  // `emit-context.ts`'s `unwrapPresentValue` narrows an optional-carried value
  // to a printer-level view whose id is not an SSA value at all, and that view
  // inherits the identity: if the value IS the host object, so is the value
  // proven present. Stated here rather than minted at the narrowing, which is
  // a render-time act; nothing reads the view unless the narrowing made one.
  for (const [value, read] of [...reads]) reads.set(`${value}:present` as IrValueId, read)
  return reads
}
