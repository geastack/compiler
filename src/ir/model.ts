import type { DeclarationId, FunctionId, IrValueId, OperationId, PhysicalBodyId, RegionId, SemanticResultId } from '../identity/ids.js'
import type { CallableAbi, Representation } from '../representation/model.js'
import type { ConstantLiteral } from '../semantics/model/operands.js'
import type { HostMethodBinding } from '../semantics/host-methods.js'
import type { SemanticTargetProof } from '../semantics/model/operations.js'
import type { VirtualMemberRole } from '../projection/dispatch.js'
import type { NativeEqualityRecipe } from './native-equality.js'
import type { FixedDataDefinitionRecipe } from './fixed-data-definition.js'
import type { TypedComputedReadRecipe, TypedComputedWriteRecipe } from './typed-property-access.js'

/**
 * The typed IR: verified SSA values and a closed operation union.
 *
 * Every operation here is one of the object-substrate internal methods, a
 * callable/CFG/value primitive, an allocation of one of the runtime carriers,
 * a conversion-use application, or an iterator-protocol step. Nothing here may
 * be named after a framework, fixture, or optimization -- `proxy-wrap`,
 * `direct-map`, `fresh-array`, and similar source-shaped names are exactly the
 * defect the object substrate exists to prevent (architecture.md, "Non-
 * negotiable runtime object substrate").
 *
 * Property syntax lowers through the object internal methods only: `get`,
 * `set`, `delete`, `has-property`, `own-property-keys`, `define-own-property`.
 * There is no second, source-shaped route from a property expression to a
 * runtime operation.
 */

declare const irBlockBrand: unique symbol

/** A basic block inside one physical body. Never an identity outside that body. */
export type IrBlockId = string & { readonly [irBlockBrand]: 'IrBlockId' }

export const irBlockId = (owner: PhysicalBodyId, ordinal: number): IrBlockId => `irblock|${owner}|${ordinal}` as IrBlockId

/**
 * The authenticated conversion-use identity a `convert` operation applies.
 *
 * Minted and owned by the `conversion/` capability algebra, not by typed IR.
 * Left as a plain string, like `ConversionNodeId` in `conversion/algebra.ts`,
 * because typed IR only cites it -- it never mints or interprets one.
 */
export type ConversionUseId = string

/**
 * One value an operation consumes, paired with the carrier the consuming
 * operation expects it to have.
 *
 * The pairing looks redundant with the definition the id points to, but it is
 * the same deliberate redundancy `SemanticOperand.type` uses against the
 * structural-type table: the consumer states its expectation so verification
 * can catch the case where a producer's published carrier and a consumer's
 * assumed carrier have quietly diverged, instead of trusting that they always
 * agree.
 */
export interface IrOperand {
  readonly value: IrValueId
  readonly representation: Representation
}

/**
 * How the target hands an operand's value to the site consuming it: `move`
 * empties the source storage (the value's last use anywhere in the unit, or
 * the last use of a physically owned SSA temporary), `retain` leaves it
 * (copy or borrow, decided elsewhere by carrier ownership -- see
 * `ir/transfer.ts`). There is no third "borrow" arm here because this fact
 * only ever proves one thing, a last use; an ABI's own ownership tier is a
 * different question (`representation/model.ts`'s `AbiParameter.passing`).
 *
 * Per-operand in name, not in storage: `ir/transfer.ts`'s whole-program
 * analysis runs after every body is built, so it publishes value-keyed facts
 * (`TransferFacts`) rather than mutating already-built `IrOperand`s in place.
 * A value the analysis can flag is read from exactly one structural site by
 * construction (the dying tests below all require a single use), so keying
 * by `IrValueId` is equivalent to keying by the one operand that names it.
 */
export type ValueTransfer = 'move' | 'retain'

/** One value an operation defines. Never a second declaration of a carrier already selected upstream. */
export interface IrResult {
  readonly id: IrValueId
  readonly representation: Representation
}

/** Fields every operation carries, regardless of kind. */
export interface IrOperationBase {
  /**
   * The published semantic result this operation lowers.
   *
   * Per "one operation, one authoritative result", this is a citation, not a
   * proof: the operation does not re-derive or duplicate anything the
   * semantic/representation layers already decided.
   *
   * Every ordinary operation carries this citation even when it discards its
   * runtime value. Only synthesized jump/return terminators widen lineage to
   * null in their own interfaces; adding an operation cannot accidentally make
   * missing provenance a valid input to the builder.
   */
  readonly lineage: SemanticResultId
}

// ---------------------------------------------------------------------------
// Object internal methods
// ---------------------------------------------------------------------------

export interface GetOperation extends IrOperationBase {
  readonly hostMethod?: HostMethodBinding
  readonly kind: 'get'
  /** Semantic proof that normal completion is the undefined value. */
  readonly normalResult?: 'undefined'
  readonly receiver: IrOperand
  readonly key: IrOperand
  readonly result: IrResult
  /**
   * `true` when this read names a class field an installed plugin declared a
   * reactive cell -- `PluginCapabilities.reactiveClassFields`, merged once per
   * lowering run (`ir/lower.ts`) and consulted at the one point a property
   * read is built (`lower-property.ts`, `lower-destructuring.ts`'s object
   * pattern step).
   *
   * Stated here, on the operation, instead of re-asked at render time: the
   * target's own answer to the same question (`targets/cpp/records.ts`'s
   * `celled`/`revisions`) is not published until STRUCT RENDERING runs, which
   * is after this read has already been built, so a printer that "asks
   * again" is really asking a table that does not exist yet for the body
   * currently rendering and is forced to substitute a whole-program
   * over-approximation instead (`emit.ts`'s deferral policy used to flatten
   * every struct's celled keys into one bare name set, so a plain field
   * merely SHARING a name with some other class's reactive field anywhere in
   * the program was refused deferral too). This fact is a plan-time
   * question -- which field a plugin marked reactive -- and belongs beside
   * the read that resolved it, not behind a second, later-arriving table.
   *
   * Deliberately NOT the cell-vs-companion-revision distinction
   * (`records.ts`'s `representationCanCell`): that is a C++ carrier decision
   * made during struct rendering, still asked from `celled`/`revisions`
   * wherever it matters (`class-properties/emit-class-properties.ts`,
   * `reactive-dependencies.ts`). This marker only answers "did the plugin
   * name this field reactive", which is enough to settle every consumer that
   * was asking exactly that and nothing more.
   */
  readonly reactive?: boolean
  /**
   * The census's answer for a `prototype` read off a callable carrier
   * (`semantics/callable-origins.ts`'s `callableOwnPrototypeAt`): `true` where
   * the declaration ran `MakeConstructor`, `false` where it provably did not,
   * and ABSENT where the census proved neither -- which is why this is present
   * at `false` rather than stripped. Its presence is the printer's proof that
   * this read is the one certification admitted.
   *
   * Stated here for the same reason `reactive` above is: the CARRIER cannot
   * answer it. `function-and-constructor` materializes its prototype from
   * inside the runtime read because being constructable is proof enough there,
   * while a `function-value-dispatch` receiver has no such proof in its
   * carrier -- the fact belongs to the DECLARATION, and this is where the one
   * layer that could ask hands it to the one layer that spells it.
   */
  readonly callableOwnPrototype?: boolean
  /** A sealed finite-key fixed-field read, when lowering published one. */
  readonly typedComputedRead?: TypedComputedReadRecipe
  /**
   * Class arms of this read's union receiver that provably answer `undefined`
   * for its key (`reflection-demand.ts`'s `finalizeAbsentClassArms`): no class
   * on the arm's chain or below it declares the key, it is no
   * `Object.prototype` member, and the closed reflection census left the
   * class without a dynamic protocol -- so nothing in the program can give
   * one of its instances that own property. The printer renders these arms
   * as the result's `undefined` instead of an expando lookup.
   */
  readonly absentClassArms?: readonly DeclarationId[]
  /** A field read whose synthetic ancestor slot was relocated to its real owners. */
  readonly nativeFieldOwnerRead?: import('./native-field-owner.js').NativeFieldOwnerRead
  /** Callable identity proved from an unmodified compiler-owned record allocation. */
  readonly closedCallable?: CallCalleeIdentity
  /**
   * The computed key's proven finite name set, copied from
   * `PropertyOperation.provenKeyTexts` while the semantic graph is still open
   * -- by emission the key is an opaque `std::string` and the question can no
   * longer be asked. `reflection-demand.ts` is the one reader: at a computed
   * key it cannot resolve to a constant, this lets it demand each proven
   * field by name (`promoteNamedField`, fanned across the receiver's whole
   * class family) instead of the whole reachable carrier graph
   * (`promoteFull`). Absent for a static key and absent whenever the proof
   * refused or failed to survive the sealed host-mutation census's own
   * obligations -- an upper bound never assumed beyond what was proven.
   */
  readonly provenKeyTexts?: readonly string[]
}

