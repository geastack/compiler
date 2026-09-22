import type { NativeSelectionHelper } from './native-selection-helpers.js'
import type { StableBorrowEntry } from './borrowed-call-entry.js'
import type { SharedStringLayout } from '../../ir/string-layout-reuse.js'
import type { CapabilityKey } from '../../ir/certify.js'
import type { DeclarationId, FunctionId, IrValueId, RegionId, SemanticResultId } from '../../identity/ids.js'
import { nodeOfOperation, operationOfResult, withoutSpecialization } from '../../identity/ids.js'
import type { BindingPlacement } from '../../projection/bindings.js'
import type { ClassLayout } from '../../projection/classes.js'
import { recordLayoutPolicyOf } from '../../projection/fields.js'
import type { RecordLayoutPolicy } from '../../representation/policies.js'
import type {
  CallOperation,
  ComputeOperation,
  GetOperation,
  IrBlockId,
  IrBody,
  IrNonTerminatorOperation,
  IrOperand,
  IrResult
} from '../../ir/model.js'
import type { NumericIntrinsic } from '../../ir/numeric-intrinsics.js'
import type { DenseAccess, DenseArray, DenseGroup } from '../../ir/dense-loops.js'
import type { TypeQueryComparison } from '../../ir/type-query-results.js'
import type { ForwardedBinding } from '../../ir/deferral.js'
import { noInstantiationFacts, type InstantiationFacts } from '../../ir/instantiation.js'
import { observesEveryCallableIdentity, type CallableIdentityDemand } from '../../ir/callable-identity-demand.js'
import type { HostCallSpelling, HostSpellings } from './host/host-members.js'
import { hostCallName, hostMemberOf, statedHostIntrinsicLength } from './host/host-members.js'
import type { CallableAbi, RecordField, Representation } from '../../representation/model.js'
import { representationKey } from '../../representation/model.js'
import type { RepresentationDeriver } from '../../representation/derive.js'
import {
  cppBodyName,
  cppConstructName,
  cppNarrowedIntegerType,
  cppStringLiteral,
  cppStringViewLiteral,
  cppTypeOf,
  cppUndefinedIn
} from './types.js'
import {
  hostBuiltinFunctionIdentityText,
  hostClassValueText,
  hostFunctionValueText,
  hostJsonMemberValueText,
  hostMemberValueText
} from './host/emit-host-value.js'
import type { HostMethodAlias } from './host/host-method-aliases.js'
import type { PrinterDrift } from './emit-narrowing.js'
import { createConversionNodes, type ConversionCensus } from '../../conversion/nodes.js'
import { createCppConversionRegistry } from './conversions.js'

/**
 * The per-body naming state every emitter helper reads, and the refusal shape
 * they all raise.
 *
 * Split out of `emit.ts` so the property spine can live in its own file without
 * either half owning the context the other needs. Nothing here decides what a
 * construct means; it is the bookkeeping an emitter needs to name what it has
 * already decided.
 */

/**
 * Lowered IR bodies to C++ statement text, carried across the sealed
 * emission boundary in `document.ts`.
 *
 * Every SSA value, binding cell, and block gets its name from exactly one
 * counter and one map, walked in `body.blockOrder` order, so two calls over
 * the same body produce byte-identical text. An operation kind this file does
 * not lower throws rather than approximating -- a refused block is a stated
 * gap; a wrong one that happens to compile is a miscompile with no signal.
 */

/**
 * `src/targets/` forbids `class` (`scripts/architecture.mjs`), so this is a
 * branded shape plus a factory and predicate instead of an `Error` subclass --
 * the same shape `ir/lower-graph.ts`'s `IrLoweringBlockedError` plays for the
 * IR layer, adapted to a plain object because this layer may not use a class
 * to carry it.
 */
export interface CppEmitBlockedError extends Error {
  readonly cppEmitBlocked: true
  /**
   * The capability this refusal lacked, in `ir/certify.ts`'s one key
   * namespace. Typed by that union rather than `string` so a renderer cannot
   * refuse with a kind the certifier could never have demanded: a print-stage
   * refusal of a certified program is then always attributable to a demand
   * the certifier failed to raise (the certifier has already passed).
   */
  readonly kind: CapabilityKey
}

export const createCppEmitBlockedError = (kind: CapabilityKey, reason: string): CppEmitBlockedError =>
  Object.assign(new Error(`cpp emission refuses to lower "${kind}": ${reason}`), { cppEmitBlocked: true as const, kind })

export const isCppEmitBlockedError = (error: unknown): error is CppEmitBlockedError =>
  error instanceof Error && (error as { readonly cppEmitBlocked?: unknown }).cppEmitBlocked === true

/**
 * The standard `Symbol.<name>` identity encoded by a `sym(declaration)`
 * property key, read straight off the key TEXT.
 *
 * A record field's key arrives as text and never as an operand
 * (`derive.ts`'s `recordFieldKeyOf` mints it), so a reader that only has a
 * layout cannot go through `wellKnownSymbolMemberOf` below. Both spellings of
 * the question resolve against the one census the frontend published
 * (`host-protocols.ts`'s `wellKnownSymbolDeclarationsOf`), which is what keeps
 * "which declaration is `Symbol.match`" a single answer.
 */
export const wellKnownSymbolMemberOfKey = (wellKnownSymbols: ReadonlyMap<DeclarationId, string>, key: string): string | null => {
  for (const [declaration, member] of wellKnownSymbols) {
    if (key === `sym(${declaration})`) return member
  }
  return null
}

/** The standard `Symbol.<name>` identity encoded by a static `sym(declaration)` property key. */
export const wellKnownSymbolMemberOf = (ctx: EmitContext, operand: IrOperand): string | null => {
  const key = ctx.staticKeyTexts.get(operand.value)
  if (key === undefined) return null
  return wellKnownSymbolMemberOfKey(ctx.wellKnownSymbols, key)
}

/**
 * One value a closure carries from the frame that allocated it into the frame
 * that runs it.
 *
 * `declaration` is the cell being transported, exactly as `binding-read` and
 * `binding-write` already name it -- there is no second identity for "the same
 * variable, but captured". `representation` is copied from the plan's own
 * answer for that cell (`BindingPlacement.representation`) rather than
 * re-derived, for the same reason every other emitter reads a carrier instead
 * of guessing one.
 */
export interface CaptureSlot {
  readonly declaration: DeclarationId
  readonly representation: Representation
  /**
   * `true` when this slot's cell is shared by aliasing rather than by copying:
   * the environment field holds a `std::shared_ptr` to a heap cell every
   * frame that captures this declaration -- including the frame that owns
   * it -- reads and writes through, instead of each frame's own independent
   * copy of the value. `ir/captures.ts`'s `computeCaptureFacts` decides this
   * once, whole-program, for exactly the cases an ordinary by-value copy
   * gets wrong: a declaration reassigned somewhere after it is captured (a
   * stale copy would stop seeing later writes), a declaration that holds the
   * very closure capturing it (the copy would be taken before the cell is
   * ever written), and a declaration captured before any owning write of it
   * dominates the allocation. Published onto `IrBody.facts.boxed`, keyed by
   * the OWNING body, and read back here by `captures.ts`'s `buildCaptureIndex`
   * as one whole-program set. Every other capture stays a plain value copy,
   * unchanged.
   */
  readonly boxed: boolean
}

/**
 * What one capturing function's environment is made of.
 *
 * `receiver` is kept apart from `slots` because it has no `DeclarationId` --
 * `this` inside an arrow is not a binding cell, it is the enclosing method's
 * own receiver read across the same frame boundary -- so it needs its own
 * field rather than a synthesized declaration identity standing in for one.
 */
export interface CaptureLayout {
  readonly slots: readonly CaptureSlot[]
  readonly receiver: Representation | null
}

/**
 * Whether one capturing function's environment can be built at all.
 *
 * `refused` is not `none`: `none` is an ordinary function that closes over
 * nothing, ok, `refused` is one that closes over something this backend has
 * proof it cannot transport safely (an ownership it does not admit, or a cell
 * it cannot prove is never written after the closure captures it) -- naming
 * the reason here is what lets `emitAllocateCallable`/`emitAllocateConstructor`
 * and `bindingReference` raise the *same* refusal instead of each guessing at
 * why the other one gave up.
 *
 * @semanticCategory generic-primitive
 */
export type CaptureAdmission =
  | { readonly kind: 'none' }
  | { readonly kind: 'ok'; readonly layout: CaptureLayout }
  | { readonly kind: 'refused'; readonly reason: string }

/** Every capturing function's environment, computed once for the whole program by `translation-unit.ts`. */
export interface CaptureIndex {
  readonly of: (owner: FunctionId | RegionId) => CaptureAdmission
  /**
   * Whether this declaration's cell is boxed -- the same whole-program fact
   * `CaptureSlot.boxed` states for one capturing function's own slot, asked
   * here for the frame that OWNS the cell instead. A local's own frame never
   * consults `CaptureAdmission` for its own declarations (only a capturing
   * frame does), so `bindingReference`'s owned-local branch needs this
   * independent, declaration-keyed answer to know its plain `T b0;` must be a
   * `std::shared_ptr<T>` instead -- the same box every capturing frame's
   * environment field aliases.
   */
  readonly isBoxed: (declaration: DeclarationId) => boolean
  /**
   * Whether any closure in the program captures this declaration, boxed or by
   * value. A by-value capture copies the cell when the closure is allocated,
   * which is a read of the cell no `binding-read` operation in the owning body
   * records -- the one fact that makes the owning body's own read count an
   * incomplete answer to "who reads this cell" (`EmitContext.forwardedBindings`).
   */
  readonly isCaptured: (declaration: DeclarationId) => boolean
  /**
   * Whether the owning frame must allocate this boxed cell before its first
   * rendered block. These are captured locals for which no individual write
   * dominates the closure allocation: allocating at whichever branch happens
   * to render first leaves the other branch dereferencing an empty handle.
   */
  readonly requiresEarlyBox: (declaration: DeclarationId) => boolean
  /**
   * Whether this body reads `this` -- in its own operations, or in a closure
   * it allocates that has no receiver of its own and so reads this one.
   *
   * Read off `IrBodyFacts.readsReceiver`, closed over the allocation graph
   * the same way captures themselves are (`ir/captures.ts`'s
   * `computeCaptureFacts`). The one caller is `emit-callable.ts`, deciding
   * whether a method read as a VALUE can be passed on: the language calls a
   * detached method with no receiver, so a body that reads `this` must not be
   * bound to the object it was read from.
   */
  readonly readsReceiver: (owner: FunctionId | RegionId) => boolean
}

/** The index a body with no capture information at all reads as: every owner closes over nothing. */
export const emptyCaptureIndex: CaptureIndex = {
  of: () => ({ kind: 'none' }),
  isBoxed: () => false,
  isCaptured: () => false,
  requiresEarlyBox: () => false,
  readsReceiver: () => false
}

/**
 * Per-body naming state.
 *
 * Three independent counters, not one shared counter split by prefix: a
 * value, a binding cell, and a block are different namespaces in the target
 * language (a local variable, a mutable slot, and a `goto` label never
 * collide by construction), so giving them one counter would only make an
 * accidental collision look like a naming bug instead of the impossible thing
 * it actually is.
 */
/**
 * Where an array's reserved capacity is read from at the allocation site.
 *
 * Two spellings because a loop bound arrives two ways. A plain SSA value is
 * named by `operandText`. A value read out of a binding cell is NOT: the read
 * the loop test uses happens inside the loop, and naming that SSA value at the
 * allocation would name a variable the emitter has not defined yet. What is
 * available there is the CELL, whose contents the census already proved the
 * loop cannot change.
 */
/**
 * One host member reached but not rendered: which member, on which receiver.
 *
 * The receiver is the OPERAND, not its spelling. A record that held
 * `operandText(ctx, receiver)` was a rendered string, and a rendered string is
 * not a fact -- it could only be produced while a body was being printed, which
 * is what kept this whole channel a render-time write (docs/SINGLE-CENSUS-
 * REFACTOR.md 2.3, invariant 5). Naming the operand instead says the same thing
 * in the IR's own terms, and the consumer -- which is always the call that
 * fills the host's template -- spells it there through
 * `hostMemberReceiverText`.
 *
 * `null` is not "no receiver operand": it is a receiver that has no spelling at
 * all, because it is a host CLASS object (`ctx.hostClassReads`) or a host
 * namespace path. A template naming `{receiver}` for one of those is refused by
 * `fillHostTemplate`, which is the fail-closed answer for a row written for the
 * wrong position.
 */
/**
 * The receiver of a deferred `String`/`Array`/`Date`/... prototype method read.
 *
 * The same split `HostMemberRead` makes, for the same reason: what the access
 * knows is WHICH value the method was reached on, and that is an operand. The
 * spelling is produced by `prototypeMethodReceiverText` at the call that fuses
 * with it.
 *
 * `match-elements` is the one receiver that is not the operand's own text: a
 * `RegExp` match result is reached through `gea::runtime::regex::matchElements`,
 * a view over the receiver rather than the receiver. It travels as its own kind
 * instead of as a pre-rendered string so the record stays a fact -- the view is
 * named here, and built where every other receiver is built.
 *
 * `none` is a receiver with no spelling at all: a host intrinsic's own
 * reflection method (`Math.hasOwnProperty`), whose renderer names the intrinsic
 * outright and asks nothing of the value.
 */
export type PrototypeMethodReceiver =
  | { readonly kind: 'operand'; readonly operand: IrOperand }
  | { readonly kind: 'match-elements'; readonly operand: IrOperand }
  | { readonly kind: 'none' }

/**
 * The companion revision cell a value's origin ticks, as a FACT rather than as
 * an lvalue.
 *
 * The same three fields `reactiveFieldReads` carries, and for the same reason:
 * the owning object is an OPERAND, and its C++ name does not exist until the
 * operation that defines it renders. Spelling this at the read would make the
 * fact depend on emission order; `reactiveRevisionText` spells it at each of
 * the two stores that tick it.
 */
export interface ReactiveRevisionOrigin {
  readonly struct: string
  readonly key: string
  readonly receiver: IrOperand
}

/**
 * A method call that goes through the object rather than to a named body:
 * the C++ member the family dispatches through, and the ABI that member was
 * declared with. See `EmitContext.virtualCallees`.
 *
 * Named rather than left inline because the field is now a `ReadonlyMap`, and
 * the walk that fills it (`virtual-methods.ts`) has to spell the same value
 * type to hand it over -- an inline object literal repeated in two files is a
 * shape stated twice, which is the thing this refactor keeps removing.
 */
export interface VirtualCallee {
  readonly member: string
  readonly abi: CallableAbi
}

/**
 * One arm of a deferred tagged-union method read: which body answers, and
 * where in the union that arm lives.
 *
 * `path` is the sequence of arm indices to descend, not a rendered receiver.
 * The union's own receiver is an operand on the read, and the call spells
 * `armAt`/`armIs` down the path from it -- because a name minted for that
 * receiver does not exist until its defining operation renders, which is
 * after this fact is settled.
 */
export interface UnionMethodArm {
  readonly path: readonly number[]
  readonly receiverRepresentation: Representation
  readonly callable: FunctionId
}

/** A method read through a tagged union, by the union it was read through and the arms that answer it. */
export interface UnionMethodRead {
  readonly receiver: IrOperand
  readonly arms: readonly UnionMethodArm[]
}

/**
 * What `typeof <union>.<member>` answers, one entry per arm, in arm order.
 *
 * The answers are ECMA-262's own `typeof` strings; the receiver is the union
 * operand the discriminant is read off, which is the only value this read
 * still needs. See `EmitContext.unionMemberTypeofReads` for when it is
 * claimed.
 */
export type UnionMemberTypeofAnswer =
  /** The arm's own carrier settles it: a declared field, a class method, a prototype member, or absence. */
  | { readonly kind: 'constant'; readonly answer: string }
  /**
   * A class arm that declares no such member. The INHERITED half is closed by
   * the layouts, but an own property put there at run time is not, and the
   * expando table is where one would be -- so the arm reads it and asks the
   * boxed value its own tag, which is exact without a census proof that this
   * read (publishing no value at all) could not have carried.
   */
  | { readonly kind: 'expando' }

export interface UnionMemberTypeofRead {
  readonly receiver: IrOperand
  readonly member: string
  readonly answers: readonly UnionMemberTypeofAnswer[]
}

/**
 * One deferred prototype-method read: which method, on which receiver, with
 * whatever its family needs at the call.
 *
 * Named rather than inline because it is what a claim function returns --
 * each carrier family states its own claim beside its own method table
 * (`deferredStringMethodClaim` and friends), and the walk that settles
 * `EmitContext.prototypeMethodReads` composes those. One implementation of
 * each test, two callers: the walk that records it and the renderer that
 * spells it.
 */
export interface PrototypeMethodRead {
  readonly receiverKind:
    | 'string'
    | 'number'
    | 'bigint'
    | 'array-object'
    | 'promise'
    | 'keyed-collection'
    | 'date'
    | 'regexp'
    | 'native-error'
    | 'union-to-string'
    | 'typed-array'
    | 'typed-array-union'
    | 'mixed-union'
    | 'array-buffer'
    | 'data-view'
    | 'dictionary'
    | 'iterator'
    | 'object-shape'
    | 'native-handle-shape'
    | 'callable-shape'
    | 'dynamic-object'
  readonly member: string
  readonly receiver: PrototypeMethodReceiver
  readonly receiverElement: string | null
  /**
   * Which of the four keyed collections this receiver is, for a
   * `'keyed-collection'` read and never for any other.
   *
   * The kind alone is not enough here the way it is for the four receiver
   * families above: `Map`, `Set`, `WeakMap` and `WeakSet` share one
   * carrier kind and spell their methods differently (`gea::mapSet` vs.
   * `gea::setAdd`, and the weak pair has neither `clear` nor `size`), so
   * the family has to travel with the read rather than be re-derived at
   * the call from a receiver the call no longer has.
   */
  /**
   * The union this call dispatches over, and what each of its arms answers,
   * for a `'mixed-union'` read and never for any other.
   *
   * Unlike `typedArrayUnionCarrier` -- whose arms differ in what they store
   * and never in what the method MEANS -- these arms disagree outright:
   * `string | string[]` answers `join` on one arm with `Array.prototype.join`
   * and on the other with nothing at all. So each arm carries its OWN recorded
   * read, rendered through the same ladder a lone receiver of that carrier
   * would take, and an arm that provably has no callable member of this name
   * is `null`: at a CALL that is the TypeError the language itself throws one
   * step later, so the arm renders it rather than refusing every other arm on
   * account of one the program says cannot occur.
   */
  readonly mixedUnionCarrier?: Extract<Representation, { kind: 'tagged-union' }>
  readonly mixedUnionArms?: readonly (PrototypeMethodRead | null)[]
  readonly collectionFamily?: 'map' | 'set' | 'weak-map' | 'weak-set'
  /**
   * The receiver's own key and value carriers, for a `'keyed-collection'`
   * read and never for any other.
   *
   * `receiverElement` above is a `representationKey` STRING, which is
   * enough to re-check an Array element against but not enough to convert
   * an argument into: `Map<string, any>` stores `gea::Value`, so
   * `map.set('a', 1)` has to box its `double` at the call, and building
   * that text needs the carrier itself rather than its key. The whole
   * `keyed-collection` arm travels rather than the two halves, so the
   * family and the two carriers can never be recorded out of step.
   */
  readonly collectionCarrier?: Extract<Representation, { kind: 'keyed-collection' }>
  /**
   * The receiver's own array carrier, for an `'array-object'` read and
   * never for any other.
   *
   * `receiverElement` above is enough to RE-CHECK a rest pack's element
   * against, which is all `push`/`unshift` ever needed. The rest of
   * `Array.prototype` asks harder questions of the same element: `join`
   * and the comparator-less `sort` ask whether this runtime states a
   * ToString for it, `concat` asks whether the packed rest's element is
   * that carrier or an array OF it, and `find`/`at`/`pop`/`shift` compare
   * it against the call's own optional result payload. None of those can
   * be answered from a key string, and the call no longer has the
   * receiver -- so the carrier travels with the read, exactly as
   * `collectionCarrier` does above.
   */
  readonly arrayCarrier?: Extract<Representation, { kind: 'array-object' }>
  /**
   * The receiver's own promise carrier, for a `'promise'` read and never
   * for any other.
   *
   * `catch` is the member that needs it, for the same reason
   * `arrayCarrier` above exists: its result promise has to be constructed
   * from the RECEIVER's fulfillment value on the path where the receiver
   * was not rejected, and `Promise<T>` into `Promise<T | TResult>` is a
   * conversion whose source carrier the call no longer has.
   */
  readonly promiseCarrier?: Extract<Representation, { kind: 'promise' }>
  /**
   * The receiver's own cursor carrier, for an `'iterator'` read and never
   * for any other: `next()`'s rendering reconciles the element the cursor
   * yields against the `value` field of the result record the checker
   * typed the call with, and the call no longer has the receiver.
   */
  readonly iteratorCarrier?: Extract<Representation, { kind: 'iterator' }>
  /** The typed-array-only tagged union deferred with a shared prototype method. */
  readonly typedArrayUnionCarrier?: Extract<Representation, { kind: 'tagged-union' }>
  /**
   * How to reach the table, and what it is keyed by, for a `'dictionary'`
   * read and never for any other.
   *
   * `Object.prototype.hasOwnProperty` off a `{ [k: string]: V }` receiver
   * is the case: the index signature covers every string key, but the
   * checker still resolves that one name against `Object.prototype`, so
   * the read's published carrier is the method's signature and not `V`.
   * Rendering it as a table read is what emitted
   * `CallableObject<...> = std::string`. The call is `has`, and reaching
   * it needs the receiver's own accessor (`->` for `shared-refcount`, `.`
   * otherwise) plus the key domain to reconcile the argument against --
   * neither of which the call site can re-derive from the CARRIER alone.
   * So `dictionaryTableOf`'s own answer travels with the read, exactly as
   * `collectionCarrier` and `arrayCarrier` do above -- as the accessor
   * TOKEN, not as a rendered `<receiver><accessor>`: the receiver is
   * already named by `receiver` above and spelled by
   * `prototypeMethodReceiverText`, and holding a second, pre-rendered copy
   * of it here is what made this record something only a printing body
   * could build.
   */
  readonly dictionaryTable?: { readonly accessor: string; readonly key: 'string' | 'number' | 'symbol' }
  /**
   * A known-shape receiver's own field list and member accessor (`->`/`.`),
   * for an `'object-shape'` read (`hasOwnProperty`/`propertyIsEnumerable` off
   * a `record`/`native-record-ref`/`class-ref` whose fields the checker
   * already knows) and never for any other.
   *
   * `Object.hasOwn(o, key)` answers the identical question off the same
   * layout (`host/object-protocol.ts`'s `objectViewOf`/`ownKeyPresenceText`),
   * and this is that question asked of the METHOD form instead of the
   * static -- the fields and accessor travel with the read for the same
   * reason `dictionaryTable` above does: the call no longer has the
   * receiver's representation, only its rendered text.
   */
  readonly objectShapeFields?: readonly RecordField[]
  readonly objectShapeAccessor?: string
  /**
   * The protocol name a `'native-handle-shape'` read answers
   * `hasOwnProperty`/`propertyIsEnumerable` from -- `Math.hasOwnProperty`
   * off `hostMemberOf`'s own static member table
   * (`host/object-protocol.ts`'s `nativeHandleShapeCallText` is the call
   * renderer). A `native-handle` carries no runtime value at all, so
   * unlike `objectShapeFields` above there is no receiver text worth
   * keeping either -- the protocol name alone is the whole question.
   */
  readonly intrinsicProtocol?: string
}

export interface HostMemberRead {
  readonly protocol: string
  readonly member: string
  readonly receiver: IrOperand | null
}

export type CapacitySource =
  | { readonly kind: 'value'; readonly operand: IrOperand }
  | { readonly kind: 'binding'; readonly declaration: DeclarationId }
  | { readonly kind: 'literal'; readonly text: string }

/**
 * A counted `push` loop the emitter renders as one bulk append.
 *
 * `array` and `counter` are C++ names rather than operands because the append
 * is emitted at the loop HEADER, where the SSA values the body reads them
 * through are not defined yet -- both are binding cells, which the header can
 * name (`denseCellName`, `emit-arrays.ts`). `literal` is the same problem for
 * the pushed value: a constant is assigned to its own variable INSIDE the loop,
 * so a constant is carried as its own text and any other value has to have been
 * defined before the loop.
 */
export interface FillLoop {
  readonly exit: IrBlockId
  readonly counter: string
  readonly bound: IrOperand
  readonly inclusive: boolean
  readonly array: string
  readonly value: IrOperand
  readonly literal: string | null
  /** The array's own element carrier, which a restated `literal` has to be spelled in. */
  readonly element: Representation
}

/**
 * Every per-body fact `emitBody` settles before it renders a single line,
 * bundled as one argument to `createEmitContext` instead of twelve fields a
 * caller mutates onto the context after building it.
 *
 * The no-write-during-render rule, which moved these facts out of the target:
 * rendering is a READ of settled facts, and a printer that writes one during
 * render is a second authority over it. Before this type existed, these
 * twelve fields were typed exactly like `EmitContext`'s real OUTPUT buffers
 * (`valueNames`, `declarations`, `ownedValues`, minted during the render walk
 * itself) -- `Map`/`Set`, mutable, with nothing in the type distinguishing
 * "settled once, up front" from "grows as printing proceeds". Three of the
 * twelve (`computeOrigins`, `propertyReadOrigins`, `bindingReadDeclarations`)
 * were not even settled up front in practice: `targets/cpp/emit.ts`'s
 * `emitCompute`, `targets/cpp/emit-properties.ts`'s `emitGet` and
 * `targets/cpp/emit-bindings.ts`'s `emitBindingRead` filled them as a side
 * effect of rendering the very operation each answer is keyed by, and
 * `registerDirectCalleeOfDeadValue` kept an independent second copy of the
 * `bindingReadDeclarations` write for a value `deadValuesOf` skips rendering
 * -- one fact, two writers, agreeing only because nobody had asked them to.
 *
 * Every field here is computed by `emitBody` from `body` (and, for
 * `constructorOf`, the `classes` layout it already receives as a plain
 * parameter) BEFORE `createEmitContext` is called at all, so none of it can
 * observe -- or be observed to depend on -- anything a printer has emitted.
 * The remaining ~25 fields this refactor's inventory also classifies as
 * settled-before-render facts (the `ir/facts.ts` `IrBodyCensus` output,
 * `formalCells`/`capacityHints`/`fillLoops`/`directBindingSinks`/the dense-loop
 * admission) are not bundled here: they are already filled by `emitBody`
 * strictly before its render loop runs (verified by inventory -- zero write
 * sites outside that prologue), but moving THEM into this same
 * caller-computes-first shape would also require narrowing the several
 * `ctx: EmitContext`-typed helper functions their policy hooks call
 * (`isPlainMemberRead`, `directClassMethodBody`, `denseCellName`, ...) to a
 * type that does not presuppose a fully-built context -- real, but separable,
 * follow-up work recorded outside this file rather than
 * smuggled into this change.
 */
export interface EmitBodyFacts {
  /** Whether this body is a `function*` -- see `EmitContext.generatorBody`. */
  readonly generatorBody: boolean
  /** See `EmitContext.receiverValues`. */
  readonly receiverValues: ReadonlySet<IrValueId>
  /** See `EmitContext.bindingWriteCounts`. */
  readonly bindingWriteCounts: ReadonlyMap<DeclarationId, number>
  /** See `EmitContext.constructorOf`. */
  readonly constructorOf: { readonly layout: ClassLayout; readonly derived: boolean; readonly callsSuper: boolean } | null
  /** See `EmitContext.ownedDyingValues`. */
  readonly ownedDyingValues: ReadonlySet<IrValueId>
  /** See `EmitContext.consumingFormalConversions`. */
  readonly consumingFormalConversions: ReadonlySet<IrValueId>
  /** See `EmitContext.classTableRoots`. */
  readonly classTableRoots: ReadonlyMap<IrValueId, IrValueId>
  /** See `EmitContext.stableBorrowActuals`. */
  readonly stableBorrowActuals: ReadonlySet<IrValueId>
  /** See `EmitContext.computeOrigins`. */
  readonly computeOrigins: ReadonlyMap<IrValueId, ComputeOperation>
  /** See `EmitContext.propertyReadOrigins`. */
  readonly propertyReadOrigins: ReadonlyMap<IrValueId, GetOperation>
  /** See `EmitContext.bindingReadDeclarations`. */
  readonly bindingReadDeclarations: ReadonlyMap<IrValueId, DeclarationId>
  /** See `EmitContext.conversionSources`. */
  readonly conversionSources: ReadonlyMap<IrValueId, IrOperand>
  /** See `EmitContext.callCallees`. */
  /**
   * Settled before anything renders, from `ir/facts.ts`'s `bodyValueOriginsOf`
   * -- `operation.callee.value` of every call with a result. It used to be
   * written by `emitCall` ahead of its dispatch paths, with a comment saying
   * the answer is the same whichever path renders, which is exactly the
   * argument for it not being a render-time write at all (invariant 5, 2.3).
   * The one behaviour that moved with it: a `Function.prototype.toString`
   * call returns before the old write and so registered nothing, an exclusion
   * with no reason behind it that the byte-identity gate confirmed no program
   * depended on.
   */
  readonly callCallees: ReadonlyMap<IrValueId, IrValueId>
  /** See `EmitContext.calleeOnlyValues`. */
  readonly calleeOnlyValues: ReadonlySet<IrValueId>
  /** See `EmitContext.recordFieldSources`. */
  readonly recordFieldSources: ReadonlyMap<IrValueId, ReadonlyMap<string, IrOperand>>
  /** See `EmitContext.thunkValues`. */
  readonly thunkValues: ReadonlyMap<IrValueId, FunctionId>
  /** See `EmitContext.hostClassReads`. */
  readonly hostClassReads: ReadonlyMap<
    IrValueId,
    { readonly kind: 'class' | 'singleton'; readonly declaration: DeclarationId; readonly linkageName: string }
  >
  /** See `EmitContext.classObjectReads`. */
  readonly classObjectReads: ReadonlyMap<IrValueId, DeclarationId>
  /** See `EmitContext.hostMemberReads`. Settled by `host/emit-host-properties.ts`'s `hostMemberReadsOf`. */
  readonly hostMemberReads: ReadonlyMap<IrValueId, HostMemberRead>
  /** See `EmitContext.valueCellReads`. */
  readonly valueCellReads: ReadonlyMap<IrValueId, ReadonlySet<DeclarationId>>
  /** See `EmitContext.staticKeyTexts`. */
  readonly staticKeyTexts: ReadonlyMap<IrValueId, string>
  /**
   * See `EmitContext.hostNamespaceReads`. Settled by `host-namespace-reads.ts`'s
   * `hostNamespaceReadsOf` alongside its two siblings below -- ONE fixed point,
   * because a `get` off a namespace path is classified against the very maps it
   * also extends, and splitting them would mean re-running the walk.
   */
  readonly hostNamespaceReads: ReadonlyMap<IrValueId, string>
  /** See `EmitContext.hostNamespaceValues`. */
  readonly hostNamespaceValues: ReadonlyMap<IrValueId, string>
  /** See `EmitContext.hostFunctionReads`. */
  readonly hostFunctionReads: ReadonlyMap<IrValueId, HostCallSpelling>
  /**
   * See `EmitContext.functionSourceReads`. Settled by `function-source-reads.
   * ts`'s `functionSourceReadsOf`, which takes only `staticKeyTexts` and
   * `body` -- never `ctx` -- so it moved here alongside its siblings rather
   * than staying a post-construction merge.
   */
  readonly functionSourceReads: ReadonlyMap<IrValueId, string>
  /** See `EmitContext.functionSourceSnapshotNames`, settled by the same walk. */
  readonly functionSourceSnapshotNames: ReadonlyMap<IrValueId, string>
  /**
   * See `EmitContext.directCallees`. Settled by `directCalleesOf`, a walk over
   * every `call` whose `CallOperation.target` is already `direct` -- the
   * dispatch decision itself is `ir/call-dispatch.ts`'s, filled once for the
   * whole program after the shake, so this is a straight projection of it
   * plus `abiOfCallable`, neither of which any printer is asked about.
   */
  readonly directCallees: ReadonlyMap<IrValueId, string>
  /** See `EmitContext.directCalleeAbis`, settled by the same walk. */
  readonly directCalleeAbis: ReadonlyMap<IrValueId, CallableAbi>
}