/**
 * `[[Set]]` returns a success boolean that ordinary (non-strict) assignment
 * discards. `result` is therefore optional: a producer that has nowhere to
 * route the boolean is not forced to invent an SSA value nobody reads.
 */
export interface SetOperation extends IrOperationBase {
  readonly kind: 'set'
  /** Preserved from the source Reference Record; false `[[Set]]` throws only in strict code. */
  readonly strict: boolean
  readonly receiver: IrOperand
  readonly key: IrOperand
  readonly value: IrOperand
  readonly result: IrResult | null
  /**
   * Present when the key's semantic type was a finite set of string literals
   * that all name declared fields of the receiver. Sealed during lowering,
   * where the semantic graph is still open; by emission time the key is a
   * `std::string` and the question can no longer be asked.
   */
  readonly typedComputedWrite?: TypedComputedWriteRecipe
  /** See `GetOperation.provenKeyTexts` -- the same fact, copied for a `[[Set]]`'s own computed key. */
  readonly provenKeyTexts?: readonly string[]
}

export interface DeleteOperation extends IrOperationBase {
  readonly kind: 'delete'
  /** Preserved from the source Reference Record; false [[Delete]] throws only in strict code. */
  readonly strict: boolean
  readonly receiver: IrOperand
  readonly key: IrOperand
  readonly result: IrResult | null
}

export interface HasPropertyOperation extends IrOperationBase {
  readonly kind: 'has-property'
  readonly receiver: IrOperand
  readonly key: IrOperand
  readonly result: IrResult
}

export interface OwnPropertyKeysOperation extends IrOperationBase {
  readonly kind: 'own-property-keys'
  readonly receiver: IrOperand
  readonly result: IrResult
}

/** The attributes `[[DefineOwnProperty]]` installs. A data descriptor; the value itself is a separate operand. */
export interface IrPropertyAttributes {
  readonly writable: boolean
  readonly enumerable: boolean
  readonly configurable: boolean
}

export interface DefineOwnPropertyOperation extends IrOperationBase {
  readonly kind: 'define-own-property'
  readonly receiver: IrOperand
  readonly key: IrOperand
  readonly value: IrOperand
  readonly attributes: IrPropertyAttributes
  readonly result: IrResult | null
}

/**
 * Object spread's `CopyDataProperties` (ECMA-262 7.3.25) when the source's
 * own-property set is not known until this operation runs -- `producers/
 * protocol.ts`'s `contributeObjectSpread`, lowered by `lower-protocol.ts`.
 *
 * Not a `define-own-property` with a dynamic key: that operation is exactly
 * ONE key, known before it runs (`operation.key`), and this copy's whole
 * reason to exist is that the keys are not known until the emitted C++
 * actually walks the source -- `targets/cpp/emit-allocation.ts` is where that
 * walk (and, for a source with statically-keyed arms, the per-arm field
 * unroll) is rendered. It publishes no result: `CopyDataProperties` is not a
 * value a JS consumer ever reads, and `receiver`/`source` are the only two
 * operands the copy needs.
 */
export interface SpreadCopyOperation extends IrOperationBase {
  readonly kind: 'spread-copy'
  readonly receiver: IrOperand
  readonly source: IrOperand
}

// ---------------------------------------------------------------------------
// Callable
// ---------------------------------------------------------------------------

/**
 * `receiver` is `null` exactly when the callee's ABI declares no receiver
 * (`CallableAbi.receiver === null`), mirroring that field instead of forcing
 * every free-function call to carry a manufactured `undefined` operand.
 *
 * `result` is optional because a callable ABI whose result is `void` is "not
 * a value carrier at all" (`representation/model.ts`): there is nothing to
 * mint an SSA id for.
 */
export interface CallOperation extends IrOperationBase {
  readonly kind: 'call'
  /** Closed body entry, including evaluated arguments that do not enter its fixed frame. */
  readonly closedFrame?: {
    readonly abi: CallableAbi
    readonly receivedArguments: number
    readonly result: 'exact' | 'ignored' | 'undefined'
  }
  readonly callee: IrOperand
  readonly receiver: IrOperand | null
  readonly arguments: readonly IrOperand[]
  readonly result: IrResult | null
  /** A retained ModuleRecord exposed through a host's dynamic builtin lookup. */
  readonly builtinModuleLookup?: { readonly target: RegionId; readonly builtinModule: string }
  /**
   * `true` exactly when `arguments` holds ONE operand that is itself the
   * whole, already-materialized element sequence of a spread argument
   * (`console.log(...values)`) reaching a receiver with no physical calling
   * convention to range-copy into -- `ir/lower-invocation.ts`'s own comment
   * on the guard this lifts for exactly that shape. Indistinguishable from an
   * ordinary single array-typed argument (`console.log(values)`) by
   * `arguments` alone, which is why this exists: only `emit-host-invoke.ts`'s
   * `variadic` arity reads it, to render a runtime join over the array's
   * elements instead of ToString-ing the array itself as one value. Absent
   * everywhere else, so no other consumer of `arguments` is affected.
   */
  readonly argumentsAreSpread?: boolean
  /** Authenticated host property with a borrowed numeric rest sequence, instead of an escaping rest array. */
  readonly numericRestHostCall?: { readonly protocol: string; readonly member: string }
  /**
   * For a callee carried as a `generic-function-set`: the body to run for
   * each member the tag can name, by the member's declaration id. The set's
   * members are the tag's index space; this says which instantiated copy
   * each index dispatches to at THIS call, since a generic function has a
   * different copy at every call that instantiates it differently.
   */
  readonly family?: readonly { readonly member: DeclarationId; readonly functionId: FunctionId }[]
  /**
   * Which of the three ways this call can bypass the callee's own
   * `CallableObject` invoke pointer, or `unresolved` for the ordinary
   * indirect call every callee carrier already supports.
   *
   * Absent (rather than `unresolved`) exactly when nothing has filled it
   * yet: `ir/call-dispatch.ts`'s `fillCallDispatchTargets` is a post-shake
   * rewrite over every `call` operation (the `ir/generator-split.ts` body-
   * rewrite pattern, applied to operations instead of bodies), run in
   * `compiler.ts` after `shakeProgram` and `ir/captures.ts`'s
   * `publishCaptureFacts` -- never during lowering. All three facts this
   * field can name test whether the callee's underlying body captures
   * anything (the sealed `CallOperation.target` fact), and that answer -- `IrBody.facts.capturedDeclarations`/
   * `.capturedReceiver` -- does not exist until a body has been shaken and
   * published, both of which happen after every `call` operation in the
   * program has already been built.
   *
   * `targets/cpp/virtual-methods.ts` used to be the only place that decided
   * the `virtual` half of this (whether a family is actually dispatchable,
   * not just overridden); that verdict is `projection/dispatch.ts`'s
   * `virtualDispatchVerdictOf` now, so a target reads this field instead of
   * re-deriving the same test from a whole-unit capture index built at
   * render time.
   */
  readonly target?: CallDispatchTarget
  /**
   * The compiler-owned body identity of this call's callee, when the same
   * producer/member resolution used by `target` proved it without requiring
   * capture-free physical devirtualization.  This is deliberately separate
   * from `target`: a capturing closure still calls through its ordinary
   * `CallableObject` path, while reflection census may use the authenticated
   * body identity to match the call ABI.  Absent means the callee is open,
   * dynamic, computed, or otherwise not closed.
   */
  readonly closedCallee?: CallCalleeIdentity
  /** Authenticated own-key intrinsic, retained only for a projected intrinsic-template call. */
  readonly intrinsicOwnKeys?: true
  /** Authenticated Reflect operation: a native ABI still observes this property protocol. */
  readonly intrinsicReflection?: 'get' | 'set' | 'has' | 'deleteProperty' | 'getOwnPropertyDescriptor'
  /**
   * Authenticated `Array.isArray` -- ECMA-262 23.1.2.2, whose whole answer is
   * the argument's own carrier. Read by `ir/native-carrier-predicate.ts`; the
   * printer spells the call from the host member table, exactly as it does for
   * `intrinsicOwnKeys`.
   */
  readonly intrinsicCarrierPredicate?: true
  /**
   * The host template the printer spells this call from, when it is one this IR
   * states a frame for (`ir/lower-invocation.ts`'s `hostTemplateOf`):
   * `Object.assign` (`emit-host-object.ts`'s `assignText`), `Array.isArray`
   * (`emit-host-invoke.ts`'s `isArrayText`) and `%TypedArray%.prototype.set`
   * (`emit-buffers.ts`'s `typedArrayCallText`). Such a call never enters the
   * callee's declared convention, so the reflection census asks the template's
   * own frame (`ir/call-entry.ts`'s `hostTemplateFrameOf`) instead of that ABI.
   */
  readonly hostTemplate?: import('../representation/host-templates.js').HostTemplate
  /** A native fixed-slot descriptor update; no unknown callable boundary. */
  readonly fixedDataDefinition?: FixedDataDefinitionRecipe
  readonly objectValueConversions?: readonly import('./object-value-conversions.js').ObjectValueConversion[]
}