export interface EmitContext {
  /**
   * The calling convention this body implements, or `null` for an uncalled
   * region.
   *
   * For a body that captures the enclosing method's receiver, this is the
   * *real* semantic ABI with `.receiver` overridden to the captured
   * representation -- never the other way around. Nothing outside this file
   * ever sees the override: a caller of this callable still consults the real,
   * unmodified ABI (`abiOfCallee`, `emitCall`'s own receiver check), so an
   * arrow still takes no receiver argument at its call sites. The override
   * only changes how *this body itself* reads the value once it is inside the
   * frame, exactly as `emitReceiver` already does for an ordinary method's own
   * `this` -- the capture just moves where that value comes from.
   */
  readonly abi: CallableAbi | null
  /**
   * Whether this body is a `function*` (`IrBody.generator`) -- the frame is a
   * C++20 coroutine and every `return` spells `co_return`. Stated by the
   * declaration, never inferred from `abi.result`: an ordinary function that
   * returns a generator's cursor unchanged has the identical result carrier.
   *
   * Settled at construction, from `EmitBodyFacts` -- see that type's own doc
   * for why this and its eleven siblings are no longer filled by mutating the
   * context after building it.
   */
  readonly generatorBody: boolean
  /** The conventions of emitted bodies, shared with their signature renderer. */
  readonly abiOfCallable: (callable: FunctionId) => CallableAbi | null
  /**
   * The `name`/`length`/source text each function object must be able to
   * answer, keyed by the body -- empty when the program never reads any of
   * them (`translation-unit.ts`'s `preserveFunctionFacts` census). Read by
   * `cppThunkEntryText`, at the sites that mint a function object.
   */
  readonly functionFacts: ReadonlyMap<FunctionId, CallableFactsSpelling>
  /** The execution context whose frame this body is, so a cell owned elsewhere is recognisable as one. */
  readonly owner: FunctionId | RegionId
  /** See `emit-narrowing.ts`'s `PrinterDrift`; one program-wide list, shared by every body's context. */
  readonly printerDrift: PrinterDrift[]
  /**
   * The conversion census (`conversion/nodes.ts`): the one answer to "how does
   * this carrier become that one", the same node lowering named on every
   * `convert` it minted. A printer site that still converts on its own
   * (`emit-narrowing.ts`'s `alignedValueText`) asks it first.
   */
  readonly conversions: ConversionCensus
  readonly nativeSelectionHelpers?: ReadonlyMap<string, NativeSelectionHelper>
  /** Where each binding cell lives, projected once for the whole program. */
  readonly placements: ReadonlyMap<DeclarationId, BindingPlacement>
  /** What each class is made of, so a key on a class receiver resolves to storage or to a method. */
  readonly classes: ReadonlyMap<DeclarationId, ClassLayout>
  /** Every capturing function's environment, so a binding owned by another frame can resolve through this owner's own slot instead of refusing outright. */
  readonly captures: CaptureIndex
  /**
   * The one authority on what a structural type physically is, threaded here
   * so `targets/cpp/emit-properties.ts` can ask a receiver's own declared
   * shape what representation one field holds -- the same question
   * `targets/cpp/records.ts`'s `cppRecordDeclarations` asks to build struct
   * bodies, reused rather than re-derived a second, independently-drifting
   * way. See citations.md finding 1.
   */
  readonly deriver: RepresentationDeriver
  /** The record layout policy the conversion registry decides with (`projection/fields.ts`'s `recordLayoutPolicyOf`): the printer renders record views from the same plan. */
  readonly layouts: RecordLayoutPolicy
  readonly valueNames: Map<IrValueId, string>
  readonly ownedValues: Set<IrValueId>
  /** Settled from `EmitBodyFacts.ownedDyingValues` -- see that type's own doc. */
  readonly ownedDyingValues: ReadonlySet<IrValueId>
  /** Settled from `EmitBodyFacts.consumingFormalConversions` -- see that type's own doc. */
  readonly consumingFormalConversions: ReadonlySet<IrValueId>
  /**
   * How many times this body writes each binding cell, censused by `emitBody`
   * before a single operation renders (`EmitBodyFacts.bindingWriteCounts`).
   *
   * Read by `emit-bindings.ts` and by nothing else. A host-object read may name
   * its cell instead of copying out of it (`defineValueAlias`) only where the
   * cell still holds the same object at every use of the read -- which a body
   * that writes the cell more than once cannot promise. Absent a declaration,
   * this body never writes it.
   */
  readonly bindingWriteCounts: ReadonlyMap<DeclarationId, number>
  /**
   * Cells that ARE a formal of this frame, and the formal's own name.
   *
   * `function f(n) { ... }` lowers `n` to a cell seeded by one write from the
   * `parameter` operation, and that cell is then a second copy of a value the
   * frame already holds -- a retain and a release for a `gea::Ref`, a heap copy
   * for a `std::string`, on every call. Where the program never writes the cell
   * again, the two are the same storage and the cell can simply be the formal.
   *
   * Filled by `emitBody` before anything renders, under conditions the write
   * itself cannot check on its own: the cell must be written exactly once, be
   * this frame's own unboxed local, and spell the same C++ type the formal
   * does -- an integer-narrowed cell is `long long` where its formal is
   * `double`, and those are two storages, not one.
   *
   * Not yet `ReadonlyMap`: its one write site is `collectFormalCells`
   * (`emit-bindings.ts`), mutating through `ctx` directly -- see
   * `narrowedFormalValues`'s doc, the sibling field that function also fills.
   */
  readonly formalCells: ReadonlyMap<DeclarationId, string>
  /** Every `constant` operation's own literal text, keyed by the value it defined -- the only legal source for a static property key. */
  readonly constantTexts: Map<IrValueId, string>
  /**
   * The same `constant` texts, settled from the IR before this body renders.
   *
   * NOT a copy of `constantTexts`, which additionally accumulates the folded
   * `typeof` results the render mints as it goes (`emit.ts`'s own `namespace\
   * Typeof` and settled-typeof writes). Those must never widen the set of keys
   * a claim will treat as STATIC: a value the render happens to have folded is
   * not a property name the program wrote, and admitting one would turn a
   * computed key into a static one. So every claim that decides a deferred
   * read asks this map, at both of its two callers -- the prepass walk and the
   * resolver -- and the folding readers keep `constantTexts`.
   */
  readonly staticKeyTexts: ReadonlyMap<IrValueId, string>
  /**
   * Every host member spelling this compilation installed -- the backend's own
   * plus every plugin's, unioned once by `compiler.ts`.
   *
   * Threaded rather than imported. A plugin's host protocols are the plugin's,
   * and a lookup that read this file's own module-level table would answer for
   * half the compilation while preflight had certified against all of it.
   */
  readonly hosts: HostSpellings
  /** Standard unique symbols by the declaration identity encoded in static property keys. */
  readonly wellKnownSymbols: ReadonlyMap<DeclarationId, string>
  /**
   * Host members reached but not yet rendered.
   *
   * A host object's method is not a value any host symbol corresponds to:
   * `el.setAttribute` on its own names nothing in C++, and only
   * `el.setAttribute(a, b)` does. So the access records which member was
   * reached, on which receiver, and the *call* renders the host's template.
   * Nothing else may read this value -- a program that passes a host method
   * around as a first-class function is refused at the call site rather than
   * handed a callable that was never materialised.
   */
  readonly hostMemberReads: ReadonlyMap<IrValueId, HostMemberRead>
  /**
   * Host class objects reached but not rendered, to the name the program wrote.
   *
   * `hostMemberReads`'s own mechanism for a different unrenderable thing: a
   * host's class is not a value, so reading it produces no C++ and only what is
   * done THROUGH it does. Keeping the name is what lets a refusal say which
   * class was used as a value instead of naming an anonymous slot.
   */
  /**
   * Reads of a field this compilation holds in a reactive cell, to what a
   * consumer needs in order to SUBSCRIBE to it.
   *
   * `hostMemberReads`'s mechanism, with one deliberate difference: those maps
   * record a read that produced NO C++ and is rendered whole by its consumer.
   * This one records a read that renders perfectly well and did render -- the
   * cell converts to `const T&`, so `v7 = v5->count;` is the same line it was
   * before the field was celled, and every arithmetic use of it keeps working
   * untouched. What is recorded is only the extra fact that this particular
   * value CAME FROM a cell, so a JSX position that consumes it can register an
   * effect instead of reading it once. Suppressing the read instead would
   * break every non-JSX use of the same field.
   *
   * The DECLARING struct travels with it, not the receiver's own: a
   * pointer-to-member names the struct that declares the member, which for an
   * inherited field is the base. A struct name rather than a declaration id
   * because a reactive struct is not only a class -- the element record of a
   * reactive array is one too, and has no declaration.
   */
  readonly reactiveFieldReads: ReadonlyMap<IrValueId, ReactiveRevisionOrigin>
  /**
   * Every callable this body allocated, to the function whose body it runs.
   *
   * A JSX slot that computes something -- `class={done ? 'a' : 'b'}` -- reaches
   * the emitter as a thunk allocation followed by a call of it (see
   * `plugins/gea/reactive-slots.ts`), and the slot has to name the *thunk* in
   * order to re-run it. Keeping the function identity is what lets it ask
   * `hosts.reactive.dependencies` what that body reads, which is a question
   * about the callee that only its `FunctionId` can answer.
   *
   * Recorded, never consumed as a substitute for the value: the callable is
   * still emitted exactly as before and is still a real `CallableObject`.
   *
   * Settled before anything renders, from `ir/facts.ts`'s `bodyValueOriginsOf`
   * (invariant 5, 2.3). The two write sites this replaces tested one and the
   * same condition -- a zero-parameter, receiver-less
   * `function-value-dispatch` result -- and differed only in WHEN they ran,
   * which is the order dependence itself: the dead-value path needed its own
   * write because skipping a producer's render skipped its registration, and
   * a reactive JSX slot that looked the thunk up first found nothing.
   */
  readonly thunkValues: ReadonlyMap<IrValueId, FunctionId>
  /**
   * Callable values that need no environment, to the C++ function their call
   * runs directly.
   *
   * A `CallableObject` is a function pointer and a `void*`, and `call` invokes
   * through the pointer. That indirection is the whole point for a callable
   * whose identity is a runtime fact -- a callback held in a variable, a
   * method passed as a value -- and it is pure loss for `c.tick(i)`, where the
   * body is decided at the call site and the environment is `nullptr`: the
   * call could not be inlined, the arguments crossed a second frame, and a
   * method whose C++ was three instructions was reached through two.
   *
   * Recorded only where the environment really is `nullptr`. A closure carries
   * state its body reads out of that pointer, so its call has to go through the
   * carrier no matter how visible the body is.
   *
   * Settled from `EmitBodyFacts.directCallees` (`directCalleesOf`, invariant 5,
   * 2.3). The write used to be `registerDirectCallee`, called from the same
   * direct-dispatch walk that now runs before `createEmitContext` instead of
   * after it -- the walk only ever asked `CallOperation.target` and
   * `abiOfCallable`, neither of which needs a built context.
   */
  readonly directCallees: ReadonlyMap<IrValueId, string>
  /**
   * The body convention behind the corresponding direct spelling. Its result
   * can be physically broader than the covariant method value published at
   * the read. Settled from `EmitBodyFacts.directCalleeAbis` alongside
   * `directCallees` -- see that field's doc.
   */
  readonly directCalleeAbis: ReadonlyMap<IrValueId, CallableAbi>
  /**
   * The RECEIVER a direct callee needs, for a method value whose own carrier
   * declares none.
   *
   * A class's method body takes the instance as its leading formal, and
   * `boundMethodValueRepresentation` (`class-properties/emit-class-properties.
   * ts`) puts that back into the carrier of a materialized method value. The
   * CALL, though, reads the plan's carrier -- and a member reached through a
   * slot the program declared with an INTERFACE type carries the interface's
   * own method signature, which states no receiver. The call then renders as a
   * property read plus a receiver-less invocation (the semantic graph is
   * right: an interface member IS storage), and the direct bind named a body
   * one formal wider than the arguments it was given.
   *
   * hono's `this.router.add(method, path, ...)` is that shape once
   * `InterfaceImplementorPolicy` resolves `Router` to `PatternRouter`: the
   * slot holds the class, the member read finds a real method, and the call
   * still declares no receiver. Recorded here so the direct call can pass the
   * one the read already had, rather than binding it into an environment --
   * which would heap-allocate per call on a request path. The map also retains
   * the receiver for an immediate class-method call whose materialized
   * callable already publishes a receiver-bearing convention but is not
   * eligible for body-by-name binding. It is keyed by the property read's SSA
   * result, so a detached method read cannot acquire a receiver from it.
   */
  readonly directCallReceivers: ReadonlyMap<IrValueId, IrOperand>
  /**
   * The DISPATCHED counterpart of `directCallees`: a method the program
   * overrides, by the C++ member its family dispatches through.
   *
   * A direct bind is only right while nothing below the receiver's class
   * redeclares the key (`virtual-methods.ts`). Where something does, the call
   * has to go through the object, so the callee's value is recorded here
   * INSTEAD and `emit-callable.ts` renders `receiver->member(args)`.
   */
  readonly virtualCallees: ReadonlyMap<IrValueId, VirtualCallee>
  /**
   * Which of those a call actually consumed.
   *
   * A dispatched method reference that is STORED rather than called would be
   * carried as an ordinary `CallableObject` over one statically named body --
   * the base's -- which is the defect the dispatch exists to remove. So the
   * body refuses on any entry left unconsumed rather than emitting a carrier
   * that silently picks one implementation.
   */
  readonly virtualCalleesUsed: Set<IrValueId>
  /**
   * A method read through a tagged union whose class arms each resolve to a
   * concrete, nonoverridden body. The read itself has no single callable ABI:
   * each arm keeps its own receiver and covariant result, so the following
   * call dispatches the already-materialized arguments directly by union tag.
   */
  readonly unionMethodReads: ReadonlyMap<IrValueId, UnionMethodRead>
  /** Which deferred union method reads were consumed by a direct call. */
  readonly unionMethodReadsUsed: Set<IrValueId>
  /**
   * A member read off a tagged union whose arms DISAGREE about whether the
   * member exists, and which nothing but `typeof` consumes.
   *
   * `typeof (res as Promise<Response>).then === 'function'` is the shape, and
   * it is the whole of `@hono/node-server`'s `isPromise`. The read has no
   * value to produce -- one arm's member is a `Promise.prototype` method,
   * which is not a function object this backend can materialize, and the other
   * arm has no such member at all -- but the QUESTION the program asks has an
   * exact per-arm answer, which the discriminant already selects between.
   *
   * So the read renders nothing and the `typeof` renders the dispatch. Claimed
   * only where the arms disagree AND at least one of them answers by absence:
   * a union whose arms agree is already a constant, and one whose arms all
   * declare the member renders the member itself.
   */
  readonly unionMemberTypeofReads: ReadonlyMap<IrValueId, UnionMemberTypeofRead>
  /**
   * The general iterator protocol's own `next()` call, cached by the
   * iterator-record value it was called on.
   *
   * ECMA-262 7.4.3 `IteratorNext` is ONE call producing `{value, done}`
   * together; this IR splits that into two operations (`iterator-next` reads
   * `value`, `iterator-done` reads `done` -- `ir/model.ts`'s
   * `IteratorDoneOperation` doc explains why). The native array-cursor path
   * answers that split for free (`gea::Iterator::arrayNext` sets a flag,
   * `.done()` reads it back), but a "record"-carried iterator-record has no
   * such cursor -- its `next` is a real, once-only call through a
   * `gea::CallableObject`. So `emit-iterator.ts`'s `emitIteratorNext` calls it
   * exactly once, stores the `{value, done}` result in a fresh local, and
   * records that local's name and field-access operator here; the paired
   * `emitIteratorDone` reads the SAME local instead of calling `next()` a
   * second time, which would both double the side effect and skip an element.
   */
  readonly protocolNextResults: Map<
    IrValueId,
    {
      readonly tempName: string
      readonly accessor: string
      readonly valueName: string
      readonly valueText: string
      readonly doneText: string
    }
  >
  /**
   * The one `runtime::iterator::step` result shared by a dynamic iterator's
   * value and done reads.  Calling `next()` separately for each would advance
   * the user iterator twice, so the dynamic path has the same cache invariant
   * as the statically-shaped iterator-record path above.
   */
  readonly dynamicIteratorSteps: Map<IrValueId, string>
  /** Whether a dynamic iterator record has observed `done: true`. */
  readonly dynamicIteratorDoneStates: Map<IrValueId, string>
  /**
   * The UTF-16 metadata local captured beside an invariant `charCodeAt`
   * receiver, by the read it belongs to.
   *
   * A naming table, not a fact, which is why it is here rather than a field of
   * `prototypeMethodReads`: what it holds is the NAME of a scratch local this
   * body minted and declared, and the decision to mint one is about a hoisted
   * preheader -- a rendering choice -- rather than about what the read means.
   * Keeping it inside the read's own record was also what made that record
   * re-written mid-body, and it is what the struct's ordinal used to count.
   */
  readonly stringMetadataNames: Map<IrValueId, string>
  /**
   * Every value a `receiver` operation defined.
   *
   * `ir/lower.ts` mints one for exactly two spellings: `this`, which takes the
   * frame's own receiver representation, and `super.x`, which mints a SECOND
   * one at the BASE class's representation because the checker types bare
   * `super` as the base. So a receiver-defined value whose class is not this
   * frame's own receiver class came from `super` and from nothing else -- which
   * is what tells a statically bound super call apart from a dispatched one.
   *
   * Settled from `EmitBodyFacts.receiverValues` -- see that type's own doc.
   */
  readonly receiverValues: ReadonlySet<IrValueId>
  /**
   * The class whose constructor body this is, or `null` for every other body
   * -- and, for a derived one, whether its IR holds a `super-initialize` at
   * all. ECMA-262 10.2.2 step 13: a derived constructor completing normally
   * with `this` still uninitialized throws a ReferenceError, and one returning
   * a non-object, non-undefined value throws a TypeError. Both facts are
   * static here (the base initializer is an explicit operation, the return's
   * carrier is known), so `emit-return.ts` renders the throw instead of
   * silently constructing the instance anyway.
   *
   * Settled from `EmitBodyFacts.constructorOf` -- see that type's own doc.
   */
  readonly constructorOf: { readonly layout: ClassLayout; readonly derived: boolean; readonly callsSuper: boolean } | null
  /** Every `class key` this unit really emitted, with the root virtual member ABI. */
  readonly virtualDispatch: ReadonlyMap<string, CallableAbi>
  /** The unit-wide answer behind `directCallees` for a cell: see `buildDirectCallableIndex`. */
  /** Capture-free bodies with proved borrowed parameters and unchanged non-reference ABI. */
  readonly borrowableMemberBodies: ReadonlySet<FunctionId>
  readonly stableBorrowEntries: ReadonlyMap<string, StableBorrowEntry>
  /** Settled from `EmitBodyFacts.stableBorrowActuals` -- see that type's own doc. */
  readonly stableBorrowActuals: ReadonlySet<IrValueId>
  readonly callableMemberCandidates: ReadonlyMap<string, FunctionId>
  readonly directCallableBindings: ReadonlyMap<DeclarationId, FunctionId>
  /** Constructor cells this unit constructs through repeatedly, and the class each names -- see `buildRepeatedConstructorIndex`. */
  readonly repeatedConstructors: ReadonlyMap<DeclarationId, DeclarationId>
  /** Argument reads whose cell is dead after the call, so the argument moves -- see `buildDyingArgumentIndex`. */
  readonly dyingArguments: ReadonlySet<IrValueId>
  /** Module-level cells that hold one host method forever, so a read of one is that host member -- see `buildHostMethodAliasIndex`. */
  readonly hostMethodAliases: ReadonlyMap<DeclarationId, HostMethodAlias>
  /**
   * Deferred `Function.prototype.toString` reads, keyed by callee result and
   * carrying the complete string-producing expression.
   *
   * Settled from `EmitBodyFacts.functionSourceReads` -- see that field's own
   * doc. Was two writers minting into this map AT THE RENDER SITE off a
   * shared `.size` counter; both moved into `functionSourceReadsOf`'s own walk
   * alongside `functionSourceSnapshotNames`, which is why the two still share
   * one ordinal without sharing a render-time write.
   */
  readonly functionSourceReads: ReadonlyMap<IrValueId, string>
  /**
   * The snapshot variable's name for each entry in `functionSourceReads`.
   *
   * Was `gea_function_source_${ctx.functionSourceReads.size}` and
   * `gea_union_to_string_source_${ctx.functionSourceReads.size}`, minted by two
   * different writers sharing one counter AT THE RENDER SITE. A `.size`-derived
   * ordinal is only stable if the mint order is a property of the IR, and this
   * one was a property of which writer's render path reached a given `get`
   * first. `function-source-reads.ts` mints both maps in one walk of
   * `blockOrder` before anything renders, so the ordinal is the IR's --
   * settled from `EmitBodyFacts.functionSourceSnapshotNames`, computed
   * alongside `functionSourceReads` before `createEmitContext` is called.
   *
   * The renderer still decides WHERE to declare and assign the snapshot, which
   * is a real ordering requirement -- a following call argument may replace the
   * cell the receiver was read from -- it only stops deciding the NAME.
   */
  readonly functionSourceSnapshotNames: ReadonlyMap<IrValueId, string>
  readonly callCallees: ReadonlyMap<IrValueId, IrValueId>
  /** Values read only as a call's callee -- `ir/facts.ts`'s `calleeOnlyValues`. */
  readonly calleeOnlyValues: ReadonlySet<IrValueId>
  /**
   * The operand each `convert` result was converted FROM, so a value's history
   * survives a carrier change.
   *
   * Since lowering owns conversions (Phase 1.4), a thunk call whose result
   * enters a slot in another carrier -- a style member's `double` stored into
   * the struct's `Optional<double>` -- is two SSA values: the call, and a
   * `convert` of it. `recordFieldSources` records the one the store sees,
   * which is the conversion; the call, and with it the thunk the reactive
   * question is about, is one step behind it. This map is that step. Without
   * it every converted style member fell through to the once-only
   * `styleProperty` and a program that used to animate rendered one frame
   * and never moved again (button-tetris on the AMOLED board, 2026-09-06).
   *
   * Settled before anything renders, from `ir/facts.ts`'s `bodyValueOriginsOf`
   * -- the same move `valueCellReads` made, and for the same reason. It used
   * to be written by `emitConvert` as each conversion rendered, so a consumer
   * walking a value's history saw only the conversions emitted SO FAR: the
   * chain `emit-jsx.ts` follows was as long as render order had made it,
   * which is precisely what invariant 5 (2.3) exists to forbid. Nothing about
   * the answer needs a printer -- it is `operation.source` of every `convert`
   * in the body -- so there was never a reason for it to be a render-time
   * write.
   */
  readonly conversionSources: ReadonlyMap<IrValueId, IrOperand>
  /**
   * Every record allocation's members to the values they were initialized FROM.
   *
   * A style object is the reason: `emitElementProp` spells `style={{ ... }}`
   * one `styleProperty` call per member, reading each out of the allocated
   * struct -- and a struct field is storage, not a value with a history, so by
   * then there is no way back to the expression that produced it. A member
   * wired to a thunk (`plugins/gea/reactive-slots.ts` claims style members
   * individually) has to be recognisable as one, and this is the only place
   * that correspondence still exists.
   *
   * Recorded, never substituted: the struct is still allocated and still
   * initialized exactly as before, and a member with no reactive dependency
   * still renders by reading the field.
   */
  /**
   * Settled before anything renders, from `ir/facts.ts`'s `bodyValueOriginsOf`
   * (invariant 5, 2.3). The accumulation an object literal needs -- each
   * `set` carrying the map so far onto its receiver and onto its own result --
   * is a walk in block order there, which is the same order the stores used to
   * render in; and the "is this key a constant" test it gates on is now asked
   * of the `constant` operation the printer's own table was filled from,
   * rather than of the table.
   */
  readonly recordFieldSources: ReadonlyMap<IrValueId, ReadonlyMap<string, IrOperand>>
  /**
   * Values that came OUT of a reactive field whose own carrier cannot be a
   * cell, to the C++ lvalue of that field's companion revision cell.
   *
   * `this.cells` is an array field: writing an element, or a property of an
   * element, changes what a list rendered from it should show, and neither
   * write goes anywhere near the field itself. So the *origin* travels with the
   * value -- through the element read, through the local the program binds it
   * to -- and a store through any of them ticks the revision the list is
   * subscribed to. This is v1's own answer (`cpp-reactive-component.ts` routes
   * `arr[i] = v` through a notifying wrapper, and its hub path marks nested
   * writes dirty), computed from the value graph instead of by rewriting
   * generated text.
   *
   * Deliberately an over-approximation in one direction only: a value whose
   * origin is lost renders a list that does not re-render (the gap that already
   * existed), never one that re-renders against the wrong array. Nothing here
   * changes what a read or a write emits; it only adds the tick beside it.
   */
  readonly reactiveOrigins: ReadonlyMap<IrValueId, ReactiveRevisionOrigin>
  /** The same origin, surviving the binding cell a program stores it in -- `const cell = this.cells[i]`. */
  readonly reactiveBindingOrigins: ReadonlyMap<DeclarationId, ReactiveRevisionOrigin>
  /** Settled before anything renders by `emit-bindings.ts`'s `hostClassReadsOf` (invariant 5, 2.3), whose doc states the seed and the three propagation steps. */
  readonly hostClassReads: ReadonlyMap<
    IrValueId,
    { readonly kind: 'class' | 'singleton'; readonly declaration: DeclarationId; readonly linkageName: string }
  >
  /** Settled before anything renders by `emit-bindings.ts`'s `classObjectReadsOf`, whose doc states why such a read has no cell. */
  readonly classObjectReads: ReadonlyMap<IrValueId, DeclarationId>
  /**
   * Host free functions reached but not rendered, to the C++ function each is.
   *
   * The same mechanism again, for the third unrenderable thing a host owns. A
   * host function's name is C++ only where it is CALLED: there is no object of
   * that name to load, so the read produces nothing and the call renders
   * `gea::apple::AppKit::installRootViewController(vc)` from what is kept here.
   * Keeping the spelling rather than the program's name is deliberate -- a
   * refusal for one used as a value then says which C++ function was meant.
   */
  readonly hostFunctionReads: ReadonlyMap<IrValueId, HostCallSpelling>
  /**
   * Host NAMESPACE paths reached but not rendered, to the program-facing path
   * each value stands for.
   *
   * The fourth unrenderable thing a host owns, and the only one that is not a
   * leaf: `navigator` is a path, `navigator.bluetooth` is a longer path, and
   * only `navigator.bluetooth.keyboard.tap(x)` is C++. So a read records the
   * path, a member access extends it or resolves it against the host's tables,
   * and a use of the namespace ITSELF as a value refuses by name.
   */
  readonly hostNamespaceReads: ReadonlyMap<IrValueId, string>
  /**
   * Values that DO exist and also carry namespace member spellings.
   *
   * `__gea_audioContext` is the case: the host states it as a constant -- a
   * real object the program may hold and pass -- and states its methods under
   * that same name, because they really are members of that one object. So the
   * value renders, and a member reached through it resolves against the same
   * tables a pure namespace uses.
   *
   * Kept apart from `hostNamespaceReads` because the two answer opposite
   * questions about being used as a value: a pure namespace has no rendering
   * and must refuse, and this has one and must not.
   */
  readonly hostNamespaceValues: ReadonlyMap<IrValueId, string>
  /**
   * String/Array.prototype method reads reached but not yet rendered --
   * `hostMemberReads`'s own mechanism, applied to a different receiver family
   * for a different reason (see `emit-prototype-invoke.ts`'s header). Kept as
   * its own map rather than folded into `hostMemberReads` so a
   * `String.prototype`/`Array.prototype` method can never be mistaken for a
   * `gea::host` protocol member: the two mechanisms share a shape, not a
   * table. `receiverElement` is the receiver's own element carrier
   * (`representationKey`-encoded) for an Array read, and `null` for a String
   * read, which has no element type to re-check against.
   */
  /**
   * Results moved to a dominating loop preheader by the IR hoist plan.
   *
   * Settled by `emitBody`'s census strictly before `sealFactFieldsForRender`
   * -- see `EmitBodyPrepassFacts`'s own doc for why this and its sixteen
   * siblings below are handed back through that type rather than through
   * `EmitBodyFacts`: `irBodyCensusOf`'s own hooks need a `ctx` to already
   * exist, so these cannot be computed before `createEmitContext` runs. What
   * still holds is the render-time half of invariant 5: no printer writes
   * this field, ever, and the type now says so.
   */
  readonly hoistedResults: ReadonlySet<IrValueId>
  /** See `hoistedResults`'s doc for why this is settled the same way. */
  readonly sharedStringLayouts: ReadonlyMap<IrValueId, SharedStringLayout>
  readonly prototypeMethodReads: ReadonlyMap<IrValueId, PrototypeMethodRead>
  /**
   * Lazy-arrow-field GETs whose one reader is the call that reads them as its
   * own callee -- see `class-layout.ts`'s `lazyCalleeReadsOf`, which settles
   * this the same way `prototypeMethodReads` above is settled (it needs a
   * built `ctx` -- `abiOfCallable` and `classes` -- so it cannot be computed
   * before `createEmitContext` runs). `emit-properties.ts`'s `emitGet` reads a
   * result in this set as a raw, unmaterialized snapshot copy rather than
   * through `lazyMaterializedFieldText`'s materialize-on-read text, and
   * `emit-callable.ts`'s `emitLazyArrowFieldCall` reads it back as that
   * snapshot rather than re-reading the field's current value.
   */
  readonly lazyCalleeReads: ReadonlySet<IrValueId>
  readonly bindingNames: Map<DeclarationId, string>
  /**
   * Values whose one emitted statement may be rendered at their single use
   * instead of into storage of their own.
   *
   * The IR is three-address form -- one operation, one named temporary -- and
   * for a scalar that costs nothing, because the C++ compiler propagates a
   * `double` copy away entirely. For every other carrier it is a real machine
   * operation the optimizer may not remove: a `std::shared_ptr` copy is an
   * atomic increment and a matching decrement, and a `std::string` copy is a
   * heap allocation. An array read in a loop was paying one atomic pair per
   * iteration purely to name the array it was already holding.
   *
   * `emit.ts`'s `deferrableValuesOf` censuses which values may move, and the
   * rule it enforces is what makes the move sound: the value has exactly one
   * use, that use is in the same block, its own operation is side-effect-free,
   * and every operation between the two is itself deferred. Nothing with an
   * effect can therefore be crossed, so the reads land in a window in which
   * nothing writes -- which is why their relative order inside the use's own
   * expression, which C++ leaves unspecified, cannot be observed.
   */
  /** Results nothing reads, whose operations render nothing -- see `ir/dead-values.ts`. Settled the same way as `hoistedResults`; see that field's doc. */
  readonly deadValues: ReadonlySet<IrValueId>
  /** Effectful producers that must run but whose returned carrier is never read. Settled the same way as `hoistedResults`. */
  readonly unreadValues: ReadonlySet<IrValueId>
  /** Boolean literals by value, so a branch on one renders as the jump it is -- see `emit.ts`'s `emitTerminator`. Settled the same way as `hoistedResults`. */
  readonly booleanConstants: ReadonlyMap<IrValueId, boolean>
  /** SSA cursors used only by their native next/done protocol steps. Settled the same way as `hoistedResults`. */
  readonly localIterators: ReadonlySet<IrValueId>
  /**
   * Values whose one emitted statement may be rendered at their single use
   * instead of into storage of their own.
   *
   * Three writers, all of them in the prepass: `emitBody` seeds it from
   * `ir/deferral.ts` and then drops whatever the hoists and the length reuse
   * claimed, and `emit-arrays.ts`'s `admitDenseWindows` withdraws a value
   * whose array a preheader has to NAME rather than substitute at each use.
   * That last one was recorded here for a long time as a RENDER-time write --
   * it is not, and the belief was never checked against the call graph:
   * `materializeDenseReference` has exactly one caller, and it is the prepass.
   * The mistake is worth leaving on the record because it is the shape a stale
   * comment takes: it named a real function and a real mechanism, and only the
   * word "render-time" was wrong, which is exactly the word nothing checks.
   */
  readonly deferrable: ReadonlySet<IrValueId>
  /** Dominating native length results, selected by the IR reuse proof. Settled the same way as `hoistedResults`. */
  readonly reusedStringLengths: ReadonlyMap<IrValueId, IrOperand>
  /** Withheld values whose single reader is a call, and which therefore reach exactly one operand position -- see `emit.ts`'s `consumedByCall`. Settled the same way as `hoistedResults`. */
  readonly callArgumentOnly: ReadonlySet<IrValueId>
  /**
   * Every value belonging to a class-map table this body MIGHT spell as a token
   * list, mapped to the table it belongs to -- `emit-jsx.ts`'s
   * `classTokenTablesOf`.
   *
   * A candidate, not a decision. Whether the table is really spelled away is
   * settled at the `class` prop, which is the only place that knows whether the
   * reactive path claimed it, so the allocation and its stores render into
   * `pendingClassTableLines` and the prop either flushes that buffer or drops
   * it. Deciding at the allocation instead would mean re-deriving the reactive
   * answer from facts that are not filled until callables render.
   */
  /**
   * Functions no copy of which names its receiver, and classes whose
   * construction nothing can observe -- `ir/instantiation.ts`. Together they
   * are what lets a `construct` that exists only to manufacture a receiver its
   * callee ignores be deleted whole; both are whole-program facts, computed
   * once by `translation-unit.ts` and read here.
   */
  readonly instantiation: InstantiationFacts
  /** Whether a callable allocation must mint its function-object identity -- see `ir/callable-identity-demand.ts`; `observesEveryCallableIdentity` for a context built without the program census. */
  readonly callableIdentityDemand: CallableIdentityDemand
  /**
   * Whether any operation in the unit can freeze, seal or redefine a native
   * object's properties (`ir/integrity-restrictions.ts`). `false` lets a
   * native field store skip its writability guard; `true` -- the default for
   * a context built without the census -- keeps every guard.
   */
  readonly nativeIntegrityRestricted: boolean
  /**
   * Whether a required field's presence bit is a program-wide constant
   * (`ir/program-facts.ts`'s `fixedFieldStateConstant`: nothing deletes,
   * freezes, seals or redefines a declared field). `true` lets a field store
   * skip re-setting a bit that is `true` already -- and that `records.ts` has
   * made a `static` member; `false` keeps the store.
   */
  readonly fixedFieldStateConstant: boolean
  /** Settled from `EmitBodyFacts.classTableRoots` -- see that type's own doc. */
  readonly classTableRoots: ReadonlyMap<IrValueId, IrValueId>
  /** One candidate table's withheld lines, keyed by the table's own value. See `classTableRoots`. */
  readonly pendingClassTableLines: Map<IrValueId, string[]>
  /** The expression each deferred value stands for, recorded by `emit.ts` when its statement is withheld and substituted by `operandText`. */
  readonly deferredTexts: Map<IrValueId, string>
  /**
   * An array literal withheld whole: its element expressions, in order, rather
   * than a temporary holding the object they were pushed into.
   *
   * `ir/lower-operands.ts`'s `packRestArguments` packs every argument of a
   * variadic call into one fresh Array, which is exactly right for a callee
   * that binds `...rest` -- and pure waste for `Array.prototype.push`, whose
   * emitted form (`emit-prototype-array.ts`) immediately drains that Array back
   * into the receiver. `arr.push(x)` in a loop was allocating one control block
   * and one `ArrayObject` per iteration to carry a single element three lines.
   * Recording the elements lets the bulk-insert renderer push them directly,
   * and lets any other consumer materialize the same Array as one expression.
   */
  readonly pendingPacks: Map<IrValueId, { readonly elements: readonly string[]; readonly elementType: string }>
  /**
   * How many elements an array allocation is about to be given, when a loop
   * further down says so.
   *
   * Growing a `std::vector` from empty by ten million `push_back`s reallocates
   * about two dozen times and copies, in total, roughly twice the final
   * buffer -- for `array_read`'s ten million elements that is 160 MB of
   * memcpy the program never asked for, and it is the whole of the gap
   * against a hand-written baseline that opens with `reserve`. The count is a
   * HINT and nothing depends on it: the loop may push fewer times, more times,
   * or none, and every one of those still runs correctly. That is what lets
   * `emit-arrays.ts` take the loop's own bound as the count without proving
   * the trip count exactly.
   *
   * Keyed by the allocation's value; the operand is the bound, already checked
   * to be nameable at the allocation.
   *
   * Not yet `ReadonlyMap`: written by `collectCapacityHints` (`emit-arrays.
   * ts`) through `ctx` directly -- same follow-up as `formalCells`.
   */
  readonly capacityHints: ReadonlyMap<IrValueId, CapacitySource>
  /**
   * The counted loops whose entire body is one `push` of an unchanging value,
   * keyed by the loop header whose terminator becomes the append
   * (`collectFillLoop`, `emit-arrays.ts`). Unlike `capacityHints` this is not a
   * hint: the block's back edge is replaced, so a wrong entry runs the wrong
   * program.
   *
   * Not yet `ReadonlyMap`, for the same reason `capacityHints` is not.
   */
  readonly fillLoops: ReadonlyMap<IrBlockId, FillLoop>
  /**
   * What `ir/integers.ts` settled before anything renders, because the choice is
   * whole-body: which `number` values and cells may hold in a `long long`, which
   * ABI positions the signature declares one (`ir/integer-storage.ts`, spelled by
   * `formalsOf`), what no loop can change, and which `%` results admit a cheaper
   * spelling than `gea::remainder`. A cell's storage is settled by its first write.
   */
  readonly narrowedFormals: ReadonlySet<number>
  /**
   * The `parameter` results of the narrowed formals, so a read of one is
   * known to be a `long long` -- filled by `collectFormalCells`
   * (`emit-bindings.ts`), which writes it through `ctx` directly. Not
   * converted with its seventeen siblings: the write site is outside
   * `emit.ts`/`emit-context.ts`, so eliminating it means changing
   * `collectFormalCells`'s own signature to return the table instead of
   * mutating through `ctx` -- real, scoped follow-up, recorded here rather
   * than smuggled into this pass.
   */
  readonly narrowedFormalValues: ReadonlySet<IrValueId>
  /** Shared builtin facts used by the integer census and direct call emission. Settled the same way as `hoistedResults`; see that field's doc. */
  readonly numericCalls: ReadonlyMap<CallOperation, NumericIntrinsic>
  /** Settled the same way as `hoistedResults`. */
  readonly numericCallOnly: ReadonlySet<IrValueId>
  /** Settled the same way as `hoistedResults`. */
  readonly integerValues: ReadonlySet<IrValueId>
  /** Settled the same way as `hoistedResults`. */
  readonly integerBindings: ReadonlySet<DeclarationId>
  /** Finite typeof snapshots proved by the IR, confined to comparison-only uses. Settled the same way as `hoistedResults`. */
  readonly typeQueryValues: ReadonlySet<IrValueId>
  /** Settled the same way as `hoistedResults`. */
  readonly typeQueryBindings: ReadonlySet<DeclarationId>
  /** Settled the same way as `hoistedResults`. */
  readonly typeQueryComparisons: ReadonlyMap<ComputeOperation, TypeQueryComparison>
  /** Settled the same way as `hoistedResults`. */
  readonly loopInvariantValues: ReadonlySet<IrValueId>
  /** Settled the same way as `hoistedResults`. */
  readonly remainderForms: ReadonlyMap<IrValueId, 'restated' | 'dynamic'>
  /**
   * The dense-loop windows this body admitted, and which window each element
   * access renders against (`ir/dense-loops.ts`).
   *
   * Filled by `emitBody` before anything renders, for the same reason the
   * integer census is: an access has to know at its own site whether a
   * preheader already computed a pointer and a flag for it.
   *
   * `admitDenseWindows` (`emit-arrays.ts`) is the one writer of this and of
   * `denseAccesses`/`denseGroups`/`denseLengths` below, and it takes the
   * `EmitBodyPrepassFacts` handle rather than reaching through `ctx` -- which
   * is what lets all four be read-only here even though their writer lives in
   * a file full of renderers.
   */
  readonly denseArrays: readonly DenseArray[]
  readonly denseAccesses: ReadonlyMap<IrNonTerminatorOperation, DenseAccess>
  readonly denseGroups: ReadonlyMap<number, DenseGroup>
  /** Reads of a wrapped window's `length` that the preheader already took, by the window's ordinal. */
  readonly denseLengths: ReadonlyMap<IrValueId, number>
  /** Subscripts a wrapped window may take in the integers -- see `denseRemainderCompanion`. */
  readonly denseIndices: Map<IrValueId, string>
  /**
   * Every `compute` operation this body defines, by the value it produced --
   * read by `emit-bindings.ts` to recognize a cell's own compound update.
   *
   * Settled from `EmitBodyFacts.computeOrigins` (`ir/facts.ts`'s
   * `bodyValueOriginsOf`): a purely syntactic index over the IR, with no
   * dependency on render order -- unlike its predecessor, which
   * `targets/cpp/emit.ts`'s `emitCompute` used to fill as a side effect of
   * rendering the very operation it indexes.
   */
  readonly computeOrigins: ReadonlyMap<IrValueId, ComputeOperation>
  /**
   * Plain property read origins used to prove that a string store appends to
   * its own field. Settled from `EmitBodyFacts.propertyReadOrigins` -- see
   * `computeOrigins`'s doc above for why this moved out of the renderer that
   * used to fill it (`emit-properties.ts`'s `emitGet`).
   */
  readonly propertyReadOrigins: ReadonlyMap<IrValueId, GetOperation>
  /**
   * The declaration each `binding-read` value loaded from, for the same
   * recognition. Settled from `EmitBodyFacts.bindingReadDeclarations` -- see
   * `computeOrigins`'s doc above; this one used to be filled from TWO places
   * (`emit-bindings.ts`'s `emitBindingRead` for a live read, `emit.ts`'s
   * `registerDirectCalleeOfDeadValue` for a dead one), which is exactly the
   * two-authorities shape this refactor removes.
   */
  readonly bindingReadDeclarations: ReadonlyMap<IrValueId, DeclarationId>
  /**
   * Every cell a value transitively READS, over the whole body -- a value's own
   * `binding-read` declaration unioned with those of every operand that
   * produced it, to a fixpoint.
   *
   * `bindingReadDeclarations` answers this for a value that IS a read. The
   * question a write-in-place has to ask is one level wider: an argument that
   * merely *derives* from the cell -- `JSON.stringify(wrap(s))`, a record whose
   * field is loaded from it -- still reads storage the fill is about to
   * `clear()`, and asking only whether the argument is itself that read admits
   * exactly the aliasing a fast path must refuse. Filled before anything
   * renders, because a use may precede its own producer in emission order.
   *
   * Settled from `EmitBodyFacts.valueCellReads` (formerly
   * `targets/cpp/deferral-safety.ts`'s `collectValueCellReads`, which mutated
   * this field in place -- the fixpoint itself has no C++ in it, so it moved
   * to `ir/facts.ts`'s `bodyValueOriginsOf`).
   */
  readonly valueCellReads: ReadonlyMap<IrValueId, ReadonlySet<DeclarationId>>
  /** Declarations that have already emitted their one declaring statement in this body; a later write is a plain assignment. */
  readonly declaredBindings: Set<DeclarationId>
  /**
   * A value whose ONLY use is the binding write that immediately follows it,
   * and the cell that write fills -- see `emit-json.ts`'s
   * `jsonStringifyFillLines`.
   *
   * Not yet `ReadonlyMap`: written by `collectDirectBindingSinks`
   * (`emit-bindings.ts`) through `ctx` directly -- same follow-up as
   * `formalCells`.
   */
  readonly directBindingSinks: ReadonlyMap<IrValueId, DeclarationId>
  /**
   * Cells this body never materializes: written once, read once in the same
   * effect-free window, and private to this frame, so the write renders
   * nothing and the read spells the written value (`ir/deferral.ts`'s
   * `ForwardedBinding`). `const f = fns[(slot + 1) % 16]; total += f(i)` was a
   * 32-byte `CallableObject` copied into `f`'s cell -- two retains, two
   * releases and the branch misses that came with them -- to be called once;
   * the call now runs on the array element in place.
   */
  readonly forwardedBindings: ReadonlyMap<DeclarationId, ForwardedBinding>
  /**
   * Every local this body needs, declared once at the top rather than where it
   * is first assigned.
   *
   * Blocks render as `goto`-labelled straight-line code, and C++ forbids a jump
   * that enters the scope of a variable with a non-vacuous initializer -- which
   * every `T v = expr;` is. Hoisting the declarations is what makes a branch
   * legal at all, and it is also what lets a merge assign one variable from two
   * different predecessors.
   */
  readonly declarations: { readonly name: string; readonly type: string }[]
  /**
   * Every `Symbol.for(<literal>)` key this UNIT reaches, to the static that
   * holds it. Shared across bodies -- the map is the translation unit's, not
   * this body's -- because one key must be one static, and two bodies that name
   * the same key must name the same one.
   *
   * `Symbol.for` is a registry lookup by string, and a lookup per use is a
   * `std::map` probe on a hot property access. Interning it to a static means
   * the lookup happens once per unit, and every use afterwards is a load of a
   * 32-bit id -- which is v1's own answer to the same question (`Symbol.for('gea.*')`
   * lowered to a static `__geawebsym_*`). Cross-unit identity is unaffected:
   * each unit's static is initialized THROUGH the registry, so every unit
   * resolves the same key to the same symbol.
   */
  readonly symbolKeys: Map<string, string>
  /**
   * Every tagged-template site this UNIT reaches, to the accessor that returns
   * its template object. Shared across bodies for the same reason `symbolKeys`
   * is -- the map is the translation unit's -- though the sharing does not do
   * the same work here: two sites never share an entry, because ECMA-262
   * 13.2.8.3 caches `GetTemplateObject` per PARSE NODE, so two textually
   * identical template sites are two different objects and deduplicating them
   * by text would silently merge them.
   *
   * Keyed by the site's own semantic result plus its carrier: one Parse Node is
   * one entry, except where a generic body was emitted at two instantiations,
   * where the two copies genuinely need two differently-typed statics.
   */
  readonly templateObjects: Map<string, TemplateObjectDefinition>
  nextValueOrdinal: number
  nextBindingOrdinal: number
}

/**
 * The ABI a capturing body itself reads through, as opposed to the one its
 * callers push.
 *
 * A caller of a callable carrier -- `abiOfCallee`, `emitCall`'s own receiver
 * check, the thunk's own external signature (`translation-unit.ts`'s
 * `thunkOf`) -- always consults the *real*, unmodified ABI: an arrow still
 * takes no receiver argument at its call sites, full stop. Only the body's
 * own frame needs to know that a receiver it declares no ABI slot for is
 * nonetheless available, because a nested arrow's `this` captured it from the
 * enclosing method. Overriding `.receiver` here, in one place, is what lets
 * `emitReceiver` read it exactly as it already reads an ordinary method's own
 * `this` -- the capture only moves where the value comes from, not how the
 * body asks for it.
 */
export const effectiveAbiOf = (abi: CallableAbi | null, admission: CaptureAdmission): CallableAbi | null =>
  abi && admission.kind === 'ok' && admission.layout.receiver ? { ...abi, receiver: admission.layout.receiver } : abi

/**
 * Mutable handles onto the thirty-three settled fields
 * `EmitContext` exposes as `ReadonlyMap`/`ReadonlySet` -- the SAME Map/Set
 * instances `ctx` itself carries, under an ordinarily-mutable type.
 *
 * `EmitBodyFacts`'s own doc explains why these thirty-three could not join it:
 * `emitBody`'s census (`irBodyCensusOf`) needs a real, already-built `ctx` to
 * run at all, because several of its hooks call claims that read OTHER
 * settled fields off `ctx` (`isPlainMemberRead`, `directClassMethodBody`,
 * `spellConstants`). So `ctx` has to exist before these thirty-three can be
 * filled, which rules out computing them up front the way `EmitBodyFacts`
 * does -- but every one of them is still settled strictly before
 * `sealFactFieldsForRender` is called (verified by inventory: their only
 * write sites are `emit.ts`'s own prepass, never a printer), so the render
 * half of invariant 5 holds regardless. `createEmitContext` returns this
 * alongside `ctx` so `emitBody`'s prepass keeps the one authorized way to
 * fill them, while every other reader -- meaning every renderer, in every
 * other file -- sees only `ctx`'s `ReadonlyMap`/`ReadonlySet` view and cannot
 * compile a `.set`/`.add`/`.delete` on any of them.
 *
 * Nine of them are filled by a collector that does not live in `emit.ts` at
 * all -- `collectFormalCells`, `collectDirectBindingSinks` (`emit-bindings.
 * ts`), `collectCapacityHints`, `admitDenseWindows` (`emit-arrays.ts`). Those
 * take this handle as a parameter rather than reaching through `ctx`, which
 * is what lets the field stay read-only for everyone else: the collector's
 * own signature now states that it writes, and a renderer in the same file
 * still cannot, because it was never handed one. `scripts/architecture.mjs`
 * used to guard these nine by matching the enclosing FUNCTION NAME of every
 * `ctx.<field>.set(...)`; that rule is deleted for them, because a type the
 * compiler checks in every program beats a name a script matches in the
 * files it happens to scan.
 *
 * `deferrable` was the last holdout, on the belief that
 * `materializeDenseReference` deleted from it mid-render. It does not: its one
 * caller is `admitDenseWindows`, which runs in the prepass like the rest. The
 * belief had been written down twice and never checked against the call graph,
 * which is why it survived three passes over this file.
 */