/**
 * A closed set of compiler-owned bodies a call can enter.  This fact names
 * semantic callee identity only; it never licenses the physical direct or
 * virtual dispatch path represented by `CallOperation.target`.
 */
export type CallCalleeIdentity = (
  | { readonly kind: 'exact'; readonly functionId: FunctionId }
  | { readonly kind: 'closed-family'; readonly functionIds: readonly FunctionId[] }
) & {
  /** Dispatch census proved every implementation's adapter uses no native field protocol. */
  readonly nativeEntryAbi?: CallableAbi
}

/**
 * The one census answer behind `CallOperation.target`: which FunctionId (if
 * any) a call's callee resolves to statically, without reading the
 * callee value's own `CallableObject` invoke pointer.
 *
 * `direct` and `union-arm` both require the resolved body to capture
 * nothing -- a member function (`virtual`'s C++ shape) and a bare function
 * pointer (`direct`'s) have no environment slot to carry one -- so all three
 * non-`unresolved` variants are, at bottom, the same capture-freedom test
 * asked of a different callee shape: a closure allocated or read straight
 * off a cell (`direct`), an instance method whose family some subclass
 * overrides (`virtual`), or a method read off a receiver that is itself a
 * union of classes (`union-arm`, one target per class arm the union can
 * hold).
 */
export type CallDispatchTarget =
  | { readonly kind: 'direct'; readonly functionId: FunctionId }
  | { readonly kind: 'virtual'; readonly owner: DeclarationId; readonly key: string; readonly role: VirtualMemberRole }
  | { readonly kind: 'union-arm'; readonly arms: readonly CallUnionArmTarget[] }
  | { readonly kind: 'unresolved' }

/**
 * One arm of a `union-arm` dispatch target: the class a nested tagged-union's
 * arm names, and the body its own (non-overridden, capture-free) method
 * resolves to. `path` is the index sequence through however many
 * `tagged-union` levels the receiver nests, outermost first -- the same
 * indices `targets/cpp/emit-union-properties.ts`'s `armAt`/`armIs` take, so
 * the target names an arm the printer can still find without re-walking the
 * receiver's shape to rediscover it.
 */
export interface CallUnionArmTarget {
  readonly path: readonly number[]
  readonly declaration: DeclarationId
  readonly functionId: FunctionId
}

/** A statically resolved CommonJS module-record lookup. */
export interface CommonJsRequireOperation extends IrOperationBase {
  readonly kind: 'commonjs-require'
  readonly owner: RegionId
  readonly target: RegionId
  /** Canonical host builtin name, or null for an ordinary resolved module. */
  readonly builtinModule: string | null
  readonly result: IrResult
}

/** A lexical CommonJS wrapper parameter read. */
export interface CommonJsBindingOperation extends IrOperationBase {
  readonly kind: 'commonjs-binding'
  readonly global: 'require' | 'exports' | 'module'
  readonly owner: RegionId
  readonly result: IrResult
}

/** A write to one real lexical CommonJS wrapper binding. */
export interface CommonJsBindingSetOperation extends IrOperationBase {
  readonly kind: 'commonjs-binding-set'
  readonly global: 'require' | 'exports' | 'module'
  readonly owner: RegionId
  readonly value: IrOperand
}

/**
 * `super(...)`: the base class's initialization, run against the object this
 * constructor is already building.
 *
 * Not a call, and deliberately not carried as one. A class constructor has no
 * `[[Call]]` at all -- invoking one is a TypeError -- so a `call` whose callee
 * is a constructor has no invoke path, which is exactly what the emitter
 * refused before this kind existed. What `super()` does is `[[Construct]]`'s
 * initialization half against an *existing* receiver: it runs the base chain's
 * field initializers and constructor body, and then, before the next statement
 * of the derived constructor, the derived class's own field initializers.
 *
 * Which base, and whose field initializers, are not carried here: both are
 * facts about the class whose constructor this body *is*, which the class
 * projection publishes (`ClassLayout.base`, `ClassLayout.fields`) and IR
 * lowering cannot see. Recording the arguments and the fact that this is a
 * super-initialization -- which normalize published as
 * `InvocationResultDivergence` -- is the whole of what this layer knows.
 */
export interface SuperInitializeOperation extends IrOperationBase {
  readonly kind: 'super-initialize'
  readonly arguments: readonly IrOperand[]
}

/**
 * `Object.setPrototypeOf(C.prototype, B.prototype)` for a class `C` the
 * program models as inheriting from `B` (`semantics/prototype-reparenting.ts`).
 *
 * The layout, dispatch and upcasts already treat `base` as `C`'s base. What is
 * left for run time is the one thing a declaration cannot know: which
 * evaluation of `B` the value is, so `C`'s evaluation can reach that
 * evaluation's prototype for a `B` method read as a value or an `instanceof`
 * -- the same link `allocate-constructor`'s `heritage` makes for `extends`.
 * The heritage value must be exactly `base`; a subclass stored in the same
 * slot has a different prototype than the layout assumed, and is refused.
 */
export interface ReparentConstructorOperation extends IrOperationBase {
  readonly kind: 'reparent-constructor'
  readonly derived: DeclarationId
  readonly base: DeclarationId
  readonly classValue: IrOperand
  readonly heritage: IrOperand
}

/**
 * `newTarget` is always explicit, even for ordinary `new C()` where it equals
 * `callee`. Defaulting it silently would let an omission at a derived-class
 * construction site pass as ordinary construction instead of failing closed.
 */
export interface ConstructOperation extends IrOperationBase {
  readonly kind: 'construct'
  readonly callee: IrOperand
  readonly newTarget: IrOperand
  /** Normalization's proof of which runtime function/class the callee denotes; retained so emission never guesses constructability from a carrier shared with arrows. */
  readonly target: SemanticTargetProof
  /** Published by the call-entry census; both reflection and emission consume this convention. */
  readonly entry?: { readonly kind: 'explicit-object-return'; readonly functionId: FunctionId; readonly abi: CallableAbi }
  /**
   * The frame this site fills of the host-constructor overload the checker
   * selected (`representation/derive.ts`'s `selectedHostConstructFrameOf`).
   * Published only for a `native-handle` callee whose overload set joins into
   * no single `construct` convention -- `new WeakMap()`, `new Map()`, typed
   * arrays. The reflection census consumes it (`native-host-construction.ts`);
   * emission reads the same operands and result carrier it was derived from.
   */
  readonly hostFrame?: CallableAbi
  readonly arguments: readonly IrOperand[]
  readonly result: IrResult
}

// ---------------------------------------------------------------------------
// Value / CFG
// ---------------------------------------------------------------------------

export interface ConstantOperation extends IrOperationBase {
  readonly kind: 'constant'
  /** The constant's own value, in the same textual form `OperandSource.constant.text` uses. */
  readonly text: string
  /** Which literal form the text spells, since the text alone cannot say. */
  readonly literal: ConstantLiteral
  readonly result: IrResult
}

export interface BindingReadOperation extends IrOperationBase {
  readonly kind: 'binding-read'
  readonly declaration: DeclarationId
  readonly result: IrResult
  /** Unique compiler-owned callable stored in this cell, published by the call-identity census. */
  readonly closedCallable?: CallCalleeIdentity
  /**
   * `true` when `declaration` names a class field an installed plugin
   * declared a reactive cell -- see `GetOperation.reactive`, which this
   * mirrors for the one path a property read reaches a field WITHOUT a `get`:
   * `PropertyOperation.resolvedBinding` (`lower-property.ts`), where
   * `this.count` resolves straight to the field's own declaration rather than
   * through `[[Get]]`. Filled from the identical merged plugin table
   * (`ir/lower.ts`'s `reactiveFieldDeclarations`), so a component field reads
   * the same answer regardless of which of the two shapes lowers it.
   */
  readonly reactive?: boolean
}

/**
 * The value the caller's frame supplied at one ABI position.
 *
 * This is not a `constant` (nothing here knows the value) and not a
 * `binding-read` (no operation in this body wrote the cell). Modelling it as
 * either would make a parameter indistinguishable from a local, and the
 * emitter would then read a variable it never declared.
 */
export interface ParameterOperation extends IrOperationBase {
  readonly kind: 'parameter'
  /** The position in `IrBody.abi.parameters` this value comes from. */
  readonly ordinal: number
  readonly result: IrResult
}

/**
 * The receiver the caller's frame supplied.
 *
 * Separate from `parameter` because a convention has at most one receiver and
 * it occupies no argument position: giving it an ordinal would put it in the
 * same numbering as the arguments, and every later reader would have to know
 * which ordinals were real.
 */
export interface ReceiverOperation extends IrOperationBase {
  readonly kind: 'receiver'
  readonly result: IrResult
}