export interface EmitBodyPrepassFacts {
  readonly hoistedResults: Set<IrValueId>
  readonly sharedStringLayouts: Map<IrValueId, SharedStringLayout>
  readonly reusedStringLengths: Map<IrValueId, IrOperand>
  readonly loopInvariantValues: Set<IrValueId>
  readonly numericCalls: Map<CallOperation, NumericIntrinsic>
  readonly numericCallOnly: Set<IrValueId>
  readonly integerValues: Set<IrValueId>
  readonly integerBindings: Set<DeclarationId>
  readonly typeQueryValues: Set<IrValueId>
  readonly typeQueryBindings: Set<DeclarationId>
  readonly typeQueryComparisons: Map<ComputeOperation, TypeQueryComparison>
  readonly remainderForms: Map<IrValueId, 'restated' | 'dynamic'>
  readonly deadValues: Set<IrValueId>
  readonly unreadValues: Set<IrValueId>
  readonly booleanConstants: Map<IrValueId, boolean>
  readonly localIterators: Set<IrValueId>
  readonly callArgumentOnly: Set<IrValueId>
  readonly prototypeMethodReads: Map<IrValueId, PrototypeMethodRead>
  readonly lazyCalleeReads: Set<IrValueId>
  readonly directCallReceivers: Map<IrValueId, IrOperand>
  readonly virtualCallees: Map<IrValueId, VirtualCallee>
  readonly unionMethodReads: Map<IrValueId, UnionMethodRead>
  readonly unionMemberTypeofReads: Map<IrValueId, UnionMemberTypeofRead>
  readonly reactiveOrigins: Map<IrValueId, ReactiveRevisionOrigin>
  readonly reactiveBindingOrigins: Map<DeclarationId, ReactiveRevisionOrigin>
  readonly reactiveFieldReads: Map<IrValueId, ReactiveRevisionOrigin>
  readonly formalCells: Map<DeclarationId, string>
  readonly narrowedFormalValues: Set<IrValueId>
  readonly directBindingSinks: Map<IrValueId, DeclarationId>
  readonly forwardedBindings: Map<DeclarationId, ForwardedBinding>
  readonly capacityHints: Map<IrValueId, CapacitySource>
  readonly fillLoops: Map<IrBlockId, FillLoop>
  readonly denseArrays: DenseArray[]
  readonly denseAccesses: Map<IrNonTerminatorOperation, DenseAccess>
  readonly denseGroups: Map<number, DenseGroup>
  readonly denseLengths: Map<IrValueId, number>
  readonly deferrable: Set<IrValueId>
}

/** Every deferred direct callee this body's `call` operations resolved to, straight off `CallOperation.target` -- see `EmitContext.directCallees`'s doc. */
export const directCalleesOf = (
  body: IrBody,
  abiOfCallable: (callable: FunctionId) => CallableAbi | null
): { readonly directCallees: ReadonlyMap<IrValueId, string>; readonly directCalleeAbis: ReadonlyMap<IrValueId, CallableAbi> } => {
  const directCallees = new Map<IrValueId, string>()
  const directCalleeAbis = new Map<IrValueId, CallableAbi>()
  for (const block of body.blocks.values()) {
    for (const operation of block.operations) {
      if (operation.kind !== 'call' || operation.target?.kind !== 'direct') continue
      directCallees.set(operation.callee.value, cppBodyName(operation.target.functionId))
      const abi = abiOfCallable(operation.target.functionId)
      if (abi !== null) directCalleeAbis.set(operation.callee.value, abi)
    }
  }
  return { directCallees, directCalleeAbis }
}

export const createEmitContext = (
  abi: CallableAbi | null,
  owner: FunctionId | RegionId,
  placements: ReadonlyMap<DeclarationId, BindingPlacement>,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  hosts: HostSpellings,
  deriver: RepresentationDeriver,
  bodyFacts: EmitBodyFacts,
  wellKnownSymbols: ReadonlyMap<DeclarationId, string> = new Map(),
  captures: CaptureIndex = emptyCaptureIndex,
  symbolKeys: Map<string, string> = new Map(),
  templateObjects: Map<string, TemplateObjectDefinition> = new Map(),
  directCallableBindings: ReadonlyMap<DeclarationId, FunctionId> = new Map(),
  virtualDispatch: ReadonlyMap<string, CallableAbi> = new Map(),
  narrowedFormals: ReadonlySet<number> = new Set(),
  repeatedConstructors: ReadonlyMap<DeclarationId, DeclarationId> = new Map(),
  dyingArguments: ReadonlySet<IrValueId> = new Set(),
  instantiation: InstantiationFacts = noInstantiationFacts,
  abiOfCallable: (callable: FunctionId) => CallableAbi | null = () => null,
  functionFacts: ReadonlyMap<FunctionId, CallableFactsSpelling> = new Map(),
  hostMethodAliases: ReadonlyMap<DeclarationId, HostMethodAlias> = new Map(),
  callableMemberCandidates: ReadonlyMap<string, FunctionId> = new Map(),
  borrowableMemberBodies: ReadonlySet<FunctionId> = new Set(),
  stableBorrowEntries: ReadonlyMap<string, StableBorrowEntry> = new Map(),
  printerDrift: PrinterDrift[] = [],
  // A context built without the program's census (the value-contract
  // checks) gets one over the same tables with nothing pre-minted: the
  // registry answers every pair the eager graph would have, one node later.
  conversions: ConversionCensus | null = null,
  nativeSelections: ReadonlyMap<string, NativeSelectionHelper> | undefined = undefined,
  callableIdentityDemand: CallableIdentityDemand = observesEveryCallableIdentity,
  nativeIntegrityRestricted = true,
  fixedFieldStateConstant = false
): { readonly ctx: EmitContext; readonly prepass: EmitBodyPrepassFacts } => {
  const admission = captures.of(owner)
  const layouts = recordLayoutPolicyOf(deriver, classes)
  // The thirty-three `EmitBodyPrepassFacts` collections: minted once, here, and
  // handed to `ctx` (read-only) and to the caller's `prepass` (mutable) as
  // the SAME instances -- see that type's own doc for why a fact this late
  // still needs a mutable handle at all.
  const hoistedResults = new Set<IrValueId>()
  const sharedStringLayouts = new Map<IrValueId, SharedStringLayout>()
  const reusedStringLengths = new Map<IrValueId, IrOperand>()
  const loopInvariantValues = new Set<IrValueId>()
  const numericCalls = new Map<CallOperation, NumericIntrinsic>()
  const numericCallOnly = new Set<IrValueId>()
  const integerValues = new Set<IrValueId>()
  const integerBindings = new Set<DeclarationId>()
  const typeQueryValues = new Set<IrValueId>()
  const typeQueryBindings = new Set<DeclarationId>()
  const typeQueryComparisons = new Map<ComputeOperation, TypeQueryComparison>()
  const remainderForms = new Map<IrValueId, 'restated' | 'dynamic'>()
  const deadValues = new Set<IrValueId>()
  const unreadValues = new Set<IrValueId>()
  const booleanConstants = new Map<IrValueId, boolean>()
  const localIterators = new Set<IrValueId>()
  const callArgumentOnly = new Set<IrValueId>()
  const prototypeMethodReads = new Map<IrValueId, PrototypeMethodRead>()
  const lazyCalleeReads = new Set<IrValueId>()
  const directCallReceivers = new Map<IrValueId, IrOperand>()
  const virtualCallees = new Map<IrValueId, VirtualCallee>()
  const unionMethodReads = new Map<IrValueId, UnionMethodRead>()
  const unionMemberTypeofReads = new Map<IrValueId, UnionMemberTypeofRead>()
  const reactiveOrigins = new Map<IrValueId, ReactiveRevisionOrigin>()
  const reactiveBindingOrigins = new Map<DeclarationId, ReactiveRevisionOrigin>()
  const reactiveFieldReads = new Map<IrValueId, ReactiveRevisionOrigin>()
  const formalCells = new Map<DeclarationId, string>()
  const narrowedFormalValues = new Set<IrValueId>()
  const directBindingSinks = new Map<IrValueId, DeclarationId>()
  const forwardedBindings = new Map<DeclarationId, ForwardedBinding>()
  const capacityHints = new Map<IrValueId, CapacitySource>()
  const fillLoops = new Map<IrBlockId, FillLoop>()
  const denseArrays: DenseArray[] = []
  const denseAccesses = new Map<IrNonTerminatorOperation, DenseAccess>()
  const denseGroups = new Map<number, DenseGroup>()
  const denseLengths = new Map<IrValueId, number>()
  const deferrable = new Set<IrValueId>()
  const ctx: EmitContext = {
    abi: effectiveAbiOf(abi, admission),
    abiOfCallable,
    functionFacts,
    owner,
    placements,
    classes,
    captures,
    deriver,
    layouts,
    ...(nativeSelections === undefined ? {} : { nativeSelectionHelpers: nativeSelections }),
    conversions: conversions ?? createConversionNodes({ registry: createCppConversionRegistry(layouts), nodes: new Map() }),
    valueNames: new Map(),
    ownedValues: new Set(),
    ownedDyingValues: bodyFacts.ownedDyingValues,
    consumingFormalConversions: bodyFacts.consumingFormalConversions,
    bindingWriteCounts: bodyFacts.bindingWriteCounts,
    formalCells,
    constantTexts: new Map(),
    staticKeyTexts: bodyFacts.staticKeyTexts,
    hosts,
    wellKnownSymbols,
    reactiveFieldReads,
    thunkValues: bodyFacts.thunkValues,
    directCallees: bodyFacts.directCallees,
    directCalleeAbis: bodyFacts.directCalleeAbis,
    directCallReceivers,
    virtualCallees,
    virtualCalleesUsed: new Set(),
    unionMethodReads,
    unionMethodReadsUsed: new Set(),
    unionMemberTypeofReads,
    protocolNextResults: new Map(),
    dynamicIteratorSteps: new Map(),
    dynamicIteratorDoneStates: new Map(),
    stringMetadataNames: new Map(),
    receiverValues: bodyFacts.receiverValues,
    constructorOf: bodyFacts.constructorOf,
    generatorBody: bodyFacts.generatorBody,
    virtualDispatch,
    directCallableBindings,
    callableMemberCandidates,
    borrowableMemberBodies,
    stableBorrowEntries,
    stableBorrowActuals: bodyFacts.stableBorrowActuals,
    repeatedConstructors,
    dyingArguments,
    hostMethodAliases,
    instantiation,
    callableIdentityDemand,
    nativeIntegrityRestricted,
    fixedFieldStateConstant,
    functionSourceReads: bodyFacts.functionSourceReads,
    functionSourceSnapshotNames: bodyFacts.functionSourceSnapshotNames,
    callCallees: bodyFacts.callCallees,
    calleeOnlyValues: bodyFacts.calleeOnlyValues,
    conversionSources: bodyFacts.conversionSources,
    recordFieldSources: bodyFacts.recordFieldSources,
    reactiveOrigins,
    reactiveBindingOrigins,
    printerDrift,
    hostMemberReads: bodyFacts.hostMemberReads,
    hostClassReads: bodyFacts.hostClassReads,
    classObjectReads: bodyFacts.classObjectReads,
    hostFunctionReads: bodyFacts.hostFunctionReads,
    hostNamespaceReads: bodyFacts.hostNamespaceReads,
    hostNamespaceValues: bodyFacts.hostNamespaceValues,
    hoistedResults,
    sharedStringLayouts,
    prototypeMethodReads,
    lazyCalleeReads,
    bindingNames: new Map(),
    deadValues,
    unreadValues,
    booleanConstants,
    localIterators,
    deferrable,
    reusedStringLengths,
    callArgumentOnly,
    classTableRoots: bodyFacts.classTableRoots,
    pendingClassTableLines: new Map(),
    deferredTexts: new Map(),
    pendingPacks: new Map(),
    capacityHints,
    fillLoops,
    narrowedFormals,
    narrowedFormalValues,
    numericCalls,
    numericCallOnly,
    integerValues,
    integerBindings,
    typeQueryValues,
    typeQueryBindings,
    typeQueryComparisons,
    loopInvariantValues,
    remainderForms,
    denseArrays,
    denseAccesses,
    denseLengths,
    denseIndices: new Map(),
    denseGroups,
    computeOrigins: bodyFacts.computeOrigins,
    propertyReadOrigins: bodyFacts.propertyReadOrigins,
    bindingReadDeclarations: bodyFacts.bindingReadDeclarations,
    valueCellReads: bodyFacts.valueCellReads,
    declaredBindings: new Set(),
    directBindingSinks,
    forwardedBindings,
    declarations: [],
    symbolKeys,
    templateObjects,
    nextValueOrdinal: 0,
    nextBindingOrdinal: 0
  }
  return {
    ctx,
    prepass: {
      hoistedResults,
      sharedStringLayouts,
      reusedStringLengths,
      loopInvariantValues,
      numericCalls,
      numericCallOnly,
      integerValues,
      integerBindings,
      typeQueryValues,
      typeQueryBindings,
      typeQueryComparisons,
      remainderForms,
      deadValues,
      unreadValues,
      booleanConstants,
      localIterators,
      callArgumentOnly,
      prototypeMethodReads,
      lazyCalleeReads,
      directCallReceivers,
      virtualCallees,
      unionMethodReads,
      unionMemberTypeofReads,
      reactiveOrigins,
      reactiveBindingOrigins,
      reactiveFieldReads,
      formalCells,
      narrowedFormalValues,
      directBindingSinks,
      forwardedBindings,
      capacityHints,
      fillLoops,
      denseArrays,
      denseAccesses,
      denseGroups,
      denseLengths,
      deferrable
    }
  }
}

/**
 * Mints this result's name and records the declaration it needs.
 *
 * Throws on a second definition: SSA form makes that an internal-consistency
 * bug, not a missing feature. `spelling` overrides the type only where the
 * carrier a value is *read* as differs from the one its result declares -- a
 * receiver read through the ABI's declared receiver slot, for instance.
 */
/**
 * `long long` where the integer census narrowed this value, and the carrier's
 * own spelling everywhere else.
 *
 * An explicit spelling always wins: a caller that named the type knows
 * something this does not.
 */
export const storageTypeOf = (ctx: EmitContext, value: IrValueId, representation: Representation): string =>
  ctx.typeQueryValues.has(value) ? 'gea::Value::Tag' : ctx.integerValues.has(value) ? cppNarrowedIntegerType : cppTypeOf(representation)

/**
 * Whether a value's rendered text is a `long long`, from every storage that
 * can make it one: the value census (`integerValues`), the cell a read names
 * (`integerBindings`, through `bindingReadDeclarations`), or the narrowed
 * formal a parameter reads. `storageTypeOf` answers only the first, which is
 * right for a value's OWN declaration -- a read of an integer cell is spelled
 * as the cell's name and declares nothing -- and wrong for a consumer choosing
 * an overload by the text's type: `examples/apps/weather` indexed its arrays
 * with `long long` loop counters through `elementAt(double)`, converting the
 * index to a double and back on every read, 47 times.
 */
export const isIntegerStorageValue = (ctx: EmitContext, value: IrValueId): boolean => {
  if (ctx.integerValues.has(value) || ctx.narrowedFormalValues.has(value)) return true
  const declaration = ctx.bindingReadDeclarations.get(value)
  return declaration !== undefined && ctx.integerBindings.has(declaration) && !ctx.captures.isBoxed(declaration)
}

/**
 * One capture slot's initializer, cast to the field the environment declares.
 *
 * The struct's field is `cppTypeOf(slot.representation)` -- the CARRIER -- and
 * a cell the integer census narrowed is held in a `long long`. A braced init
 * list forbids that conversion ([dcl.init.list] admits no narrowing), so the
 * pair that reads fine everywhere else is a hard error here, exactly as it is
 * for an array literal's elements (`emit-arrays.ts`'s `packElementText`).
 */
export const captureFieldText = (ctx: EmitContext, declaration: DeclarationId, representation: Representation, text: string): string =>
  ctx.integerBindings.has(declaration) && cppTypeOf(representation) !== cppNarrowedIntegerType
    ? `static_cast<${cppTypeOf(representation)}>(${text})`
    : text