/** The one process-wide ECMAScript global object, carried as an open native dictionary. */
export interface GlobalThisOperation extends IrOperationBase {
  readonly kind: 'global-this'
  readonly result: IrResult
}

/**
 * A binding that resolves to no declaration anywhere in the program --
 * `ResolveBinding` (ECMA-262 6.2.5.6) finds no environment record naming it,
 * so `GetValue` throws a ReferenceError before any value is produced.
 *
 * `semantics/normalize/producers/references.ts`'s `buildReference` publishes
 * this citation's `value` result anyway, and says why: "the result exists so
 * the graph can be built and the throw stated, not because a value ever
 * arrives". A citing operand still needs an SSA id to name -- an argument
 * list, a callee slot -- and this is what that id resolves to: a fact about
 * the PROGRAM (the name really is undeclared) that is decidable with no C++
 * value at all, the same way `class-ref`'s "no own `toString`" case answers
 * `"[object Object]"` without a call.
 *
 * Its own IR kind rather than a `compute` form: `compute`'s own doc restricts
 * it to "operators over evaluated operands" with a physical primitive behind
 * them, and this has no operand at all to operate over -- it is a citable
 * fact about a NAME, the same reason `this`/`super`/`parameter-value`
 * (`ReferenceOperation.form`) each get their own dedicated verb here instead
 * of being folded into `compute`.
 */
export interface UnresolvableReferenceOperation extends IrOperationBase {
  readonly kind: 'unresolvable-reference'
  readonly result: IrResult
}

/**
 * `await`, restricted to the one shape this runtime's `gea::Promise<V>` can
 * ever represent: a settled value with no job queue behind it
 * (`runtime/gea_runtime.h`'s `Promise` doc comment). There is no suspension
 * primitive here -- a physical coroutine transform, the way v1's `co_await`
 * lowering works, is a different and much larger feature this substrate does
 * not have -- so this operation is the honest, narrower answer: read the
 * operand's value immediately, exactly as ECMA-262 27.7.5.3 `Await` would if
 * every promise it ever saw were already fulfilled, which is the only kind
 * `PromiseConstructor::resolve` and every gea host capture ever construct.
 *
 * `operand` is not always a `promise` carrier: `await` accepts any
 * expression, and `Awaited<T>` is `T` unchanged for a non-thenable `T`, so a
 * non-promise operand renders as a plain pass-through (see `emitAwait`,
 * `targets/cpp/emit.ts`). `result` is `null` only when the awaited payload is
 * `void` -- a `Promise<void>` -- mirroring `CallOperation.result`'s identical
 * reason.
 */
export interface AwaitOperation extends IrOperationBase {
  readonly kind: 'await'
  readonly operand: IrOperand
  readonly result: IrResult | null
}

/**
 * `yield x` inside a `function*`.
 *
 * A real suspension, unlike `await` (whose own comment above explains why this
 * backend completes it synchronously): the enclosing body is emitted as a
 * C++20 coroutine returning `gea::Iterator<T, TReturn, TNext>`, and this
 * renders as `co_yield`, which suspends the frame and hands the value to
 * whichever `next()` resumed it.
 *
 * `result` is what a consumer of the yield EXPRESSION's own value reads --
 * ECMA-262 makes that the RESUME channel, what the next `next(v)` (or an
 * abrupt `.return`/`.throw`) sends back in -- mirroring `AwaitOperation`'s
 * identical split between its operand and its result. It is `null` only when
 * `TNext` never resolved to a native carrier for this generator
 * (`representation/derive.ts`'s `GeneratorDeclarationPolicy`), matching
 * `CallOperation.result`'s identical reason for a payload with no carrier.
 * `yield*` is refused by name in `semantics/normalize/producers/control.ts`:
 * delegation is a loop, and a loop cannot be built in the middle of an
 * expression here any more than a spread's own drain can.
 */
export interface YieldOperation extends IrOperationBase {
  readonly kind: 'yield'
  readonly operand: IrOperand | null
  readonly result: IrResult | null
}

/**
 * The value a native C++ `catch` clause binds.
 *
 * Not a `constant` (nothing here knows the value) and not a `binding-read`
 * (no operation in this body wrote the cell) -- the same reasoning
 * `ParameterOperation`'s own comment states for a value the calling frame
 * supplies. This is the try-region twin: the block this operation opens is
 * rendered as the body of a `catch` clause (`IrBody.tryRegions`), and the
 * catch's own parameter binds this value there; nothing else in this body's
 * sequence ever writes it.
 */
export interface CatchBindingOperation extends IrOperationBase {
  readonly kind: 'catch-binding'
  readonly result: IrResult
}

/**
 * A primitive computation over operands that already carry their own physical
 * types.
 *
 * `form` is deliberately only the shapes with a physical primitive behind them.
 * `logical`, `conditional`, `template`, and the rest are not operators over
 * evaluated operands at all -- they select, concatenate, or short-circuit --
 * and admitting them here would let an operation whose semantics are a branch
 * render as if it were an arithmetic instruction.
 *
 * `typeof` is here because it *is* one: it reads a carrier's discriminant, or
 * no carrier state at all, and yields a string. It is not a branch -- the arm
 * it selects is a value, not a region -- so it renders as an instruction like
 * the arithmetic ones do.
 *
 * `in` is here for the same reason and no other: `[[HasProperty]]` evaluates
 * both operands, consults the receiver's carrier, and yields a boolean, with no
 * region and no short circuit anywhere in it. Being an object-substrate
 * interrogation rather than arithmetic changes which backends can render it --
 * which is a manifest claim (`computation:in:*`), not an IR shape.
 */
export interface ComputeOperation extends IrOperationBase {
  readonly kind: 'compute'
  readonly nativeEquality?: NativeEqualityRecipe
  readonly classInstanceTest?: import('../projection/instance-test.js').ClassInstanceTestRecipe
  /**
   * `update` is the arithmetic half of `++`/`--`: the store it feeds is a
   * separate binding-write or property-set operation, so this instruction only
   * ever computes the number that gets stored.
   */
  readonly form:
    | 'unary'
    | 'binary'
    | 'update'
    | 'equality'
    | 'typeof'
    | 'in'
    | 'instanceof'
    | 'template'
    | 'require-object-coercible'
    /**
     * The presence half of an array pattern's own possibly-absent source
     * (`ir/lower-destructuring.ts`'s `lowerArrayPatternSource`): asserts the
     * one operand is not `undefined`/`null` (ECMA-262 7.4.2 `GetIterator`
     * throws on either) and unwraps its `optional` carrier to the payload,
     * the same `gea::detail::requireIterablePresent` the general `for`-`of`
     * protocol's own absent sources already call (`targets/cpp/emit-iterator.ts`).
     */
    | 'require-iterable-present'
    /**
     * The arm half of the same source, when the unwrapped payload is a
     * tagged union only ONE arm of which this pattern can read positionally
     * (`representation/model.ts`'s `soleArrayPatternCapableArm`): asserts the
     * runtime tag is that arm and reads it, throwing the way the same
     * `GetIterator` throws over the union's other, non-iterable arm. The arm
     * index is not a language operator -- there is no source syntax this
     * form renders -- but it is carried through the same `operator` field
     * `require-object-coercible` already reuses for a descriptive label
     * rather than a real one, stringified so `targets/cpp/emit.ts` can read
     * it back as the compile-time `.is<N>()`/`.get<N>()` template argument.
     */
    | 'require-tagged-union-arm'
  /** The language operator, carried through from the semantic operation unchanged. */
  readonly operator: string
  readonly operands: readonly IrOperand[]
  readonly result: IrResult
}

/** A binding cell is a mutable environment slot, not an SSA value; the write has no result of its own. */
export interface BindingWriteOperation extends IrOperationBase {
  readonly kind: 'binding-write'
  readonly declaration: DeclarationId
  readonly value: IrOperand
}

/** One incoming edge of a phi: the predecessor it is reached from, and the value visible at that predecessor's exit. */
export interface IrPhiIncoming {
  readonly block: IrBlockId
  readonly value: IrOperand
}

export interface PhiOperation extends IrOperationBase {
  readonly kind: 'phi'
  readonly incoming: readonly IrPhiIncoming[]
  readonly result: IrResult
}

export interface BranchOperation extends IrOperationBase {
  readonly kind: 'branch'
  readonly condition: IrOperand
  readonly whenTrue: IrBlockId
  readonly whenFalse: IrBlockId
}

export interface JumpOperation extends Omit<IrOperationBase, 'lineage'> {
  readonly lineage: SemanticResultId | null
  readonly kind: 'jump'
  readonly target: IrBlockId
}

export interface ReturnOperation extends Omit<IrOperationBase, 'lineage'> {
  readonly lineage: SemanticResultId | null
  readonly kind: 'return'
  /** `null` for a body whose declared result is `void`; there is no value to carry. */
  readonly value: IrOperand | null
}

export interface ThrowOperation extends IrOperationBase {
  readonly kind: 'throw'
  readonly value: IrOperand
}

export interface IrSwitchCase {
  readonly test: IrOperand
  readonly target: IrBlockId
}

export interface SwitchOperation extends IrOperationBase {
  readonly kind: 'switch'
  readonly discriminant: IrOperand
  readonly cases: readonly IrSwitchCase[]
  readonly defaultTarget: IrBlockId
}

// ---------------------------------------------------------------------------
// Allocation: one operation per runtime carrier in the object substrate
// ---------------------------------------------------------------------------

/**
 * A fresh `OrdinaryObject` with no declared fields yet. Population is a
 * sequence of ordinary `set`/`define-own-property` operations afterward --
 * there is no separate initializer payload here, because the substrate does
 * not admit a second route from allocation straight to installed state.
 */
export interface AllocateOrdinaryObjectOperation extends IrOperationBase {
  readonly kind: 'allocate-ordinary-object'
  readonly result: IrResult
}

/**
 * A present element and a hole are different; collapsing them loses
 * observable Array behavior. A `spread` slot is neither: it names a whole
 * source array to range-copy in place rather than a single value to push --
 * `from` is the zero-based index its own copy starts at, so an array-literal
 * spread ("everything") and a pattern's rest element ("everything past
 * position N") are the same primitive at two different start points.  A
 * `gather` is deliberately separate: it drains one already-acquired dynamic
 * iterator record, not a Value projected as a native array.
 */
export type IrArrayElement =
  | { readonly kind: 'element'; readonly value: IrOperand }
  | { readonly kind: 'hole' }
  | {
      readonly kind: 'spread'
      readonly value: IrOperand
      readonly from: number
      /**
       * Present when the lowering admitted a PER-ELEMENT conversion into this
       * array's own element carrier -- the source's elements are carried
       * wider than the destination's (an open-ended tuple's tail, whose
       * array carries the union of every position, range-copied into a rest
       * parameter of the tail's own type). Absent, the two carriers must be
       * identical and the emitter refuses otherwise; present, the emitter
       * converts each copied element with the ordinary conversion recipes and
       * refuses when none exists.
       */
      readonly element?: Representation
    }
  /** Drain one genuinely dynamic iterator record into this fresh/native array. */
  | { readonly kind: 'gather'; readonly iterator: IrOperand }

export interface AllocateArrayObjectOperation extends IrOperationBase {
  readonly kind: 'allocate-array-object'
  readonly elements: readonly IrArrayElement[]
  readonly result: IrResult
}

export interface AllocateCallableOperation extends IrOperationBase {
  readonly kind: 'allocate-callable'
  readonly functionId: FunctionId
  /**
   * Captured environment slots, in capture order.
   *
   * Still unfilled by every producer, exactly as when this field was added:
   * an `IrOperand` only ever names an already-DEFINED SSA value
   * (`verify.ts`'s `value-used-before-defined` guard), so populating one
   * per capture here would mean minting a real `binding-read` operation for
   * every relayed declaration at every allocation site -- and that operation
   * is a genuine new operand everywhere `operandsOfIrOperation` is asked
   * (`ir/captures.ts`'s own `buildDyingArgumentIndex`/`ownedDyingValuesOf`
   * among them), which would perturb move/dying-value analysis this task
   * does not own. `ir/captures.ts`'s `computeCaptureFacts` publishes the
   * same information instead on `IrBody.facts.capturedDeclarations` /
   * `.capturedReceiver`, keyed by `functionId` through `IrBody.sourceOwner`
   * -- a side channel that adds no new operand and so cannot move this. If
   * `IrOperand.transfer` (the later phase-3 row) ever needs a real capture
   * operand, that is the point to revisit this field, not before.
   */
  readonly captures: readonly IrOperand[]
  readonly result: IrResult
}

/** A native `Function.prototype.bind` result with its receiver and leading arguments captured once. */
export interface BindCallableOperation extends IrOperationBase {
  readonly kind: 'bind-callable'
  readonly source: IrOperand
  /** Exact semantic origin required when `source` is a dynamic Function object. */
  readonly sourceFunctionId: FunctionId | null
  /**
   * The source callable's checked physical convention. `source` itself may be
   * dynamic solely because its Function object has dynamic own-property
   * semantics; that carrier must not erase the frame its bound prefix enters.
   */
  readonly sourceAbi: CallableAbi
  /** Retained for evaluation even when the source convention has no receiver slot. */
  readonly thisArgument: IrOperand | null
  /** The source frame's receiver, when its convention declares one. */
  readonly receiver: IrOperand | null
  readonly bound: readonly IrOperand[]
  /**
   * A method read as a VALUE and handed to a receiver-less slot (`map(this.f)`,
   * `const g = obj.m`), bound to the object it was read from only because the
   * C++ member needs a receiver to be invoked at all. The language calls a
   * detached method with no `this`, so the printer refuses a body that reads
   * it rather than answer where the program would have thrown; a real
   * `Function.prototype.bind` (`false`) binds whatever its body does.
   */
  readonly detached: boolean
  readonly result: IrResult
}

export interface AllocateConstructorOperation extends IrOperationBase {
  readonly kind: 'allocate-constructor'
  readonly declaration: DeclarationId
  /** Same status as `AllocateCallableOperation.captures` -- see its comment. */
  readonly captures: readonly IrOperand[]
  /** The evaluated superclass object, whose prototype belongs to that evaluation rather than its declaration. */
  readonly heritage?: IrOperand
  readonly result: IrResult
}

/** A proxy carries exactly target and handler; there is no target-only carrier (architecture.md substrate section). */
export interface AllocateProxyOperation extends IrOperationBase {
  readonly kind: 'allocate-proxy'
  readonly target: IrOperand
  readonly handler: IrOperand
  readonly result: IrResult
}

export interface IrRecordFieldInit {
  readonly key: string
  readonly value: IrOperand
}

/**
 * Allocation of a value whose whole layout the plan already selected: a
 * struct, a native record reference, or a keyed container. `fields` carries
 * the initializers a producer supplied at the allocation site; an object
 * literal that installs its members as separate `define-own-property`
 * operations allocates with none.
 */
export interface AllocateRecordOperation extends IrOperationBase {
  readonly kind: 'allocate-record'
  readonly fields: readonly IrRecordFieldInit[]
  readonly result: IrResult
}

/**
 * The template object a tagged template site hands its tag (ECMA-262 13.2.8.3
 * `GetTemplateObject`).
 *
 * It is the only operation in this file that does not allocate when it runs.
 * `GetTemplateObject` caches its answer per Parse Node, so one site's object is
 * created once and the SAME object is handed to the tag on every evaluation --
 * which is the whole reason the operation exists rather than being an ordinary
 * `allocate-record` plus a sequence of stores. A target renders it as a read of
 * a per-site immortal; nothing about it is per-evaluation.
 *
 * `raw[i]` is the final segment text. `cooked[i]` is either its final string
 * or the explicit `undefined` state an invalid escape produces; no runtime
 * step computes, converts or re-escapes either one.
 */
export type IrTemplateCookedSegment = { readonly kind: 'string'; readonly text: string } | { readonly kind: 'undefined' }

export interface AllocateTemplateObjectOperation extends IrOperationBase {
  readonly kind: 'allocate-template-object'
  readonly cooked: readonly IrTemplateCookedSegment[]
  readonly raw: readonly string[]
  readonly result: IrResult
}

/**
 * A regular-expression object, from the pattern and flags a literal or a
 * `RegExp` construction states (ECMA-262 22.2.4.1 `RegExp(pattern, flags)`,
 * which reaches 22.2.3.1 `RegExpAlloc` then 22.2.3.2 `RegExpInitialize`).
 *
 * `source` and `flags` are the texts the producer read off the literal's own
 * token, already final: 22.2.3.2 hands `RegExpInitialize` the pattern text
 * unmodified, so no runtime step computes, converts or re-escapes either one.
 * They are the literal's BODY and FLAGS, without the delimiting slashes --
 * which is what `RegExp.prototype.source` and `.flags` answer, so the same two
 * strings serve both the construction and the accessors.
 *
 * Unlike `allocate-template-object` this really does allocate on every
 * evaluation, and that is observable rather than incidental: 22.2.4.1 creates a
 * fresh object per evaluation of the literal, and `lastIndex` is mutable state
 * on it -- two evaluations of the same `/g` literal must not share a cursor.
 */