export const defineValue = (ctx: EmitContext, result: IrResult, spelling?: string): string => {
  if (ctx.valueNames.has(result.id)) throw new Error(`ir value ${result.id} is defined twice in one body, which SSA form forbids`)
  if (spelling === undefined && result.representation.kind === 'void') {
    throw createCppEmitBlockedError(
      `physical-cpp-type:${representationKey(result.representation)}`,
      `tries to define storage for void result ${result.id}, which has no value carrier`
    )
  }
  const name = `v${ctx.nextValueOrdinal}`
  ctx.nextValueOrdinal += 1
  ctx.valueNames.set(result.id, name)
  ctx.declarations.push({ name, type: spelling ?? storageTypeOf(ctx, result.id, result.representation) })
  if (spelling === undefined) ctx.ownedValues.add(result.id)
  return name
}

/**
 * Mints this result's name without hoisting a declaration for it.
 *
 * For a value some other C++ construct already declares -- the catch clause's
 * own parameter is the one case today (`CatchBindingOperation`). The region's
 * own `catch (const gea::Value& vN)` text IS this value's declaration;
 * hoisting a second one under the same name would redeclare it.
 */
export const defineValueBoundElsewhere = (ctx: EmitContext, result: IrResult): string => {
  if (ctx.valueNames.has(result.id)) throw new Error(`ir value ${result.id} is defined twice in one body, which SSA form forbids`)
  const name = `v${ctx.nextValueOrdinal}`
  ctx.nextValueOrdinal += 1
  ctx.valueNames.set(result.id, name)
  return name
}

/**
 * Publishes this result under storage that already exists, rather than under a
 * fresh temporary of its own.
 *
 * The one use is a read of a HOST OBJECT (`native-handle`) out of its cell. In
 * the source language that read is not a copy: `const ctx = Display.ctx` binds
 * a reference to one object, and `ctx.fillStyle = c` then `ctx.fillText(...)`
 * are two operations on that same object. Minting a temporary and assigning the
 * cell into it makes each read a fresh C++ VALUE, and every host type that
 * carries state behind its handle -- `CanvasRenderingContext2D` holds
 * `batchDepth_`, `presentRecording_`, `fillStyle_`, `fontSizePx_` and the
 * present-command buffer -- then loses whatever the previous statement set on
 * it, silently and with no diagnostic. The cell IS the object, so the read
 * names the cell.
 */
export const defineValueAlias = (ctx: EmitContext, result: IrResult, storage: string): void => {
  if (ctx.valueNames.has(result.id)) throw new Error(`ir value ${result.id} is defined twice in one body, which SSA form forbids`)
  ctx.valueNames.set(result.id, storage)
}

/** Records a local binding cell's declaration, for the same reason values are hoisted. */
export const declareCell = (ctx: EmitContext, name: string, type: string): void => {
  ctx.declarations.push({ name, type })
}

/**
 * The expression a deferred value stands for, or `null` when it has storage of
 * its own.
 *
 * A withheld array literal materializes here rather than at the point it was
 * withheld: `gea::arrayOf` builds the same Array exotic object the pushed form
 * did, as one expression, so a consumer that genuinely wants the object gets
 * it and only the bulk-insert renderer -- which drains it immediately -- gets
 * to skip building it at all.
 */
const deferredText = (ctx: EmitContext, value: IrValueId): string | null => {
  const text = ctx.deferredTexts.get(value)
  if (text !== undefined) return text
  const pack = ctx.pendingPacks.get(value)
  if (pack === undefined) return null
  return `gea::arrayOf<${pack.elementType}>({${pack.elements.join(', ')}})`
}

/**
 * Whether a value renders as the expression that computes it rather than as a
 * cell of its own -- `emitOperation`'s withholding, or a whole withheld array
 * literal. Such a value is a prvalue at its use: it has no storage anyone could
 * move FROM, and `std::move` around it is either redundant (gcc's
 * -Wredundant-move / -Wpessimizing-move, both errors under the boards' -Werror)
 * or, when the withheld expression happens to name a field, a move out of that
 * field's storage.
 */
export const isDeferredValue = (ctx: EmitContext, value: IrValueId): boolean => deferredText(ctx, value) !== null

/** The one name a value was minted under. Reading an undefined value is a dominance bug in the body, not a rendering choice. */
export const nameOfValue = (ctx: EmitContext, value: IrValueId): string => {
  const deferred = deferredText(ctx, value)
  if (deferred !== null) return deferred
  const name = ctx.valueNames.get(value)
  if (name === undefined) {
    const state = [
      ctx.deadValues.has(value) ? 'dead' : null,
      ctx.deferrable.has(value) ? 'deferrable' : null,
      ctx.unreadValues.has(value) ? 'unread' : null
    ].filter((fact): fact is string => fact !== null)
    throw new Error(
      `ir value ${value} is read before it is defined in body ${ctx.owner}${state.length === 0 ? '' : ` (${state.join(', ')})`}`
    )
  }
  return name
}

/**
 * A host method is not a value.
 *
 * `storage.getItem` names no C++ symbol on its own -- the host states a
 * spelling for the *call*, `gea::host::storage::getItem(k)`, and there
 * is nothing to bind the bare access to. So the access publishes no name, and
 * any use of it other than as a callee is refused here, by name, rather than
 * crashing on a value that was never minted.
 */
export const operandText = (ctx: EmitContext, operand: IrOperand): string => {
  const host = ctx.hostMemberReads.get(operand.value)
  if (host) {
    // Unless the read asks for no call at all. A builtin whose overloads name
    // no single convention is carried as its identity half, and the function
    // OBJECT is a thing this backend can build even where the frame is not:
    // `Array.from.name` reads a fact ECMA-262 states, and the spec's own
    // `length` for it is stated beside the other host facts. Where it is not
    // stated there is nothing to fall back to -- a value read has no census
    // arity behind it -- so that refuses below with the rest.
    if (operand.representation.kind === 'callable-identity') {
      const length = statedHostIntrinsicLength(host.protocol, host.member)
      if (length !== null) return hostBuiltinFunctionIdentityText(host.protocol, host.member, length)
      throw createCppEmitBlockedError(
        `host-invocation:${host.protocol}.${host.member}:value`,
        `"${host.protocol}.${host.member}" is read as a function object with no calling convention, and no host row states its own length`
      )
    }
    // Otherwise the read IS a function object, and the host's own call
    // template is what it calls -- rendered into a captureless thunk over the
    // slot's convention, the same closing a free host function's read already
    // gets. `hostMemberValueText` states which template shapes fill from bare
    // formals and which cannot.
    // `JSON` is dispatched by protocol name BEFORE the template fill, exactly
    // as `hostCallText` dispatches it before the same fill for a real call:
    // its two rows carry a placeholder `emit`, not a template, because their
    // C++ is generated per call site. Filling from that placeholder would
    // splice the placeholder's own comment text in where the call belongs.
    if (host.protocol === 'JSON') {
      const json = hostJsonMemberValueText(host.member, operand.representation)
      if (json !== null) return json
      throw createCppEmitBlockedError(
        `host-invocation:JSON.${host.member}:value`,
        `"JSON.${host.member}" read as a value renders a thunk only over a carrier "gea_runtime.h" declares its own ` +
          `gea_json_read/gea_json_write for; this slot carries "${representationKey(operand.representation)}", whose overload is ` +
          'generated per CALL site and so does not exist for a read'
      )
    }
    const row = hostMemberOf(ctx.hosts.members, host.protocol, host.member)
    if (row) {
      const thunk = hostMemberValueText(operand.representation, row, recordLayoutPolicyOf(ctx.deriver, ctx.classes))
      if (thunk !== null) return thunk
    }
    throw createCppEmitBlockedError(
      `host-invocation:${host.protocol}.${host.member}:value`,
      `"${host.protocol}.${host.member}" is a host method used as a value carried as "${representationKey(operand.representation)}", and the ` +
        'captureless thunk over its own call template that renders one does not apply to that shape; hostMemberValueText ' +
        '(host/emit-host-value.ts) states the shapes it declines'
    )
  }
  const hostClass = ctx.hostClassReads.get(operand.value)
  if (hostClass !== undefined) {
    const called = hostClassValueText(operand.representation, hostClass.linkageName)
    if (called !== null) return called
    throw createCppEmitBlockedError(
      `host-invocation:${hostClass.linkageName}:value`,
      `"${hostClass.linkageName}" is a host class used as a value; the host states spellings for constructing it and for its own class ` +
        `members, and none for the class itself`
    )
  }
  const classObject = ctx.classObjectReads.get(operand.value)
  if (classObject !== undefined) {
    throw createCppEmitBlockedError(
      'native-boundary:uncensused-class-object',
      `"${classObject}" is a program class this compilation introduces no constructor object for -- a generic the program never instantiates ` +
        'is not censused -- so its name can be tested against and constructed through, and there is no object of it to read, store or pass'
    )
  }
  const hostNamespace = ctx.hostNamespaceReads.get(operand.value)
  if (hostNamespace !== undefined) {
    throw createCppEmitBlockedError(
      `host-invocation:${hostNamespace}:value`,
      `"${hostNamespace}" is a host namespace used as a value; it is a path to the host's spellings, and no object of that name ` +
        'exists at run time to be read, stored or passed'
    )
  }
  const hostFunction = ctx.hostFunctionReads.get(operand.value)
  if (hostFunction !== undefined) {
    const wrapped = hostFunctionValueText(operand.representation, hostFunction)
    if (wrapped !== null) return wrapped
    throw createCppEmitBlockedError(
      `host-invocation:${hostCallName(hostFunction)}:value`,
      `"${hostCallName(hostFunction)}" is a host function used as a value, and the captureless thunk over its own ABI that renders one does not apply here; hostFunctionValueText (host/emit-host-value.ts) states the two cases it declines`
    )
  }
  const prototypeMethod = ctx.prototypeMethodReads.get(operand.value)
  if (prototypeMethod) {
    throw createCppEmitBlockedError(
      `property-access:${prototypeMethod.receiverKind}:get:false:value`,
      `"${prototypeMethod.member}" is a String/Number/Array/Promise.prototype method used as a value; this backend fuses it with its call and never materializes it as a first-class function`
    )
  }
  return nameOfValue(ctx, operand.value)
}

/**
 * The receiver a deferred prototype-method call renders on.
 *
 * The mirror of `hostMemberReceiverText` for the other deferral family, and
 * here for the same reason: the access that recorded the read produced no C++,
 * so it had no occasion to print anything, and the record it leaves behind
 * names the operand rather than a spelling of it.
 */
export const prototypeMethodReceiverText = (ctx: EmitContext, receiver: PrototypeMethodReceiver): string => {
  if (receiver.kind === 'none') return ''
  const text = operandText(ctx, receiver.operand)
  return receiver.kind === 'match-elements' ? `gea::runtime::regex::matchElements(${text})` : text
}

/** One dense window's element pointer: the array's own storage, named once at the preheader. */
export const cppDensePointerName = (ordinal: number): string => `gea_dense_${ordinal}`

/** The row a dense window indexes, when the array is itself an element of another: `grid[i]`, taken once at the preheader. */
export const cppDenseRowName = (ordinal: number): string => `gea_dense_row_${ordinal}`

/** One loop's dense-window condition. Loop-invariant by construction, which is what lets the backend version the loop on it. */
export const cppDenseFlagName = (group: number): string => `gea_dense_ok_${group}`

/** A wrapped window's own length, read once at the preheader -- see `DenseLoopPlan.lengths`. */
export const cppDenseLengthName = (ordinal: number): string => `gea_dense_len_${ordinal}`

/** The reciprocal of that length, built once at the preheader rather than re-checked by `gea::preparedDivisor` on every turn. */
export const cppDenseDivisorName = (ordinal: number): string => `gea_dense_div_${ordinal}`

/** The formal this body declares for one ABI position. `translation-unit.ts`'s `formalsOf` spells the same names. */
export const cppFormalName = (ordinal: number): string => `gea_arg_${ordinal}`

/** The formal a body declares for the receiver. `translation-unit.ts`'s `formalsOf` spells the same name. */
export const cppReceiverName = 'gea_this'

/** The thunk that adapts one function body to the environment-passing invoke pointer a callable carrier holds. */
export const cppThunkName = (functionId: string): string => `${cppBodyName(functionId)}_thunk`

/**
 * What one function object answers for `name`, `length` and
 * `Function.prototype.toString`, already spelled for the registration call:
 * `abiType` is `cppAbiType` of the thunk's own convention, which the
 * registry's `Invoke` template parameter must match exactly.
 */
export interface CallableFactsSpelling {
  readonly abiType: string
  readonly name: string
  readonly length: number
  readonly source: string
}

/**
 * The invoke pointer a minting site stores in a callable carrier: `&thunk`,
 * or -- when the program reads function facts -- `&thunk` handed back by
 * `gea::CallableObject<Abi>::entryWithFacts<&thunk>(name, length, text)`,
 * which registers the facts the first time any site mints this function.
 *
 * Registration lives HERE, at the mint, and not beside the thunk, because a
 * namespace-scope `static const bool ... = registerSource<&thunk>(...)` is a
 * static initializer that takes the thunk's address, and a static initializer
 * with a side effect is a root the linker may not drop. Every emitted
 * function, and its source text, then survived `--gc-sections` and LTO
 * whether or not anything reached it: a raw HTTP server whose `EventEmitter`
 * boxed one listener kept all 384 of its functions. A mint site is reachable
 * exactly when a function object can exist, and only an existing function
 * object can be asked for its facts, so registering there preserves every
 * observable answer and pins nothing else.
 */
export const cppThunkEntryText = (ctx: EmitContext, functionId: FunctionId): string => {
  const thunk = `&${cppThunkName(functionId)}`
  const facts = ctx.functionFacts.get(functionId)
  if (facts === undefined) return thunk
  return (
    `gea::CallableObject<${facts.abiType}>::entryWithFacts<${thunk}>(` +
    `${cppStringViewLiteral(facts.name)}, ${facts.length}, ${cppStringViewLiteral(facts.source)})`
  )
}

/** The thunk that adapts one class's construct function to the environment-passing construct pointer a constructor carrier holds. */
export const cppConstructThunkName = (declaration: DeclarationId): string => `${cppConstructName(declaration)}_thunk`

/**
 * The same pointer for a pre-`class` JavaScript constructor FUNCTION, whose
 * construction has no separate construct function to adapt: one body serves
 * both entry points, so the thunk itself is where the instance is allocated
 * (`translation-unit.ts`'s `constructThunkOf`). Keyed by the function rather
 * than by a declaration, because that is the identity the carrier's allocation
 * site names (`emit-callable.ts`'s `emitAllocateCallable`).
 */
export const cppConstructedThunkName = (functionId: string): string => `${cppBodyName(functionId)}_construct_thunk`

/**
 * The environment struct one capturing function's closure allocates.
 *
 * One struct per capturing function, not one shared layout: two closures
 * capture different cells in general, and a shared struct would need every
 * field every closure ever captures, most of them unused in most instances.
 */
export const cppEnvironmentStructName = (functionId: string): string => `${cppBodyName(functionId)}_env`

/** One captured cell's field inside its function's environment struct, in capture order. `translation-unit.ts`'s thunk unpacking spells the same name. */
export const cppCaptureFieldName = (index: number): string => `c${index}`

/** The captured-receiver's own field, kept apart from `cppCaptureFieldName` because it has no capture-order index -- there is at most one per environment. */
export const cppCaptureReceiverFieldName = 'crecv'

/** The thunk's own `void*` formal, named only when a body actually has an environment to unpack. */
export const cppEnvironmentParamName = 'gea_env'

/** The local the thunk casts `cppEnvironmentParamName` to, so the body call and the field reads inside a captured body share one pointer. */
export const cppEnvironmentLocalName = 'gea_e'

/** The thunk's own one-pointer stack storage, which a captured state small enough to travel inside the carrier's pointer is copied back into. */
export const cppEnvironmentSlotName = 'gea_env_slot'

/**
 * The environment actual a capturing accessor's body is called with, read in
 * place out of the object that carries it.
 *
 * An accessor is reached by NAME off the shape, so unlike a closure it has no
 * carrier to hold its captures: the object carries them
 * (`cppRecordAccessorEnvironmentName`, packed at the allocation). Reading it
 * back is an EXPRESSION -- `gea::storedEnvironment` casts the member in place
 * rather than copying an inline environment into a stack slot the way a
 * thunk's `unpackEnvironment` must -- which is what lets every accessor call
 * site, including the ones that render a whole call as one expression
 * (`emit-iterator.ts`), pass it without first emitting statements.
 */
export const storedEnvironmentText = (body: string, member: string): string =>
  `gea::storedEnvironment<${cppEnvironmentStructName(body)}>(${member})`

/**
 * The payload needed to read a property or invoke a nullable carrier.
 * Optional chaining guards this access, but a TypeScript non-null assertion
 * erases and proves nothing at runtime. Check presence before unwrapping so
 * `a!.b` and `(a?.b)!.c` throw on absence instead of dereferencing a default
 * payload. Name the payload once even when a recipe uses it twice.
 */
export const unwrapPresentValue = (ctx: EmitContext, lines: string[], operand: IrOperand): IrOperand => {
  if (operand.representation.kind !== 'optional') return operand
  const value = `${operand.value}:present` as IrValueId
  // The narrowed view's own deferral is already stated by `hostMemberReadsOf`,
  // which names the `<value>:present` twin of every read it claims -- the same
  // unconditional statement `hostClassReadsOf` makes just below, and for the
  // same reason: if a value IS a deferred host member then so is the value
  // proven present, and nothing reads the twin unless a narrowing minted one.
  if (ctx.hostMemberReads.has(operand.value)) return { value, representation: operand.representation.payload }
  // The narrowed view's own identity is already stated by
  // `emit-bindings.ts`'s `hostClassReadsOf`, so this only has to hand it back.
  if (ctx.hostClassReads.has(value)) return { value, representation: operand.representation.payload }
  if (!ctx.valueNames.has(value)) {
    const name = `v${ctx.nextValueOrdinal}`
    ctx.nextValueOrdinal += 1
    ctx.valueNames.set(value, name)
    ctx.declarations.push({ name, type: cppTypeOf(operand.representation.payload) })
    lines.push(`if (!(${operandText(ctx, operand)}).has_value()) gea::host::throwGetPropertyOfNullish<void>();`)
    lines.push(`${name} = *${operandText(ctx, operand)};`)
  }
  return { value, representation: operand.representation.payload }
}

/**
 * The arguments a call actually passes, padded out to the frame the callee
 * declares.
 *
 * A JavaScript call may pass fewer arguments than the function has parameters,
 * and the parameters it skipped are `undefined` -- so a parameter that may be
 * omitted is carried as an `optional`, and the frame still has a slot for it.
 * C++ has no such rule: `construct()` against a
 * `ConstructorObject<T(Optional<double>, Optional<double>, ...)>` is "too few
 * arguments", full stop. `new Quaternion()` against `constructor(w = 1, x = 0,
 * y = 0, z = 0)` is exactly that call.
 *
 * So the absence is passed, not assumed. Only a slot whose own carrier states
 * the absence `undefined` can hold an omitted argument; a slot that cannot is
 * refused by name rather than default-constructed into whatever its carrier
 * happens to allow -- an `optional` tagged `null` would answer a later
 * `=== null` with `true`, which is a wrong answer and not a spelling gap. A
 * rest slot is refused here too: what a caller owes a rest parameter is an
 * allocated array, and building one is lowering's, not this line's.
 *
 * Shared between the generic callable-carrier invoke path (`emit-callable.ts`)
 * and the plugin-stated host construct-template path (`emit-host-invoke.ts`'s
 * `nativeHandleInvocationText`): a host that states a fixed-arity construct
 * template for a protocol whose checker signature has a trailing optional
 * parameter (`new MediaRecorder(stream)` against `new (stream, options?)`)
 * needs the identical padding a generic constructor carrier already gets --
 * without it, only the call sites that happen to pass every optional argument
 * explicitly would emit, and the ones that rely on the parameter's own
 * optionality would refuse for no reason the host template states.
 */
export const paddedArguments = (abi: CallableAbi, args: readonly string[], what: string): readonly string[] => {
  const supplied = abi.receiver === null ? args.length : args.length - 1
  if (supplied >= abi.parameters.length) return args
  const padding = abi.parameters.slice(supplied).map((parameter, offset) => {
    const position = supplied + offset
    if (abi.restFrom !== null && position >= abi.restFrom) {
      // An omitted rest argument list IS the empty array -- ECMA-262 10.2.11
      // binds the rest parameter to a fresh Array of the arguments beyond the
      // fixed ones, and there are none. That is not lowering's judgement to
      // make; it is the language's answer, and `virtual-methods.ts`'s adapter
      // already spells it this way for the identical omission. Only an array
      // carrier is filled: anything else really is a shape this line cannot
      // build. `it.next()` against `lib.es5.d.ts`'s own
      // `next(...args: [] | [TNext])` is the case.
      if (parameter.value.kind === 'array-object') return `gea::makeRef<gea::ArrayObject<${cppTypeOf(parameter.value.element)}>>()`
      throw createCppEmitBlockedError(
        `call-abi:${what}:rest-parameter`,
        `omits the rest parameter at position ${position}, which the caller must allocate`
      )
    }
    // A `dynamic` slot states the absence the same way it states every other
    // value: `gea::Value()` is `undefined` (gea_runtime.h -- "a
    // default-constructed box is `undefined`"), which is exactly what
    // ECMA-262 10.2.1 binds an omitted argument to. So the box needs no
    // optional around it to hold one, which is the same fact `optionalOf`
    // (representation/optional.ts) states when it declines to wrap one.
    // A slot that spends absence on `null` as well -- `f(x: T | null = null)`,
    // a three-armed union (`normalize/parameter-slot.ts`) -- states omission by
    // its `undefined` ARM, since a default-constructed union holds its first
    // arm, which is not necessarily that one. `ArmType` names the arm's own C++
    // type so the empty value is spelled once, here, rather than re-derived
    // from the representation.
    const omitted = cppUndefinedIn(parameter.value)
    if (omitted === null) {
      throw createCppEmitBlockedError(
        `call-abi:${what}:omitted-argument`,
        `omits the argument at position ${position}, whose "${representationKey(parameter.value)}" slot cannot hold the \`undefined\` the ` +
          'language binds an unpassed parameter to'
      )
    }
    return omitted
  })
  return [...args, ...padding]
}

/**
 * The identifier this unit uses for one `Symbol.for` key, minting it on first
 * ask.
 *
 * The ordinal, not the sanitized text, is what makes the name unique: two
 * different keys can sanitize identically (`gea.d.dirty` and `gea/d/dirty`),
 * and a name collision between two distinct symbols would be a silently wrong
 * program rather than a build error. The text is still in the name because a
 * reader of the emitted C++ should be able to see which key a static is.
 */
export const internSymbolKey = (symbolKeys: Map<string, string>, key: string): string => {
  const existing = symbolKeys.get(key)
  if (existing !== undefined) return existing
  let sanitized = ''
  for (const character of key) {
    const ok = (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') || (character >= '0' && character <= '9')
    sanitized += ok ? character : '_'
  }
  const name = `gea_symbol_${sanitized}_${symbolKeys.size}`
  symbolKeys.set(key, name)
  return name
}

/**
 * The namespace-scope definitions for every key this unit interned.
 *
 * `inline` so a split build's units share one object rather than one each --
 * and even where they do not (a key only one unit interns), correctness does
 * not depend on it: the initializer goes THROUGH `gea::symbolFor`, so two
 * separate statics for one key still resolve to the same registry entry.
 *
 * Emitted ahead of every body, because C++ requires a name to be declared
 * before it is used and these are used from inside bodies.
 */
export const symbolKeyDefinitions = (symbolKeys: ReadonlyMap<string, string>): readonly string[] =>
  [...symbolKeys].map(([key, name]) => `inline const gea::Symbol ${name} = gea::symbolFor(${cppStringLiteral(key)});`)

/**
 * One tagged-template site's per-site template object: the accessor a body
 * calls, and the namespace-scope definition that holds the object itself.
 */
export interface TemplateObjectDefinition {
  readonly name: string
  readonly text: string
  /** The one C++ carrier every specialization view of this parse site must share. */
  readonly holder: string
}

/**
 * Reserves this site's accessor and records its definition.
 *
 * The `static` inside the accessor is what makes the object per-site: it is
 * initialized on the first call and every later call returns the SAME object,
 * which is exactly `GetTemplateObject`'s per-Parse-Node cache (ECMA-262
 * 13.2.8.3) and the property a tag's own `WeakMap` cache depends on. A
 * function-local `static` rather than a namespace-scope object because the
 * initializer builds a `shared_ptr` graph, and a namespace-scope one would run
 * during static initialization, before the runtime this unit links against is
 * necessarily up.
 *
 * `inline` so a split build's units share one definition instead of one each --
 * and unlike an interned symbol key, that sharing is load-bearing rather than
 * an optimization: two copies of one site's object would be two objects, which
 * is the one thing this may not be.
 */
export const internTemplateObject = (
  templateObjects: Map<string, TemplateObjectDefinition>,
  operation: { readonly lineage: SemanticResultId | null; readonly result: IrResult },
  holder: string,
  body: readonly string[]
): string => {
  const site = operation.lineage
  if (site === null) {
    throw createCppEmitBlockedError(
      `runtime-helper:allocation:template-object:${representationKey(operation.result.representation)}`,
      'a template object cites no semantic result, so there is no per-site identity to key its one static on'
    )
  }
  // GetTemplateObject is keyed by the Parse Node, not by a monomorphized body
  // copy and not by the representation view through which that copy reaches
  // it. Strip the specialization suffix from the operation's source node;
  // keeping either suffix or `representationKey` here creates two objects for
  // one source site and breaks tag caches.
  const key = withoutSpecialization(nodeOfOperation(operationOfResult(site)))
  const existing = templateObjects.get(key)
  if (existing !== undefined) {
    if (existing.holder !== holder) {
      throw createCppEmitBlockedError(
        `runtime-helper:allocation:template-object:${representationKey(operation.result.representation)}`,
        `one tagged-template parse site reached incompatible carrier views "${existing.holder}" and "${holder}"; ` +
          'GetTemplateObject requires one identity-preserving carrier for every specialization'
      )
    }
    return existing.name
  }
  const name = `gea_template_object_${templateObjects.size}`
  const text = [
    `inline const ${holder}& ${name}() {`,
    `  static const ${holder} gea_template = []() {`,
    ...body.map((line) => `    ${line}`),
    '  }();',
    '  return gea_template;',
    '}'
  ].join('\n')
  templateObjects.set(key, { name, text, holder })
  return name
}

/** The namespace-scope definitions for every tagged-template site this unit reached, emitted ahead of the bodies that call them. */
export const templateObjectDefinitions = (templateObjects: ReadonlyMap<string, TemplateObjectDefinition>): readonly string[] =>
  [...templateObjects.values()].map((definition) => definition.text)

// `bindingReference` moved to its own file when this one crossed the
// architecture gate's 1200-line limit. Re-exported here because it is the same
// question every caller was already asking of this module -- "what C++ name
// does this declaration have here" -- and moving the import sites would have
// been a rename dressed up as a refactor.
export { bindingReference } from './emit-binding-reference.js'

/**
 * Invariant 5 (invariant 5: no write during render): the printer's context is
 * immutable for the duration of a body.
 *
 * A FACT written while statements render makes what a later statement emits
 * depend on render ORDER rather than on the program -- the sharp end of which
 * is `emit-properties.ts`'s `gea_string_metadata_${ctx.prototypeMethodReads
 * .size}`, a struct whose NAME is however many prototype reads happened to be
 * registered before it. Section 2.7's shrink (every fact field off
 * `EmitContext`, leaving naming, interning, spelling tables and buffers) is
 * what makes the invariant structural; until then this is the instrument that
 * says which fields are left.
 *
 * A grep cannot answer that question: most `ctx.<collection>.set(...)` sites
 * are reached from `emitBody`'s PREPASS (`admitDenseWindows`, the census
 * reconciliation, the direct-callee walk), which runs before any operation
 * renders and is exactly where a fact is supposed to be settled. Only a seal
 * taken at the block loop tells the two apart, and it names the field and
 * carries a stack to the site.
 *
 * Off unless `GEA_SEAL_EMIT_CONTEXT` is set, and it restores the context it
 * sealed, so a run that enumerates violations is a run of the same printer.
 */
const renderMutableEmitContextFields: ReadonlySet<string> = new Set([
  // Naming and interning -- 2.7 keeps both, and both are minted as an
  // operation renders by construction.
  'valueNames',
  'bindingNames',
  'symbolKeys',
  'templateObjects',
  // Output buffers. `ownedValues` is one despite reading like a fact: see
  // `emit.ts`'s note at the formal-argument seeding -- membership is not
  // independent of the naming machinery that grows it.
  'declarations',
  'printerDrift',
  'pendingClassTableLines',
  'deferredTexts',
  'pendingPacks',
  'ownedValues',
  // Render bookkeeping, not a fact: `declaredBindings` is which declarations
  // have ALREADY emitted their one declaring statement, so a later write is a
  // plain assignment. Its whole content is what has been printed so far, which
  // is what a buffer is.
  'declaredBindings',
  // Naming again, by the same test as `valueNames`: what these two hold is the
  // C++ NAME of a scratch local this render minted for a dynamic iterator --
  // `v<ordinal>` from `nextValueOrdinal`, declared into `declarations` on the
  // same line that records it. A name that does not exist until something is
  // printed cannot be settled before printing, and nothing about the body is
  // being decided here: WHICH values are dynamic iterator records is the
  // carrier's own answer, asked afresh at every use.
  'dynamicIteratorDoneStates',
  'dynamicIteratorSteps',
  // The same test a third time, for the iterator-record path the two above are
  // the dynamic twin of: what `protocolNextResults` holds is the NAME of the
  // once-only `next()` result local, plus the accessor that reads its two
  // fields back. `emitIteratorNext` mints and declares it, `emitIteratorDone`
  // reads the same local instead of calling `next()` again -- which is a
  // caching decision about the text, not about the body.
  'protocolNextResults',
  // A wrapped dense window's subscript companion, minted and declared beside
  // the read that needed it (`denseRemainderCompanion`). WHICH accesses a
  // window admits is `admitDenseWindows`' prepass answer; this is only what
  // that access's index is spelled as.
  'denseIndices',
  // The same test again: `gea_string_metadata_<N>` is a local this render
  // minted and declared, and `<N>` is how many it had minted before -- which
  // is why the ordinal now counts THIS table rather than however many
  // prototype reads happened to be registered, and why
  // `scripts/normalize-emitted.mjs` renumbers it positionally like `v<N>`.
  'stringMetadataNames',
  // PROOF, the fourth category, and the only one that cannot be settled even
  // in principle: each records that a deferred read was CONSUMED by a call,
  // and `emitBody` refuses on any entry still unconsumed once the body has
  // finished. "Did the rest of this body call it" is a question about the
  // render, asked after the render, so it is answered during one by
  // construction. WHICH reads are deferred is the settled fact
  // (`virtualCallees`, `unionMethodReads`); this is only what became of them.
  'virtualCalleesUsed',
  'unionMethodReadsUsed',
  // The one the seal had simply never been told about -- which meant it could
  // only pass on programs that happen not to reach this write, so a green run
  // under `GEA_SEAL_EMIT_CONTEXT` proved less than it looked like it did.
  //
  // `constantTexts` is the FOLDING READER half of what used to be one map.
  // `staticKeyTexts` was split out of it precisely because this half keeps
  // growing during a render -- a `typeof` whose operand's tag is known folds
  // to a literal here as it is spelled -- so it is a superset of the settled
  // constants in exactly the place where a superset would turn a computed key
  // into a static one. Every claim asks `staticKeyTexts`; this one exists so a
  // later fold can reuse text an earlier one produced.
  'constantTexts'
])

const mapMutators: ReadonlySet<string> = new Set(['set', 'delete', 'clear'])
const setMutators: ReadonlySet<string> = new Set(['add', 'delete', 'clear'])

const sealedCollection = <T extends object>(field: string, collection: T, mutators: ReadonlySet<string>): T =>
  new Proxy(collection, {
    get: (target, property) => {
      if (typeof property === 'string' && mutators.has(property)) {
        return () => {
          throw new Error(`EmitContext.${field}.${property} written during render (invariant 5: no write during render)`)
        }
      }
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === 'function' ? (value as (...args: readonly unknown[]) => unknown).bind(target) : value
    }
  })

/** Seals every fact collection on `ctx` for the caller's render, and returns the undo. */
export const sealFactFieldsForRender = (ctx: EmitContext): (() => void) => {
  if (process.env['GEA_SEAL_EMIT_CONTEXT'] === undefined) return () => {}
  const fields = ctx as unknown as Record<string, unknown>
  const original = new Map<string, unknown>()
  for (const [field, value] of Object.entries(fields)) {
    if (renderMutableEmitContextFields.has(field)) continue
    if (value instanceof Map) {
      original.set(field, value)
      fields[field] = sealedCollection(field, value, mapMutators)
    } else if (value instanceof Set) {
      original.set(field, value)
      fields[field] = sealedCollection(field, value, setMutators)
    }
  }
  return () => {
    for (const [field, value] of original) fields[field] = value
  }
}