export interface AllocateRegExpOperation extends IrOperationBase {
  readonly kind: 'allocate-regexp'
  readonly source: string
  readonly flags: string
  readonly result: IrResult
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

/**
 * A conversion-use application.
 *
 * Deliberately minimal: an authenticated conversion-use identity plus its
 * exact source and result SSA identities, and nothing else. Carrying a second
 * capability payload, a re-stated classifier, or a reason string here would
 * be the second provenance proof the canonical provenance graph forbids
 * (architecture.md, "Canonical semantic provenance graph").
 */
export interface ConvertOperation extends IrOperationBase {
  readonly kind: 'convert'
  readonly conversionUse: ConversionUseId
  readonly source: IrOperand
  readonly result: IrResult
  /**
   * `'checked'` on a load out of an `optional` that no program fact proves
   * present (`ir/presence-proof.ts`): the printer tests presence and raises a
   * TypeError rather than read a payload that may not be there. Absent on every
   * proven load, and on every conversion that is not an unchecked load at all.
   */
  readonly presence?: 'checked'
}

/**
 * Rebuilding a merge input into the merge's own carrier when control flow has
 * proven some state of a tagged union carrier dead at THIS merge.
 *
 * Two lowerings carry that proof here. `mergeIncoming`
 * (`ir/lower-narrow.ts`) uses `partialDeadMergeArms` for a `&&` merge's kept
 * operand, where some arms can never be the falsy reason that arm ran.
 * `lowerDefaultValueStep` (`ir/lower-destructuring.ts`) uses the truthy arm of
 * an `is-defined` guard, where top-level `undefined` arms are dead but a
 * sibling `null` arm remains live. In both cases the operation records the
 * exact surviving indices at the site that established them.
 *
 * A general `convert` cannot express this. `convert`'s C++ rendering
 * (`emit.ts`'s `emitConvert`) dispatches purely on the source/result
 * REPRESENTATION PAIR (`convertedValueText`), which is a promise that holds
 * everywhere that exact pair recurs in the program -- and "the dead arm
 * never needs testing" is true only at merges the checker's own narrowing
 * already proved it for, not for every occurrence of the same two carriers.
 * Widening `convertedValueText` to drop an arm generically would silently
 * mis-render an actually-live value of that arm's shape at any other,
 * unguarded call site sharing the pair.
 *
 * `liveArms` is therefore the proof, not a hint: the arm indices the producing
 * control-flow lowering proved live, computed once there and carried forward
 * rather than re-derived -- or guessed from carrier shape alone -- at
 * emission.
 * Rendering tests only these indices, in source-arm order, against `source`
 * (unwrapped of one optional layer first, exactly as `isDeadMergeContribution`
 * unwraps it), converts each live arm's own payload into `result`'s carrier
 * through the ordinary, unmodified `convertedValueText` (a live arm's payload
 * really can convert to the merge's carrier everywhere that pair recurs --
 * only the DEAD arms are the merge-site-specific fact), and falls back to
 * `result`'s own absent value when `source` itself is optional and that
 * absence remains live. A `??` kept branch proves precisely that top-level
 * absence dead while leaving every payload arm live; `sourceAbsenceLive`
 * carries that distinct proof without pretending any payload arm disappeared.
 */
export interface MergeLiveArmRebuildOperation extends IrOperationBase {
  readonly kind: 'merge-live-arm-rebuild'
  readonly nativeTransport?: import('./native-merge-transport.js').NativeMergeTransport
  readonly source: IrOperand
  readonly result: IrResult
  /**
   * Indices, into `source`'s (optional-unwrapped) tagged union arms, of the
   * arms the producing control-flow guard proved live -- in ascending
   * source-arm order. Never empty. It is smaller than the union's full arm
   * count when a payload arm was ruled out, and may equal the full count when
   * a `??` presence guard ruled out only the optional wrapper's absence. The
   * `&&` producer obtains that split from `partialDeadMergeArms`; the
   * default-value producer removes only top-level `undefined` on the
   * `is-defined` branch. Both route a whole-live or whole-dead set elsewhere.
   */
  readonly liveArms: readonly number[]
  /** Whether an absent optional source can still reach this merge input. */
  readonly sourceAbsenceLive: boolean
}

// ---------------------------------------------------------------------------
// Iterator protocol
// ---------------------------------------------------------------------------

/**
 * `method` is the already-fetched `@@iterator`/`@@asyncIterator` method;
 * fetching it is an ordinary `get`, not part of this op. `null` for the
 * native array fast path: a provably plain `T[]` has no dynamic method to
 * fetch at all (ECMA-262 23.1.5's Array Iterator is a plain index/length
 * walk), so there is nothing to pass -- see `emit-iterator.ts`'s
 * `emitGetIterator`, which requires a null `method` for exactly the
 * `array-object` receiver this shape is reached with.
 */
export interface GetIteratorOperation extends IrOperationBase {
  readonly kind: 'get-iterator'
  /**
   * Which walk this is. Two protocols reach this one operation over the same
   * receiver carrier and mean opposite things: `for`-`in` over a struct yields
   * its KEYS, `for`-`of` over a fixed-arity tuple -- also carried as a
   * positional record -- yields its VALUES. Both cursors are
   * `gea::Iterator<std::string>` when the fields are strings, so neither the
   * receiver's carrier nor the result's can tell the emitter which walk to
   * build, and picking the wrong one is a silent miscompile rather than a
   * refusal. Preflight already keys its obligations on the protocol
   * (`protocol:enumerate:...` vs `protocol:iterator:...`); this carries the
   * same fact to emission instead of leaving it to infer one from a carrier
   * spelling.
   */
  readonly protocol: 'iterator' | 'async-iterator' | 'enumerate'
  readonly receiver: IrOperand
  readonly method: IrOperand | null
  readonly result: IrResult
}

export interface IteratorNextOperation extends IrOperationBase {
  readonly kind: 'iterator-next'
  readonly iterator: IrOperand
  /** The optional argument to `.next(value)`; absent for ordinary `for-of` consumption. */
  readonly value: IrOperand | null
  readonly result: IrResult
}

/**
 * `IteratorResult`'s `done` half, split out as its own IR operation rather
 * than a second result field on `IteratorNextOperation` -- every other
 * operation in this IR publishes exactly one result, and `resultOfIrOperation`
 * reads that as `operation.result` unconditionally; a second result field
 * would be invisible to it. The native array fast path's `next` sets the
 * cursor's own `done` flag as a side effect of stepping it
 * (`gea::Iterator::arrayNext`), and this op reads that flag back -- ordered
 * after `next` by an ordinary operand edge (the negation `contributeForOfIn`
 * mints over this op's result), never by construction order alone.
 */
export interface IteratorDoneOperation extends IrOperationBase {
  readonly kind: 'iterator-done'
  readonly iterator: IrOperand
  readonly result: IrResult
}

export interface IteratorCloseOperation extends IrOperationBase {
  readonly kind: 'iterator-close'
  readonly iterator: IrOperand
  readonly result: IrResult | null
  /** Finite destructuring closes only while no step has observed exhaustion. */
  readonly onlyIfOpen: boolean
}

// ---------------------------------------------------------------------------
// The closed union
// ---------------------------------------------------------------------------

/**
 * One JSX element, constructed.
 *
 * This stays a single operation rather than a create-then-mutate sequence
 * because that is what the language states: `<div a={x}>{y}</div>` evaluates
 * its attributes and children and then produces one element, and no
 * intermediate half-built element is observable. A sequence would also let a
 * later pass reorder or drop one step, which for a child list is the whole
 * content of the value.
 *
 * The props are key/value pairs rather than a record operand: under `jsx:
 * "preserve"` no props object is ever created, so allocating one here would
 * publish an object identity the program does not have.
 */
export interface IrElementPropertyInit {
  readonly key: IrOperand
  readonly value: IrOperand
}

/**
 * Creating one host element node -- the tag alone, with nothing yet on it.
 *
 * Properties and children are separate operations rather than fields here, and
 * the reason is ordering. A bundled element states its whole subtree as values
 * that must already exist, which forces the tree to lower leaves-first: every
 * child is materialized before the parent that will hold it. That is the wrong
 * order for a library whose children *attach into* a parent instead of
 * returning a node -- such a child needs its parent to exist before it can run
 * at all, and no arrangement of a bundled operation's operand list expresses
 * that.
 *
 * Split into three, the order is written down instead of implied: create the
 * node, then set properties on it, then attach children to it. Anything a
 * consumer wants to interleave between those steps -- attaching a nested tree
 * into the node, capturing the node for a later update -- has a place to
 * happen, and the emitted sequence is unchanged for the ordinary case.
 */
export interface ElementOperation extends IrOperationBase {
  readonly kind: 'element'
  readonly form: 'intrinsic' | 'value' | 'fragment'
  /** The intrinsic tag or the tag value; `null` only for a fragment, which names nothing. */
  readonly tag: IrOperand | null
  /**
   * This element IS its text, rather than containing it.
   *
   * `<span>front</span>` is a leaf that carries characters, and a host with a
   * text node builds it as one -- carrying the span's own class and style --
   * rather than as a container holding a separate text child. Which tags may be
   * one is the host's answer (`PluginCapabilities.elementTextTags`); whether
   * THIS element's contents are a single text run is the language's, decided
   * from the children's own carriers in `lower-element.ts`.
   *
   * Set here rather than left to the emitter because the node's kind is fixed
   * at creation -- a host cannot turn a container into a text node afterwards
   * -- and the create operation is the only one that sees the tag and the whole
   * child list at once. `false` for every element that is not proven to be one,
   * which is the answer every element got before this existed.
   */
  readonly textLeaf: boolean
  readonly result: IrResult
}

/** Setting one property on an element node already created. Publishes no result: it is a store. */
export interface ElementPropOperation extends IrOperationBase {
  readonly kind: 'element-prop'
  readonly node: IrOperand
  readonly key: IrOperand
  readonly value: IrOperand
  /** Always absent: setting a property evaluates to nothing there is an SSA name for. */
  readonly result: null
}

/** Attaching one child to an element node already created. Publishes no result: it is a store. */
export interface ElementChildOperation extends IrOperationBase {
  readonly kind: 'element-child'
  readonly node: IrOperand
  readonly child: IrOperand
  /**
   * The node this attaches to IS its text -- see `ElementOperation.textLeaf`.
   *
   * Carried here as well as on the create, because both operations act on it
   * and neither can see the other: this one names the node and not its tag, and
   * the create sees the tag and not what the child turns out to be. One
   * decision in `lower-element.ts` sets both, so the two cannot disagree.
   */
  readonly textLeaf: boolean
  /** Always absent: attaching a child evaluates to nothing there is an SSA name for. */
  readonly result: null
}

/**
 * A predicate over one value, yielding a boolean.
 *
 * `to-boolean` is the language's `ToBoolean`, and it is exact and
 * carrier-specific: an empty string is false and a non-empty one true, `0` and
 * `NaN` are false and every other number true, an absent optional is false, and
 * every object is true whatever it contains.
 *
 * `is-present` is the *other* test the language performs, and it is not a
 * weaker or stricter truthiness. `a?.b` and `a ?? b` branch on whether `a` is
 * `null` or `undefined` and on nothing else: `0`, `''` and `NaN` are all
 * present, and every one of them is falsy. Running `ToBoolean` where the
 * language runs a nullish check takes the wrong branch for exactly those
 * values, which is why they are two predicates here rather than one with a
 * flag applied afterwards.
 *
 * `is-defined` is the third, and it is the narrow half of `is-present`: only
 * `undefined` counts as absent. That is the test a defaulted parameter runs --
 * the language substitutes an initializer for a missing argument and for
 * nothing else, so `f(x = 0)` called `f(null)` binds `null`.
 *
 * All three are one operation over a stated carrier rather than a cast, and a
 * backend either has the rule for that carrier or refuses -- which is why the
 * carrier stays on the operand instead of being erased into a
 * boolean-producing coercion. The result is always a boolean scalar; there is
 * no other thing either predicate can produce.
 */
export interface TestOperation extends IrOperationBase {
  readonly kind: 'test'
  readonly predicate: 'to-boolean' | 'is-present' | 'is-defined'
  readonly value: IrOperand
  readonly result: IrResult
}

export type IrTerminatorOperation = BranchOperation | JumpOperation | ReturnOperation | ThrowOperation | SwitchOperation

export type IrOperation =
  | GetOperation
  | SetOperation
  | DeleteOperation
  | HasPropertyOperation
  | OwnPropertyKeysOperation
  | DefineOwnPropertyOperation
  | SpreadCopyOperation
  | CallOperation
  | CommonJsRequireOperation
  | CommonJsBindingOperation
  | CommonJsBindingSetOperation
  | SuperInitializeOperation
  | ReparentConstructorOperation
  | ConstructOperation
  | ConstantOperation
  | BindingReadOperation
  | BindingWriteOperation
  | ParameterOperation
  | ReceiverOperation
  | GlobalThisOperation
  | UnresolvableReferenceOperation
  | AwaitOperation
  | YieldOperation
  | CatchBindingOperation
  | ComputeOperation
  | PhiOperation
  | IrTerminatorOperation
  | AllocateOrdinaryObjectOperation
  | AllocateArrayObjectOperation
  | AllocateCallableOperation
  | BindCallableOperation
  | AllocateConstructorOperation
  | AllocateProxyOperation
  | AllocateRecordOperation
  | AllocateTemplateObjectOperation
  | AllocateRegExpOperation
  | ConvertOperation
  | MergeLiveArmRebuildOperation
  | GetIteratorOperation
  | IteratorNextOperation
  | IteratorDoneOperation
  | IteratorCloseOperation
  | ElementOperation
  | ElementPropOperation
  | ElementChildOperation
  | TestOperation

/** Every operation kind that may terminate a block. Used to keep the "terminator is last" invariant checkable. */
export const terminatorKinds = ['branch', 'jump', 'return', 'throw', 'switch'] as const

export const isTerminatorOperation = (operation: IrOperation): operation is IrTerminatorOperation =>
  (terminatorKinds as readonly string[]).includes(operation.kind)

/** An operation the type system already excludes from `IrBlock.operations` -- see `isTerminatorOperation` for the runtime mirror. */
export type IrNonTerminatorOperation = Exclude<IrOperation, IrTerminatorOperation>

/**
 * A basic block.
 *
 * `terminator` is its own field, not the last array element, so "no
 * terminator" and "terminator not last" are unrepresentable by construction
 * rather than facts `verify` has to rediscover by scanning an array.
 */
export interface IrBlock {
  readonly id: IrBlockId
  readonly operations: readonly IrNonTerminatorOperation[]
  readonly terminator: IrTerminatorOperation
}

/** Every operation in a block, in execution order, terminator last. */
export const allOperationsOf = (block: IrBlock): readonly IrOperation[] => [...block.operations, block.terminator]

export interface IrBody {
  readonly owner: PhysicalBodyId
  /**
   * The execution region this body belongs to, carried alongside the folded
   * identity rather than recovered from it.
   *
   * `physicalBodyId` folds an owner and a variant key into one opaque string,
   * and taking it apart again would make every reader a second authority over
   * a structure `identity/ids.ts` alone is allowed to define -- the same
   * objection that forbids parsing rendered C++ to recover a decision. A
   * consumer that needs the real owner is told it, once, by the layer that
   * had it.
   */
  readonly sourceOwner: FunctionId | RegionId
  /** Observable [[SourceText]], retained even when the allocating expression is dead. */
  readonly functionSource?: string
  /** `[[Name]]` -- own declared name or `NamedEvaluation` name; `''` for a truly anonymous callable. Carried alongside `functionSource`, present under the identical condition. */
  readonly functionName?: string
  /** `Function.prototype.length` -- written parameters before the first default/rest one. Carried alongside `functionSource`. */
  readonly functionLength?: number
  /**
   * Whether this body is a `function*` -- the DECLARATION's fact, carried from
   * the allocation operation because the result carrier cannot answer it: a
   * plain `function makeGen() { return g() }` returns the same `iterator`
   * cursor a generator does, and only the former spells `return`.
   */
  readonly generator?: boolean
  /**
   * Where `FunctionDeclarationInstantiation`'s own work ends inside this
   * generator's entry -- `null` for a non-generator, and for a generator
   * whose formals need nothing run early (no default, no destructured
   * pattern): the plain `parameter` copies a coroutine's own frame already
   * makes before `initial_suspend` need no help.
   *
   * ECMA-262 runs a function's parameter defaults and destructuring
   * (10.2.1 step 8, `FunctionDeclarationInstantiation`) as part of `[[Call]]`,
   * before `EvaluateGeneratorBody` (15.5.2) ever creates the suspended
   * generator object -- so a default's thrown error, or a pattern's failed
   * iterator-close, surfaces at the CALL, not at the first `next()`. A C++20
   * coroutine cannot express that split within one function: the whole
   * function's execution -- including its very first statement -- is
   * deferred behind `initial_suspend`, coroutine-ness being a whole-function
   * property. `ir/generator-split.ts` reads this field to carve such a body
   * into an ordinary OUTER function (this body's own declared signature,
   * running the prefix) that tail-calls a private INNER coroutine (holding
   * everything from `operationIndex` on, plus every block this owner's
   * `blockOrder` lists that is not in `outerBlocks`).
   *
   * `block`/`operationIndex` name the cut inside that one block: operations
   * `[0, operationIndex)` belong to the outer prefix, the rest -- plus that
   * block's own terminator -- start the inner coroutine. `outerBlocks` is
   * every block whose OWN operations lowering reached while still inside the
   * parameter-instantiation phase (`OrderedOwnerOperations.parameterPrologue`
   * in `lower-graph.ts`), captured here because lowering already has the
   * `blockStarts` table that answers it and a later consumer, working from
   * the sealed body alone, would have to re-derive block reachability from
   * scratch to recover the same set.
   */
  readonly generatorPrologueBoundary?: {
    readonly block: IrBlockId
    readonly operationIndex: number
    readonly outerBlocks: ReadonlySet<IrBlockId>
  } | null
  /**
   * The calling convention this body implements, or `null` for a body nobody
   * calls -- a module body, a field initializer, a static block.
   *
   * It is stated once, here, rather than re-derived by each consumer from the
   * owner's signature. A `parameter` operation's ordinal indexes into
   * `abi.parameters`, and the emitter spells the signature from the same
   * field, so the frame the body reads and the frame the signature declares
   * cannot come apart.
   */
  readonly abi: CallableAbi | null
  /**
   * The convention `new` invokes into THIS SAME body, or `null` for a body
   * that is only ever called.
   *
   * A pre-`class` JavaScript constructor function is entered two ways
   * (`projection/abi.ts`'s `constructs`), and the two are separately physical:
   * `[[Call]]` is handed a receiver, `[[Construct]]` manufactures one
   * (ECMA-262 10.2.2) and evaluates to it. Both are needed to render the two
   * function pointers `gea::CallableConstructorObject` holds, and carrying the
   * second here -- beside the first, from the one projection that decided both
   * -- is what keeps the emitter from re-deriving it out of `abi.receiver`.
   */
  readonly construct: CallableAbi | null
  readonly entry: IrBlockId
  readonly blocks: ReadonlyMap<IrBlockId, IrBlock>
  /** Deterministic iteration order, fixed at build time so two verifications of the same body agree. */
  readonly blockOrder: readonly IrBlockId[]
  /** Every SSA value's declared carrier, indexed once so a consumer never re-derives it by re-scanning operations. */
  readonly values: ReadonlyMap<IrValueId, Representation>
  /**
   * Every try statement this body lowered, naming the blocks C++ emission
   * cannot reach the ordinary way.
   *
   * `tryEntry` and `catchEntry` are real blocks with real terminators, exactly
   * like any other -- `verify.ts`'s guards all pass over them unmodified --
   * but nothing in this body's own jump/branch graph ever transfers control
   * into either from outside: entering `tryEntry` is C++'s own fallthrough
   * into a `try {` the emitter writes instead of a `goto`+label (which C++
   * forbids), and `catchEntry` is reached only by the runtime unwinding an
   * exception out of the try body. `emit.ts` reads this table to know which
   * blocks need that special rendering; nothing else does.
   */
  readonly tryRegions: readonly IrTryRegion[]
  /** Synchronous iteration regions that route abrupt or finite completion through IteratorClose. */
  readonly iteratorCloseRegions?: readonly IrIteratorCloseRegion[]
  /**
   * What `ir/captures.ts` decided about this body from a whole-program walk
   * of the lowered bodies plus the binding placements -- absent only for a
   * body nobody has run that analysis over yet (a hand-built test body, or a
   * pipeline stage upstream of `publishCaptureFacts`). A body downstream of
   * that pass always carries one, even a body that captures nothing and is
   * never allocated as a value, so a reader default to the empty answer for
   * `undefined` rather than to a MISSING one it has to special-case.
   *
   * Read by `targets/cpp/captures.ts`'s `buildCaptureIndex`, which used to
   * recompute all of this itself from the same bodies and placements
   * (a program fact, so it belongs to the IR) -- a fact of the representation
   * the target had no business re-deriving at render time.
   */
  readonly facts?: IrBodyFacts
}

/**
 * One body's own share of the whole-program capture analysis
 * `ir/captures.ts`'s `computeCaptureFacts` performs -- which declarations an
 * allocation THIS body's owner makes must transport from an enclosing frame,
 * and which declarations THIS body OWNS (per `BindingPlacement.storage`)
 * that some capturing frame needs shared by aliasing rather than by copying.
 *
 * `boxed` and `requiresEarlyBox` are scoped to the OWNING body rather than
 * published as one whole-program set, because a declaration belongs to
 * exactly one physical frame (`BindingPlacement.storage.owner`) and every
 * reader that needs the whole-program answer -- `CaptureIndex.isBoxed`,
 * consulted by any frame that reads or writes the cell, capturing or not --
 * gets it by taking the union of every body's own set. That union can never
 * disagree with itself the way two independently-recomputed whole-program
 * sets could.
 */
export interface IrBodyFacts {
  /**
   * Every declaration outside this body's own frame that an allocation this
   * body's owner is the target of must carry in its environment, in
   * first-mention/relay order -- the transitive closure over `allocate-callable`
   * allocation edges (`ir/captures.ts`'s `transitiveCaptures`). Empty for a
   * body that is never allocated as a value, or that closes over nothing.
   */
  readonly capturedDeclarations: readonly DeclarationId[]
  /**
   * The enclosing method's receiver representation this body reads directly
   * or merely relays to a deeper closure that reads it, or `null` when this
   * body needs no receiver from anywhere but its own ABI.
   */
  readonly capturedReceiver: Representation | null
  /**
   * Whether some `allocate-callable` operation anywhere in the program names
   * this body's own `sourceOwner` as the function it allocates -- the same
   * gate `buildCaptureIndex` used to re-derive by scanning every body.
   */
  readonly allocatedAsValue: boolean
  /**
   * Whether this body reads `this` -- in its own operations, or by allocating
   * a nested closure that has no receiver of its own and reads this one.
   */
  readonly readsReceiver: boolean
  /** Declarations OWNED by this body that must be shared by aliasing rather than copied into a capturing environment. */
  readonly boxed: ReadonlySet<DeclarationId>
  /**
   * Declarations OWNED by this body for which no individual write dominates
   * every allocation that captures them -- the owning frame must allocate the
   * shared cell before its first rendered block rather than at the write.
   */
  readonly requiresEarlyBox: ReadonlySet<DeclarationId>
}

/** One synchronous `for`-`of` iteration or finite destructuring sequence protected by ECMAScript IteratorClose. */
export interface IrIteratorCloseRegion {
  readonly loop: OperationId
  readonly lineage: SemanticResultId
  readonly iterator: IrOperand
  readonly entry: IrBlockId
  readonly blocks: readonly IrBlockId[]
  /** Jumps representing same-loop continuation or normal exhaustion dismiss cleanup; empty for finite patterns. */
  readonly dismissTargets: readonly IrBlockId[]
  /** Finite patterns close only if no step has already observed exhaustion. */
  readonly onlyIfOpen: boolean
  /**
   * Where the loop BODY starts, or `null` for a finite pattern.
   *
   * The region covers the head test and the body alike, but ECMA-262 14.7.5.7
   * closes for only one of them. It calls `next` with `?` -- ReturnIfAbrupt --
   * and IteratorComplete and IteratorValue likewise set `[[Done]]` and
   * propagate, so **a throw out of the step does not close the iterator**;
   * only a throw out of the body does, and that one discards the close's own
   * failure (7.4.9 step 3). The two cannot be separate C++ `try` blocks -- the
   * head test's branch jumps INTO the body, and a `goto` into a try block is
   * ill-formed -- so the rendering keeps one handler and this names the point
   * at which it starts closing.
   */
  readonly bodyEntry: IrBlockId | null
}

/** One try statement's blocks, keyed by its own control operation. See `IrBody.tryRegions`. */
export interface IrTryRegion {
  readonly region: OperationId
  /** First block of the try body. */
  readonly tryEntry: IrBlockId
  /** First block of the catch handler, or `null` for a try with no catch clause. */
  readonly catchEntry: IrBlockId | null
  /**
   * First block of the finally clause, or `null` for a try without one.
   *
   * Reached by no control-flow edge this IR builds, exactly as `catchEntry` is
   * reached by none: the C++ rendering runs it from a SCOPE GUARD's destructor
   * placed around the whole `try`/`catch`, which is what makes every one of
   * ECMAScript's five ways out of a try body run it without a completion record
   * to dispatch on. Falling off the end, a `return`, a `break`/`continue` to an
   * enclosing loop and a `goto` past the scope all destroy the guard on the way
   * out, and an exception propagating destroys it while unwinding.
   *
   * The part's own blocks end by reaching `join`, which the emitter renders as
   * falling off the end of the guard's body rather than as a jump -- a `goto`
   * out of the guard body is ill-formed C++, and that is the same fact as "a
   * finally clause does not decide where control goes next".
   */
  readonly finallyEntry: IrBlockId | null
  /**
   * Where the finally clause's own normal completion goes, or `null` for a try
   * without one (or one whose clause never completes normally).
   *
   * Not the region's `join`, which is where the try body and the catch handler
   * converge: a finally clause decides nothing about where control goes next,
   * so its end is not an arrival, it is a hand-back. The emitter renders
   * reaching this block as falling off the end of the guard body, after which
   * control resumes wherever the completion that ran the clause was headed.
   */
  readonly finallyExit: IrBlockId | null
  /**
   * Where both sides rejoin on ordinary completion, or `null` when neither
   * side ever does (both end in `return`/`throw`, so nothing ever asked for a
   * join).
   */
  readonly join: IrBlockId | null
}
